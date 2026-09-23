import type { FormulaCardinality } from './types.js';
import type { SourceFormulaSet } from '../contracts/workspace.js';

export interface ProjectedFormula {
  formulaRef: string;
  formulaId: string;
  name: string;
  composition: string;
  relation: 'PRIMARY_SELECTED' | 'SOURCE_ALTERNATIVE' | 'CLINICALLY_EXCLUDED';
  applicableModifications: SourceFormulaSet['formulas'][number]['applicableModifications'];
}

/**
 * Deterministic formula projection. The model does not get a second chance to silently drop
 * source alternatives or copy generic conditional modifications into patient-specific advice.
 */
export function projectFormulaSet(
  set: SourceFormulaSet | undefined,
  cardinality: FormulaCardinality,
): ProjectedFormula[] {
  if (!set) return [];
  const eligible = set.formulas.filter((f) => f.relation !== 'CLINICALLY_EXCLUDED');
  const primary = eligible.filter((f) => f.relation === 'PRIMARY_SELECTED');
  let selected = eligible;
  if (cardinality.mode === 'PRIMARY_ONLY') selected = primary.slice(0, 1);
  if (cardinality.mode === 'AT_LEAST') {
    const ordered = [...primary, ...eligible.filter((f) => f.relation !== 'PRIMARY_SELECTED')];
    selected = ordered.slice(0, Math.max(cardinality.count, primary.length));
  }
  return selected.map((f) => ({
    formulaRef: f.formulaRef,
    formulaId: f.formulaId,
    name: f.formulaName,
    composition: f.composition,
    relation: f.relation,
    applicableModifications: f.applicableModifications,
  }));
}
