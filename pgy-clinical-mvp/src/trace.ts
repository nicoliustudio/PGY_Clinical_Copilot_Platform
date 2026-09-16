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
}): RunTrace {
  if (!currentTrace) throw new Error('trace 未初始化');
  currentTrace.finishedAt = new Date().toISOString();
  currentTrace.totalMs = Date.now() - new Date(currentTrace.startedAt).getTime();
  currentTrace.finalResult = args.finalResult;
  currentTrace.error = args.error;
  currentTrace.usage = args.usage;
  return currentTrace;
}
