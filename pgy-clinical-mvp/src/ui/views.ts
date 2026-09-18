import type { AgentResult } from '../contracts/result.js';
import type { AuthorityResult } from '../contracts/authority.js';
import type {
  CandidateAssessment,
  CandidateReference,
  ClinicalWorkspace,
  DeliberationCoverage,
  EvidenceItem,
  HypothesisCandidate,
  WorkspaceEvent,
} from '../contracts/workspace.js';
import type { RunTrace, ToolCallTrace } from '../trace.js';
import type { ClinicalStrategy } from '../contracts/clinical-strategy.js';
import { buildComparisonMatrix } from '../platform/workspace/deliberation-projection.js';

/**
 * UI DTO 层：把 Runtime 结果映射为前端可读的稳定视图。
 * 前端不 import Runtime 内部对象，只消费这里的 DTO。
 * 所有 DTO 都只包含可观测状态（tool call / workspace / 结构化结论），不含 hidden CoT。
 */

// ---------- Result ----------

export interface ResultView {
  mode: AgentResult['mode'];
  status?: 'COMPLETED' | 'BLOCKED';
  disease?: { name: string; confidence: number; evidence_refs: string[] };
  syndrome?: { name: string; confidence: number; evidence_refs: string[] };
  treatment?: { text: string; evidence_refs: string[] };
  formula?: {
    authority: string;
    formula_id: string;
    name: string;
    composition: string[];
    source_id: string;
    candidate_ref?: string;
    evidence_refs: string[];
  };
  missing_information?: string[];
  safety?: { status: string };
  message?: string;
  questions?: string[];
  risks?: { description: string; severity: string }[];
}

export function buildResultView(result: AgentResult): ResultView {
  const view: ResultView = { mode: result.mode };
  if (result.mode === 'clinical') {
    view.status = result.status;
    view.disease = result.disease;
    view.syndrome = result.syndrome;
    view.treatment = result.treatment;
    view.formula = result.formula;
    view.missing_information = result.missing_information;
    view.safety = result.safety;
  } else if (result.mode === 'conversation') {
    view.message = result.message;
  } else if (result.mode === 'clarification') {
    view.questions = result.questions;
  } else if (result.mode === 'urgent') {
    view.message = result.message;
    view.risks = result.risks;
  }
  return view;
}

// ---------- Workspace ----------

export interface EvidenceViewItem {
  id: string;
  sourceRef: string;
  sourceType: string;
  sourceSchool?: string;
  title?: string;
  summary?: string;
  relatedCandidates: string[];
  supportingSignals: string[];
  contradictingSignals: string[];
}

export interface HypothesisViewItem {
  id: string;
  label: string;
  description?: string;
  supportingEvidenceRefs: string[];
  contradictingEvidenceRefs: string[];
  missingEvidence: string[];
  status: HypothesisCandidate['status'];
}

export interface CandidateViewItem {
  id: string;
  kind: CandidateReference['kind'];
  name?: string;
  formulaId?: string;
  sourceId?: string;
  composition?: string[];
  status: 'presented' | 'selected' | 'rejected' | 'unknown';
  hypothesisRefs: string[];
}

export interface DeliberationView {
  rows: {
    candidateRef: string;
    hypothesisRefs: string[];
    assessmentStatus: string;
    supportingEvidenceRefs: string[];
    contradictingEvidenceRefs: string[];
    unresolvedQuestions: string[];
    assessmentSummaries: string[];
  }[];
  assessments: CandidateAssessment[];
  coverage: DeliberationCoverage[];
}

export interface WorkspaceView {
  facts: unknown[];
  informationGaps: string[];
  uncertainties: string[];
  safetyDisposition: ClinicalWorkspace['safetyDisposition'];
  activeCapabilities: string[];
  activeSkills: string[];
  evidence: EvidenceViewItem[];
  hypotheses: HypothesisViewItem[];
  candidates: CandidateViewItem[];
  deliberation: DeliberationView;
}

export function buildWorkspaceView(ws: ClinicalWorkspace): WorkspaceView {
  const statusById = new Map<string, 'presented' | 'selected' | 'rejected'>(
    ws.evidenceState.candidateComparisons.map((c) => [c.candidateRef, c.status]),
  );

  return {
    facts: ws.facts,
    informationGaps: ws.informationGaps,
    uncertainties: ws.uncertainties,
    safetyDisposition: ws.safetyDisposition,
    activeCapabilities: ws.activeCapabilities,
    activeSkills: ws.activeSkills,
    evidence: ws.evidenceState.evidenceItems.map((e: EvidenceItem) => ({
      id: e.id,
      sourceRef: e.sourceRef,
      sourceType: e.sourceType,
      sourceSchool: e.sourceSchool,
      title: e.title,
      summary: e.summary,
      relatedCandidates: e.relatedCandidates,
      supportingSignals: e.supportingSignals,
      contradictingSignals: e.contradictingSignals,
    })),
    hypotheses: ws.hypothesisState.hypotheses.map((h: HypothesisCandidate) => ({
      id: h.id,
      label: h.label,
      description: h.description,
      supportingEvidenceRefs: h.supportingEvidenceRefs,
      contradictingEvidenceRefs: h.contradictingEvidenceRefs,
      missingEvidence: h.missingEvidence,
      status: h.status,
    })),
    candidates: ws.candidates.map((c: CandidateReference) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      formulaId: c.formulaId,
      sourceId: c.sourceId,
      composition: c.composition,
      status: statusById.get(c.id) ?? 'unknown',
      hypothesisRefs: c.originatingHypothesisRefs ?? [],
    })),
    deliberation: {
      rows: buildComparisonMatrix(ws).rows.map((r) => ({ ...r })),
      assessments: ws.deliberationState.assessments.map((a) => ({ ...a })),
      coverage: ws.deliberationState.coverage.map((c) => ({ ...c })),
    },
  };
}

// ---------- Trace ----------

export interface TraceView {
  runId: string;
  input: string;
  startedAt: string;
  finishedAt?: string;
  totalMs?: number;
  toolCalls: ToolCallTrace[];
  workspaceEvents: WorkspaceEvent[];
  retrievalDiagnostics: RunTrace['retrievalDiagnostics'];
  agentLoop?: RunTrace['agentLoop'];
  contextMetrics?: RunTrace['contextMetrics'];
  runMetrics?: RunTrace['runMetrics'];
  snapshot: {
    modelProfileId?: string;
    promptHash?: string;
    capabilities?: string[];
    skills?: string[];
    activeSkills?: string[];
    skillVersions?: { id: string; version: string }[];
    knowledgeScopes?: string[];
  };
}

export function buildTraceView(trace: RunTrace): TraceView {
  return {
    runId: trace.runId,
    input: trace.input,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
    totalMs: trace.totalMs,
    toolCalls: trace.toolCalls,
    workspaceEvents: trace.workspaceEvents,
    retrievalDiagnostics: trace.retrievalDiagnostics,
    agentLoop: trace.agentLoop,
    contextMetrics: trace.contextMetrics,
    runMetrics: trace.runMetrics,
    snapshot: {
      modelProfileId: trace.modelProfileId,
      promptHash: trace.promptHash,
      capabilities: trace.capabilities,
      skills: trace.skills,
      activeSkills: trace.activeSkills,
      skillVersions: trace.skillVersions,
      knowledgeScopes: trace.knowledgeScopes,
    },
  };
}

// ---------- Knowledge Source ----------

export interface KnowledgeSourceView {
  sourceId: string;
  source?: string;
  sourceFile?: string;
  title?: string;
  disease?: string;
  syndrome?: string;
  treatment?: string;
  tier?: string;
  summary?: string;
  formulas?: { id: string; name: string; composition?: string }[];
}

function readField(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null;
}

/**
 * 从 tool call 输出中还原某个 source 的 provenance。
 * 只依赖工具返回的公开字段（source / sourceFile / formulas / tier / title / disease / syndrome / treatment），
 * 不进入模型中间推理。
 */
export function buildKnowledgeSourceView(sourceId: string, trace: { toolCalls: ToolCallTrace[] }): KnowledgeSourceView | null {
  const view: KnowledgeSourceView = { sourceId };

  for (const call of trace.toolCalls) {
    const out = call.output;
    if (call.toolName === 'knowledge.get_source' && isRecord(out)) {
      if (readField(out, 'id') === sourceId) {
        view.source = asString(readField(out, 'source'));
        view.sourceFile = asString(readField(out, 'sourceFile'));
        view.title = asString(readField(out, 'title'));
        view.disease = asString(readField(out, 'disease'));
        view.syndrome = asString(readField(out, 'syndrome'));
        view.treatment = asString(readField(out, 'treatment'));
        view.tier = asString(readField(out, 'sourceTier')) ?? asString(readField(out, 'tier'));
        const text = readField(out, 'text');
        if (typeof text === 'string') view.summary = text.slice(0, 600);
        const formulas = readField(out, 'formulas');
        if (Array.isArray(formulas)) {
          view.formulas = formulas.map((f) => ({
            id: asString(readField(f, 'id')) ?? '',
            name: asString(readField(f, 'name')) ?? '',
            composition: asString(readField(f, 'composition')),
          }));
        }
        return view;
      }
    }

    if (call.toolName === 'formula.search_normative' && Array.isArray(out)) {
      for (const item of out) {
        if (!isRecord(item)) continue;
        if (readField(item, 'sourceId') === sourceId) {
          view.source = asString(readField(item, 'source'));
          view.disease = asString(readField(item, 'disease'));
          view.syndrome = asString(readField(item, 'syndrome'));
          view.treatment = asString(readField(item, 'treatment'));
          const name = asString(readField(item, 'name'));
          const formulaId = asString(readField(item, 'formulaId'));
          const composition = readField(item, 'composition');
          view.formulas = [
            { id: formulaId ?? '', name: name ?? '', composition: Array.isArray(composition) ? composition.join('') : asString(composition) },
          ];
          return view;
        }
      }
    }

    if (call.toolName === 'knowledge.search' && Array.isArray(out)) {
      for (const item of out) {
        if (!isRecord(item)) continue;
        if (readField(item, 'sourceId') === sourceId) {
          view.source = asString(readField(readField(item, 'provenance'), 'source'));
          view.sourceFile = asString(readField(readField(item, 'provenance'), 'sourceFile'));
          view.disease = asString(readField(readField(item, 'provenance'), 'disease'));
          view.syndrome = asString(readField(readField(item, 'provenance'), 'syndrome'));
          view.treatment = asString(readField(readField(item, 'provenance'), 'treatment'));
          view.tier = asString(readField(item, 'authority'));
          view.title = asString(readField(item, 'title'));
          const excerpt = readField(item, 'excerpt');
          if (typeof excerpt === 'string') view.summary = excerpt;
          const formulas = readField(item, 'formulas');
          if (Array.isArray(formulas)) {
            view.formulas = formulas.map((f) => ({
              id: asString(readField(f, 'id')) ?? '',
              name: asString(readField(f, 'name')) ?? '',
              composition: asString(readField(f, 'composition')),
            }));
          }
          return view;
        }
      }
    }
  }

  return Object.keys(view).length > 1 ? view : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ---------- Session ----------

export interface SessionView {
  runId: string;
  model: string;
  result: ResultView;
  authority: AuthorityResult;
  workspace: WorkspaceView;
  trace: TraceView;
  strategy?: ClinicalStrategy;
}

export interface SessionSource {
  result: AgentResult;
  workspace: ClinicalWorkspace;
  authority: AuthorityResult;
  trace: RunTrace;
}

export function buildSessionView(src: SessionSource): SessionView {
  return {
    runId: src.trace.runId,
    model: src.trace.modelProfileId ?? 'unknown',
    result: buildResultView(src.result),
    authority: src.authority,
    workspace: buildWorkspaceView(src.workspace),
    trace: buildTraceView(src.trace),
    strategy: src.trace.clinicalStrategy,
  };
}
