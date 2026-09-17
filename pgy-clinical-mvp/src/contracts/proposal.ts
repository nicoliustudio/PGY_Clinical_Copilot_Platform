/** 三态方剂权威状态 —— 封闭世界的有限安全状态，允许强类型。 */
export const FORMULA_AUTHORITY_STATES = [
  'NORMATIVE',
  'GENERATED_DRAFT',
  'BLOCKED',
] as const;

export type FormulaAuthorityState = (typeof FORMULA_AUTHORITY_STATES)[number];

export interface FormulaAuthorityInput {
  authority: FormulaAuthorityState;
  composition: string[];
  sourceId: string;
}

export interface FormulaAuthorityOutput {
  authority: FormulaAuthorityState;
  reason?: string;
}
