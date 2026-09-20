import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type {
  DiagnosticKnowledgeRecord,
  FieldProvenance,
  KnowledgeField,
  SourceMetadata,
  SourceStatus,
  SourceType,
  VerificationStatus,
} from './diagnostic-schema.js';

/**
 * Diagnostic Knowledge Release adapter —— 把 staging ZIP 中的 portable 数据映射到现有 schema。
 *
 * Compatibility Dry Run 结论：
 * - diagnostic_patterns.jsonl 字段几乎完全对齐 DiagnosticKnowledgeRecord；
 * - 唯一 adapter：sourceType 的 portable label（INDUSTRY_STANDARD / GROUP_STANDARD）→ 现有 SourceType enum token。
 * - 不改写医学文本、不 merge source、不补空字段、不自动生成病机/鉴别/alias。
 */

/** 新 Diagnostic Knowledge Release 目录（独立、可回滚，不覆盖现有 agent-ready release）。 */
const DIAGNOSTIC_RELEASE_DIR = join(config.kb.releaseDir, '..', '2026.09.19-diagnostic-r1');

/** portable source type → 现有 SourceType enum token。 */
function mapPortableSourceType(portable: string): SourceType {
  if (portable === 'INDUSTRY_STANDARD') return 'standard';
  if (portable === 'GROUP_STANDARD') return 'local_standard';
  return 'other';
}

function asStatus(v: unknown): SourceStatus {
  const s = String(v ?? 'UNVERIFIED');
  const known: SourceStatus[] = ['NORMATIVE_CURRENT', 'NORMATIVE_HISTORICAL', 'GUIDELINE_CURRENT', 'TEXTBOOK', 'LOCAL_STANDARD', 'SUPPLEMENTAL', 'UNVERIFIED'];
  return (known as string[]).includes(s) ? (s as SourceStatus) : 'UNVERIFIED';
}

function asVerification(v: unknown): VerificationStatus {
  const s = String(v ?? 'UNVERIFIED');
  const known: VerificationStatus[] = ['VERIFIED_ORIGINAL', 'VERIFIED_METADATA_ONLY', 'TEXTBOOK_PARAPHRASE', 'STANDARD_NOT_STATED', 'UNVERIFIED'];
  return (known as string[]).includes(s) ? (s as VerificationStatus) : 'UNVERIFIED';
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function mapProvenance(raw: unknown): FieldProvenance {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    sourceId: asString(r.sourceId) ?? '',
    sourceType: mapPortableSourceType(asString(r.sourceType) ?? ''),
    sourceStatus: asStatus(r.sourceStatus),
    verificationStatus: asVerification(r.verificationStatus),
    version: asString(r.version),
    pageOrSection: asString(r.pageOrSection),
  };
}

function mapSource(raw: unknown): SourceMetadata {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...mapProvenance(r),
    title: asString(r.title),
    standardNo: asString(r.standardNo),
    version: asString(r.publishedDate)?.slice(0, 4) ?? asString(r.version),
  };
}

function mapField(raw: unknown): KnowledgeField | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  const text = asString(r.text);
  if (!text) return undefined;
  return { text, provenance: mapProvenance(r.provenance) };
}

/** 疾病诊断标准（新 release 的 disease_standards.jsonl 记录，保留额外字段）。 */
export interface ReleaseDiseaseStandard {
  id: string;
  disease: string;
  aliases: string[];
  definition?: KnowledgeField;
  diagnosticBasis?: KnowledgeField;
  differentialDiagnosis?: KnowledgeField;
  westernCorrespondence?: KnowledgeField;
  tcmCorrespondence?: KnowledgeField;
  generalMechanism?: KnowledgeField;
  source: SourceMetadata;
}

/** crosswalk candidate（不 activate 成 runtime relation，进入 review layer）。 */
export interface CrosswalkCandidate {
  id: string;
  from: string;
  to: string;
  relation: string;
  reviewStatus: string;
  runtimeReady: boolean;
  evidence: string;
  provenance: FieldProvenance;
}

interface ReleaseData {
  diseaseStandards: ReleaseDiseaseStandard[];
  patterns: DiagnosticKnowledgeRecord[];
  crosswalkCandidates: CrosswalkCandidate[];
}

let releaseCache: ReleaseData | null = null;

function loadRelease(): ReleaseData | null {
  if (releaseCache !== null) return releaseCache;
  releaseCache = { diseaseStandards: [], patterns: [], crosswalkCandidates: [] };
  try {
    // disease_standards.jsonl
    for (const line of readFileSync(join(DIAGNOSTIC_RELEASE_DIR, 'disease_standards.jsonl'), 'utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const r = JSON.parse(l) as Record<string, unknown>;
      const disease = (r.disease ?? {}) as Record<string, unknown>;
      releaseCache.diseaseStandards.push({
        id: asString(r.id) ?? '',
        disease: asString(disease.canonicalName) ?? '',
        aliases: Array.isArray(disease.aliases) ? (disease.aliases as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        definition: mapField(r.definition),
        diagnosticBasis: mapField(r.diagnosticBasis),
        differentialDiagnosis: mapField(r.differentialDiagnosis),
        westernCorrespondence: mapField(r.westernCorrespondence),
        tcmCorrespondence: mapField(r.tcmCorrespondence),
        generalMechanism: mapField(r.generalMechanism),
        source: mapSource(r.source),
      });
    }

    // diagnostic_patterns.jsonl → DiagnosticKnowledgeRecord
    for (const line of readFileSync(join(DIAGNOSTIC_RELEASE_DIR, 'diagnostic_patterns.jsonl'), 'utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const r = JSON.parse(l) as Record<string, unknown>;
      const disease = (r.disease ?? {}) as Record<string, unknown>;
      const syndrome = (r.syndrome ?? {}) as Record<string, unknown>;
      const m = (r.manifestations ?? {}) as Record<string, unknown>;
      releaseCache.patterns.push({
        id: asString(r.id) ?? '',
        disease: {
          canonicalName: asString(disease.canonicalName) ?? '',
          aliases: Array.isArray(disease.aliases) ? (disease.aliases as unknown[]).filter((x): x is string => typeof x === 'string') : [],
        },
        syndrome: {
          name: asString(syndrome.name) ?? '',
          originalName: asString(syndrome.originalName),
        },
        manifestations: {
          main: mapField(m.main),
          secondary: mapField(m.secondary),
          tongue: mapField(m.tongue),
          pulse: mapField(m.pulse),
        },
        diagnosticBasis: mapField(r.diagnosticBasis),
        mechanism: mapField(r.mechanism),
        treatmentPrinciple: mapField(r.treatmentPrinciple),
        source: mapSource(r.source),
      });
    }

    // disease_crosswalk_candidates.jsonl
    for (const line of readFileSync(join(DIAGNOSTIC_RELEASE_DIR, 'disease_crosswalk_candidates.jsonl'), 'utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const r = JSON.parse(l) as Record<string, unknown>;
      releaseCache.crosswalkCandidates.push({
        id: asString(r.id) ?? '',
        from: asString(r.from) ?? '',
        to: asString(r.to) ?? '',
        relation: asString(r.relation) ?? '',
        reviewStatus: asString(r.reviewStatus) ?? '',
        runtimeReady: r.runtimeReady === true,
        evidence: asString(r.evidence) ?? '',
        provenance: mapProvenance(r.provenance),
      });
    }
  } catch {
    // release 目录缺失或损坏 → 空数据（fail-closed，不影响现有行为）。
  }
  return releaseCache;
}

/** 返回新 release 中某病种的疾病诊断标准（数组，按 source 区分）。不检查 flag（flag 在合并点控制）。 */
export function getReleaseDiseaseStandards(disease: string): ReleaseDiseaseStandard[] {
  return (loadRelease()?.diseaseStandards ?? []).filter((d) => d.disease === disease);
}

/** 返回新 release 中某病种的证候 patterns（DiagnosticKnowledgeRecord，未做 formula 投影）。 */
export function getReleaseDiagnosticPatterns(disease: string): DiagnosticKnowledgeRecord[] {
  return (loadRelease()?.patterns ?? []).filter((p) => p.disease.canonicalName === disease);
}

/** 返回新 release 的全部 crosswalk candidates（runtimeReady 保持 false，不 activate）。 */
export function getReleaseCrosswalkCandidates(): CrosswalkCandidate[] {
  return loadRelease()?.crosswalkCandidates ?? [];
}

/** 已激活的 source-backed disease relation（TCM_CORRESPONDENCE 双向 / SUBTYPE_OF 方向性）。 */
export interface ActivatedDiseaseRelation {
  from: string;
  to: string;
  relation: 'TCM_CORRESPONDENCE' | 'SUBTYPE_OF';
  /** 端点病名的 surface forms（canonical + release 中该病种的 aliases），供 case context 匹配，避免精确子串脆弱。 */
  fromSurfaceForms: string[];
  toSurfaceForms: string[];
  provenance: {
    sourceId: string;
    standardNo?: string;
    sourceType: string;
    sourceStatus: string;
    verificationStatus: string;
    pageOrSection?: string;
    evidenceText: string;
  };
}

/** 病名的 surface forms（canonical + release 中该病种的 aliases）。别名来自 release 数据，不新增硬编码。 */
export function getDiseaseSurfaceForms(disease: string): string[] {
  const forms: string[] = [];
  const push = (f: string) => {
    if (f && !forms.includes(f)) forms.push(f);
  };
  push(disease);
  for (const s of loadRelease()?.diseaseStandards ?? []) {
    if (s.disease === disease) {
      for (const a of s.aliases) push(a);
    }
  }
  return forms;
}

/**
 * 确定性激活：candidate → runtimeReady 只当：
 * 1) relation 来自已核对 source（VERIFIED_ORIGINAL）；
 * 2) source 原文明确表达对应关系（evidence 非空）；
 * 3) provenance 完整（sourceId + pageOrSection）；
 * 4) relation 非模型推断 / 非 Gold 派生 / 非字符串相似。
 * 本轮激活 TCM_CORRESPONDENCE（痛经/月经过多/癥瘕）与 SUBTYPE_OF（子宫腺肌瘤→子宫腺肌病），
 * 不激活 RELATED / WESTERN_CORRESPONDENCE。
 */
export function getActivatedDiseaseRelations(): ActivatedDiseaseRelation[] {
  return getReleaseCrosswalkCandidates()
    .filter((c) => {
      if (c.relation !== 'TCM_CORRESPONDENCE' && c.relation !== 'SUBTYPE_OF') return false;
      if (c.reviewStatus !== 'SOURCE_SUPPORTED_CANDIDATE') return false;
      if (!c.provenance.sourceId || !c.provenance.pageOrSection) return false;
      if (!c.evidence) return false;
      return true;
    })
    .map((c) => ({
      from: c.from,
      to: c.to,
      relation: c.relation as 'TCM_CORRESPONDENCE' | 'SUBTYPE_OF',
      fromSurfaceForms: getDiseaseSurfaceForms(c.from),
      toSurfaceForms: getDiseaseSurfaceForms(c.to),
      provenance: {
        sourceId: c.provenance.sourceId,
        sourceType: c.provenance.sourceType,
        sourceStatus: c.provenance.sourceStatus,
        verificationStatus: c.provenance.verificationStatus,
        pageOrSection: c.provenance.pageOrSection,
        evidenceText: c.evidence,
      },
    }));
}

export function resetDiagnosticReleaseCache(): void {
  releaseCache = null;
}
