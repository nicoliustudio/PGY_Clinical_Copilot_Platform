import type { RuntimeSnapshot } from './contracts/runtime.js';

export interface ToolCallTrace {
  toolName: string;
  input: unknown;
  output: unknown;
  ms: number;
}

export interface RunTrace {
  runId: string;
  input: string;
  startedAt: string;
  finishedAt?: string;
  totalMs?: number;
  toolCalls: ToolCallTrace[];
  finalResult?: unknown;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  // 运行快照（最小版 ClinicalRunSnapshot）：回答「本次 Run 用了什么」。
  modelProfileId?: string;
  promptHash?: string;
  capabilities?: string[];
  skills?: string[];
  knowledgeScopes?: string[];
}

let currentTrace: RunTrace | null = null;

export function newTrace(input: string): RunTrace {
  currentTrace = {
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    input,
    startedAt: new Date().toISOString(),
    toolCalls: [],
  };
  return currentTrace;
}

export function getTrace(): RunTrace | null {
  return currentTrace;
}

export function addToolCall(t: ToolCallTrace): void {
  currentTrace?.toolCalls.push(t);
}

export function finishTrace(args: {
  finalResult?: unknown;
  error?: string;
  usage?: RunTrace['usage'];
  snapshot?: RuntimeSnapshot;
}): RunTrace {
  if (!currentTrace) throw new Error('trace 未初始化');
  currentTrace.finishedAt = new Date().toISOString();
  currentTrace.totalMs = Date.now() - new Date(currentTrace.startedAt).getTime();
  currentTrace.finalResult = args.finalResult;
  currentTrace.error = args.error;
  currentTrace.usage = args.usage;
  if (args.snapshot) {
    currentTrace.modelProfileId = args.snapshot.modelProfileId;
    currentTrace.promptHash = args.snapshot.promptHash;
    currentTrace.capabilities = args.snapshot.capabilities;
    currentTrace.skills = args.snapshot.skills;
    currentTrace.knowledgeScopes = args.snapshot.knowledgeScopes;
  }
  return currentTrace;
}
