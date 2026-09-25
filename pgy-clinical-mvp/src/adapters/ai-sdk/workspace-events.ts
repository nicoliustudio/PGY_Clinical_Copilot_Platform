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

    // Candidate Authority is intentionally single-surface: generic knowledge.search contributes
    // evidence only. Selectable formula candidates may only originate from formula.search_candidates
    // (or the explicitly retained legacy formula.search_normative surface). This prevents a broad
    // retrieval path from bypassing patient-fact recall protection and manufacturing candidates.
    return [completed, ...added];
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
          sourceKind: readField(c, 'sourceKind'),
          retrievalRank: readField(c, 'retrievalRank'),
          retrievalScore: readField(c, 'retrievalScore'),
          retrievalLane: readField(c, 'retrievalLane'),
          selectionUnit: readField(c, 'selectionUnit'),
          sourceProductRefs: readField(c, 'sourceProductRefs'),
          sourceProductNames: readField(c, 'sourceProductNames'),
          sourceProductCount: readField(c, 'sourceProductCount'),
          sourceCaseRef: readField(c, 'sourceCaseRef'),
          sourceEvidenceRef: readField(c, 'sourceEvidenceRef'),
          visitRef: readField(c, 'visitRef'),
          stage: readField(c, 'stage'),
          composition: readField(c, 'composition'),
          originatingHypothesisRefs: [],
        },
      });
    }
    // CandidateSet is one Runtime transaction: canonical evidence is materialized first, then the
    // Kernel receipt freezes the complete selectable universe together with those evidence links.
    const candidateRefs = (candidates as Record<string, unknown>[])
      .map((candidate) => readField(candidate, 'candidateRef'))
      .filter((ref): ref is string => typeof ref === 'string');
    const hydrated = Array.isArray(result?.hydratedEvidence) ? result.hydratedEvidence : [];
    for (const entry of hydrated as Record<string, unknown>[]) {
      const candidateRef = readField(entry, 'candidateRef');
      const evidence = readField(entry, 'evidence');
      if (typeof candidateRef !== 'string' || !evidence || typeof evidence !== 'object') continue;
      drafts.push(...workspaceEventsForTool('formula.get_evidence', { candidateRef }, evidence));
    }
    if (candidateRefs.length > 0) {
      drafts.push({ type: 'candidate.frontier.set', payload: { candidateRefs } });
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
    const canonicalCandidateRef = typeof requestedCandidateRef === 'string' && requestedCandidateRef
      ? requestedCandidateRef
      : derivedCandidateRef;
    return [{
      type: 'evidence.added',
      payload: {
        // Evidence identity is candidate-scoped, not parent-source-scoped. Three sibling formulas
        // from the same P1 source must produce three durable hydration facts; otherwise each new
        // evidence event overwrites the previous sibling linkage and formula-evidence can never close.
        id: `formula-evidence:${canonicalCandidateRef}`,
        sourceRef: sourceId,
        sourceType: readField(doc, 'sourceTier') ?? 'knowledge',
        sourceSchool: readPath(doc, 'provenance', 'sourceSchool'),
        title: typeof formulaName === 'string' ? formulaName : readField(doc, 'formulaId'),
        summary: readField(doc, 'indicationText'),
        evidenceKind: 'treatment_knowledge',
        sourceDisease: readPath(doc, 'provenance', 'disease'),
        sourceSyndrome: readPath(doc, 'provenance', 'syndrome'),
        relatedCandidates: [canonicalCandidateRef, derivedCandidateRef]
          .filter((x, index, all): x is string => typeof x === 'string' && x.length > 0 && all.indexOf(x) === index),
        supportingSignals: [],
        contradictingSignals: [],
      },
    }];
  }

  if (toolName === 'workspace.consider_hypotheses') {
    const resolved = readField(output, 'hypotheses');
    const hyps = Array.isArray(resolved)
      ? resolved
      : (Array.isArray(readField(input, 'hypotheses')) ? readField(input, 'hypotheses') : []);
    const drafts: WorkspaceEventDraft[] = [];
    for (const h of (hyps as unknown[])) {
      const label = readField(h, 'label');
      if (typeof label !== 'string' || !label.trim()) continue;
      const suppliedRef = readField(h, 'hypothesisRef');
      const id = typeof suppliedRef === 'string' && suppliedRef ? suppliedRef : stableHypothesisId(label);
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
    const drafts: WorkspaceEventDraft[] = candidateRefs.map((candidateRef) => ({
      type: 'candidate.focused' as const,
      payload: { id: candidateRef, candidateRef },
    }));
    // focus_candidates deterministically hydrates every focused candidate. Persist those canonical
    // evidence facts in the same atomic tool result so a partial frontier cannot strand selection.
    const hydrated = Array.isArray(readField(output, 'hydratedEvidence')) ? readField(output, 'hydratedEvidence') : [];
    for (const entry of hydrated as Record<string, unknown>[]) {
      const candidateRef = readField(entry, 'candidateRef');
      const evidence = readField(entry, 'evidence');
      if (typeof candidateRef !== 'string' || !evidence || typeof evidence !== 'object') continue;
      drafts.push(...workspaceEventsForTool('formula.get_evidence', { candidateRef }, evidence));
    }
    return drafts;
  }

  if (toolName === 'workspace.record_deliberation' || toolName === 'workspace.commit_clinical_model') {
    const drafts: WorkspaceEventDraft[] = [];
    // Frontier authority is intentionally exclusive to workspace.focus_candidates because that tool
    // atomically hydrates canonical evidence for every focused formula. workspace deliberation tools must not
    // recreate a partial-frontier bypass.

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
    // Tool execution may return a Runtime-normalized plan (e.g. SOURCE_BOUND source-owned fields
    // stripped before persistence). Durable state must use that canonical payload, not raw model input.
    const treatmentPlan = firstDefinedField(output, 'canonicalTreatmentPlan') ?? firstDefinedField(input, 'treatmentPlan');
    if (typeof treatmentPlan === 'object' && treatmentPlan !== null) {
      drafts.push({ type: 'treatment.plan.recorded', payload: treatmentPlan as Record<string, unknown> });
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
