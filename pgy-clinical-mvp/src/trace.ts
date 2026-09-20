import type { RuntimeSnapshot, SkillVersion } from './contracts/runtime.js';
import type { CandidateAssessment, CandidateComparison, DeliberationCoverage, HypothesisCandidate, PromotionCoverage, WorkspaceEvent } from './contracts/workspace.js';
import type { RetrievalDiagnostics } from './knowledge/diagnostics.js';
import type { AgentLoopTrace, ContextMetrics } from './contracts/agent-loop.js';
import type { ClinicalStrategy } from './contracts/clinical-strategy.js';
import type { ActionReceipt, RunExecutionMetrics, H14TreatmentRetrieval } from './contracts/execution.js';

export interface ToolCallTrace { toolName: string; input: unknown; output: unknown; error?: unknown; ms: number; reused?: boolean; }

/**
 * H8 Forensic：formula identity chain 诊断（debug-only，只进 Trace，不进 Agent prompt）。
 * 用于定位 candidate → hydrate → validate → proposal → Authority 的身份连续性。
 */
export interface FormulaIdentityTrace {
  candidateRef?: string;
  rawFormula?: { name?: string; sourceId: string; formulaId: string; composition?: string[] };
  hydratedFormula?: { sourceId: string; formulaId: string; name?: string; composition?: string[] };
  canonicalFormula?: { sourceId: string; formulaId: string; name: string; composition: string };
  authorityBlockCode?: string;
  authorityReasons?: string[];
}

export interface RunTrace {
  runId: string; input: string; startedAt: string; finishedAt?: string; totalMs?: number;
  toolCalls: ToolCallTrace[]; finalResult?: unknown; error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  workspaceEvents: WorkspaceEvent[];
  evidenceEvents: WorkspaceEvent[];
  candidateComparison: CandidateComparison[];
  hypothesisEvents: WorkspaceEvent[];
  hypothesisComparison: HypothesisCandidate[];
  promotionCoverage: PromotionCoverage[];
  candidateAssessments: CandidateAssessment[];
  deliberationCoverage: DeliberationCoverage[];
  retrievalDiagnostics: RetrievalDiagnostics[];
  actionReceipts: ActionReceipt[];
  runMetrics?: RunExecutionMetrics;
  formulaIdentityTrace?: FormulaIdentityTrace;
  h14TreatmentRetrievals?: H14TreatmentRetrieval[];
  activeSkills?: string[];
  skillVersions?: SkillVersion[];
  skillPromptSections?: string[];
  modelProfileId?: string; promptHash?: string; capabilities?: string[]; skills?: string[]; knowledgeScopes?: string[];
  agentLoop?: AgentLoopTrace;
  clinicalStrategy?: ClinicalStrategy;
  contextMetrics?: ContextMetrics;
}

const traces = new Map<string, RunTrace>();

export function newTrace(input: string): RunTrace {
  const trace: RunTrace = {
    runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    input,
    startedAt: new Date().toISOString(),
    toolCalls: [],
    workspaceEvents: [],
    evidenceEvents: [],
    candidateComparison: [],
    hypothesisEvents: [],
    hypothesisComparison: [],
    promotionCoverage: [],
    candidateAssessments: [],
    deliberationCoverage: [],
    retrievalDiagnostics: [],
    actionReceipts: [],
  };
  traces.set(trace.runId, trace);
  return trace;
}

export function getTrace(runId: string): RunTrace | null { return traces.get(runId) ?? null; }
export function addToolCall(runId: string, t: ToolCallTrace): void { traces.get(runId)?.toolCalls.push(t); }
export function addRetrievalDiagnostics(runId: string, d: RetrievalDiagnostics): void { traces.get(runId)?.retrievalDiagnostics.push(d); }
export function addH14TreatmentRetrieval(runId: string, r: H14TreatmentRetrieval): void { const t = traces.get(runId); if (t) (t.h14TreatmentRetrievals ??= []).push(r); }
export function addActionReceipt(runId: string, r: ActionReceipt): void { traces.get(runId)?.actionReceipts.push(r); }
export function setRunMetrics(runId: string, m: RunExecutionMetrics): void { const t = traces.get(runId); if (t) t.runMetrics = m; }
export function setFormulaIdentityTrace(runId: string, ft: FormulaIdentityTrace): void { const t = traces.get(runId); if (t) t.formulaIdentityTrace = ft; }

export function finishTrace(runId: string, args: {
  finalResult?: unknown; error?: string; usage?: RunTrace['usage']; snapshot?: RuntimeSnapshot;
  workspaceEvents?: WorkspaceEvent[]; evidenceEvents?: WorkspaceEvent[]; candidateComparison?: CandidateComparison[];
  hypothesisEvents?: WorkspaceEvent[]; hypothesisComparison?: HypothesisCandidate[]; promotionCoverage?: PromotionCoverage[];
  candidateAssessments?: CandidateAssessment[];
  deliberationCoverage?: DeliberationCoverage[];
  agentLoop?: AgentLoopTrace;
  clinicalStrategy?: ClinicalStrategy;
  contextMetrics?: ContextMetrics;
}): RunTrace {
  const trace = traces.get(runId);
  if (!trace) throw new Error(`trace 未初始化: ${runId}`);
  trace.finishedAt = new Date().toISOString();
  trace.totalMs = Date.now() - new Date(trace.startedAt).getTime();
  trace.finalResult = args.finalResult; trace.error = args.error; trace.usage = args.usage;
  if (args.workspaceEvents) trace.workspaceEvents = args.workspaceEvents;
  if (args.evidenceEvents) trace.evidenceEvents = args.evidenceEvents;
  if (args.candidateComparison) trace.candidateComparison = args.candidateComparison;
  if (args.hypothesisEvents) trace.hypothesisEvents = args.hypothesisEvents;
  if (args.hypothesisComparison) trace.hypothesisComparison = args.hypothesisComparison;
  if (args.promotionCoverage) trace.promotionCoverage = args.promotionCoverage;
  if (args.candidateAssessments) trace.candidateAssessments = args.candidateAssessments;
  if (args.deliberationCoverage) trace.deliberationCoverage = args.deliberationCoverage;
  if (args.agentLoop) trace.agentLoop = args.agentLoop;
  if (args.clinicalStrategy) trace.clinicalStrategy = args.clinicalStrategy;
  if (args.contextMetrics) trace.contextMetrics = args.contextMetrics;
  if (args.snapshot) {
    trace.modelProfileId = args.snapshot.modelProfileId; trace.promptHash = args.snapshot.promptHash;
    trace.capabilities = args.snapshot.capabilities; trace.skills = args.snapshot.skills;
    trace.knowledgeScopes = args.snapshot.knowledgeScopes;
    trace.activeSkills = args.snapshot.activeSkills;
    trace.skillVersions = args.snapshot.skillVersions;
    trace.skillPromptSections = args.snapshot.skillPromptSections;
  }
  return trace;
}
