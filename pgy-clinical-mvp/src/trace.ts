import type { RuntimeSnapshot } from './contracts/runtime.js';

export interface ToolCallTrace { toolName: string; input: unknown; output: unknown; ms: number; }
export interface RunTrace {
  runId: string; input: string; startedAt: string; finishedAt?: string; totalMs?: number;
  toolCalls: ToolCallTrace[]; finalResult?: unknown; error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  modelProfileId?: string; promptHash?: string; capabilities?: string[]; skills?: string[]; knowledgeScopes?: string[];
}

const traces = new Map<string, RunTrace>();

export function newTrace(input: string): RunTrace {
  const trace: RunTrace = {
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    input,
    startedAt: new Date().toISOString(),
    toolCalls: [],
  };
  traces.set(trace.runId, trace);
  return trace;
}

export function getTrace(runId: string): RunTrace | null { return traces.get(runId) ?? null; }
export function addToolCall(runId: string, t: ToolCallTrace): void { traces.get(runId)?.toolCalls.push(t); }

export function finishTrace(runId: string, args: {
  finalResult?: unknown; error?: string; usage?: RunTrace['usage']; snapshot?: RuntimeSnapshot;
}): RunTrace {
  const trace = traces.get(runId);
  if (!trace) throw new Error(`trace 未初始化: ${runId}`);
  trace.finishedAt = new Date().toISOString();
  trace.totalMs = Date.now() - new Date(trace.startedAt).getTime();
  trace.finalResult = args.finalResult; trace.error = args.error; trace.usage = args.usage;
  if (args.snapshot) {
    trace.modelProfileId = args.snapshot.modelProfileId; trace.promptHash = args.snapshot.promptHash;
    trace.capabilities = args.snapshot.capabilities; trace.skills = args.snapshot.skills;
    trace.knowledgeScopes = args.snapshot.knowledgeScopes;
  }
  return trace;
}
