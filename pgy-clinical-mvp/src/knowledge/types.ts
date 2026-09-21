/**
 * 知识库类型 —— Runtime Knowledge Role / Source Tier / Index 结构。
 *
 * 关键分离：
 * - `sourceTier`（P1/P2/AUX）：粗粒度权威层级，决定检索 precedence。
 * - `knowledgeRole`（DIAGNOSTIC_* / NORMATIVE_* / CLINICAL_*）：知识功能角色。
 * - `prescriptionAuthority`：处方权。Role 不决定处方权，必须单独判定（见 manifest.ts）。
 */

/** 粗粒度来源权威层级（用于 precedence / 报告）。 */
export type SourceTier = 'P1' | 'P2' | 'AUX';

/** 运行时知识角色。 */
export type KnowledgeRole =
  | 'DIAGNOSTIC_DIFFERENTIAL'
  | 'DIAGNOSTIC_STANDARD'
  | 'NORMATIVE_TREATMENT'
  | 'CLINICAL_CASE';

/** 文档功能形态（仅作 provenance，不参与临床路由）。 */
export type Kind = 'normative' | 'case' | 'case-formula' | 'diagnostic' | 'standard';

/** 来源流派（School-aware Evidence 元数据）。 */
export type SourceSchool = 'shen_zhongli' | 'national_standard' | 'classical' | 'general_tcm';

export interface NormativeFormula {
  id: string;
  name: string;
  composition: string;
  /** 公式级 source_tier（源自源数据，provenance 字符串，非 doc.sourceTier）。 */
  sourceTier: string;
  /** 公式级 knowledge_role（源自源数据，provenance 字符串）。 */
  knowledgeRole: string;
}

/** 一个可检索的知识单元（对应一个 chunk / 向量）。 */
export interface KnowledgeDoc {
  id: string;
  text: string;
  /** 稳定来源身份（catalog layer id，如 P1_GYN_MANUAL / S1_SYMPTOM_DIFFERENTIAL）。 */
  sourceId: string;
  source: string;
  sourceFile: string;
  sourceSchool?: SourceSchool;
  sourceTier: SourceTier;
  knowledgeRole: KnowledgeRole;
  /** 处方权。任何非 NORMATIVE_TREATMENT 角色默认 false（fail-closed）。 */
  prescriptionAuthority: boolean;
  specialty?: string;
  /** 知识 scope（如 general / gaofang），检索时按激活 Capability 过滤。 */
  scope?: string;
  disease: string;
  syndrome: string;
  treatment: string;
  title: string;
  formulas: NormativeFormula[];
  /** 原资产 identity（不通过文本重新推断）。 */
  diseaseId?: string;
  syndromeId?: string;
  formulaId?: string;
  releaseVersion: string;
  kind: Kind;
  raw?: unknown;
  /**
   * H15.2.7：病例方药证据单元（kind = 'case-formula'）的追溯字段。
   * 来自 release 内已结构化的 encounters.json，不通过 runtime LLM 重新抽取。
   */
  caseId?: string;
  visit?: string;
  composition?: string;
  patient?: string;
  symptoms?: string;
  sourceSpanId?: string;
  /** H15.2.7：来源若有正式方名（formula_name），否则为空（用稳定 identity 兜底）。 */
  formulaName?: string;
}

/** 索引 breakdown（build 报告 + 可观测性）。 */
export interface IndexBreakdown {
  byRole: Record<KnowledgeRole, number>;
  bySourceTier: Record<SourceTier, number>;
  bySourceSchool: Record<string, number>;
  prescriptionAuthority: { true: number; false: number };
  /** 未进入 vector index 的资产（blocked / shadow / evaluation-only）。 */
  blockedAssets: string[];
  shadowAssets: string[];
}

export interface KnowledgeIndex {
  version: string;
  releaseVersion: string;
  builtAt: string;
  docCount: number;
  docs: KnowledgeDoc[];
  /** 与 docs 严格对齐的向量。 */
  vectors: number[][];
  breakdown: IndexBreakdown;
}

/** knowledge.search 返回的结构化条目。 */
export interface SearchHit {
  sourceId: string;
  title: string;
  /** 向后兼容：等价于 sourceTier。 */
  authority: SourceTier;
  sourceTier: SourceTier;
  knowledgeRole: KnowledgeRole;
  prescriptionAuthority: boolean;
  excerpt: string;
  score: number;
  provenance: {
    source: string;
    sourceFile: string;
    disease: string;
    syndrome: string;
    treatment: string;
    sourceSchool?: SourceSchool;
  };
  formulas: NormativeFormula[];
  /** H6 紧凑结果卡片字段（additive，不改变 ranking）。 */
  shortEvidenceSummary?: string;
  matchedConcepts?: string[];
  candidateRefs?: string[];
  detailAvailable?: boolean;
  /** H15.2.7：病例方药证据单元（encounter-level）字段，供 P2 fallback 直接形成 formula-level candidate。 */
  kind?: Kind;
  caseId?: string;
  visit?: string;
  composition?: string;
  sourceSpanId?: string;
  patient?: string;
  symptoms?: string;
  formulaName?: string;
}
