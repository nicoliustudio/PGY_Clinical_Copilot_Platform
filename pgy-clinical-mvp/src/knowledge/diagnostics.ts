export interface RankItem {
  sourceId: string;
  /** 1-based rank within the candidate list */
  rank: number;
  score: number;
}

export interface RetrievalDiagnostics {
  tool: 'knowledge.search' | 'formula.search_normative';
  query: string;
  scopes: string[];
  topK: number;
  /** dense 召回 Top-K 候选（未 rerank） */
  dense: RankItem[];
  /** rerank 后最终返回的 Top-K */
  reranked: RankItem[];
  /** formula.search_normative 时，Agent 引用的 opaque promotion work item */
  promotionWorkItemRef?: string;
  /** Runtime 由 promotionWorkItemRef 解析出的真实 hypothesis ref（不来自 LLM） */
  resolvedHypothesisRef?: string;
  /** 本次搜索返回的 candidateRefs（标识搜索所属 reasoning branch） */
  candidateRefs?: string[];
}
