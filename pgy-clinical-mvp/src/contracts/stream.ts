import type { WorkspaceEvent } from './workspace.js';

/**
 * Agent loop 对外暴露的「可观测事件」。
 * 只包含 tool call 与 workspace 状态变化，绝不包含模型中间文本（hidden CoT）。
 * 这些事件由 Runtime 在 reasoning loop 内实时发射，供 UI/SSE 消费。
 */
export interface AgentToolCallEvent {
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  ms: number;
  /** 是否命中 ToolCallLedger 的精确 deterministic 去重（复用结果，未真实执行）。 */
  reused?: boolean;
}

/** 收敛生命周期阶段（observable lifecycle，非 hidden CoT）。 */
export type LifecycleStage = 'exploring' | 'reviewing' | 'finalizing' | 'completed' | 'no-commit';

export type AgentStreamEvent =
  | { type: 'tool-call'; toolCall: AgentToolCallEvent }
  | { type: 'workspace'; events: WorkspaceEvent[] }
  | { type: 'lifecycle'; stage: LifecycleStage };
