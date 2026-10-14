/**
 * LLM 性能观测探针（pure observation，不参与任何执行路径）。
 *
 * 用途：perf 实测脚本离线读取逐次 LLM 请求的耗时 / usage / 缓存命中。
 * 约束：
 * - 不写入 trace / DB，不影响 Agent 行为；
 * - 默认关闭（LLM_PROBE=1 才记录），生产进程零开销、零内存累积；
 * - 硬上限防意外增长；
 * - 所有挂点回调必须 try-catch 包裹，观测失败不得中断 run；
 * - 本模块禁止 import 'ai' / '@ai-sdk/*'（core 分层守卫），类型用结构化声明。
 */
export interface LlmProbeStepRecord {
  kind: 'step';
  seq: number;
  ts: number;
  /** 步总时长（LLM 响应等待 + 工具执行）。 */
  stepTimeMs: number;
  /** 纯 LLM 响应等待（不含工具执行）。 */
  responseTimeMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  toolExecutionMs: Record<string, number>;
  finishReason: string;
}

export interface LlmProbeControlRecord {
  kind: 'control';
  seq: number;
  ts: number;
  /** 控制面单次 generateText 墙钟。 */
  responseTimeMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  /** 纯观测：结构化调用身份与尝试序号（1=首次，2=格式修复重试）。 */
  operation?: string;
  attempt?: number;
}

export interface LlmProbeParseErrorRecord {
  kind: 'parse_error';
  seq: number;
  ts: number;
  operation: string | undefined;
  attempt: number;
  /** JSON 解析 / zod 校验错误摘要（截断）。 */
  error: string;
  /** 原始输出长度与开头片段，用于离线归因（截断）。 */
  outputLen: number;
  outputHead: string;
}

export type LlmProbeRecord = LlmProbeStepRecord | LlmProbeControlRecord | LlmProbeParseErrorRecord;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const MAX_RECORDS = 5000;

const records: LlmProbeRecord[] = [];
let seq = 0;

export function pushLlmProbeRecord(record: DistributiveOmit<LlmProbeRecord, 'seq'>): void {
  if (process.env.LLM_PROBE !== '1') return;
  if (records.length >= MAX_RECORDS) return;
  records.push({ seq: ++seq, ...record } as LlmProbeRecord);
}

export function takeLlmProbeRecords(): readonly LlmProbeRecord[] {
  return [...records];
}

export function resetLlmProbe(): void {
  records.length = 0;
  seq = 0;
}
