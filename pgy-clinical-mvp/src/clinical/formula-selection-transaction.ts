import type { RuntimeContext } from '../contracts/runtime.js';
import type { CandidateReference, FormulaCandidateDecision, SourceFormulaSet } from '../contracts/workspace.js';
import { loadIndex } from '../knowledge/build.js';
import type { KnowledgeIndex } from '../knowledge/types.js';
import { formulaSelectionReady, focusedFormulaCandidateRefs, missingFocusedFormulaEvidence } from './formula-selection.js';
import { renderMedicationList, searchModificationEvidence, type ModificationEvidenceResult } from './modification-evidence.js';
import { hydrateSourceFormulaSetForCandidate } from './source-formula-set.js';

export type FormulaSelectionTransactionResult =
  | {
      ok: true;
      selectedCandidateRef: string;
      selectedSourceRef: string;
      primaryFormulaRef?: string;
      sourceFormulaCount: number;
      modificationRuleCount: number;
      modificationState: 'PRESENT' | 'KNOWN_EMPTY' | 'NOT_APPLICABLE';
      sourceAuthority: 'P1' | 'P2_CASE_DERIVED';
    }
  | {
      ok: false;
      code: 'UNKNOWN_CANDIDATE_REF' | 'CANDIDATE_NOT_FOCUSED' | 'CANDIDATE_EXCLUDED' | 'CANDIDATE_DELIBERATION_INCOMPLETE' | 'FORMULA_EVIDENCE_INCOMPLETE' | 'CANONICAL_HYDRATION_FAILED' | 'MODIFICATION_EVIDENCE_UNAVAILABLE';
      details: string[];
    };

export interface FormulaSelectionDependencies {
  loadIndex: () => Promise<KnowledgeIndex>;
  hydrateSourceFormulaSet: (docs: KnowledgeIndex['docs'], candidate: CandidateReference) => SourceFormulaSet | null;
  searchModificationEvidence: (workspace: RuntimeContext['workspace'], topK?: number) => ModificationEvidenceResult;
}

const DEFAULT_DEPENDENCIES: FormulaSelectionDependencies = {
  loadIndex,
  hydrateSourceFormulaSet: hydrateSourceFormulaSetForCandidate,
  searchModificationEvidence,
};

function validateClosedWorldDecision(
  candidateRefs: string[],
  selectedCandidateRef: string,
  decisions: FormulaCandidateDecision[],
): { ok: true } | { ok: false; details: string[]; selectedExcluded?: boolean } {
  const expected = new Set(candidateRefs);
  const seen = new Set<string>();
  const details: string[] = [];
  for (const decision of decisions) {
    if (!expected.has(decision.candidateRef)) details.push(`decision references candidate outside CandidateSet: ${decision.candidateRef}`);
    if (seen.has(decision.candidateRef)) details.push(`duplicate candidate decision: ${decision.candidateRef}`);
    seen.add(decision.candidateRef);
  }
  for (const ref of candidateRefs) if (!seen.has(ref)) details.push(`candidate has no clinical disposition: ${ref}`);
  const selected = decisions.find((decision) => decision.candidateRef === selectedCandidateRef);
  if (selected?.disposition === 'EXCLUDED') {
    details.push(`selected candidate is explicitly excluded: ${selectedCandidateRef}`);
    return { ok: false, details, selectedExcluded: true };
  }
  if (!selected) details.push(`selected candidate has no decision: ${selectedCandidateRef}`);
  return details.length === 0 ? { ok: true } : { ok: false, details };
}

/**
 * Closed-world semantic selection transaction.
 *
 * Runtime owns CandidateSet membership and canonical evidence linkage. The model submits one clinical
 * decision over that immutable universe: selected candidate + one disposition per candidate + rationale.
 * No opaque evidence ids or hypothesis ids are required from the model.
 */
export async function selectCanonicalFormula(
  context: RuntimeContext,
  input: {
    candidateRef: string;
    candidateDecisions: FormulaCandidateDecision[];
    rationale?: string;
  },
  dependencies: Partial<FormulaSelectionDependencies> = {},
): Promise<FormulaSelectionTransactionResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const candidate = context.workspace.candidates.find((item) => item.kind === 'formula' && item.id === input.candidateRef);
  if (!candidate) {
    return { ok: false, code: 'UNKNOWN_CANDIDATE_REF', details: [`unknown formula candidate: ${input.candidateRef}`] };
  }

  const candidateRefs = focusedFormulaCandidateRefs(context.workspace);
  if (!candidateRefs.includes(input.candidateRef)) {
    return { ok: false, code: 'CANDIDATE_NOT_FOCUSED', details: [`candidate is not in the Kernel CandidateSet: ${input.candidateRef}`] };
  }

  if (!formulaSelectionReady(context.workspace)) {
    const missing = missingFocusedFormulaEvidence(context.workspace);
    return {
      ok: false,
      code: 'FORMULA_EVIDENCE_INCOMPLETE',
      details: missing.length > 0 ? missing.map((ref) => `missing canonical evidence: ${ref}`) : ['CandidateSet canonical evidence is incomplete'],
    };
  }

  const decisionCheck = validateClosedWorldDecision(candidateRefs, input.candidateRef, input.candidateDecisions ?? []);
  if (!decisionCheck.ok) {
    return {
      ok: false,
      code: decisionCheck.selectedExcluded ? 'CANDIDATE_EXCLUDED' : 'CANDIDATE_DELIBERATION_INCOMPLETE',
      details: decisionCheck.details,
    };
  }

  let sourceFormulaSet: SourceFormulaSet | null;
  try {
    const index = await deps.loadIndex();
    sourceFormulaSet = deps.hydrateSourceFormulaSet(index.docs, candidate);
  } catch {
    sourceFormulaSet = null;
  }
  if (!sourceFormulaSet || sourceFormulaSet.completeness !== 'COMPLETE') {
    return {
      ok: false,
      code: 'CANONICAL_HYDRATION_FAILED',
      details: [`unable to hydrate complete canonical source bundle for ${input.candidateRef}`],
    };
  }

  const isP2CaseSource = candidate.sourceAuthority === 'P2_CASE_DERIVED' || sourceFormulaSet.sourceAuthority === 'P2_CASE_DERIVED';
  const modificationEvidence = isP2CaseSource
    ? null
    : deps.searchModificationEvidence(context.workspace, Number.MAX_SAFE_INTEGER);
  if (modificationEvidence?.result === 'UNAVAILABLE') {
    return {
      ok: false,
      code: 'MODIFICATION_EVIDENCE_UNAVAILABLE',
      details: [modificationEvidence.reason ?? 'modification evidence store unavailable'],
    };
  }

  const receipt = context.workspace.candidateSetReceipt;
  const selectedBinding = receipt?.evidenceBindings.find((binding) => binding.candidateRef === input.candidateRef);
  const selectedSourceRef = candidate.sourceId ?? sourceFormulaSet.parentRecordRef;
  const primaryFormulaRef = sourceFormulaSet.formulas.find((formula) => formula.relation === 'PRIMARY_SELECTED')?.formulaRef;

  // Complete source membership becomes durable truth at selection time. Downstream may qualify but not erase it.
  context.workspace.sourceFormulaSet = sourceFormulaSet;
  context.workspaceStore.append('formula.selection.recorded', {
    selectedCandidateRef: input.candidateRef,
    selectedSourceRef,
    primaryFormulaRef,
    candidateDecisions: input.candidateDecisions,
    rationale: input.rationale,
    // Canonical evidence linkage comes from CandidateSetReceipt, never from model-authored ref copying.
    supportingEvidenceRefs: selectedBinding?.evidenceRefs ?? [],
    contradictingEvidenceRefs: [],
  });

  let modificationItems: Array<{ statement: string; patientEvidenceRefs: string[]; assessmentRefs: string[]; sourceEvidenceRefs: string[] }> = [];
  if (modificationEvidence) {
    modificationItems = modificationEvidence.candidates.map((item) => ({
      // 文本是结构化用药的投影：逐味「药名+剂量」相邻，配对信息不被拆成两条平行列表。
      statement: renderMedicationList(item.medications),
      patientEvidenceRefs: [...item.matchedPatientEvidenceRefs],
      assessmentRefs: [...item.matchedAssessmentRefs],
      sourceEvidenceRefs: [item.modificationEvidenceRef, item.sourceRef].filter(Boolean),
    }));
    context.workspaceStore.append('modification.plan.recorded', { items: modificationItems });
    context.workspace.modificationEvidenceClosure = {
      status: modificationEvidence.result === 'FOUND' ? 'FOUND' : 'SEARCHED_NONE',
      baseCandidateRef: input.candidateRef,
      parentSourceId: selectedSourceRef,
      matchedRuleRefs: modificationEvidence.candidates.map((item) => item.modificationEvidenceRef).filter(Boolean),
      evaluatedPatientEvidenceRefs: [...new Set(modificationEvidence.candidates.flatMap((item) => item.matchedPatientEvidenceRefs))],
      version: context.workspaceStore.version,
    };
  } else {
    context.workspace.modificationEvidenceClosure = {
      status: 'NOT_APPLICABLE',
      baseCandidateRef: input.candidateRef,
      parentSourceId: selectedSourceRef,
      matchedRuleRefs: [],
      evaluatedPatientEvidenceRefs: [],
      version: context.workspaceStore.version,
    };
  }

  return {
    ok: true,
    selectedCandidateRef: input.candidateRef,
    selectedSourceRef,
    primaryFormulaRef,
    sourceFormulaCount: sourceFormulaSet.formulas.length,
    modificationRuleCount: modificationItems.length,
    modificationState: isP2CaseSource ? 'NOT_APPLICABLE' : (modificationItems.length > 0 ? 'PRESENT' : 'KNOWN_EMPTY'),
    sourceAuthority: isP2CaseSource ? 'P2_CASE_DERIVED' : 'P1',
  };
}
