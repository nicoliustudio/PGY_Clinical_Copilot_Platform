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
