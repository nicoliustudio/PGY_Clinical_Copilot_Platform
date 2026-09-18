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
 * - provider_error：结构化产出失败（schema 不匹配等）
 */
export type TerminationReason =
  | 'agent_submitted'
  | 'resource_limit_fallback'
  | 'timeout_fallback'
  | 'agent_stopped_without_submit'
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
