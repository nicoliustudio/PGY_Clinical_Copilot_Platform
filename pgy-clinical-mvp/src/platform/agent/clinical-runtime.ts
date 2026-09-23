import type { RuntimeRunResult } from '../../contracts/authority.js';
import type { PrimaryAgentPort, RuntimePreparationPort } from '../../contracts/ports.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { CandidateAssessment, CandidateComparison, ClinicalWorkspace, DeliberationCoverage, HypothesisCandidate, PromotionCoverage, WorkspaceEvent } from '../../contracts/workspace.js';
import type { AgentStreamEvent } from '../../contracts/stream.js';
import type { AgentLoopTrace, ContextMetrics } from '../../contracts/agent-loop.js';
import type { ClinicalStrategy } from '../../contracts/clinical-strategy.js';
import { AuthorityPipeline } from '../authority/pipeline.js';
import { EVIDENCE_EVENT_TYPES } from '../workspace/evidence-projection.js';
import { HYPOTHESIS_EVENT_TYPES } from '../workspace/hypothesis-projection.js';
import { getCanonicalFormula } from '../../clinical/formula.js';
import { hydrateSourceFormulaSet } from '../../clinical/source-formula-set.js';
import { computeModificationEvidenceClosure } from '../../clinical/modification-evidence.js';
import { loadIndex } from '../../knowledge/build.js';
import { setFormulaIdentityTrace, type FormulaIdentityTrace } from '../../trace.js';
import { contractResolved, contractSatisfied, outcomeCoverage, refreshControlPlaneV21 } from '../control-plane/control-plane-v21-session.js';
import { projectFormulaSet } from '../../control-plane-v2/result-projection.js';
import type { ProjectedFormula } from '../../control-plane-v2/result-projection.js';
import type { OutcomeProjectionV21 } from '../../control-plane-v21/result-projection.js';
import { treatmentDeliveryArtifacts, treatmentDeliveryCompleteness } from '../../clinical/capability-delivery.js';

export interface ClinicalRunResult extends RuntimeRunResult {
  workspace: ClinicalWorkspace;
  workspaceEvents: WorkspaceEvent[];
  evidenceEvents: WorkspaceEvent[];
  candidateComparison: CandidateComparison[];
  hypothesisEvents: WorkspaceEvent[];
  hypothesisComparison: HypothesisCandidate[];
  promotionCoverage: PromotionCoverage[];
  candidateAssessments: CandidateAssessment[];
  deliberationCoverage: DeliberationCoverage[];
  agentLoop?: AgentLoopTrace;
  strategy: ClinicalStrategy;
  contextMetrics?: ContextMetrics;
  /** Phase 8：确定性结果装配（outcome 覆盖 + 方剂集合投影），不由模型重新总结。 */
  controlPlane?: {
    outcomeCoverage: OutcomeProjectionV21[];
    formulaSet: ProjectedFormula[];
    selectedCandidateRef?: string;
    contractResolved: boolean;
    contractSatisfied: boolean;
  };
}

/**
 * 依据 proposal 的 candidate_ref 记录候选比较结果：仅标记主选方为 selected。
 * H15.6：不再把「未选中」的同源原典方 blanket 标为 rejected ——
 * `not selected` ≠ `clinically rejected`。同源多方完整性由 sourceFormulaSet 确定性水合表达。
 */
function recordCandidateDecision(proposal: AgentResult, context: RuntimeContext): void {
  if (proposal.mode !== 'clinical') return;
  const ref = proposal.formula.candidate_ref;
  if (!ref) return;
  for (const candidate of context.workspace.candidates) {
    if (candidate.kind !== 'formula') continue;
    if (candidate.id === ref) {
      context.workspaceStore.append('candidate.selected', { id: candidate.id });
    }
  }
}

/**
 * H15.6 确定性来源/证据闭环（Runtime 完成义务，非模型自觉）：
 * - 选中 P1 主选方后，水合同一 parent 下的全部 ACTIVE 原典方（sourceFormulaSet）。
 * - 计算加减证据闭环（modificationEvidenceClosure）。
 * 不经过 semantic search / topK / rerank；不产生新 Agent step。
 */
async function finalizeSourceClosures(proposal: AgentResult, context: RuntimeContext): Promise<void> {
  if (proposal.mode !== 'clinical') return;
  const ref = proposal.formula.candidate_ref;
  const candidate = ref ? context.workspace.candidates.find((c) => c.id === ref && c.kind === 'formula') : undefined;

  // H15.6 同源多方水合：以 P1 sourceId 为 gate，而不是 sourceAuthority 字段。
  // sourceAuthority 只在 formula.search_candidates 单一路径被写入 payload；而 knowledge.search /
  // formula.search_normative 同样会产出 P1 候选却未标注该字段，导致同源多方被静默丢弃。
  // sourceId 以 `P1:` 为稳定前缀，且 hydrateSourceFormulaSet 内部已 fail-closed 校验 sourceTier === 'P1'。
  if (candidate?.sourceId?.startsWith('P1:')) {
    try {
      const idx = await loadIndex();
      const sourceFormulaSet = hydrateSourceFormulaSet(idx.docs, ref ?? '');
      if (sourceFormulaSet) context.workspace.sourceFormulaSet = sourceFormulaSet;
    } catch {
      // fail-closed：索引不可用（如单测无 .kb-cache）时跳过同源多方水合，不影响 authority/提交。
    }
  }

  context.workspace.modificationEvidenceClosure = computeModificationEvidenceClosure(context.workspace, ref);
}

/** 依据 proposal 的 syndrome 记录最终领先 hypothesis（不覆盖已有 support/contradiction 状态）。 */
function recordHypothesisDecision(proposal: AgentResult, context: RuntimeContext): void {
  if (proposal.mode !== 'clinical') return;
  const name = proposal.syndrome.name;
  if (!name) return;
  const hypothesis = context.workspace.hypothesisState.hypotheses.find(
    (h) => h.id === name || h.label === name,
  );
  if (hypothesis) {
    context.workspaceStore.append('hypothesis.selected', { id: hypothesis.id });
  }
}

/**
 * candidate_ref → canonical formula record，再进入 Authority 校验。
 * H7：canonical hydrate 由 Harness 内部完成，不依赖模型重建 composition。
 *
 * H7.1：candidate_ref 是最终 formula identity 的唯一来源。模型提供的
 * name / formula_id / source_id / composition 不得覆盖 canonical data。
 * 若 candidate_ref 不存在，保持现有 fail-closed / non-normative 行为。
 */
export async function hydrateFormulaProposal(proposal: AgentResult, context: RuntimeContext): Promise<AgentResult> {
  if (proposal.mode !== 'clinical') return proposal;
  const ref = proposal.formula.candidate_ref;
  if (!ref) return proposal;
  const candidate = context.workspace.candidates.find((c) => c.id === ref && c.kind === 'formula');
  if (!candidate?.formulaId || !candidate?.sourceId) return proposal;
  // 已 hydrate 的 candidate（或测试 fixture）直接复用 composition，避免重复 hydrate。
  if (candidate.composition && candidate.composition.length > 0) {
    return {
      ...proposal,
      formula: {
        ...proposal.formula,
        formula_id: candidate.formulaId,
        source_id: candidate.sourceId,
        composition: candidate.composition,
        name: candidate.name ?? '',
      },
    };
  }
  // H7 canonical hydrate：card 级 candidate 无 composition，由 Harness 内部从 canonical store 查找。
  const canonical = await getCanonicalFormula(candidate.sourceId, candidate.formulaId, context.runId);
  if (!canonical) return proposal;
  return {
    ...proposal,
    formula: {
      ...proposal.formula,
      formula_id: canonical.formulaId,
      source_id: canonical.sourceId,
      composition: [canonical.composition],
      name: canonical.name,
    },
  };
}

/**
 * 稳定的 Runtime 外壳：prepare → reason/propose → compare/hydrate → authority。
 * 业务能力应通过注册数据接入，而不是在此处新增分支。
 */
export class ClinicalRuntime {
  constructor(
    private readonly preparer: RuntimePreparationPort,
    private readonly primaryAgent: PrimaryAgentPort,
    private readonly authority: AuthorityPipeline,
    /** 本次装配所用的 Prompt 内容 hash（用于 Run 快照溯源） */
    private readonly promptHash?: string,
  ) {}

  async run(input: string, runId?: string, onEvent?: (event: AgentStreamEvent) => void): Promise<ClinicalRunResult> {
    const context = await this.preparer.prepare(input, runId);
    const output = await this.primaryAgent.run(context, onEvent);
    recordCandidateDecision(output.proposal, context);
    recordHypothesisDecision(output.proposal, context);
    const rawFormula = output.proposal.mode === 'clinical' ? output.proposal.formula : undefined;
    const proposal = await hydrateFormulaProposal(output.proposal, context);
    // H15.6：确定性同源多方水合 + 加减证据闭环（先于 Authority，不改处方权）。
    await finalizeSourceClosures(output.proposal, context);
    // canonical safety truth：模型 proposal.safety 不覆盖 canonical safety disposition。
    const withCanonicalSafety: AgentResult = proposal.mode === 'clinical'
      ? {
          ...proposal,
          safety: {
            status: context.safety.blockNormativeCommit ? 'BLOCK' : 'PASS',
            reviewRequired: context.safety.reviewRequired,
            reviewReasons: context.safety.reviewReasons,
          },
        }
      : proposal;
    const authority = await this.authority.resolve(withCanonicalSafety, context);

    // H8 Forensic：只记录 identity chain 进 Trace，不改变任何行为。
    if (proposal.mode === 'clinical') {
      const ref = proposal.formula.candidate_ref;
      let canonicalFormula: FormulaIdentityTrace['canonicalFormula'];
      if (ref) {
        const [sid, fid] = ref.split('::');
        if (sid && fid) {
          const c = await getCanonicalFormula(sid, fid);
          if (c) canonicalFormula = { sourceId: c.sourceId, formulaId: c.formulaId, name: c.name, composition: c.composition };
        }
      }
      const formulaDecision = authority.decisions.find((d) => d.stage === 'formula.authority');
      setFormulaIdentityTrace(context.runId, {
        candidateRef: ref,
        rawFormula: rawFormula ? { name: rawFormula.name, sourceId: rawFormula.source_id, formulaId: rawFormula.formula_id, composition: rawFormula.composition } : undefined,
        hydratedFormula: { sourceId: proposal.formula.source_id, formulaId: proposal.formula.formula_id, name: proposal.formula.name, composition: proposal.formula.composition },
        canonicalFormula,
        authorityBlockCode: formulaDecision?.reasons?.[0],
        authorityReasons: formulaDecision?.reasons,
      });
    }

    const workspaceEvents = context.workspaceStore.trace();
    const assembled = this.assembleDeterministicResult(context, authority.proposal);
    return {
      authority: assembled.proposal === authority.proposal ? authority : { ...authority, proposal: assembled.proposal },
      usage: output.usage,
      snapshot: {
        modelProfileId: context.model.id,
        promptHash: this.promptHash,
        capabilities: context.capabilities.map((c) => c.id),
        skills: context.skills.map((s) => s.id),
        activeSkills: context.skills.map((s) => s.id),
        skillVersions: context.skills.map((s) => ({ id: s.id, version: s.version })),
        skillPromptSections: context.skills.filter((s) => s.promptSections.length > 0).map((s) => s.id),
        knowledgeScopes: context.knowledgeScopes,
      },
      workspace: context.workspace,
      workspaceEvents,
      evidenceEvents: workspaceEvents.filter((e) => EVIDENCE_EVENT_TYPES.includes(e.type)),
      candidateComparison: context.workspace.evidenceState.candidateComparisons.map((c) => ({ ...c })),
      hypothesisEvents: workspaceEvents.filter((e) => HYPOTHESIS_EVENT_TYPES.includes(e.type)),
      hypothesisComparison: context.workspace.hypothesisState.hypotheses.map((h) => ({ ...h })),
      promotionCoverage: context.workspace.promotionState.coverage.map((c) => ({ ...c })),
      candidateAssessments: context.workspace.deliberationState.assessments.map((a) => ({ ...a })),
      deliberationCoverage: context.workspace.deliberationState.coverage.map((c) => ({ ...c })),
      agentLoop: output.agentLoop,
      strategy: context.strategy,
      contextMetrics: output.contextMetrics,
      ...(assembled.controlPlane ? { controlPlane: assembled.controlPlane } : {}),
    };
  }

  /**
   * Phase 8 —— Deterministic Result Assembler。
   *
   * 最终聊天结果不由模型重新「回忆」该输出什么：
   * - 所有用户要求的 outcome 的交付状态来自 obligation graph + bound artifacts；
   * - 合法终止但不可交付（知识库无可用资产）的 outcome **必须**在结果中显式出现，而不是静默消失；
   * - 方剂集合由 cardinality policy 确定性投影（同源多方不会被 silent drop）。
   */
  private assembleDeterministicResult(
    context: RuntimeContext,
    proposal: AgentResult,
  ): { proposal: AgentResult; controlPlane?: ClinicalRunResult['controlPlane'] } {
    const state = context.controlPlaneV21;
    if (!state || state.compileStatus !== 'COMPILED') return { proposal };
    refreshControlPlaneV21(context);
    const coverage = outcomeCoverage(state);
    const notDeliverable = coverage.filter((o) => o.status === 'NOT_DELIVERABLE');
    const modelAllowed = state.requestIR.generationPolicy.knowledgeSource === 'MODEL_ALLOWED';
    const formulaSet = projectFormulaSet(
      context.workspace.sourceFormulaSet,
      state.requestIR.outputPolicy.formulaCardinality,
    );
    const controlPlane = {
      outcomeCoverage: coverage,
      formulaSet,
      selectedCandidateRef: context.workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef,
      contractResolved: contractResolved(state),
      contractSatisfied: contractSatisfied(state),
    };
    if (proposal.mode !== 'clinical') return { proposal, controlPlane };

    const explicit = notDeliverable.map((o) =>
      `required outcome ${o.outcome} is NOT_DELIVERABLE: the knowledge base returned no qualified asset`
      + (modelAllowed
        ? '; a model-authored advisory may be provided but is not a normative delivery'
        : '; model-authored substitution is not permitted by the request generation policy'),
    );
    const cardinality = state.requestIR.outputPolicy.formulaCardinality;
    if (cardinality.mode === 'AT_LEAST' && formulaSet.length < cardinality.count) {
      explicit.push(`formula cardinality shortfall: requested at least ${cardinality.count}, but only ${formulaSet.length} eligible source formulas were deterministically available`);
    }
    const treatmentDeliveries = treatmentDeliveryArtifacts(context.workspace).flatMap((delivery) => {
      const completeness = treatmentDeliveryCompleteness(
        context.capabilities,
        delivery as unknown as Record<string, unknown>,
      );
      if (!completeness.complete) {
        explicit.push(
          `incomplete treatment delivery ${delivery.outcome ?? delivery.form}: missing ${completeness.missingFields.join(', ')}`,
        );
        return [];
      }
      return [{
        ...(delivery.outcome ? { outcome: delivery.outcome } : {}),
        form: delivery.form,
        disposition: delivery.disposition,
        statement: delivery.statement,
        source_evidence_refs: delivery.sourceEvidenceRefs,
        ...(delivery.advisoryComposition?.length ? { advisory_composition: delivery.advisoryComposition } : {}),
        ...(delivery.preparation ? { preparation: delivery.preparation } : {}),
        ...(delivery.usage ? { usage: delivery.usage } : {}),
        ...(delivery.details ? { details: delivery.details } : {}),
      }];
    });
    const formulaProjection = formulaSet.map((formula) => ({
      formula_ref: formula.formulaRef,
      formula_id: formula.formulaId,
      name: formula.name,
      composition: formula.composition,
      source_ref: formula.sourceRef,
      modification_rules: formula.sourceModifications,
      modification_status: formula.modificationStatus,
      modification_text: formula.modificationStatus === 'PRESENT'
        ? formula.sourceModifications.join('；')
        : (formula.modificationStatus === 'KNOWN_EMPTY'
          ? '无加减'
          : '源节点存在加减规则，但无法安全归属到该方'),
      ...(formula.modificationStatus === 'UNATTRIBUTED_SOURCE_RULES' && formula.sourceLevelModifications.length > 0
        ? { source_level_modification_rules: formula.sourceLevelModifications }
        : {}),
      ...(formula.usage ? { usage: formula.usage } : {}),
      relation: formula.relation,
    }));
    return {
      proposal: {
        ...proposal,
        ...(formulaProjection.length ? { formula_set: formulaProjection } : {}),
        ...(treatmentDeliveries.length ? { treatment_deliveries: treatmentDeliveries } : {}),
        missing_information: [...new Set([...proposal.missing_information, ...explicit])],
      },
      controlPlane,
    };
  }
}
