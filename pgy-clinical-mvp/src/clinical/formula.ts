import { searchWithDiagnostics } from '../knowledge/search.js';
import { loadIndex } from '../knowledge/build.js';
import type { RetrievalDiagnostics } from '../knowledge/diagnostics.js';
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

export interface NormativeSearchWithDiagnostics {
  results: NormativeFormulaResult[];
  diagnostics: RetrievalDiagnostics;
}

export async function searchNormativeWithDiagnostics(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
): Promise<NormativeSearchWithDiagnostics> {
  const { hits, diagnostics } = await searchWithDiagnostics(query, topK, scopes, 'formula.search_normative');
  const results: NormativeFormulaResult[] = [];
  for (const h of hits) {
    if (h.authority !== 'P1') continue;
    for (const f of h.formulas) {
      if (!f.composition) continue;
      results.push({
        authority: 'NORMATIVE', formulaId: f.id, name: f.name,
        composition: f.composition, sourceId: h.sourceId,
        source: h.provenance.source, disease: h.provenance.disease,
        syndrome: h.provenance.syndrome, treatment: h.provenance.treatment,
        score: h.score,
      });
    }
  }
  return { results, diagnostics };
}

export async function searchNormative(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
): Promise<NormativeFormulaResult[]> {
  return (await searchNormativeWithDiagnostics(query, topK, scopes)).results;
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
