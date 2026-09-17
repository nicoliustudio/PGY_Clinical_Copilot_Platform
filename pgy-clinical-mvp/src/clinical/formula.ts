import { search } from '../knowledge/search.js';
import { loadIndex } from '../knowledge/build.js';
import { validateNormativeFormulaInDocs } from './formula-binding.js';

export interface NormativeFormulaResult {
  authority: 'NORMATIVE';
  formulaId: string;
  name: string;
  composition: string;
  sourceId: string;
  source: string;
  disease: string;
  syndrome: string;
  treatment: string;
  score: number;
}

export async function searchNormative(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
): Promise<NormativeFormulaResult[]> {
  const hits = await search(query, topK, scopes);
  const out: NormativeFormulaResult[] = [];
  for (const h of hits) {
    if (h.authority !== 'P1') continue;
    for (const f of h.formulas) {
      if (!f.composition) continue;
      out.push({
        authority: 'NORMATIVE', formulaId: f.id, name: f.name,
        composition: f.composition, sourceId: h.sourceId,
        source: h.provenance.source, disease: h.provenance.disease,
        syndrome: h.provenance.syndrome, treatment: h.provenance.treatment,
        score: h.score,
      });
    }
  }
  return out;
}

function normalize(s: string): string {
  return s.replace(/[\s，。、,.;；:：()（）\[\]【】{}《》<>'"“”‘’\-_]/g, '');
}

export interface ValidationResult {
  valid: boolean;
  matchedFormulaId?: string;
  matchedName?: string;
  matchedSourceId?: string;
}

export async function validateFormula(composition: string): Promise<ValidationResult> {
  const idx = await loadIndex();
  const target = normalize(composition);
  if (!target) return { valid: false };
  for (const doc of idx.docs) {
    if (doc.tier !== 'P1') continue;
    for (const f of doc.formulas) {
      if (normalize(f.composition) === target) {
        return { valid: true, matchedFormulaId: f.id, matchedName: f.name, matchedSourceId: doc.id };
      }
    }
  }
  return { valid: false };
}


/** Authority-grade validation: source + formula + composition must bind to the same P1 record. */
export async function validateNormativeFormula(input: {
  sourceId: string;
  formulaId: string;
  composition: string;
}): Promise<ValidationResult> {
  const idx = await loadIndex();
  return validateNormativeFormulaInDocs(idx.docs, input);
}
