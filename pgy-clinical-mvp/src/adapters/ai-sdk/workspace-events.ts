import type { WorkspaceBatchResult, WorkspaceControlPort, WorkspaceEventDraft, WorkspaceEventType } from '../../contracts/workspace.js';

function readField(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
}

function readPath(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) current = readField(current, key);
  return current;
}

function firstDefinedField(input: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = readField(input, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

function formulaIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((f) => readField(f, 'id')).filter((x): x is string => typeof x === 'string');
}

/** 稳定 hypothesis 身份：由语义标签派生确定性 H_xxx（跨多次检索保持一致，不与 sourceId/label 混用）。 */
function stableHypothesisId(label: string): string {
  let h = 5381;
  for (let i = 0; i < label.length; i++) {
    h = ((h << 5) + h + label.charCodeAt(i)) >>> 0;
  }
  return `H_${h.toString(16).padStart(6, '0')}`;
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
      sourceDisease: readPath(hit, 'provenance', 'disease'),
      sourceSyndrome: readPath(hit, 'provenance', 'syndrome'),
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

    // H12：knowledge.search 只产生 evidence / presented candidate，不自动产生 patient hypothesis。
    // provenance.syndrome 是 SOURCE_SYNDROME_LABEL（知识元数据），不是 patient diagnosis。
    const candidates: WorkspaceEventDraft[] = [];
    for (const hit of output) {
      const sourceId = readField(hit, 'sourceId');
      const authority = readField(hit, 'authority');
      // 直接 canonical hydrate：knowledge.search 已返回明确 P1 formula candidate 时，
      // 不要求重复 formula.search_normative。
      if (authority === 'P1' && typeof sourceId === 'string') {
        const formulas = readField(hit, 'formulas');
        if (Array.isArray(formulas)) {
          for (const f of formulas) {
            const formulaId = readField(f, 'id');
            const composition = readField(f, 'composition');
            if (typeof formulaId === 'string' && typeof composition === 'string' && composition.trim()) {
              candidates.push({
                type: 'candidate.presented',
                payload: {
                  id: `${sourceId}::${formulaId}`,
                  formulaId,
                  sourceId,
                  composition: [composition],
                  name: readField(f, 'name'),
                  originatingHypothesisRefs: [],
                },
              });
            }
          }
        }
      }
    }

    return [completed, ...added, ...candidates];
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
        sourceType: readField(doc, 'sourceTier') ?? 'knowledge',
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
    for (const candidate of output) {
      const id = readField(candidate, 'candidateRef');
      if (typeof id === 'string') {
        drafts.push({
          type: 'candidate.presented',
          payload: {
            id,
            formulaId: readField(candidate, 'formulaId'),
            sourceId: readField(candidate, 'sourceId'),
            // H7：candidate card 不携带 composition；canonical hydrate 由 Harness 内部完成。
            // 兼容旧字段名 name / syndrome。
            name: readField(candidate, 'formulaName') ?? readField(candidate, 'name'),
            originatingHypothesisRefs: readField(candidate, 'originatingHypothesisRefs'),
          },
        });
      }
      // H12：不再从 syndromeVariant / syndrome 自动生成 patient hypothesis。
    }
    return drafts;
  }

  if (toolName === 'workspace.consider_hypotheses') {
    const hyps = Array.isArray(readField(input, 'hypotheses')) ? readField(input, 'hypotheses') : [];
    const drafts: WorkspaceEventDraft[] = [];
    for (const h of (hyps as unknown[])) {
      const label = readField(h, 'label');
      if (typeof label !== 'string' || !label.trim()) continue;
      const id = stableHypothesisId(label);
      drafts.push({
        type: 'hypothesis.presented',
        payload: {
          id,
          label,
          origin: 'agent_reasoning',
          supportingEvidenceRefs: Array.isArray(readField(h, 'basisRefs')) ? readField(h, 'basisRefs') : [],
        },
      });
      if (readField(h, 'role') === 'leading') {
        drafts.push({ type: 'hypothesis.selected', payload: { id } });
      }
    }
    return drafts;
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
    const focusedField = firstDefinedField(input, 'focusedCandidateRefs', 'focusedCandidates');
    const focused = Array.isArray(focusedField) ? focusedField : [];
    for (const candidateRef of (focused as unknown[]).filter((x): x is string => typeof x === 'string')) {
      drafts.push({ type: 'candidate.focused', payload: { id: candidateRef, candidateRef } });
    }

    const assessmentsField = firstDefinedField(input, 'candidateAssessments', 'assessments');
    const assessments = Array.isArray(assessmentsField) ? assessmentsField : [];
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

    const exclusionsField = firstDefinedField(input, 'exclusions');
    const exclusions = Array.isArray(exclusionsField) ? exclusionsField : [];
    for (const x of (exclusions as Record<string, unknown>[])) {
      const candidateRef = readField(x, 'candidateRef');
      if (typeof candidateRef !== 'string') continue;
      drafts.push({ type: 'candidate.excluded', payload: { id: candidateRef, candidateRef, reason: readField(x, 'reason') } });
    }

    // H9：batch hypothesis updates（status / evidence）。
    const hypothesisUpdatesField = firstDefinedField(input, 'hypothesisUpdates');
    const hypothesisUpdates = Array.isArray(hypothesisUpdatesField) ? hypothesisUpdatesField : [];
    for (const u of (hypothesisUpdates as Record<string, unknown>[])) {
      const hypothesisRef = readField(u, 'hypothesisRef');
      if (typeof hypothesisRef !== 'string') continue;
      const status = readField(u, 'status');
      const supporting = Array.isArray(readField(u, 'supportingEvidenceRefs')) ? readField(u, 'supportingEvidenceRefs') : [];
      const contradicting = Array.isArray(readField(u, 'contradictingEvidenceRefs')) ? readField(u, 'contradictingEvidenceRefs') : [];
      if (status === 'active') drafts.push({ type: 'hypothesis.selected', payload: { id: hypothesisRef } });
      if (status === 'rejected') drafts.push({ type: 'hypothesis.rejected', payload: { id: hypothesisRef } });
      if (status === 'preserved_as_uncertainty') drafts.push({ type: 'hypothesis.preserved_as_uncertainty', payload: { id: hypothesisRef } });
      if ((supporting as unknown[]).length > 0) drafts.push({ type: 'hypothesis.supported', payload: { id: hypothesisRef, evidenceRefs: supporting } });
      if ((contradicting as unknown[]).length > 0) drafts.push({ type: 'hypothesis.challenged', payload: { id: hypothesisRef, evidenceRefs: contradicting } });
    }

    // H9：batch uncertainty resolution。
    const resolvedUncertaintyRefs = firstDefinedField(input, 'resolvedUncertaintyRefs');
    const remainingDecisionChangingUnknowns = firstDefinedField(input, 'remainingDecisionChangingUnknowns');
    const resolvedRefs = Array.isArray(resolvedUncertaintyRefs) ? resolvedUncertaintyRefs.filter((x): x is string => typeof x === 'string') : [];
    const remainingRefs = Array.isArray(remainingDecisionChangingUnknowns) ? remainingDecisionChangingUnknowns.filter((x): x is string => typeof x === 'string') : undefined;
    if (resolvedRefs.length > 0 || remainingRefs !== undefined) {
      drafts.push({
        type: 'uncertainty.resolved',
        payload: { resolvedRefs, remainingRefs },
      });
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
): { rawOutput?: unknown; error?: unknown; batchResult?: WorkspaceBatchResult } {
  if (envelope.type === 'tool-result') {
    const rawOutput = envelope.output;
    if (rawOutput !== undefined) {
      const drafts = workspaceEventsForTool(toolName, input, rawOutput);
      if (drafts.length > 0) {
        const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const batchResult = store.appendBatch(drafts, batchId);
        return { rawOutput, batchResult };
      }
    }
    return { rawOutput };
  }
  return { error: envelope.error };
}
