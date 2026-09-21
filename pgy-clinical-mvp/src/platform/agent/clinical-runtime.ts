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
import { setFormulaIdentityTrace, type FormulaIdentityTrace } from '../../trace.js';

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
}

/** 依据 proposal 的 candidate_ref 记录候选比较结果：选中 vs 放弃。 */
function recordCandidateDecision(proposal: AgentResult, context: RuntimeContext): void {
  if (proposal.mode !== 'clinical') return;
  const ref = proposal.formula.candidate_ref;
  if (!ref) return;
  for (const candidate of context.workspace.candidates) {
    if (candidate.kind !== 'formula') continue;
    if (candidate.id === ref) {
      context.workspaceStore.append('candidate.selected', { id: candidate.id });
    } else {
      context.workspaceStore.append('candidate.rejected', { id: candidate.id });
    }
  }
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
    return {
      authority,
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
    };
  }
}
