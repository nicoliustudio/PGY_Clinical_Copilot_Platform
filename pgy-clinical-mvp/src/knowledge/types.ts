export type Tier = 'P1' | 'P2';
export type Kind = 'normative' | 'case' | 'gaofang';

export interface NormativeFormula {
  id: string;
  name: string;
  composition: string;
  sourceTier: string;
  knowledgeRole: string;
}

/** 一个可检索的知识单元（对应一个 chunk） */
export interface KnowledgeDoc {
  id: string;
  tier: Tier;
  kind: Kind;
  source: string;
  sourceFile: string;
  disease: string;
  syndrome: string;
  /** 治法（normative 有；case 为空，治法含于 raw） */
  treatment: string;
  /** 知识 scope（如 general / gaofang），检索时按 Capability 过滤 */
  scope: string;
  title: string;
  /** 用于 embedding / rerank 的文本 */
  text: string;
  formulas: NormativeFormula[];
  raw: unknown;
}

export interface KnowledgeIndex {
  version: string;
  builtAt: string;
  docCount: number;
  docs: KnowledgeDoc[];
  /** 与 docs 严格对齐的向量 */
  vectors: number[][];
}

/** knowledge.search 返回的结构化条目 */
export interface SearchHit {
  sourceId: string;
  title: string;
  authority: Tier;
  excerpt: string;
  score: number;
  provenance: {
    source: string;
    sourceFile: string;
    disease: string;
    syndrome: string;
    treatment: string;
  };
  formulas: NormativeFormula[];
}
