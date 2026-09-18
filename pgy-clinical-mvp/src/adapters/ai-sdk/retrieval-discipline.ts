import type {
  DecisionImpact,
  RecentRetrievalFeedback,
  RetrievalDisciplineMetrics,
} from '../../contracts/execution.js';
import type { ClinicalWorkspace } from '../../contracts/workspace.js';

/**
 * H8 Retrieval Discipline —— 纯观测与去重判定，不做硬门控。
 *
 * 只负责：
 * - 识别「检索类」工具调用（knowledge.search / knowledge.get_source / formula.search_normative）。
 * - 记录 First Viable Candidate（canonical formula candidate，含稳定身份 + 来源 provenance）。
 * - 统计 before/after viable 的检索与 non-decision-changing 检索。
 * - 复用判定（get_source / formula.search / evidence 复用）。
 * - Decision-to-Submit 收敛观测。
 *
 * 不限制搜索空间、不设 confidence threshold、不强制 submit。
 */

export const RETRIEVAL_TOOL_NAMES = [
  'knowledge.search',
  'knowledge.get_source',
  'formula.search_normative',
] as const;
export type RetrievalToolName = (typeof RETRIEVAL_TOOL_NAMES)[number];

export function isRetrievalTool(toolName: string): toolName is RetrievalToolName {
  return (RETRIEVAL_TOOL_NAMES as readonly string[]).includes(toolName);
}

/** A formula candidate is "viable" when it carries a stable canonical identity (sourceId + formulaId). */
export function isViableFormulaCandidate(candidate: {
  kind?: string;
  formulaId?: string;
  sourceId?: string;
}): boolean {
  return candidate.kind === 'formula' && !!candidate.formulaId && !!candidate.sourceId;
}

export function findFirstViableCandidateRef(workspace: ClinicalWorkspace): string | undefined {
  return workspace.candidates.find(isViableFormulaCandidate)?.id;
}

function stringField(item: unknown, key: string): string | undefined {
  if (item && typeof item === 'object') {
    const v = (item as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function candidateRefsFromFormulaSearch(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  return output
    .map((c) => stringField(c, 'candidateRef') ?? stringField(c, 'candidateId'))
    .filter((x): x is string => !!x);
}

function sourceIdsFromSearch(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  return output.map((h) => stringField(h, 'sourceId')).filter((x): x is string => !!x);
}

/** formula.search_normative 复用：返回的所有 candidateRef 都已存在于 workspace。 */
export function isFormulaSearchReuse(
  output: unknown,
  candidateIdsBefore: ReadonlySet<string>,
): boolean {
  const refs = candidateRefsFromFormulaSearch(output);
  return refs.length > 0 && refs.every((r) => candidateIdsBefore.has(r));
}

/** knowledge.search 复用：返回的所有 sourceId 都已作为 evidence 存在。 */
export function isEvidenceReuse(
  output: unknown,
  evidenceIdsBefore: ReadonlySet<string>,
): boolean {
  const ids = sourceIdsFromSearch(output);
  return ids.length > 0 && ids.every((id) => evidenceIdsBefore.has(id));
}

export interface RecordToolExecutionInput {
  toolName: string;
  reused: boolean;
  decisionImpact: DecisionImpact;
  rawOutput: unknown;
  candidateIdsBefore: ReadonlySet<string>;
  evidenceIdsBefore: ReadonlySet<string>;
}

const RECENT_WINDOW = 6;

export class RetrievalDisciplineTracker {
  private firstViableCandidateRef?: string;
  private firstViableCandidateStep?: number;
  private firstViableCandidateAt?: string;
  private firstViableCandidateAtMs?: number;
  private submitStep?: number;
  private submitAtMs?: number;

  private retrievalsBefore = 0;
  private retrievalsAfter = 0;
  private nonDecisionChangingBefore = 0;
  private nonDecisionChangingAfter = 0;
  private getSourceReuseCount = 0;
  private formulaSearchReuseCount = 0;
  private evidenceReuseCount = 0;

  private recentWindow: { impact: DecisionImpact; reused: boolean }[] = [];

  /** 在 workspace 首次出现 viable candidate 时记录（幂等）。 */
  recordViableCandidateIfAbsent(workspace: ClinicalWorkspace, step: number, nowMs: number): void {
    if (this.firstViableCandidateRef !== undefined) return;
    const ref = findFirstViableCandidateRef(workspace);
    if (ref === undefined) return;
    this.firstViableCandidateRef = ref;
    this.firstViableCandidateStep = step;
    this.firstViableCandidateAt = new Date(nowMs).toISOString();
    this.firstViableCandidateAtMs = nowMs;
  }

  recordToolExecution(input: RecordToolExecutionInput): void {
    const { toolName, reused, decisionImpact, rawOutput, candidateIdsBefore, evidenceIdsBefore } = input;

    if (isRetrievalTool(toolName)) {
      const before = this.firstViableCandidateRef === undefined;
      if (before) this.retrievalsBefore += 1;
      else this.retrievalsAfter += 1;
      if (decisionImpact === 'none') {
        if (before) this.nonDecisionChangingBefore += 1;
        else this.nonDecisionChangingAfter += 1;
      }
    }

    let retrievalReused = false;
    if (toolName === 'knowledge.get_source' && reused) {
      this.getSourceReuseCount += 1;
      retrievalReused = true;
    }
    if (toolName === 'formula.search_normative' && (reused || isFormulaSearchReuse(rawOutput, candidateIdsBefore))) {
      this.formulaSearchReuseCount += 1;
      retrievalReused = true;
    }
    if (toolName === 'knowledge.search' && isEvidenceReuse(rawOutput, evidenceIdsBefore)) {
      this.evidenceReuseCount += 1;
      retrievalReused = true;
    }

    if (isRetrievalTool(toolName)) {
      this.recentWindow.push({ impact: decisionImpact, reused: retrievalReused });
      if (this.recentWindow.length > RECENT_WINDOW) this.recentWindow.shift();
    }
  }

  recordSubmit(step: number, nowMs: number): void {
    if (this.submitStep === undefined) {
      this.submitStep = step;
      this.submitAtMs = nowMs;
    }
  }

  feedback(): RecentRetrievalFeedback {
    const recent = this.recentWindow;
    const lastImpact = recent.length > 0 ? recent[recent.length - 1].impact : undefined;
    const feedback: RecentRetrievalFeedback = {
      lastImpact,
      recentNonDecisionChangingRetrievals: recent.filter((r) => r.impact === 'none').length,
      recentEvidenceReuseCount: recent.filter((r) => r.reused).length,
    };
    if (this.firstViableCandidateRef !== undefined) {
      feedback.firstViableCandidateRef = this.firstViableCandidateRef;
    }
    return feedback;
  }

  metrics(): RetrievalDisciplineMetrics {
    const m: RetrievalDisciplineMetrics = {
      retrievalsBeforeFirstViableCandidate: this.retrievalsBefore,
      retrievalsAfterFirstViableCandidate: this.retrievalsAfter,
      nonDecisionChangingRetrievalsBeforeViable: this.nonDecisionChangingBefore,
      nonDecisionChangingRetrievalsAfterViable: this.nonDecisionChangingAfter,
      getSourceReuseCount: this.getSourceReuseCount,
      formulaSearchReuseCount: this.formulaSearchReuseCount,
      evidenceReuseCount: this.evidenceReuseCount,
    };
    if (this.firstViableCandidateRef !== undefined) {
      m.firstViableCandidateRef = this.firstViableCandidateRef;
      m.firstViableCandidateStep = this.firstViableCandidateStep;
      m.firstViableCandidateAt = this.firstViableCandidateAt;
    }
    if (this.firstViableCandidateStep !== undefined && this.submitStep !== undefined) {
      m.stepsFromFirstViableCandidateToSubmit = Math.max(0, this.submitStep - this.firstViableCandidateStep);
    }
    if (this.firstViableCandidateAtMs !== undefined && this.submitAtMs !== undefined) {
      m.timeFromFirstViableCandidateToSubmitMs = Math.max(0, this.submitAtMs - this.firstViableCandidateAtMs);
    }
    return m;
  }
}
