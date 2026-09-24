import type { WorkspaceBatchResult, WorkspaceControlPort, WorkspaceEventDraft, WorkspaceEventType } from '../../contracts/workspace.js';
import { isToolFailureOutput, serializeToolError } from '../../contracts/tool-failure.js';

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

/** H15.2：knowledgeRole → evidenceKind（结构性映射，非医学 enum）。 */
function evidenceKindForRole(role: unknown): 'diagnostic_knowledge' | 'treatment_knowledge' | undefined {
  if (role === 'DIAGNOSTIC_DIFFERENTIAL' || role === 'DIAGNOSTIC_STANDARD') return 'diagnostic_knowledge';
  if (role === 'NORMATIVE_TREATMENT' || role === 'CLINICAL_CASE') return 'treatment_knowledge';
  return undefined;
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
      evidenceKind: evidenceKindForRole(readField(hit, 'knowledgeRole')),
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
  // Failed validation is observational only: it must never persist the rejected input.
  if (isToolFailureOutput(output) || readField(output, 'accepted') === false) return [];
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
        evidenceKind: evidenceKindForRole(readField(doc, 'knowledgeRole')),
        relatedCandidates: formulaIds(readField(doc, 'formulas')),
        supportingSignals: [],
        contradictingSignals: [],
      },
    }];
  }

  if (toolName === 'knowledge.search_cards') {
    if (!Array.isArray(output)) return [];
    const assetIds = output
      .map((hit) => readField(hit, 'asset_id'))
      .filter((x): x is string => typeof x === 'string');
    return [{
      type: 'knowledge.search.completed',
      payload: {
        query: readField(input, 'query'),
        count: output.length,
        assetIds,
        surface: 'runtime-catalog',
      },
    }];
  }

  if (toolName === 'knowledge.get_asset') {
    if (typeof output !== 'object' || output === null) return [];
    const doc = output as Record<string, unknown>;
    const assetId = readField(doc, 'asset_id');
    if (typeof assetId !== 'string') return [];
    const summary = readField(doc, 'indication_text') ?? readField(doc, 'treatment_method') ?? readField(doc, 'title');
    return [{
      type: 'evidence.added',
      payload: {
        id: assetId,
        sourceRef: assetId,
        sourceType: readField(doc, 'asset_type') ?? 'runtime-catalog',
        sourceSchool: readPath(doc, 'provenance', 'book'),
        title: readField(doc, 'title'),
        summary: typeof summary === 'string' ? summary.slice(0, 400) : undefined,
        evidenceKind: 'treatment_knowledge',
        sourceDisease: readPath(doc, 'disease', 'name'),
        sourceSyndrome: readField(doc, 'syndrome_pattern'),
        relatedCandidates: [],
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

  if (toolName === 'formula.search_candidates') {
    const result = typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : undefined;
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    const drafts: WorkspaceEventDraft[] = [];
    for (const c of candidates as Record<string, unknown>[]) {
      const id = readField(c, 'candidateRef');
      if (typeof id !== 'string') continue;
      drafts.push({
        type: 'candidate.presented',
        payload: {
          id,
          formulaId: readField(c, 'formulaId'),
          sourceId: readField(c, 'sourceId'),
          name: readField(c, 'formulaName'),
          sourceAuthority: readField(c, 'sourceAuthority'),
          sourceCaseRef: readField(c, 'sourceCaseRef'),
          sourceEvidenceRef: readField(c, 'sourceEvidenceRef'),
          visitRef: readField(c, 'visitRef'),
          stage: readField(c, 'stage'),
          composition: readField(c, 'composition'),
          originatingHypothesisRefs: [],
        },
      });
    }
    return drafts;
  }

  if (toolName === 'formula.get_evidence') {
    if (typeof output !== 'object' || output === null) return [];
    const doc = output as Record<string, unknown>;
    const sourceId = readField(doc, 'sourceId');
    if (typeof sourceId !== 'string') return [];
    const formulaName = readField(doc, 'formulaName');
    const requestedCandidateRef = readField(input, 'candidateRef');
    const derivedCandidateRef = `${sourceId}::${readField(doc, 'formulaId')}`;
    return [{
      type: 'evidence.added',
      payload: {
        id: sourceId,
        sourceRef: sourceId,
        sourceType: readField(doc, 'sourceTier') ?? 'knowledge',
        sourceSchool: readPath(doc, 'provenance', 'sourceSchool'),
        title: typeof formulaName === 'string' ? formulaName : readField(doc, 'formulaId'),
        summary: readField(doc, 'indicationText'),
        evidenceKind: 'treatment_knowledge',
        sourceDisease: readPath(doc, 'provenance', 'disease'),
        sourceSyndrome: readPath(doc, 'provenance', 'syndrome'),
        // 优先保留调用时的 canonical candidateRef。P2 formula-level candidate 的
        // candidateRef 与 formulaId 并非同一字符串，若只重建 `${sourceId}::${formulaId}`
        // 会丢失 candidate ↔ expanded evidence 的 durable linkage，导致 recovery 无法判断
        // “这个 frontier candidate 是否已经读过完整证据”。
        relatedCandidates: [
          typeof requestedCandidateRef === 'string' ? requestedCandidateRef : undefined,
          derivedCandidateRef,
        ].filter((x): x is string => typeof x === 'string' && x.length > 0),
        supportingSignals: [],
        contradictingSignals: [],
      },
    }];
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

    // H13：PatternAssessment 结构（开放语义患者级辨证结构）。
    const patternAssessment = firstDefinedField(input, 'patternAssessment');
    if (typeof patternAssessment === 'object' && patternAssessment !== null) {
      drafts.push({
        type: 'pattern.assessment.recorded',
        payload: patternAssessment as Record<string, unknown>,
      });
    }

    // H15：Clinical Decision Spine 各层（开放文本，不生成医学 enum）。
    const diseaseAssessment = firstDefinedField(input, 'diseaseAssessment');
    if (typeof diseaseAssessment === 'object' && diseaseAssessment !== null) {
      drafts.push({ type: 'disease.assessment.recorded', payload: diseaseAssessment as Record<string, unknown> });
    }
    const treatmentPlan = firstDefinedField(input, 'treatmentPlan');
    if (typeof treatmentPlan === 'object' && treatmentPlan !== null) {
      drafts.push({ type: 'treatment.plan.recorded', payload: treatmentPlan as Record<string, unknown> });
    }
    const formulaSelection = firstDefinedField(input, 'formulaSelection');
    if (typeof formulaSelection === 'object' && formulaSelection !== null) {
      drafts.push({ type: 'formula.selection.recorded', payload: formulaSelection as Record<string, unknown> });
    }
    const modificationPlan = firstDefinedField(input, 'modificationPlan');
    if (typeof modificationPlan === 'object' && modificationPlan !== null) {
      drafts.push({ type: 'modification.plan.recorded', payload: modificationPlan as Record<string, unknown> });
    }
    const formulaReview = firstDefinedField(input, 'formulaReview');
    if (typeof formulaReview === 'object' && formulaReview !== null) {
      drafts.push({ type: 'formula.review.recorded', payload: formulaReview as Record<string, unknown> });
    }
    const completionObligation = firstDefinedField(input, 'completionObligation');
    const ignoredArtifacts = Array.isArray(readField(output, 'ignoredArtifacts'))
      ? (readField(output, 'ignoredArtifacts') as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (!ignoredArtifacts.includes('completionObligation')
      && typeof completionObligation === 'object' && completionObligation !== null) {
      drafts.push({ type: 'completion.obligation.recorded', payload: completionObligation as Record<string, unknown> });
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
  return { error: serializeToolError(envelope.error) };
}
