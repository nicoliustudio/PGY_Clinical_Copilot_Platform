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
import { getCanonicalFormula, validateNormativeFormula } from '../../clinical/formula.js';
import { hydrateSourceFormulaSet } from '../../clinical/source-formula-set.js';
import { computeModificationEvidenceClosure } from '../../clinical/modification-evidence.js';
import { loadIndex } from '../../knowledge/build.js';
import { setFormulaIdentityTrace, type FormulaIdentityTrace } from '../../trace.js';
import { ledgerContractResolved, ledgerContractSatisfied, ledgerOutcomeCoverage, refreshControlPlaneV21 } from '../control-plane/control-plane-v21-session.js';
import { projectFormulaSet } from '../../control-plane-v2/result-projection.js';
import type { ProjectedFormula } from '../../control-plane-v2/result-projection.js';
import type { OutcomeProjectionV21 } from '../../control-plane-v21/result-projection.js';
import { treatmentDeliveryArtifacts, treatmentDeliveryCompleteness } from '../../clinical/capability-delivery.js';
import { CandidateHandleRegistry } from '../commit/candidate-handle-registry.js';
import { CommitCoordinator, type CommitEnvironment } from '../commit/commit-coordinator.js';
import type { CommitRecord } from '../../contracts/commit.js';

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
  /**
   * Kernel Commit Boundary：本次 run 的唯一权威交付真相。
   * 下游（final / UI / audit）只能从这些 committed records 投影，不得从 Workspace/Proposal 重建。
   */
  commits: CommitRecord[];
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
  const ref = proposal.formula?.candidate_ref;
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
  const ref = proposal.formula?.candidate_ref;
  const candidate = ref ? context.workspace.candidates.find((c) => c.id === ref && c.kind === 'formula') : undefined;

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
 * candidate_ref → canonical formula record。
 * H7.1：candidate_ref 是最终 formula identity 的唯一来源。模型提供的
 * name / formula_id / source_id / composition 不得覆盖 canonical data。
 * Kernel Commit Boundary 切后：canonical hydrate 失败**不再**降级为空 GENERATED_DRAFT；
 * 缺失即缺失（formula 为 undefined），由 commit 阶段 fail-closed。
 */
export async function hydrateFormulaProposal(proposal: AgentResult, context: RuntimeContext): Promise<AgentResult> {
  if (proposal.mode !== 'clinical') return proposal;
  const formula = proposal.formula;
  const ref = formula?.candidate_ref;
  if (!ref || !formula) return proposal;
  const candidate = context.workspace.candidates.find((c) => c.id === ref && c.kind === 'formula');
  if (!candidate?.formulaId || !candidate?.sourceId) return proposal;
  if (candidate.composition && candidate.composition.length > 0) {
    return {
      ...proposal,
      formula: {
        ...formula,
        formula_id: candidate.formulaId,
        source_id: candidate.sourceId,
        composition: candidate.composition,
        name: candidate.name ?? '',
      },
    };
  }
  const canonical = await getCanonicalFormula(candidate.sourceId, candidate.formulaId, context.runId);
  if (!canonical) return proposal;
  return {
    ...proposal,
    formula: {
      ...formula,
      formula_id: canonical.formulaId,
      source_id: canonical.sourceId,
      composition: [canonical.composition],
      name: canonical.name,
    },
  };
}

/**
 * 从 RuntimeContext + proposal 组装 Kernel Commit Environment。
 * 这里只做「数据适配」，不含任何业务/模态分支；provider/field 校验全部来自 manifest / 闭世界核心。
 */
function buildCommitEnvironment(context: RuntimeContext, proposal: AgentResult): CommitEnvironment {
  return {
    safety: {
      status: context.safety.status,
      reviewRequired: context.safety.reviewRequired,
      reasons: context.safety.reasons,
    },
    readReasoningProduct: (ref) => {
      if (ref === 'clinical-assessment') {
        if (proposal.mode !== 'clinical') return undefined;
        return {
          disease: proposal.disease?.name ?? '',
          syndrome: proposal.syndrome?.name ?? '',
          treatment: proposal.treatment?.text ?? '',
        };
      }
      const deliveries = treatmentDeliveryArtifacts(context.workspace);
      const idx = Number.parseInt(ref, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= deliveries.length) return undefined;
      return deliveries[idx] as unknown as Record<string, unknown>;
    },
    validateDelivery: (outcome, product) => {
      if (outcome === 'outcome:clinical-assessment') {
        const disease = typeof product.disease === 'string' && product.disease.trim().length > 0;
        const syndrome = typeof product.syndrome === 'string' && product.syndrome.trim().length > 0;
        const treatment = typeof product.treatment === 'string' && product.treatment.trim().length > 0;
        if (disease && syndrome && treatment) {
          const provider = context.capabilities.find((c) => c.provides?.includes('outcome:clinical-assessment'));
          return { ok: true, providerId: provider?.id ?? 'clinical-core' };
        }
        return { ok: false, code: 'MISSING_REQUIRED_FIELDS', missing: ['disease', 'syndrome', 'treatment'] };
      }
      const completeness = treatmentDeliveryCompleteness(context.capabilities, product);
      if (!completeness.complete) {
        return { ok: false, code: 'MISSING_REQUIRED_FIELDS', missing: completeness.missingFields };
      }
      if (!completeness.capabilityId) return { ok: false, code: 'NO_PROVIDER' };
      return { ok: true, providerId: completeness.capabilityId };
    },
    hydrateCanonicalCandidate: async (truth) => {
      const sep = truth.canonicalKey.indexOf('::');
      if (sep <= 0) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
      const sourceId = truth.canonicalKey.slice(0, sep);
      const formulaId = truth.canonicalKey.slice(sep + 2);
      const canonical = await getCanonicalFormula(sourceId, formulaId, context.runId);
      if (!canonical) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      // P0：composition / structured product facts binding validation（复用现有确定性 validator）。
      if (typeof truth.composition === 'string' && truth.composition.trim().length > 0) {
        const validation = await validateNormativeFormula({ sourceId, formulaId, composition: truth.composition });
        if (!validation.valid) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
      }
      const provider = context.capabilities.find((c) => c.provides?.includes('outcome:clinical-assessment'));
      return {
        ok: true,
        providerId: provider?.id ?? 'clinical-core',
        product: {
          name: canonical.name,
          composition: [canonical.composition],
          source_id: canonical.sourceId,
          formula_id: canonical.formulaId,
        },
        sourceRefs: [canonical.sourceId],
      };
    },
  };
}

/** 依据 proposal + workspace，把 REQUIRED delivery 意图提交进 Kernel Commit Ledger（fail-closed）。 */
async function commitDeliveries(
  context: RuntimeContext,
  proposal: AgentResult,
  registry: CandidateHandleRegistry,
): Promise<CommitRecord[]> {
  const coordinator = new CommitCoordinator(registry, context.commitLedger);
  const env = buildCommitEnvironment(context, proposal);
  const records: CommitRecord[] = [];
  if (proposal.mode !== 'clinical') return records;

  // 0) clinical assessment（baseline outcome）—— MODEL_DERIVED，闭世界核心完整性校验。
  const assessment = await coordinator.commit(
    { outcome: 'outcome:clinical-assessment', reasoningArtifactRef: 'clinical-assessment' },
    env,
  );
  if (assessment.ok) records.push(assessment.record);

  // 1) herbal formula delivery：Agent 只能引用候选；canonical identity + composition binding 由 Kernel 解析并水合。
  const candidateRef = proposal.formula?.candidate_ref;
  if (candidateRef) {
    const candidate = context.workspace.candidates.find(
      (c) => c.kind === 'formula' && c.id === candidateRef,
    );
    if (candidate?.sourceId && candidate?.formulaId) {
      const handle = registry.issue({
        kind: candidate.kind,
        canonicalKey: `${candidate.sourceId}::${candidate.formulaId}`,
        sourceId: candidate.sourceId,
        productId: candidate.formulaId,
        composition: candidate.composition?.join(''),
        provenanceKind: 'CANONICAL_SOURCE',
      });
      const result = await coordinator.commit(
        { outcome: 'outcome:clinical-assessment', candidateHandle: handle },
        env,
      );
      if (result.ok) records.push(result.record);
    }
  }

  // 2) treatment-form delivery：Agent 的 advisory 载荷经 manifest field 校验后才 commit。
  const deliveries = treatmentDeliveryArtifacts(context.workspace);
  for (let i = 0; i < deliveries.length; i++) {
    const delivery = deliveries[i];
    const outcome = typeof delivery.outcome === 'string' ? delivery.outcome : '';
    if (!outcome) continue;
    const result = await coordinator.commit(
      { outcome, reasoningArtifactRef: String(i) },
      env,
    );
    if (result.ok) records.push(result.record);
  }

  return records;
}

/**
 * 稳定的 Runtime 外壳：prepare → reason/propose → commit → authority → project。
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
    const proposal = await hydrateFormulaProposal(output.proposal, context);
    await finalizeSourceClosures(output.proposal, context);

    // canonical safety truth：模型 proposal.safety 不覆盖 canonical safety disposition。
    // 安全与 formula authority 正交；CAUTION 的 review 语义由 reviewRequired/reviewReasons + commit 的 executionClearance 承载。
    const withCanonicalSafety: AgentResult = proposal.mode === 'clinical'
      ? {
          ...proposal,
          safety: {
            status: context.safety.status === 'BLOCK' ? 'BLOCK' : 'PASS',
            reviewRequired: context.safety.reviewRequired,
            reviewReasons: context.safety.reviewReasons,
          },
        }
      : proposal;

    // Kernel Commit Boundary：唯一权威交付真相（fail-closed hydrate + manifest field 校验 + 正交 execution clearance）。
    const registry = new CandidateHandleRegistry();
    const commits = await commitDeliveries(context, withCanonicalSafety, registry);

    const authority = await this.authority.resolve(withCanonicalSafety, context);

    // H8 Forensic：只记录 identity chain 进 Trace，不改变任何行为。
    if (proposal.mode === 'clinical') {
      const ref = proposal.formula?.candidate_ref;
      let canonicalFormula: FormulaIdentityTrace['canonicalFormula'];
      if (ref) {
        const candidate = context.workspace.candidates.find((c) => c.kind === 'formula' && c.id === ref);
        if (candidate?.sourceId && candidate?.formulaId) {
          const c = await getCanonicalFormula(candidate.sourceId, candidate.formulaId);
          if (c) canonicalFormula = { sourceId: c.sourceId, formulaId: c.formulaId, name: c.name, composition: c.composition };
        }
      }
      const formulaDecision = authority.decisions.find((d) => d.stage === 'formula.authority');
      setFormulaIdentityTrace(context.runId, {
        candidateRef: ref,
        rawFormula: proposal.formula ? { name: proposal.formula.name, sourceId: proposal.formula.source_id, formulaId: proposal.formula.formula_id, composition: proposal.formula.composition } : undefined,
        hydratedFormula: proposal.formula ? { sourceId: proposal.formula.source_id, formulaId: proposal.formula.formula_id, name: proposal.formula.name, composition: proposal.formula.composition } : undefined,
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
      commits,
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
    // P0：coverage/DELIVERED/completion/readiness 的唯一真相来自 CommitLedger（+ graph terminal）。
    const coverage = ledgerOutcomeCoverage(state, context.commitLedger);
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
      contractResolved: ledgerContractResolved(state, context.commitLedger),
      contractSatisfied: ledgerContractSatisfied(state, context.commitLedger),
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
