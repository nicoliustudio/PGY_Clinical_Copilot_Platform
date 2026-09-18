/**
 * H5 Agent Execution Protocol —— 统一工具执行元数据。
 *
 * 关键分离：
 * - actionId 由 runtime 生成，不由模型生成。
 * - Receipt 区分「execution success」与「decision impact」。
 * - 协议升级采用 additive migration，不破坏现有 tool 名与 DeepSeek schema。
 */

export const executionProtocolVersion = 'action-receipt-v1';

export type ExpectedImpact =
  | 'disease'
  | 'syndrome'
  | 'treatment'
  | 'formula'
  | 'evidence'
  | 'safety'
  | 'validation';

/** 工具执行的统一意图元数据（additive，非全必填）。 */
export interface ActionIntent {
  actionId: string;
  runId: string;
  decisionRef?: string;
  purpose?: string;
  expectedImpact?: ExpectedImpact;
  hypothesisRefs?: string[];
  candidateRefs?: string[];
  parallelGroupId?: string;
}

export type ActionStatus = 'success' | 'cached' | 'deduplicated' | 'error';

export type DecisionImpact = 'changed' | 'reinforced' | 'none' | 'unresolved';

/** 工具执行后的统一结构化 Receipt（Trace/Workspace 事实记录，非模型编造）。 */
export interface ActionReceipt {
  executionProtocolVersion: string;
  actionId: string;
  runId: string;
  toolName: string;
  status: ActionStatus;
  decisionRef?: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  stateDeltaRefs: string[];
  newEvidenceCount: number;
  reusedEvidenceCount: number;
  stateDeltaCount: number;
  decisionImpact: DecisionImpact;
  duplicateOf?: string;
  latencyMs: number;
  resultPayloadSize?: number;
  resultTokenEstimate?: number;
  errorCode?: string;
  parallelGroupId?: string;
}

/**
 * H8 Retrieval Discipline 观测指标：减少「不推进决策」的检索。
 * 均为 telemetry，不是 clinical score，不参与任何阈值门控。
 */
export interface RetrievalDisciplineMetrics {
  retrievalsBeforeFirstViableCandidate: number;
  retrievalsAfterFirstViableCandidate: number;
  nonDecisionChangingRetrievalsBeforeViable: number;
  nonDecisionChangingRetrievalsAfterViable: number;
  getSourceReuseCount: number;
  formulaSearchReuseCount: number;
  evidenceReuseCount: number;
  firstViableCandidateRef?: string;
  firstViableCandidateStep?: number;
  firstViableCandidateAt?: string;
  stepsFromFirstViableCandidateToSubmit?: number;
  timeFromFirstViableCandidateToSubmitMs?: number;
}

/** WorkingView 中注入的极简检索反馈（不包含完整 history）。 */
export interface RecentRetrievalFeedback {
  lastImpact?: DecisionImpact;
  recentNonDecisionChangingRetrievals: number;
  recentEvidenceReuseCount: number;
  firstViableCandidateRef?: string;
}

/** Run 级执行可观测指标。 */
export interface RunExecutionMetrics extends RetrievalDisciplineMetrics {
  totalToolCalls: number;
  decisionChangingToolCalls: number;
  reinforcingToolCalls: number;
  nonDecisionChangingToolCalls: number;
  unresolvedToolCalls: number;
  redundantSearchCount: number;
  deduplicatedCallCount: number;
  cacheHitCount: number;
  parallelGroupCount: number;
  parallelToolCallCount: number;
  knowledgeSearchCount: number;
  getSourceCount: number;
  formulaSearchCount: number;
  formulaValidationCalls: number;
  toolLatencyMsTotal: number;
  resultTokensProduced: number;
  /**
   * H8 formula candidate funnel（unique，不是调用次数）。
   * 同一 candidate 被多次 validate/hydrate 时不重复计数；调用次数见
   * formulaHydrationCalls / formulaValidationCalls。
   */
  uniqueCandidatesDiscovered: number;
  uniqueCandidatesPromoted: number;
  uniqueCandidatesHydrated: number;
  uniqueCandidatesValidated: number;
  formulaHydrationCalls: number;
  formulaHydrationCacheHitCount: number;
  formulaCandidateVisibleTokens: number;
  formulaHydratedVisibleTokens: number;
}
