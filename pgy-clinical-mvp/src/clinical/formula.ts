import { search } from '../knowledge/search.js';
import { loadIndex } from '../knowledge/build.js';

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

/**
 * formula.search_normative：在病例/治法方向下检索知识库已存在的 P1 规范方。
 * 只返回带真实 composition 的 P1 条目，绝不返回模型凭空生成的方子。
 */
export async function searchNormative(
  query: string,
  topK = 10,
): Promise<NormativeFormulaResult[]> {
  const hits = await search(query, topK);
  const out: NormativeFormulaResult[] = [];
  for (const h of hits) {
    if (h.authority !== 'P1') continue;
    for (const f of h.formulas) {
      if (!f.composition) continue;
      out.push({
        authority: 'NORMATIVE',
        formulaId: f.id,
        name: f.name,
        composition: f.composition,
        sourceId: h.sourceId,
        source: h.provenance.source,
        disease: h.provenance.disease,
        syndrome: h.provenance.syndrome,
        treatment: h.provenance.treatment,
        score: h.score,
      });
    }
  }
  return out;
}

/** 归一化：去掉空白与中英文标点，用于防止方剂组成被模型悄悄改写。 */
function normalize(s: string): string {
  return s.replace(/[\s，。、,.;；:：()（）\[\]【】{}《》<>'"“”‘’\-_]/g, '');
}

export interface ValidationResult {
  valid: boolean;
  matchedFormulaId?: string;
  matchedName?: string;
  matchedSourceId?: string;
}

/**
 * formula.validate：验证最终引用的方剂组成在知识库中真实存在、未被篡改。
 */
export async function validateFormula(
  composition: string,
): Promise<ValidationResult> {
  const idx = await loadIndex();
  const target = normalize(composition);
  if (!target) return { valid: false };
  for (const doc of idx.docs) {
    if (doc.tier !== 'P1') continue;
    for (const f of doc.formulas) {
      if (normalize(f.composition) === target) {
        return {
          valid: true,
          matchedFormulaId: f.id,
          matchedName: f.name,
          matchedSourceId: doc.id,
        };
      }
    }
  }
  return { valid: false };
}
