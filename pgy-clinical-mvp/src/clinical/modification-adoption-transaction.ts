import type { ModificationPlan } from '../contracts/workspace.js';
import type { RuntimeContext } from '../contracts/runtime.js';
import { renderMedicationList, searchModificationEvidence } from './modification-evidence.js';
import type { ModificationEvidenceCandidate } from '../contracts/workspace.js';

/**
 * Modification Retrieval != Modification Adoption.
 *
 * `formula.select` must not auto-write durable modification plans. Discovery only produces evidence;
 * a separate explicit transaction turns discovered evidence into a patient-specific plan through a
 * closed-world ADOPT/REJECT decision. The deterministic matcher has no clinical prescribing authority.
 */

export interface ModificationAdoptionDecision {
  modificationEvidenceRef: string;
  disposition: 'ADOPT' | 'REJECT';
  rationale?: string;
}

export type ModificationAdoptionResult =
  | { ok: true; adoptedCount: number; decisionReceipt: ModificationAdoptionDecision[] }
  | { ok: false; code: 'BASE_FORMULA_REQUIRED' | 'SOURCE_NOT_HYDRATED' | 'PRODUCT_QUALIFICATION_REQUIRED' | 'NOT_APPLICABLE' | 'MODIFICATION_EVIDENCE_UNAVAILABLE' | 'ADOPTION_VALIDATION_FAILED'; details: string[] };

/**
 * Pure closed-world adoption over the evidence returned to the model.
 * - every decision must reference a discovered evidence (unknown ref fail-closed);
 * - every discovered evidence must have exactly one decision (omission is neither reject nor adopt);
 * - only ADOPT enters the durable plan.
 */
export function adoptModificationEvidence(
  discovered: readonly ModificationEvidenceCandidate[],
  decisions: readonly ModificationAdoptionDecision[],
): { items: ModificationPlan['items']; decisionReceipt: ModificationAdoptionDecision[] } {
  const evidence = new Map(discovered.map((item) => [item.modificationEvidenceRef, item]));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (!evidence.has(decision.modificationEvidenceRef)) {
      throw new Error(`unknown modification evidence: ${decision.modificationEvidenceRef}`);
    }
    if (seen.has(decision.modificationEvidenceRef)) {
      throw new Error(`duplicate modification decision: ${decision.modificationEvidenceRef}`);
    }
    seen.add(decision.modificationEvidenceRef);
  }
  // Closed-world over the evidence returned to the model: omission cannot silently become adoption.
  for (const item of discovered) {
    if (!seen.has(item.modificationEvidenceRef)) {
      throw new Error(`modification evidence has no adoption decision: ${item.modificationEvidenceRef}`);
    }
  }
  return {
    items: decisions
      .filter((decision) => decision.disposition === 'ADOPT')
      .map((decision) => {
        const item = evidence.get(decision.modificationEvidenceRef)!;
        return {
          // 文本是结构化用药的投影：逐味「药名+剂量」相邻，配对信息不被拆成两条平行列表。
          statement: renderMedicationList(item.medications),
          patientEvidenceRefs: [...item.matchedPatientEvidenceRefs],
          assessmentRefs: [...item.matchedAssessmentRefs],
          sourceEvidenceRefs: [item.modificationEvidenceRef, item.sourceRef].filter(Boolean),
        };
      }),
    decisionReceipt: [...decisions],
  };
}

/**
 * Explicit adoption transaction. Re-discovers modification evidence deterministically, validates the
 * model's closed-world ADOPT/REJECT decisions, and only then writes a durable ModificationPlan.
 * Until this runs (successfully), patient-specific modification state remains UNKNOWN.
 */
export async function adoptCanonicalModifications(
  context: RuntimeContext,
  decisions: ModificationAdoptionDecision[],
): Promise<ModificationAdoptionResult> {
  const selected = context.workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef;
  if (!selected) {
    return { ok: false, code: 'BASE_FORMULA_REQUIRED', details: ['select a base formula before adopting modifications'] };
  }
  const sourceFormulaSet = context.workspace.sourceFormulaSet;
  if (!sourceFormulaSet) {
    return { ok: false, code: 'SOURCE_NOT_HYDRATED', details: ['selected source is not hydrated'] };
  }
  if (sourceFormulaSet.sourceAuthority === 'P2_CASE_DERIVED') {
    return { ok: false, code: 'NOT_APPLICABLE', details: ['P2 case source has no modification adoption surface'] };
  }

  // Patient-specific modifications are product-scoped execution facts. Source selection alone does not
  // authorize the Kernel to guess a product target. Until the adoption input carries an explicit target
  // product, exactly one product must already be clinically qualified by the selection transaction.
  const qualifiedProducts = sourceFormulaSet.formulas.filter((formula) => formula.clinicalQualification === 'CURRENTLY_SELECTED');
  if (qualifiedProducts.length !== 1) {
    return {
      ok: false,
      code: 'PRODUCT_QUALIFICATION_REQUIRED',
      details: [`patient-specific modification adoption requires exactly one explicitly selected product; got ${qualifiedProducts.length}`],
    };
  }

  const discovered = searchModificationEvidence(context.workspace, Number.MAX_SAFE_INTEGER);
  if (discovered.result === 'UNAVAILABLE') {
    return { ok: false, code: 'MODIFICATION_EVIDENCE_UNAVAILABLE', details: [discovered.reason ?? 'modification evidence store unavailable'] };
  }

  try {
    const { items, decisionReceipt } = adoptModificationEvidence(discovered.candidates, decisions);
    if (items.length > 0) {
      context.workspaceStore.append('modification.plan.recorded', { items });
    }
    context.workspace.modificationEvidenceClosure = {
      status: discovered.result === 'FOUND' ? 'FOUND' : 'SEARCHED_NONE',
      baseCandidateRef: selected,
      parentSourceId: sourceFormulaSet.parentRecordRef,
      matchedRuleRefs: discovered.candidates.map((item) => item.modificationEvidenceRef).filter(Boolean),
      evaluatedPatientEvidenceRefs: [...new Set(discovered.candidates.flatMap((item) => item.matchedPatientEvidenceRefs))],
      version: context.workspaceStore.version,
    };
    return { ok: true, adoptedCount: items.length, decisionReceipt };
  } catch (error) {
    return { ok: false, code: 'ADOPTION_VALIDATION_FAILED', details: [error instanceof Error ? error.message : String(error)] };
  }
}
