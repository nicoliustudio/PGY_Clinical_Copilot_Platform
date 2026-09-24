/**
 * Authority-owned fact namespaces for the baseline clinical assessment product.
 *
 * This module deliberately knows no treatment modality. It defines the clinical-assessment side
 * of the boundary: assessment may own diagnostic/treatment-principle facts, while exact product
 * execution facts are owned by treatment-delivery CommitRecords.
 */
export const CLINICAL_ASSESSMENT_FACT_FIELDS = [
  'disease',
  'syndrome',
  'treatmentPrinciple',
  'treatmentTarget',
  'rationale',
] as const;

const ASSESSMENT_FACT_FIELD_SET = new Set<string>(CLINICAL_ASSESSMENT_FACT_FIELDS);

export interface ClinicalAssessmentProductInput {
  disease: string;
  syndrome: string;
  treatmentPrinciple: string;
  treatmentTarget?: string;
  rationale?: string;
}

export function buildClinicalAssessmentProduct(input: ClinicalAssessmentProductInput): Readonly<Record<string, unknown>> {
  return {
    disease: input.disease,
    syndrome: input.syndrome,
    treatmentPrinciple: input.treatmentPrinciple,
    ...(input.treatmentTarget?.trim() ? { treatmentTarget: input.treatmentTarget } : {}),
    ...(input.rationale?.trim() ? { rationale: input.rationale } : {}),
  };
}

export function validateClinicalAssessmentFactOwnership(product: Readonly<Record<string, unknown>>): {
  ok: boolean;
  forbiddenFields: string[];
} {
  const forbiddenFields = Object.keys(product).filter((key) => !ASSESSMENT_FACT_FIELD_SET.has(key));
  return { ok: forbiddenFields.length === 0, forbiddenFields };
}
