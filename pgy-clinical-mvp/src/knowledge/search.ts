import { loadIndex } from './build.js';
import { cosine, embed, rerank } from '../model/adapter.js';
import type { SearchHit } from './types.js';
import type { RetrievalDiagnostics } from './diagnostics.js';

const HYBRID_CANDIDATE_K = 40;

export interface SearchWithDiagnostics {
  hits: SearchHit[];
  diagnostics: RetrievalDiagnostics;
}

/**
 * knowledge.search：dense 召回 → rerank 精排 → 结构化 Top-K。
 * 同时返回 dense/rerank 的 rank/score，供 Retrieval 诊断，不改变检索行为。
 */
export async function searchWithDiagnostics(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
  tool: RetrievalDiagnostics['tool'] = 'knowledge.search',
): Promise<SearchWithDiagnostics> {
  const idx = await loadIndex();
  const scopeSet = new Set(scopes);
  const [qv] = await embed([query]);

  const scored = idx.docs
    .map((doc, i) => ({ doc, i, score: cosine(qv, idx.vectors[i]) }))
    .filter((s) => scopeSet.has(s.doc.scope))
    .sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, HYBRID_CANDIDATE_K);
  const ranked = await rerank(query, candidates.map((c) => c.doc.text), topK);

  const dense = candidates.map((c, index) => ({
    sourceId: c.doc.id,
    rank: index + 1,
    score: c.score,
  }));
  const reranked = ranked.map((r, index) => ({
    sourceId: candidates[r.index].doc.id,
    rank: index + 1,
    score: r.score,
  }));

  const hits = ranked.map((r) => {
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

  return {
    hits,
    diagnostics: { tool, query, scopes, topK, dense, reranked },
  };
}

export async function search(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
): Promise<SearchHit[]> {
  return (await searchWithDiagnostics(query, topK, scopes, 'knowledge.search')).hits;
}

/** Read one full knowledge source by id, constrained by active scopes. */
export async function getSource(
  sourceId: string,
  scopes: string[] = ['general'],
): Promise<import('./types.js').KnowledgeDoc | null> {
  const idx = await loadIndex();
  const allowed = new Set(scopes);
  return idx.docs.find((doc) => doc.id === sourceId && allowed.has(doc.scope)) ?? null;
}
