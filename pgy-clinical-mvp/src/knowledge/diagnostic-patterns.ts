import { loadIndex } from './build.js';
import { config } from '../config.js';
import type { KnowledgeDoc } from './types.js';
import { resolveDiseaseConcepts, type ResolvedDiseaseConcept } from './disease-concepts.js';
import { getReleaseDiagnosticPatterns, getActivatedDiseaseRelations } from './diagnostic-release.js';
import type { DiagnosticKnowledgeRecord } from './diagnostic-schema.js';

/**
 * Diagnostic Pattern Set —— 同病种规范证候诊断知识的「中性查询」能力。
 *
 * 职责边界（严格遵守）：
 * - 只回答「这个规范病种有哪些来源支持的证候定义」，不回答「患者是什么证」。
 * - 只做 Closed World 知识投影：从现有 P1 规范记录忠实投影已有结构化字段。
 * - 不比较患者、不排序临床正确性、不给出最佳证型、不返回方剂（formula）。
 * - 病名身份由 Disease Concept Resolver 解析（含关系语义），不做 synonym 合并。
 */

export interface DiagnosticPatternRecord {
  patternRef: string;
  disease: string;
  syndrome: string;
  description?: string;
  etiology?: string;
  /** 症状原文（含舌脉混杂，保持 provenance，不重新拆解）。 */
  symptoms?: string;
  tongue?: string;
  pulse?: string;
  diagnosisPoints?: string;
  /** 证候诊断依据（源标准原文）。 */
  diagnosticBasis?: string;
  /** 病机（源标准原文）。 */
  mechanism?: string;
  /** 治法（treatment principle），不是方剂。 */
  treatment?: string;
  sourceId: string;
  source: string;
  sourceFile?: string;
  sourceTier?: string;
  sourceSchool?: string;
  /** Debug/Eval provenance：该 pattern 是如何被召回的（query disease + relation + crosswalk source）。 */
  retrievalRelation?: {
    queryDisease: string;
    matchedDisease: string;
    relation: string;
    crosswalkSource: string;
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function readField(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

/** 从原始 P1 记录中读取症状原文（字段名兼容 symptoms / symptom）。 */
function readSymptoms(raw: unknown): string | undefined {
  return asString(readField(raw, 'symptoms')) ?? asString(readField(raw, 'symptom'));
}

/**
 * 纯函数投影：给定规范病名列表，筛选对应 P1 规范证候记录，并排除方剂字段。
 * 独立于 index / resolver，便于单元测试（不读磁盘 / 不依赖向量）。
 */
export function projectDiagnosticPatterns(
  docs: KnowledgeDoc[],
  resolvedDiseases: string[],
  options: { sourceSchool?: string; scopes?: string[] } = {},
): DiagnosticPatternRecord[] {
  const diseaseSet = new Set(resolvedDiseases);
  const scopes = new Set(options.scopes ?? ['general']);

  return docs
    .filter((d) => {
      if (d.sourceTier !== 'P1') return false;
      if (!diseaseSet.has(d.disease)) return false;
      if (!scopes.has(d.scope ?? 'general')) return false;
      if (options.sourceSchool && d.sourceSchool !== options.sourceSchool) return false;
      return true;
    })
    .map((d) => ({
      patternRef: d.id,
      disease: d.disease,
      syndrome: d.syndrome,
      symptoms: readSymptoms(d.raw),
      treatment: d.treatment || undefined,
      sourceId: d.id,
      source: d.source,
      sourceFile: d.sourceFile || undefined,
      sourceTier: d.sourceTier,
      sourceSchool: d.sourceSchool,
    }));
}

/** 投影新 Diagnostic Release 的 disease-specific pattern（保留来源，不做 formula 投影）。 */
function projectReleasePattern(record: DiagnosticKnowledgeRecord): DiagnosticPatternRecord {
  return {
    patternRef: record.id,
    disease: record.disease.canonicalName,
    syndrome: record.syndrome.name,
    symptoms: record.manifestations?.main?.text,
    tongue: record.manifestations?.tongue?.text,
    pulse: record.manifestations?.pulse?.text,
    diagnosticBasis: record.diagnosticBasis?.text,
    mechanism: record.mechanism?.text,
    treatment: record.treatmentPrinciple?.text,
    sourceId: record.source.sourceId,
    source: record.source.title ?? record.source.standardNo ?? record.source.sourceId,
    sourceFile: record.source.standardNo,
    sourceTier: record.source.sourceType,
    sourceSchool: record.source.standardNo,
  };
}

export interface GetDiagnosticPatternsOptions {
  sourceSchool?: string;
  scopes?: string[];
  /** 病例中已明确存在的疾病上下文（西医病名原文）。crosswalk 启用时用于 relation expansion。 */
  caseDiseaseContext?: string[];
  /** 是否启用 Disease Concept Crosswalk（A/B）。OFF 保持上一轮 includes 匹配行为。 */
  crosswalkEnabled?: boolean;
}

/**
 * 返回当前 Knowledge Store 中属于该病种（及 crosswalk 关联病种）的全部 P1 规范证候记录。
 * 明确排除：formula name / formulaId / composition / candidateRef / bestMatch / score / recommendedSyndrome。
 */
export async function getDiagnosticPatterns(
  disease: string,
  options: GetDiagnosticPatternsOptions = {},
): Promise<DiagnosticPatternRecord[]> {
  const idx = await loadIndex();

  let concepts: ResolvedDiseaseConcept[];
  if (options.crosswalkEnabled) {
    concepts = resolveDiseaseConcepts({
      queryDisease: disease,
      caseDiseaseContext: options.caseDiseaseContext,
      docs: idx.docs,
      relations: config.experiment.diagnosticRelease ? getActivatedDiseaseRelations() : [],
    });
  } else {
    // Crosswalk OFF：维持上一轮行为（disease 子串匹配），统一标记 EXACT 便于对比观测。
    const matched = idx.docs
      .filter((d) => d.sourceTier === 'P1' && d.disease.includes(disease))
      .map((d) => d.disease);
    concepts = [...new Set(matched)].map((d) => ({ disease: d, relation: 'EXACT' as const, provenance: 'p1.disease.includes' }));
  }

  const records = projectDiagnosticPatterns(idx.docs, concepts.map((c) => c.disease), options);
  const relationByDisease = new Map(concepts.map((c) => [c.disease, c]));

  const projected = records.map((r) => {
    const concept = relationByDisease.get(r.disease);
    return concept
      ? {
          ...r,
          retrievalRelation: {
            queryDisease: disease,
            matchedDisease: r.disease,
            relation: concept.relation,
            crosswalkSource: concept.provenance,
          },
        }
      : r;
  });

  // 合并新 Diagnostic Release 的 disease-specific patterns（不 merge source text，保留 source provenance）。
  if (config.experiment.diagnosticRelease) {
    for (const rec of getReleaseDiagnosticPatterns(disease)) {
      projected.push(projectReleasePattern(rec));
    }
  }

  return projected;
}
