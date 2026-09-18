import type { WorkspaceControlPort, WorkspaceEventType } from '../../contracts/workspace.js';

export interface WorkspaceEventDraft {
  type: WorkspaceEventType;
  payload: Record<string, unknown>;
}

function readField(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
}

function readPath(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) current = readField(current, key);
  return current;
}

function formulaIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((f) => readField(f, 'id')).filter((x): x is string => typeof x === 'string');
}

function evidenceItemDraft(hit: Record<string, unknown>): WorkspaceEventDraft | null {
  const sourceId = readField(hit, 'sourceId');
  if (typeof sourceId !== 'string') return null;
  return {
    type: 'evidence.added',
    payload: {
      id: sourceId,
      sourceRef: sourceId,
      sourceType: readField(hit, 'authority') ?? 'knowledge',
      sourceSchool: readPath(hit, 'provenance', 'sourceSchool'),
      title: readField(hit, 'title'),
      summary: readField(hit, 'excerpt'),
      relatedCandidates: formulaIds(readField(hit, 'formulas')),
      supportingSignals: [],
      contradictingSignals: [],
    },
  };
}

/**
 * 纯函数：由工具结果推导 WorkspaceEvent。
 * 搜索只产生 evidence / presented，不产生 selected；selected/rejected 由 proposal 决策阶段记录。
 */
export function workspaceEventsForTool(
  toolName: string,
  input: unknown,
  output: unknown,
): WorkspaceEventDraft[] {
  if (toolName === 'capability.activate') {
    const id = readField(input, 'id');
    if (typeof id !== 'string') return [];
    const result = typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : undefined;
    const addedSkills = Array.isArray(result?.addedSkills)
      ? result.addedSkills.map((s) => readField(s, 'id')).filter((x): x is string => typeof x === 'string')
      : [];
    return [{ type: 'capability.activated', payload: { id, addedSkills } }];
  }

  if (toolName === 'knowledge.search') {
    if (!Array.isArray(output)) return [];
    const completed: WorkspaceEventDraft = {
      type: 'knowledge.search.completed',
      payload: {
        query: readField(input, 'query'),
        count: output.length,
        evidenceIds: output.map((hit) => readField(hit, 'sourceId')).filter((x): x is string => typeof x === 'string'),
      },
    };
    const added = output
      .map((hit) => (typeof hit === 'object' && hit !== null ? evidenceItemDraft(hit as Record<string, unknown>) : null))
      .filter((x): x is WorkspaceEventDraft => x !== null);

    const hypotheses: WorkspaceEventDraft[] = [];
    for (const hit of output) {
      const sourceId = readField(hit, 'sourceId');
      const syndrome = readPath(hit, 'provenance', 'syndrome');
      if (typeof syndrome === 'string' && syndrome.trim()) {
        hypotheses.push({
          type: 'hypothesis.presented',
          payload: {
            id: syndrome,
            label: syndrome,
            supportingEvidenceRefs: typeof sourceId === 'string' ? [sourceId] : [],
          },
        });
      }
    }

    return [completed, ...added, ...hypotheses];
  }

  if (toolName === 'knowledge.get_source') {
    if (typeof output !== 'object' || output === null) return [];
    const doc = output as Record<string, unknown>;
    const sourceId = readField(doc, 'id');
    if (typeof sourceId !== 'string') return [];
    const summary = readField(doc, 'text');
    return [{
      type: 'evidence.added',
      payload: {
        id: sourceId,
        sourceRef: sourceId,
        sourceType: readField(doc, 'tier') ?? 'knowledge',
        sourceSchool: readField(doc, 'sourceSchool'),
        title: readField(doc, 'title'),
        summary: typeof summary === 'string' ? summary.slice(0, 400) : undefined,
        relatedCandidates: formulaIds(readField(doc, 'formulas')),
        supportingSignals: [],
        contradictingSignals: [],
      },
    }];
  }

  if (toolName === 'formula.search_normative') {
    if (!Array.isArray(output)) return [];
    const drafts: WorkspaceEventDraft[] = [];
    const hypotheses: WorkspaceEventDraft[] = [];
    for (const candidate of output) {
      const id = readField(candidate, 'candidateRef');
      if (typeof id === 'string') {
        drafts.push({
          type: 'candidate.presented',
          payload: {
            id,
            formulaId: readField(candidate, 'formulaId'),
            sourceId: readField(candidate, 'sourceId'),
            composition: readField(candidate, 'composition'),
            name: readField(candidate, 'name'),
            originatingHypothesisRefs: readField(candidate, 'originatingHypothesisRefs'),
          },
        });
      }
      const syndrome = readField(candidate, 'syndrome');
      if (typeof syndrome === 'string' && syndrome.trim()) {
        hypotheses.push({
          type: 'hypothesis.presented',
          payload: { id: syndrome, label: syndrome },
        });
      }
    }
    return [...drafts, ...hypotheses];
  }

  if (toolName === 'workspace.record_candidate_assessment') {
    const candidateRef = readField(output, 'candidateRef');
    const hypothesisRef = readField(output, 'hypothesisRef');
    if (typeof candidateRef !== 'string' || typeof hypothesisRef !== 'string') return [];
    return [{
      type: 'candidate.assessed',
      payload: {
        id: `assess:${candidateRef}::${hypothesisRef}`,
        candidateRef,
        hypothesisRef,
        supportingEvidenceRefs: readField(output, 'supportingEvidenceRefs'),
        contradictingEvidenceRefs: readField(output, 'contradictingEvidenceRefs'),
        unresolvedQuestions: readField(output, 'unresolvedQuestions'),
        assessmentSummary: readField(output, 'assessmentSummary'),
        assessmentEvidenceRefs: readField(output, 'assessmentEvidenceRefs'),
      },
    }];
  }

  if (toolName === 'workspace.record_candidate_exclusion') {
    const candidateRef = readField(output, 'candidateRef');
    if (typeof candidateRef !== 'string') return [];
    return [{
      type: 'candidate.excluded',
      payload: {
        id: candidateRef,
        candidateRef,
        reason: readField(output, 'reason'),
      },
    }];
  }

  if (toolName === 'workspace.focus_candidates') {
    const refs = Array.isArray(readField(input, 'candidateRefs')) ? readField(input, 'candidateRefs') : [];
    const candidateRefs = (refs as unknown[]).filter((x): x is string => typeof x === 'string');
    return candidateRefs.map((candidateRef) => ({
      type: 'candidate.focused' as const,
      payload: { id: candidateRef, candidateRef },
    }));
  }

  if (toolName === 'workspace.record_deliberation') {
    const drafts: WorkspaceEventDraft[] = [];
    const focused = Array.isArray(readField(input, 'focusedCandidates')) ? readField(input, 'focusedCandidates') : [];
    for (const candidateRef of (focused as unknown[]).filter((x): x is string => typeof x === 'string')) {
      drafts.push({ type: 'candidate.focused', payload: { id: candidateRef, candidateRef } });
    }
    const assessments = Array.isArray(readField(input, 'assessments')) ? readField(input, 'assessments') : [];
    for (const a of (assessments as Record<string, unknown>[])) {
      const candidateRef = readField(a, 'candidateRef');
      const hypothesisRef = readField(a, 'hypothesisRef');
      if (typeof candidateRef !== 'string' || typeof hypothesisRef !== 'string') continue;
      drafts.push({
        type: 'candidate.assessed',
        payload: {
          candidateRef,
          hypothesisRef,
          supportingEvidenceRefs: readField(a, 'supportingEvidenceRefs'),
          contradictingEvidenceRefs: readField(a, 'contradictingEvidenceRefs'),
          unresolvedQuestions: readField(a, 'unresolvedQuestions'),
          assessmentSummary: readField(a, 'assessmentSummary'),
          assessmentEvidenceRefs: readField(a, 'assessmentEvidenceRefs'),
        },
      });
    }
    const exclusions = Array.isArray(readField(input, 'exclusions')) ? readField(input, 'exclusions') : [];
    for (const x of (exclusions as Record<string, unknown>[])) {
      const candidateRef = readField(x, 'candidateRef');
      if (typeof candidateRef !== 'string') continue;
      drafts.push({ type: 'candidate.excluded', payload: { id: candidateRef, candidateRef, reason: readField(x, 'reason') } });
    }
    return drafts;
  }

  return [];
}

export interface ToolExecutionEnvelope {
  type: 'tool-result' | 'tool-error';
  output?: unknown;
  error?: unknown;
}

/**
 * AI SDK v7 的 onToolExecutionEnd 里 toolOutput 是判别联合：
 *   { type: 'tool-result', output } | { type: 'tool-error', error }
 * 这里解包并把工具结果写入 workspace；tool-error 不产生 evidence event。
 */
export function applyToolExecutionResult(
  toolName: string,
  input: unknown,
  envelope: ToolExecutionEnvelope,
  store: WorkspaceControlPort,
): { rawOutput?: unknown; error?: unknown } {
  if (envelope.type === 'tool-result') {
    const rawOutput = envelope.output;
    if (rawOutput !== undefined) {
      for (const draft of workspaceEventsForTool(toolName, input, rawOutput)) {
        store.append(draft.type, draft.payload);
      }
    }
    return { rawOutput };
  }
  return { error: envelope.error };
}
