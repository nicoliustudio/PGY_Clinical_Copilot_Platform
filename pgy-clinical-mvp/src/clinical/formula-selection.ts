import type { ClinicalWorkspace } from '../contracts/workspace.js';

/**
 * CandidateSetReceipt is the only durable truth for the treatment-retrieval stage.
 * Discovery + canonical hydration are one Runtime transaction; the model never owns frontier membership.
 */
export function focusedFormulaCandidateRefs(workspace: ClinicalWorkspace): string[] {
  const formulaIds = new Set(workspace.candidates.filter((candidate) => candidate.kind === 'formula').map((candidate) => candidate.id));
  const receiptRefs = workspace.candidateSetReceipt?.candidateRefs ?? workspace.deliberationState.frontier;
  return receiptRefs.filter((ref) => formulaIds.has(ref));
}

export function hydratedFormulaCandidateRefs(workspace: ClinicalWorkspace): Set<string> {
  return new Set(workspace.evidenceState.evidenceItems.flatMap((item) => item.relatedCandidates));
}

export function missingFocusedFormulaEvidence(workspace: ClinicalWorkspace): string[] {
  const refs = focusedFormulaCandidateRefs(workspace);
  if (refs.length === 0) return [];
  const receipt = workspace.candidateSetReceipt;
  if (receipt) {
    const bound = new Map(receipt.evidenceBindings.map((binding) => [binding.candidateRef, binding.evidenceRefs]));
    return refs.filter((ref) => (bound.get(ref)?.length ?? 0) === 0);
  }
  const hydrated = hydratedFormulaCandidateRefs(workspace);
  return refs.filter((ref) => !hydrated.has(ref));
}

export function formulaSelectionReady(workspace: ClinicalWorkspace): boolean {
  const refs = focusedFormulaCandidateRefs(workspace);
  return refs.length > 0 && missingFocusedFormulaEvidence(workspace).length === 0;
}

/**
 * Legacy observability only. Candidate deliberation is now submitted atomically with formula.select;
 * omission cannot become selection authority because the transaction accounts the whole CandidateSetReceipt.
 */
export function missingCandidateDeliberation(workspace: ClinicalWorkspace): string[] {
  if (workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef) return [];
  return focusedFormulaCandidateRefs(workspace);
}

export function formulaDecisionReady(workspace: ClinicalWorkspace): boolean {
  return formulaSelectionReady(workspace);
}
