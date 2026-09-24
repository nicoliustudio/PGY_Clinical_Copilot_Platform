import { loadIndex } from './build.js';
import { cosine, embed, rerank } from '../model/adapter.js';
import type { Kind, KnowledgeDoc, KnowledgeRole, SearchHit } from './types.js';
import type { RetrievalDiagnostics } from './diagnostics.js';

const HYBRID_CANDIDATE_K = 40;

export interface SearchWithDiagnostics {
  hits: SearchHit[];
  diagnostics: RetrievalDiagnostics;
}

export interface SearchOptions {
  /** role-aware 检索：仅在该知识角色内召回。 */
  role?: KnowledgeRole;
  /** kind 过滤：仅在指定文档形态内召回（如 P2 病例方药单元 kind='case-formula'）。 */
  kind?: Kind;
  /** P1 → P2 fallback 原因（由 Agent 标注，可选）。 */
  fallbackReason?: string;
  /**
   * Recall-preservation guard for source-discovery channels. Keeps the strongest dense recalls
   * visible even when the reranker omits them. This is not a score boost and does not infer medicine;
   * it only prevents a downstream ranker from deleting upstream candidate visibility.
   */
  denseRecallGuard?: number;
}

/** 纯函数：按知识角色过滤文档。无 role 时不过滤（fail-open 仅限「未指定」；指定未知 role 不会发生，因为调用方枚举受限）。 */
export function filterDocsByRole(docs: KnowledgeDoc[], role?: KnowledgeRole): KnowledgeDoc[] {
  if (!role) return docs;
  return docs.filter((d) => d.knowledgeRole === role);
}

/**
 * knowledge.search：role 过滤 → dense 召回 → rerank 精排 → 结构化 Top-K。
 * 返回 dense/rerank 的 rank/score 与 fallback 观测字段，不改变检索行为。
 */
export async function searchWithDiagnostics(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
  tool: RetrievalDiagnostics['tool'] = 'knowledge.search',
  options: SearchOptions = {},
): Promise<SearchWithDiagnostics> {
  const idx = await loadIndex();
  const scopeSet = new Set(scopes);
  const [qv] = await embed([query]);

  const roleFiltered: { doc: KnowledgeDoc; i: number }[] = [];
  for (let i = 0; i < idx.docs.length; i++) {
    const doc = idx.docs[i];
    if (options.role && doc.knowledgeRole !== options.role) continue;
    if (options.kind && doc.kind !== options.kind) continue;
    if (!scopeSet.has(doc.scope ?? 'general')) continue;
    roleFiltered.push({ doc, i });
  }

  const scored = roleFiltered
    .map(({ doc, i }) => ({ doc, i, score: cosine(qv, idx.vectors[i]) }))
    .sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, HYBRID_CANDIDATE_K);
  const ranked = candidates.length
    ? await rerank(query, candidates.map((c) => c.doc.text), topK)
    : [];

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

  const denseGuard = Math.max(0, Math.min(options.denseRecallGuard ?? 0, topK, candidates.length));
  const selected: Array<{ index: number; score: number }> = [];
  const seen = new Set<number>();
  for (let i = 0; i < denseGuard; i++) {
    selected.push({ index: i, score: candidates[i].score });
    seen.add(i);
  }
  for (const r of ranked) {
    if (seen.has(r.index)) continue;
    selected.push({ index: r.index, score: r.score });
    seen.add(r.index);
    if (selected.length >= topK) break;
  }

  const hits: SearchHit[] = selected.map((r) => {
    const { doc } = candidates[r.index];
    return {
      sourceId: doc.id,
      title: doc.title,
      authority: doc.sourceTier,
      sourceTier: doc.sourceTier,
      knowledgeRole: doc.knowledgeRole,
      prescriptionAuthority: doc.prescriptionAuthority,
      excerpt: doc.text.slice(0, 400),
      score: r.score,
      provenance: {
        source: doc.source,
        sourceFile: doc.sourceFile,
        disease: doc.disease,
        syndrome: doc.syndrome,
        treatment: doc.treatment,
        sourceSchool: doc.sourceSchool,
      },
      formulas: doc.formulas,
      shortEvidenceSummary: doc.text.slice(0, 160),
      matchedConcepts: [doc.disease, doc.syndrome].filter(Boolean),
      candidateRefs: doc.formulas.map((f) => `${doc.id}::${f.id}`),
      detailAvailable: true,
      kind: doc.kind,
      caseId: doc.caseId,
      visit: doc.visit,
      composition: doc.composition,
      sourceSpanId: doc.sourceSpanId,
      patient: doc.patient,
      symptoms: doc.symptoms,
      formulaName: doc.formulaName,
    };
  });

  const topHit = hits[0];
  const p1Usable = hits.some((h) => h.sourceTier === 'P1');

  const diagnostics: RetrievalDiagnostics = {
    tool,
    query,
    scopes,
    topK,
    requestedRole: options.role,
    sourceTier: topHit?.sourceTier,
    sourceSchool: topHit?.provenance.sourceSchool,
    p1Attempted: options.role === 'NORMATIVE_TREATMENT' || options.role === undefined,
    p2Attempted: options.role === 'CLINICAL_CASE',
    p1Usable,
    fallbackToP2: options.role === 'CLINICAL_CASE',
    fallbackReason: options.fallbackReason,
    dense,
    reranked,
  };

  return { hits, diagnostics };
}

export async function search(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  return (await searchWithDiagnostics(query, topK, scopes, 'knowledge.search', options)).hits;
}

/** H6 Source cache：同一 sourceId + detailLevel + scopes 复读不重复解析/截断。 */
const sourceCache = new Map<string, KnowledgeDoc | null>();

/** Read one full knowledge source by id, constrained by active scopes. detailLevel 默认 excerpt。 */
export async function getSource(
  sourceId: string,
  scopes: string[] = ['general'],
  detailLevel: 'excerpt' | 'full' = 'excerpt',
): Promise<KnowledgeDoc | null> {
  const allowed = new Set(scopes);
  const cacheKey = `${[...allowed].sort().join(',')}::${sourceId}::${detailLevel}`;
  if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey)!;

  const idx = await loadIndex();
  const doc = idx.docs.find((d) => d.id === sourceId && allowed.has(d.scope ?? 'general')) ?? null;
  const result = doc && detailLevel === 'excerpt' ? { ...doc, text: doc.text.slice(0, 400) } : doc;
  sourceCache.set(cacheKey, result);
  return result;
}
