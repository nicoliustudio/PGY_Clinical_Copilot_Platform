import type { ToolCallLedgerEntry } from '../../contracts/agent-loop.js';

/**
 * Harness 级 ToolCallLedger —— 精确 deterministic 去重。
 *
 * 只负责「完全相同的 tool + 完全相同的规范化输入」的复用，是 closed-world execution dedupe，
 * 不是临床判断。语义相似但文字不同的 search 不在此处处理（那由 Agent 依据 Search History 自行判断）。
 */

/** 键排序的确定性序列化，避免对象 key 顺序导致相同输入被判为不同。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export class ToolCallLedger {
  private readonly results = new Map<string, { output: unknown; entry: ToolCallLedgerEntry }>();
  private readonly calls = new Map<string, number>();

  private static key(toolName: string, input: unknown): string {
    return `${toolName}\u0000${stableStringify(input)}`;
  }

  /** 每次执行前调用；返回本次是该 key 的第几次调用（>1 即复用）。 */
  private bump(toolName: string, input: unknown): number {
    const key = ToolCallLedger.key(toolName, input);
    const n = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, n);
    return n;
  }

  /** 尝试复用结果。返回 undefined 表示首次执行，应真实执行。 */
  reuse(toolName: string, input: unknown): { output: unknown } | undefined {
    this.bump(toolName, input);
    return this.results.get(ToolCallLedger.key(toolName, input));
  }

  /** 记录一次真实执行的确定性结果。 */
  record(toolName: string, input: unknown, output: unknown): void {
    const key = ToolCallLedger.key(toolName, input);
    if (this.results.has(key)) return;
    const entry: ToolCallLedgerEntry = {
      toolName,
      normalizedInput: stableStringify(input),
      resultIdentity: stableStringify(output),
      reused: false,
      timestamp: new Date().toISOString(),
    };
    this.results.set(key, { output, entry });
  }

  /** 当前调用是否属于复用（同一 key 已执行过）。 */
  isReused(toolName: string, input: unknown): boolean {
    return (this.calls.get(ToolCallLedger.key(toolName, input)) ?? 0) > 1;
  }

  entries(): ToolCallLedgerEntry[] {
    return [...this.results.values()].map((v) => v.entry);
  }
}
