import type { FormulaCardinality } from './types.js';
import type { SourceFormulaSet } from '../contracts/workspace.js';

export interface ProjectedFormula {
  formulaRef: string;
  formulaId: string;
  name: string;
  composition: string;
  sourceRef: string;
  sourceModifications: string[];
  sourceLevelModifications: string[];
  modificationStatus: SourceFormulaSet['formulas'][number]['modificationStatus'];
  usage?: string;
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
  // SOURCE_SIBLING_COMPLETENESS: once a canonical source parent is adopted, every ACTIVE
  // sibling formula is a deliverable. `formulaCardinality` remains a request/completion constraint;
  // it must never be used as a projection filter that silently drops source siblings.
  // PRIMARY_ONLY therefore means one reasoning anchor, not one visible source product.
  void cardinality;
  // SOURCE COMPLETENESS: clinical exclusion changes qualification, never source membership.
  return set.formulas.map((f) => ({
    formulaRef: f.formulaRef,
    formulaId: f.formulaId,
    name: f.formulaName,
    composition: f.composition,
    sourceRef: set.parentRecordRef,
    sourceModifications: [...f.sourceModifications],
    sourceLevelModifications: [...set.sourceLevelModifications],
    modificationStatus: f.modificationStatus,
    usage: f.usage,
    relation: f.relation,
    applicableModifications: f.applicableModifications,
  }));
}
