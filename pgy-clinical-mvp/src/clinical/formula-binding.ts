import type { KnowledgeDoc } from '../knowledge/types.js';

export interface FormulaBindingValidationResult {
  valid: boolean;
  matchedFormulaId?: string;
  matchedName?: string;
  matchedSourceId?: string;
}

function normalize(s: string): string {
  return s.replace(/[\s，。、,.;；:：()（）\[\]【】{}《》<>'"“”‘’\-_]/g, '');
}

/** Pure invariant helper: source + formula + composition must identify one P1 record. */
export function validateNormativeFormulaInDocs(
  docs: KnowledgeDoc[],
  input: { sourceId: string; formulaId: string; composition: string },
): FormulaBindingValidationResult {
  const target = normalize(input.composition);
  const doc = docs.find((d) => d.id === input.sourceId && d.sourceTier === 'P1');
  if (!doc || !target) return { valid: false };
  const formula = doc.formulas.find(
    (f) => f.id === input.formulaId && normalize(f.composition) === target,
  );
  return formula
    ? {
        valid: true,
        matchedFormulaId: formula.id,
        matchedName: formula.name,
        matchedSourceId: doc.id,
      }
    : { valid: false };
}
