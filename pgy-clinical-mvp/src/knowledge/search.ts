import { loadIndex } from './build.js';
import { cosine, embed, rerank } from '../model/adapter.js';
import type { SearchHit } from './types.js';

const HYBRID_CANDIDATE_K = 40;

/**
 * knowledge.search：dense 召回 → rerank 精排 → 结构化 Top-K。
 * 返回 source_id / title / authority / excerpt / score / provenance。
 */
export async function search(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
): Promise<SearchHit[]> {
  const idx = await loadIndex();
  const scopeSet = new Set(scopes);
  const [qv] = await embed([query]);

  // dense 召回（按激活的 Capability scopes 过滤）
  const scored = idx.docs
    .map((doc, i) => ({ doc, i, score: cosine(qv, idx.vectors[i]) }))
    .filter((s) => scopeSet.has(s.doc.scope));
  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, HYBRID_CANDIDATE_K);

  // rerank 精排
  const ranked = await rerank(
    query,
    candidates.map((c) => c.doc.text),
    topK,
  );

  return ranked.map((r) => {
    const { doc } = candidates[r.index];
    return {
      sourceId: doc.id,
      title: doc.title,
      authority: doc.tier,
      excerpt: doc.text.slice(0, 400),
      score: r.score,
      provenance: {
        source: doc.source,
        sourceFile: doc.sourceFile,
        disease: doc.disease,
        syndrome: doc.syndrome,
        treatment: doc.treatment,
      },
      formulas: doc.formulas,
    };
  });
}
