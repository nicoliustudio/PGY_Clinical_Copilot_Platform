/**
 * Diagnostic Knowledge Schema —— 结构化诊断知识的「表达契约」。
 *
 * 核心设计原则（严格遵守）：
 * - Closed World（可枚举）→ 来源类型 / 来源状态 / 核对状态 / 病名 relation / knowledge role。
 * - Open World（不可枚举）→ 证型名称 / 病机 / 病位 / 病性 / 主证 / 兼证 / 标本 / 症状 / 舌脉 / 鉴别理由 / 治法。
 *
 * 禁止出现 enum Syndrome / enum Mechanism / enum Organ / enum Pattern / enum TreatmentPrinciple。
 * 这些全部保持开放文本。
 *
 * 每个字段必须能自己携带 provenance（field-level provenance）。
 */

/** 来源类型（Closed World）。 */
export type SourceType =
  | 'standard'
  | 'guideline'
  | 'textbook'
  | 'local_standard'
  | 'supplemental'
  | 'other';

/** 来源等级（Closed World）。不是临床正确性分数，不映射为小数。 */
export type SourceStatus =
  | 'NORMATIVE_CURRENT'
  | 'NORMATIVE_HISTORICAL'
  | 'GUIDELINE_CURRENT'
  | 'TEXTBOOK'
  | 'LOCAL_STANDARD'
  | 'SUPPLEMENTAL'
  | 'UNVERIFIED';

/** 核对状态（Closed World）。与 authority 正交。 */
export type VerificationStatus =
  | 'VERIFIED_ORIGINAL'
  | 'VERIFIED_METADATA_ONLY'
  | 'TEXTBOOK_PARAPHRASE'
  | 'STANDARD_NOT_STATED'
  | 'UNVERIFIED';

/** 字段级 provenance：每个知识字段自证来源。 */
export interface FieldProvenance {
  sourceId: string;
  sourceType: SourceType;
  sourceStatus: SourceStatus;
  verificationStatus: VerificationStatus;
  /** 文献版本（用于新旧标准/指南冲突时的可追溯）。 */
  version?: string;
  pageOrSection?: string;
}

/** 一个开放文本知识字段，自带 provenance。 */
export interface KnowledgeField {
  text: string;
  provenance: FieldProvenance;
}

/** 来源元数据（record 级默认 provenance）。 */
export interface SourceMetadata extends FieldProvenance {
  /** 文献标题/出处。 */
  title?: string;
  /** 标准号（如 ZY/T 3.1-2025 / T/GDACM 0117-2022），保留溯源身份。 */
  standardNo?: string;
}

/** 相似证型鉴别（一等数据，开放文本，不做规则）。 */
export interface DifferentialRecord {
  againstSyndrome: string;
  commonFeatures?: string;
  distinguishingFeatures?: string;
  evidenceForCurrent?: string;
  evidenceAgainstCurrent?: string;
  provenance: SourceMetadata;
}

/** 结构化诊断知识记录（一个 source-backed 的 clinical concept）。 */
export interface DiagnosticKnowledgeRecord {
  /** 稳定记录 id（sourceId + syndrome 的确定性派生，不随术语改写变化）。 */
  id: string;
  disease: {
    /** 规范病名（经 concept resolver 解析）。 */
    canonicalName: string;
    aliases?: string[];
  };
  syndrome: {
    /** 归一化显示名（用于展示 grouping，保留原名）。 */
    name: string;
    /** 原始术语（ingestion 不丢原名）。 */
    originalName?: string;
  };
  definition?: KnowledgeField;
  manifestations?: {
    main?: KnowledgeField;
    secondary?: KnowledgeField;
    tongue?: KnowledgeField;
    pulse?: KnowledgeField;
  };
  diagnosticBasis?: KnowledgeField;
  mechanism?: KnowledgeField;
  location?: KnowledgeField;
  nature?: KnowledgeField;
  rootBranch?: KnowledgeField;
  differential?: DifferentialRecord[];
  treatmentPrinciple?: KnowledgeField;
  source: SourceMetadata;
}

/**
 * 去重 grouping key：同一 clinical concept（病 + 证）对应多个 source-backed records，
 * 不 merge 成「超级答案」，仅用于 grouping。
 */
export function dedupeGroupKey(record: DiagnosticKnowledgeRecord): string {
  return `${record.disease.canonicalName}::${record.syndrome.name}`;
}

/**
 * Diagnostic Projection —— 面向 Agent 的精简视图。
 * 只暴露诊断知识，绝不暴露 formula / composition / candidateRef / bestMatch / score。
 */
export interface DiagnosticProjection {
  patternRef: string;
  disease: string;
  syndrome: string;
  definition?: string;
  mainSymptoms?: string;
  secondarySymptoms?: string;
  tongue?: string;
  pulse?: string;
  diagnosticBasis?: string;
  mechanism?: string;
  location?: string;
  nature?: string;
  rootBranch?: string;
  differential?: { againstSyndrome: string; distinguishingFeatures?: string }[];
  treatmentPrinciple?: string;
  sourceStatus: SourceStatus;
  verificationStatus: VerificationStatus;
}

function fieldText(f?: KnowledgeField): string | undefined {
  return f && f.text.trim() ? f.text : undefined;
}

/**
 * 纯函数投影：raw record → Diagnostic Projection（剥离 formula，精简 token）。
 * 来源状态保留，供 Agent 判断证据等级（但绝不转成伪科学小数）。
 */
export function projectDiagnosticRecord(record: DiagnosticKnowledgeRecord): DiagnosticProjection {
  return {
    patternRef: record.id,
    disease: record.disease.canonicalName,
    syndrome: record.syndrome.name,
    definition: fieldText(record.definition),
    mainSymptoms: fieldText(record.manifestations?.main),
    secondarySymptoms: fieldText(record.manifestations?.secondary),
    tongue: fieldText(record.manifestations?.tongue),
    pulse: fieldText(record.manifestations?.pulse),
    diagnosticBasis: fieldText(record.diagnosticBasis),
    mechanism: fieldText(record.mechanism),
    location: fieldText(record.location),
    nature: fieldText(record.nature),
    rootBranch: fieldText(record.rootBranch),
    differential: (record.differential ?? [])
      .map((d) => ({ againstSyndrome: d.againstSyndrome, distinguishingFeatures: d.distinguishingFeatures }))
      .filter((d) => d.againstSyndrome),
    treatmentPrinciple: fieldText(record.treatmentPrinciple),
    sourceStatus: record.source.sourceStatus,
    verificationStatus: record.source.verificationStatus,
  };
}
