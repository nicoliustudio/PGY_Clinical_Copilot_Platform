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

/**
 * H10 Execution Necessity —— 与 DecisionImpact 正交的确定性维度。
 * 由 Harness 根据 tool role / workspace state / cache / candidate / validation /
 * capability activation state 判定，不由模型填写。
 *
 * - required   当前业务动作完成所必需的确定性执行（即使 decisionImpact=none）。
 * - avoidable  不执行也不影响当前业务目标，且没有新增有效状态/证据。
 * - unknown    runtime 无法确定，保守保留。
 */
export type ExecutionNecessity = 'required' | 'avoidable' | 'unknown';

/** H10 每个 ExecutionRole 的 run-level 成本聚合。 */
export type ExecutionRoleCost = {
  toolCalls: number;
  nonDecisionChangingCalls: number;
  latencyMs: number;
  resultTokens: number;
};

/**
 * H9 工具执行角色分类：
 * - RETRIEVAL          检索类（knowledge.search / get_source / formula.search_normative）
 * - COGNITIVE_MUTATION 认知状态持久化（workspace.* deliberation/focus/assessment/exclusion）
 * - VALIDATION         校验类（formula.validate）
 * - COMMIT             终结提交（proposal.submit）
 * - CAPABILITY         能力发现/激活（capability.*）
 * - OTHER              其它
 */
export type ExecutionRole =
  | 'RETRIEVAL'
  | 'COGNITIVE_MUTATION'
  | 'VALIDATION'
  | 'COMMIT'
  | 'CAPABILITY'
  | 'OTHER';

/** 工具执行后的统一结构化 Receipt（Trace/Workspace 事实记录，非模型编造）。 */
export interface ActionReceipt {
  executionProtocolVersion: string;
  actionId: string;
  runId: string;
  toolName: string;
  status: ActionStatus;
  /** H9 执行角色分类（区分「未改变 DecisionState 但完成必要持久化」与真正 noop）。 */
  executionRole?: ExecutionRole;
  decisionRef?: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  stateDeltaRefs: string[];
  newEvidenceCount: number;
  reusedEvidenceCount: number;
  stateDeltaCount: number;
  decisionImpact: DecisionImpact;
  /** H10 执行必要性（Harness 确定性判定，非模型声明）。 */
  executionNecessity?: ExecutionNecessity;
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
  /** H15.2.9：最近一次 formula 检索的信息增量（事实反馈，非临床指令）。 */
  lastFormulaRetrieval?: FormulaRetrievalInfo;
}

/** H15.2.9：一次 formula 检索动作的信息增量事实（确定性推导）。 */
export interface FormulaRetrievalInfo {
  tool: string;
  newCandidateCount: number;
  newEvidenceCount: number;
  info: 'NEW_INFORMATION' | 'NO_NEW_INFORMATION';
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
  /** H9 Workspace Mutation Consolidation telemetry。 */
  cognitiveMutationCalls: number;
  effectiveMutationCalls: number;
  noopMutationCalls: number;
  workspaceEventsWritten: number;
  workspaceEventBatches: number;
  workspaceProjectionCount: number;
  decisionStateProjectionCount: number;
  deliberationCommitCount: number;
  /** H10 Action Surface Consolidation & Tool Economy telemetry。 */
  toolCallsByExecutionRole: Record<ExecutionRole, ExecutionRoleCost>;
  nonDecisionChangingCallsByExecutionRole: Record<ExecutionRole, number>;
  latencyMsByExecutionRole: Record<ExecutionRole, number>;
  resultTokensByExecutionRole: Record<ExecutionRole, number>;
  requiredNonDecisionChangingCalls: number;
  avoidableNonDecisionChangingCalls: number;
  capabilityActivationCount: number;
  capabilityReuseCount: number;
  duplicateCapabilityActivationCount: number;
  validationCallCount: number;
  validationReuseCount: number;
  duplicateValidationCount: number;
  projectionWithStateChange: number;
  projectionWithoutStateChange: number;
  projectionReuseCount: number;
  /** Diagnostic Pattern Set Spike telemetry（Debug/Eval，不进入 clinical decision；旧 run 可能缺失）。 */
  diagnosticPatternSetUsed?: boolean;
  diagnosticPatternSetFirstClinicalRetrieval?: boolean;
  returnedPatternRefs?: string[];
  formalHypothesisRefsAfterPatternSet?: string[];
  formulaSearchBeforeFormalHypothesis?: boolean;
  /** Disease Crosswalk Spike telemetry。 */
  diagnosticPatternQueryDisease?: string;
  resolvedDiseaseConcepts?: string[];
  diagnosticSyndromesReturned?: string[];
  /** Existing Standards Runtime telemetry。 */
  diseaseStandardUsed?: boolean;
  syndromeStandardUsed?: boolean;
  syndromeConceptsReturned?: string[];
  formalHypothesesAfterStandardEvidence?: string[];
  /** Diagnostic Release telemetry（区分 2024 标准 / GB/T ontology / ZY/T 3.1-2025 / T/GDACM 0117-2022）。 */
  diagnosticReleaseUsed?: boolean;
  diagnosticReleaseSourcesUsed?: string[];
  diseaseStandardSourceIds?: string[];
  diagnosticPatternSourceIds?: string[];
  /** H13 Pattern Assessment telemetry。 */
  patternAssessmentRecorded?: boolean;
  primaryPatternRef?: string;
  secondaryPatternRefs?: string[];
  sharedMechanismCount?: number;
  rootBranchRecorded?: boolean;
  currentDominantMechanismRecorded?: boolean;
  treatmentTargetRecorded?: boolean;
  patternAssessmentBeforeFormulaSearch?: boolean;
  /** H13 consistency：初次 leading hypothesis 与最终 primary 是否发生变化（仅记录，不纠正）。 */
  primaryPatternChangedAfterAssessment?: boolean;
  /** H14 Treatment Decision Causality telemetry（仅观察，不做临床裁决）。 */
  h14Enabled?: boolean;
  firstTreatmentRetrievalStep?: number;
  patternAssessmentBeforeFirstTreatmentRetrieval?: boolean;
  treatmentTargetBeforeFirstTreatmentRetrieval?: boolean;
  openQuestionPresentBeforeTreatmentRetrieval?: boolean;
  treatmentRetrievalCount?: number;
  specializedTreatmentRetrievalCount?: number;
  formulaRetrievalCount?: number;
  treatmentRetrievalBeforePatternAssessmentCount?: number;
  treatmentRetrievalBeforeTreatmentTargetCount?: number;
  hypothesisTransitionsAfterTreatmentRetrieval?: number;
  /** H15 Clinical Decision Spine telemetry（只观察，不做临床裁决）。 */
  diseaseAssessmentBeforeTreatmentRetrieval?: boolean;
  formalHypothesisBeforeTreatmentRetrieval?: boolean;
  treatmentPlanBeforeTreatmentRetrieval?: boolean;
  formulaRetrievalRejectedForMissingContext?: number;
  formulaReviewRecorded?: boolean;
  modificationItemsWithPatientEvidence?: number;
  /** H15.1 Completion Obligation & Formula Decision Quality telemetry（只观察，不做临床裁决）。 */
  clinicalCompletionObligationCreated?: boolean;
  completionRequestedOutcome?: string;
  completionRequiredArtifacts?: string[];
  completionMissingArtifactsAtEnd?: string[];
  falseCompletionAttemptCount?: number;
  formulaCandidateRetrievalCount?: number;
  formulaEvidenceRetrievalCount?: number;
  formulaSelectionFromEvidence?: boolean;
  selectedCandidateRef?: string;
  retrievalSuggestedHypothesisCount?: number;
  /** H15.2.3 no-progress correction telemetry（仅观测，不设 hard gate）。 */
  repeatedNoProgressCorrectionCount?: number;
  repeatedUnresolvedHypothesisCorrectionCount?: number;
  repeatedTreatmentContextCorrectionCount?: number;
}

/** H14：每次治疗知识检索的观测快照（不含 hidden CoT）。 */
export interface H14TreatmentRetrieval {
  tool: string;
  step: number;
  activeCapability: string;
  activeScope: string;
  patternAssessmentPresent: boolean;
  treatmentTargetPresent: boolean;
  openQuestionsSnapshot: string[];
  cardsReturned: number;
  assetIdsFetched: number;
  workspaceStateVersion: number;
}
