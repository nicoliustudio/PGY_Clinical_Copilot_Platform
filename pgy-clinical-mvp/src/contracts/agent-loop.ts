/**
 * Harness 级收敛/终结的可观测状态（平台状态，不是临床枚举）。
 * 这些字段回答「本次 reasoning loop 如何结束」，与病/证/方无关。
 */

/** 精确相同、deterministic 的 tool call 去重记录。 */
export interface ToolCallLedgerEntry {
  toolName: string;
  /** 规范化（键排序）后的输入序列化，用于 exact dedupe 身份。 */
  normalizedInput: string;
  /** 结果的身份摘要（键排序序列化）。 */
  resultIdentity: string;
  reused: boolean;
  timestamp: string;
}

/**
 * terminationReason 是平台状态，不是临床枚举：
 * - agent_submitted：Agent 主动调用 proposal.submit 终结
 * - resource_limit_fallback：step 预算耗尽，进入 Forced Finalization
 * - timeout_fallback：总超时临界，进入 Forced Finalization
 * - agent_stopped_without_submit：自然 stop 但未调用 proposal.submit，进入 Forced Finalization
 * - runtime_committed_ready_state：durable clinical state 已 ready，由 Runtime 确定性序列化并提交
 * - provider_error：结构化产出失败（schema 不匹配等）
 */
export type TerminationReason =
  | 'agent_submitted'
  | 'resource_limit_fallback'
  | 'timeout_fallback'
  | 'agent_stopped_without_submit'
  | 'execution_incomplete'
  | 'no_progress'
  | 'runtime_committed_ready_state'
  | 'provider_error';

export interface AgentLoopTrace {
  stepCount: number;
  finishReason?: string;
  terminationReason: TerminationReason;
  proposalSubmitted: boolean;
  forcedFinalization: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  finalStepHadToolCalls: boolean;
  toolCallLedger: ToolCallLedgerEntry[];
  /** 每一步 prompt 构成估算（仅观测，无硬阈值）。 */
  promptComponents?: PromptComponents;
  /** H11 Proposal Commit Reliability（区分主动 submit 与 runtime forced finalization）。 */
  commitReliability?: CommitReliabilityMetrics;
  /** Control Plane V2.1 运行期遥测（Request IR / obligation graph / shadow 分歧 / typed blocker）。 */
  controlPlane?: ControlPlaneTraceV21;
}

/**
 * Control Plane V2.1 遥测。
 * 只描述「控制语义」的平台状态，不含病/证/方，也不含 hidden CoT。
 */
export interface ControlPlaneTraceV21 {
  /** COMPILED：Request IR 建立成功，V2.1 拥有调度主权；FAILED：仅观测。 */
  requestCompileStatus: 'COMPILED' | 'FAILED';
  requestCompileError?: string;
  /** Immutable user-compiled required outcomes. */
  requiredOutcomes: string[];
  /** Kernel-owned contract expansions accepted through delivery.adopt. */
  adoptedOutcomes?: string[];
  /** Baseline + immutable request + adopted outcomes used by the live graph. */
  effectiveRequiredOutcomes?: string[];
  preferredOutcomes: string[];
  /** V2.1.3：允许但不要求（“可以考虑”）；永不创建 obligation。 */
  allowedOutcomes: string[];
  excludedOutcomes: string[];
  /** V2.1.1：用户显式点名但 registry 无 provider 的治疗形式（必须 fail-closed，不得吸附到相近 modality）。 */
  unresolvedOutcomes: string[];
  /** V2.1.3：PREFERRED 且不可表示 → 非阻断 shortfall（显式报告，不阻断主任务）。 */
  preferredShortfalls: string[];
  /** V2.1.2/V2.1.3：用户点名的治疗形式 + 承诺等级（Deterministic Semantic Validator 的输入）。 */
  mentionOutcomes: { name: string; commitment: string }[];
  /** V2.1.2：Deterministic Semantic Validator 的 mention → relation 解析（审计用）。 */
  semanticValidation?: {
    resolutions: { mention: string; relation: string; term?: string }[];
    rejected: { term: string; mention: string; relation: string }[];
    preferredShortfalls: string[];
  };
  exclusive: boolean;
  formulaCardinality: string;
  knowledgeSourcePolicy: string;
  /** 结构性 planning issues（unsupported / ambiguous / cycle）。 */
  planningIssues: { type: string; message: string }[];
  requiredObligationCount: number;
  satisfiedObligationCount: number;
  openObligations: string[];
  blockedObligations: string[];
  notDeliverableObligations: string[];
  graphComplete: boolean;
  /** 未被满足的 required obligation（readiness 的同一缺失集）。 */
  unmetObligations: string[];
  /** 义务明细（provider/rule 身份 + 依赖 + root outcomes），供 Phase 3 逐步 trace。 */
  obligations: {
    id: string;
    type: string;
    outcome?: string;
    provider?: string;
    source: string;
    status: string;
    required: boolean;
    rootOutcomes: string[];
    dependsOn: string[];
    blocker?: string;
  }[];
  /** outcome 级覆盖投影（确定性；最终结果装配输入）。 */
  outcomeCoverage: { outcome: string; status: string }[];
  /** Typed blocker（runtime-owned）；唯一允许重新打开定向检索的通道。 */
  appliedBlockers: { obligationId: string; type: string; question: string }[];
  /** 每一步的 runnable obligation 与当时的 legal effect surface（用于核对「无状态推进」）。 */
  steps: {
    step: number;
    runnable: string[];
    surface: string[];
  }[];
  /** 运行结束时的 readiness（与 runtime 同一真源）。 */
  readiness: {
    ready: boolean;
    blockerCodes: string[];
    missingArtifacts: string[];
  };
}

/**
 * H11 Proposal Commit Reliability —— 提交可靠性的明确、逐路径统计。
 * 不再用模糊的 proposalSubmitted 汇总；主动 submit 与 forced finalization 分开计数。
 */
export interface CommitReliabilityMetrics {
  agentProposalSubmitCount: number;
  agentProposalSubmitSuccessCount: number;
  runtimeForcedFinalizationCount: number;
  runtimeForcedFinalizationSuccessCount: number;
  /** durable state ready 后的 deterministic commit；不是 forced finalization，也不调用 LLM。 */
  runtimeReadyStateCommitCount: number;
  runtimeReadyStateCommitSuccessCount: number;
  finalProposalCommittedCount: number;
  proposalParseFailureCount: number;
  proposalSchemaFailureCount: number;
  proposalRetryCount: number;
  proposalRetrySuccessCount: number;
  finalizationInputTokens: number;
  finalizationOutputTokens: number;
  finalizationContextItemCount: number;
  proposalDraftFieldCount: number;
  timeFromFinalDecisionToCommitMs?: number;
  proposalSerializationLatencyMs?: number;
}

/** H4 Prompt Telemetry：估算各部分 token，仅观测不设阈值。 */
export interface PromptComponents {
  basePromptTokens: number;
  strategyTokens: number;
  decisionStateTokens: number;
  workingViewTokens: number;
  skillTokens: number;
  toolSchemaTokens: number;
  recentMessageTokens: number;
  totalPromptTokens: number;
  /** H6 渐进式 tool 披露观测。 */
  activeToolCount?: number;
  availableCapabilityCount?: number;
}

/**
 * H3 Context 压缩指标（估算值，非精确 tokenizer）。
 * 用于度量「目标驱动工作上下文」相对「全量投影」的收缩程度。
 */
export interface ContextMetrics {
  workingViewTokenEstimate: number;
  rawContextTokenEstimate: number;
  /** raw / working：值越大表示压缩越显著。 */
  compressionRatio: number;
}
