import type { RuntimeRunResult } from '../../contracts/authority.js';
import type { PrimaryAgentPort, RuntimePreparationPort } from '../../contracts/ports.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { CandidateAssessment, CandidateComparison, ClinicalWorkspace, DeliberationCoverage, HypothesisCandidate, PromotionCoverage, WorkspaceEvent } from '../../contracts/workspace.js';
import type { AgentStreamEvent } from '../../contracts/stream.js';
import type { AgentLoopTrace } from '../../contracts/agent-loop.js';
import { AuthorityPipeline } from '../authority/pipeline.js';
import { EVIDENCE_EVENT_TYPES } from '../workspace/evidence-projection.js';
import { HYPOTHESIS_EVENT_TYPES } from '../workspace/hypothesis-projection.js';

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
 * LLM 只引用候选，不负责产出 formula_id/source_id/composition。
 */
function hydrateFormulaProposal(proposal: AgentResult, context: RuntimeContext): AgentResult {
  if (proposal.mode !== 'clinical') return proposal;
  const ref = proposal.formula.candidate_ref;
  if (!ref) return proposal;
  const candidate = context.workspace.candidates.find((c) => c.id === ref && c.kind === 'formula');
  if (!candidate?.formulaId || !candidate?.sourceId || !candidate?.composition) return proposal;
  return {
    ...proposal,
    formula: {
      ...proposal.formula,
      formula_id: candidate.formulaId,
      source_id: candidate.sourceId,
      composition: candidate.composition,
      name: candidate.name ?? proposal.formula.name,
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
    const proposal = hydrateFormulaProposal(output.proposal, context);
    const authority = await this.authority.resolve(proposal, context);
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
    };
  }
}
