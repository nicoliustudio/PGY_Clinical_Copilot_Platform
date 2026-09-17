export const FORMULA_AUTHORITY_STATES = ['NORMATIVE', 'GENERATED_DRAFT', 'BLOCKED'] as const;
export type FormulaAuthorityState = (typeof FORMULA_AUTHORITY_STATES)[number];

export interface FormulaAuthorityInput {
  authority: FormulaAuthorityState;
  composition: string[];
  sourceId: string;
  formulaId: string;
}

export interface FormulaAuthorityOutput {
  authority: FormulaAuthorityState;
  reason?: string;
}
