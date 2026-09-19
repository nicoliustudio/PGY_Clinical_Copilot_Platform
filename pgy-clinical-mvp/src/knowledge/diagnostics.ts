import type { KnowledgeRole, SourceSchool, SourceTier } from './types.js';

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
  /** 本次检索请求的知识角色（role-aware search）。 */
  requestedRole?: KnowledgeRole;
  /** 检索结果命中的粗粒度来源层级（取命中源，用于可观测）。 */
  sourceTier?: SourceTier;
  /** 检索结果命中的来源流派（取命中源，用于可观测）。 */
  sourceSchool?: SourceSchool;
  /** 是否尝试了 P1（NORMATIVE_TREATMENT）检索。 */
  p1Attempted?: boolean;
  /** 是否尝试了 P2（CLINICAL_CASE）检索（fallback 信号）。 */
  p2Attempted?: boolean;
  /** P1 是否返回可用证据（observable floor：命中 ≥1 条；最终语义判断由 Agent 完成）。 */
  p1Usable?: boolean;
  /** 是否发生 P1 → P2 fallback。 */
  fallbackToP2?: boolean;
  /** fallback 原因（可选，由 Agent/调用方标注）。 */
  fallbackReason?: string;
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
  /**
   * H12：search 发起时的 DecisionState 快照（Debug/Eval 数据，不进入 clinical decision）。
   * 用于判断该 query 是探索性的，还是已处于某个 hypothesis frame 下。
   */
  retrievalContext?: {
    decisionQuestion?: string;
    leadingHypothesisRefs: string[];
    alternativeHypothesisRefs: string[];
  };
}
