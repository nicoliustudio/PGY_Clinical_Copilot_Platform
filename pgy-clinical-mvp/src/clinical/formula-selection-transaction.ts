import type { RuntimeContext } from '../contracts/runtime.js';
import type { CandidateReference, CaseFact, FormulaCandidateDecision, SourceFormulaSet } from '../contracts/workspace.js';
import { loadIndex } from '../knowledge/build.js';
import type { KnowledgeIndex } from '../knowledge/types.js';
import { formulaSelectionReady, focusedFormulaCandidateRefs, missingFocusedFormulaEvidence } from './formula-selection.js';
import { hydrateSourceFormulaSetForCandidate } from './source-formula-set.js';
import { caseFactCanBackDecision } from './canonical-clinical-state.js';

export type FormulaSelectionTransactionResult =
  | {
      ok: true;
      selectedCandidateRef: string;
      selectedSourceRef: string;
      primaryFormulaRef?: string;
      sourceFormulaCount: number;
      /** Selection no longer scans/adopts modifications. Discovery closure is recorded by the adoption transaction. */
      modificationRuleCount: number;
      modificationState: 'UNKNOWN' | 'PRESENT' | 'KNOWN_EMPTY' | 'NOT_APPLICABLE';
      sourceAuthority: 'P1' | 'P2_CASE_DERIVED';
    }
  | {
      ok: false;
      code: 'UNKNOWN_CANDIDATE_REF' | 'CANDIDATE_NOT_FOCUSED' | 'CANDIDATE_EXCLUDED' | 'CANDIDATE_DELIBERATION_INCOMPLETE' | 'FORMULA_EVIDENCE_INCOMPLETE' | 'CANONICAL_HYDRATION_FAILED' | 'FACT_BACKING_INVALID';
      details: string[];
    };

export interface FormulaSelectionDependencies {
  loadIndex: () => Promise<KnowledgeIndex>;
  hydrateSourceFormulaSet: (docs: KnowledgeIndex['docs'], candidate: CandidateReference) => SourceFormulaSet | null;
}

const DEFAULT_DEPENDENCIES: FormulaSelectionDependencies = {
  loadIndex,
  hydrateSourceFormulaSet: hydrateSourceFormulaSetForCandidate,
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
  if (selected && selected.disposition !== 'CONSIDERED') {
    details.push(`selected candidate must be CONSIDERED: ${selectedCandidateRef}`);
    return { ok: false, details, selectedExcluded: true };
  }
  if (!selected) details.push(`selected candidate has no decision: ${selectedCandidateRef}`);
  return details.length === 0 ? { ok: true } : { ok: false, details };
}

/**
 * P0-5: fact-backed disposition validation.
 *
 * The rationale is explanation only. Disposition authority comes from typed patient facts:
 * - CONSIDERED requires >=1 known supporting patient fact.
 * - EXCLUDED requires >=1 known contradicting patient fact.
 * - INSUFFICIENT_EVIDENCE requires >=1 missingCriticalEvidence item and no fabricated negative fact.
 *
 * PRESENT and explicitly_absent are both real patient facts. `unknown` is NOT_MENTIONED and cannot
 * support or contradict a decision. Semantic fit between the cited fact and candidate criterion remains
 * model judgment; the Kernel guarantees epistemic provenance, not disease-specific rules.
 */
export function validateFactBackedDecision(
  caseFacts: CaseFact[],
  decisions: FormulaCandidateDecision[],
): { ok: true } | { ok: false; details: string[] } {
  const byId = new Map(caseFacts.map((f) => [f.id, f]));
  const details: string[] = [];

  const validateRefs = (decision: FormulaCandidateDecision, refs: readonly string[], role: 'support' | 'contradiction') => {
    for (const ref of refs) {
      const fact = byId.get(ref);
      if (!fact) {
        details.push(`${role} fact ref is not a patient fact: ${ref}`);
        continue;
      }
      if (!caseFactCanBackDecision(fact)) {
        details.push(`${role} fact ref is UNKNOWN/NOT_MENTIONED and cannot back a disposition: ${ref}`);
      }
    }
  };

  for (const decision of decisions) {
    const support = decision.supportingFactRefs ?? [];
    const contradiction = decision.contradictingFactRefs ?? [];
    const missing = decision.missingCriticalEvidence ?? [];

    validateRefs(decision, support, 'support');
    validateRefs(decision, contradiction, 'contradiction');

    if (decision.disposition === 'CONSIDERED' && support.length === 0) {
      details.push(`CONSIDERED candidate requires supportingFactRefs: ${decision.candidateRef}`);
    }
    if (decision.disposition === 'EXCLUDED' && contradiction.length === 0) {
      details.push(`EXCLUDED candidate requires contradictingFactRefs: ${decision.candidateRef}`);
    }
    if (decision.disposition === 'INSUFFICIENT_EVIDENCE' && missing.length === 0) {
      details.push(`INSUFFICIENT_EVIDENCE candidate requires missingCriticalEvidence: ${decision.candidateRef}`);
    }
  }

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

  // P0-5: every clinical disposition must be backed by typed patient facts or typed missing evidence.
  const factCheck = validateFactBackedDecision(context.workspace.caseFacts, input.candidateDecisions ?? []);
  if (!factCheck.ok) {
    return { ok: false, code: 'FACT_BACKING_INVALID', details: factCheck.details };
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

  const receipt = context.workspace.candidateSetReceipt;
  const selectedBinding = receipt?.evidenceBindings.find((binding) => binding.candidateRef === input.candidateRef);
  const selectedSourceRef = candidate.sourceId ?? sourceFormulaSet.parentRecordRef;
  // Product qualification is the only source of a primary ref. Source hydration alone yields 0 CURRENTLY_SELECTED.
  const primaryFormulaRef = sourceFormulaSet.formulas.find((formula) => formula.clinicalQualification === 'CURRENTLY_SELECTED')?.formulaRef;

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

  // Retrieval != Adoption: formula.select does NOT scan or write modification evidence. A separate explicit
  // `formula.adopt_modifications` transaction owns discovery → closed-world ADOPT/REJECT → durable ModificationPlan.
  // Until adoption, patient-specific modification state is UNKNOWN (never KNOWN_EMPTY, never auto-filled).
  return {
    ok: true,
    selectedCandidateRef: input.candidateRef,
    selectedSourceRef,
    primaryFormulaRef,
    sourceFormulaCount: sourceFormulaSet.formulas.length,
    modificationRuleCount: 0,
    modificationState: isP2CaseSource ? 'NOT_APPLICABLE' : 'UNKNOWN',
    sourceAuthority: isP2CaseSource ? 'P2_CASE_DERIVED' : 'P1',
  };
}
