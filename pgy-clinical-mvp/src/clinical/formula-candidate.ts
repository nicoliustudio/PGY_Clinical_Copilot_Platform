export interface FormulaCandidate {
  candidateRef: string;
  formulaId: string;
  sourceId: string;
}

export interface CanonicalFormulaRecord {
  formulaId: string;
  sourceId: string;
  composition: string[];
}

/**
 * LLM selects candidateRef. Runtime hydrates canonical identity.
 * The model should never author source_id/formula_id/composition.
 */
export function hydrateCanonicalFormula(
  candidate: FormulaCandidate,
  records: CanonicalFormulaRecord[],
): CanonicalFormulaRecord | undefined {
  return records.find(
    (item) => item.formulaId === candidate.formulaId && item.sourceId === candidate.sourceId,
  );
}
