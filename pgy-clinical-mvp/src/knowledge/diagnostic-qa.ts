import {
  dedupeGroupKey,
  projectDiagnosticRecord,
  type DiagnosticKnowledgeRecord,
  type KnowledgeField,
} from './diagnostic-schema.js';

/**
 * Ingestion QA —— 批量导入前的确定性结构检查（fail-closed）。
 * 任何致命错误都阻止 release 发布。
 */

export interface IngestionQAResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface IngestionQAOptions {
  /** 已知规范病名白名单（来自 disease concept resolver / 知识库 canonical disease 集合）。 */
  resolvedDiseaseNames?: Set<string>;
}

const FORMULA_LEAK_MARKERS = ['formulaId', 'candidateRef', 'composition', 'bestMatch', 'recommendedSyndrome', '"score"'];
const GOLD_MARKERS = ['goldKey', 'expectedSyndrome', 'expectedFormula', 'goldLabel', 'holdout'];

export function qaIngestion(
  records: DiagnosticKnowledgeRecord[],
  options: IngestionQAOptions = {},
): IngestionQAResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  for (const r of records) {
    // 空 disease / syndrome
    if (!r.disease.canonicalName.trim()) errors.push(`${r.id}: disease.canonicalName 为空`);
    if (!r.syndrome.name.trim()) errors.push(`${r.id}: syndrome.name 为空`);

    // provenance 丢失 / status 不明
    const s = r.source;
    if (!s.sourceId.trim()) errors.push(`${r.id}: source.sourceId 丢失`);
    if (!s.sourceType) errors.push(`${r.id}: sourceType 不明`);
    if (!s.sourceStatus || s.sourceStatus === 'UNVERIFIED') errors.push(`${r.id}: sourceStatus 不明/UNVERIFIED`);
    if (!s.verificationStatus || s.verificationStatus === 'UNVERIFIED') errors.push(`${r.id}: verificationStatus 不明/UNVERIFIED`);

    // field-level provenance：任何非空字段必须有 provenance
    const fields: [string, KnowledgeField | undefined][] = [
      ['definition', r.definition],
      ['manifestations.main', r.manifestations?.main],
      ['manifestations.secondary', r.manifestations?.secondary],
      ['manifestations.tongue', r.manifestations?.tongue],
      ['manifestations.pulse', r.manifestations?.pulse],
      ['diagnosticBasis', r.diagnosticBasis],
      ['mechanism', r.mechanism],
      ['location', r.location],
      ['nature', r.nature],
      ['rootBranch', r.rootBranch],
      ['treatmentPrinciple', r.treatmentPrinciple],
    ];
    for (const [label, f] of fields) {
      if (f && (!f.provenance || !f.provenance.sourceId)) {
        errors.push(`${r.id}: ${label} 字段 provenance 丢失`);
      }
    }
    for (const d of r.differential ?? []) {
      if (!d.provenance || !d.provenance.sourceId) {
        errors.push(`${r.id}: differential[${d.againstSyndrome}] provenance 丢失`);
      }
    }

    // formula 泄漏进 diagnostic projection
    const projJson = JSON.stringify(projectDiagnosticRecord(r));
    for (const marker of FORMULA_LEAK_MARKERS) {
      if (projJson.includes(marker)) {
        errors.push(`${r.id}: diagnostic projection 泄漏 "${marker}"`);
      }
    }

    // Gold 混入
    const rawJson = JSON.stringify(r);
    for (const marker of GOLD_MARKERS) {
      if (rawJson.includes(marker)) {
        errors.push(`${r.id}: 疑似 Gold 数据混入 "${marker}"`);
      }
    }

    // 重复 ID
    if (seenIds.has(r.id)) errors.push(`${r.id}: 重复 ID`);
    seenIds.add(r.id);

    // crosswalk unresolved（病名未解析到规范集合）
    if (options.resolvedDiseaseNames && options.resolvedDiseaseNames.size > 0) {
      if (!options.resolvedDiseaseNames.has(r.disease.canonicalName)) {
        warnings.push(`${r.id}: 病名 "${r.disease.canonicalName}" 不在已知规范病名集合（crosswalk unresolved）`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface IngestionManifest {
  releaseVersion: string;
  sourceFiles: string[];
  recordCount: number;
  diseaseCount: number;
  syndromeRecordCount: number;
  differentialCount: number;
  verifiedOriginalCount: number;
  textbookCount: number;
  historicalCount: number;
  unverifiedCount: number;
  duplicateGroups: string[];
  unresolvedDiseaseNames: string[];
}

export interface IngestionManifestMeta {
  releaseVersion: string;
  sourceFiles: string[];
  resolvedDiseaseNames?: Set<string>;
}

/** 生成 ingestion manifest（可追溯这批知识来自哪里）。 */
export function buildIngestionManifest(
  records: DiagnosticKnowledgeRecord[],
  meta: IngestionManifestMeta,
): IngestionManifest {
  const diseases = new Set<string>();
  const groups = new Map<string, number>();
  let differentialCount = 0;
  let verifiedOriginalCount = 0;
  let textbookCount = 0;
  let historicalCount = 0;
  let unverifiedCount = 0;

  for (const r of records) {
    diseases.add(r.disease.canonicalName);
    const key = dedupeGroupKey(r);
    groups.set(key, (groups.get(key) ?? 0) + 1);
    differentialCount += (r.differential ?? []).length;
    if (r.source.verificationStatus === 'VERIFIED_ORIGINAL') verifiedOriginalCount += 1;
    if (r.source.sourceStatus === 'TEXTBOOK') textbookCount += 1;
    if (r.source.sourceStatus === 'NORMATIVE_HISTORICAL') historicalCount += 1;
    if (r.source.sourceStatus === 'UNVERIFIED' || r.source.verificationStatus === 'UNVERIFIED') unverifiedCount += 1;
  }

  return {
    releaseVersion: meta.releaseVersion,
    sourceFiles: meta.sourceFiles,
    recordCount: records.length,
    diseaseCount: diseases.size,
    syndromeRecordCount: records.length,
    differentialCount,
    verifiedOriginalCount,
    textbookCount,
    historicalCount,
    unverifiedCount,
    duplicateGroups: [...groups.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    unresolvedDiseaseNames: meta.resolvedDiseaseNames
      ? [...diseases].filter((d) => !meta.resolvedDiseaseNames!.has(d))
      : [],
  };
}
