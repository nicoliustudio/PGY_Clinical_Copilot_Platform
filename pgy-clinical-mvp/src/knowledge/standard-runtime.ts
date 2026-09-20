import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { getReleaseDiseaseStandards, getActivatedDiseaseRelations } from './diagnostic-release.js';

/**
 * Existing Standards Runtime —— 把 release 中已存在但未进入 runtime 的标准知识接通。
 *
 * 关键原则：
 * - 通过 canonical concept identity / structured lookup 暴露，不混入 general vector RAG。
 * - 只返回结构化标准字段 + provenance，不返回 bestSyndrome / patientMatchScore / recommendedSyndrome / formula。
 * - 所有标准检索不自动生成 patient hypothesis（H12 invariant 不变）。
 */

/** 证候标准记录（GB/T 16751.2-2021 证候本体叶子节点）。 */
export interface SyndromeStandardRecord {
  conceptId: string;
  canonicalName: string;
  definition?: string;
  etiologyMechanism?: string;
  characteristicEvidence: string[];
  tongueEvidence: string[];
  pulseEvidence: string[];
  provenance: {
    codeStandard: string;
    definitionStandard: string;
  };
}

/** 疾病诊断标准记录（《中医病证诊断疗效标准 2024 版》）。 */
export interface DiseaseStandardRecord {
  disease: string;
  specialty: string;
  /** 病名定义（intro）。 */
  definition?: string;
  /** 诊断依据。 */
  diagnosisBasis?: string;
  /** 该标准中已有的证候分类（name + criteria）。 */
  syndromes: { name: string; criteria: string }[];
  provenance: {
    source: string;
    sourceFile: string;
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

interface SyndromeOntologyRow {
  concept_id?: string;
  canonical_name?: string;
  is_category?: boolean;
  definition?: string;
  etiology_mechanism_text?: string;
  characteristic_evidence?: string[];
  tongue_evidence?: string[];
  pulse_evidence?: string[];
  source?: { code_standard?: string; definition_standard?: string };
}

interface Diagnostic2024Row {
  disease?: string;
  specialty?: string;
  intro?: string;
  diagnosis_basis?: string;
  syndromes?: { name?: string; criteria?: string }[];
  source?: string;
  source_file?: string;
}

let syndromeIndex: Map<string, SyndromeStandardRecord> | null = null;
let diseaseIndex: Map<string, DiseaseStandardRecord> | null = null;

function loadSyndromeOntology(): Map<string, SyndromeStandardRecord> {
  if (syndromeIndex) return syndromeIndex;
  syndromeIndex = new Map();
  try {
    const p = join(config.kb.releaseDir, 'standards/ontology/syndrome_ontology.jsonl');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const r = JSON.parse(l) as SyndromeOntologyRow;
      // 只索引叶子证型（有实际特征证据），不索引 category。
      if (r.is_category === true) continue;
      const name = asString(r.canonical_name);
      if (!name) continue;
      syndromeIndex.set(name, {
        conceptId: asString(r.concept_id) ?? name,
        canonicalName: name,
        definition: asString(r.definition),
        etiologyMechanism: asString(r.etiology_mechanism_text),
        characteristicEvidence: asStringArray(r.characteristic_evidence),
        tongueEvidence: asStringArray(r.tongue_evidence),
        pulseEvidence: asStringArray(r.pulse_evidence),
        provenance: {
          codeStandard: asString(r.source?.code_standard) ?? 'GB/T 15657-2021',
          definitionStandard: asString(r.source?.definition_standard) ?? 'GB/T 16751.2-2021',
        },
      });
    }
  } catch {
    // 文件缺失时返回空索引（fail-closed：查不到即返回 null）。
  }
  return syndromeIndex;
}

function loadDiseaseStandard(): Map<string, DiseaseStandardRecord> {
  if (diseaseIndex) return diseaseIndex;
  diseaseIndex = new Map();
  try {
    const p = join(config.kb.releaseDir, 'tcm_diagnostic_2024.json');
    const rows = JSON.parse(readFileSync(p, 'utf8')) as Diagnostic2024Row[];
    for (const r of rows) {
      const disease = asString(r.disease);
      if (!disease) continue;
      diseaseIndex.set(disease, {
        disease,
        specialty: asString(r.specialty) ?? '',
        definition: asString(r.intro),
        diagnosisBasis: asString(r.diagnosis_basis),
        syndromes: (r.syndromes ?? [])
          .map((s) => ({ name: asString(s.name) ?? '', criteria: asString(s.criteria) ?? '' }))
          .filter((s) => s.name),
        provenance: {
          source: asString(r.source) ?? '中医病证诊断疗效标准（2024版）',
          sourceFile: asString(r.source_file) ?? '',
        },
      });
    }
  } catch {
    // fail-closed
  }
  return diseaseIndex;
}

/**
 * 证候标准结构化查找：精确 canonical_name，兼容「证」后缀差异。
 * 不做模糊评分、不返回 bestMatch。
 */
export function getSyndromeStandard(syndrome: string): SyndromeStandardRecord | null {
  const idx = loadSyndromeOntology();
  if (idx.has(syndrome)) return idx.get(syndrome)!;
  if (!syndrome.endsWith('证') && idx.has(syndrome + '证')) return idx.get(syndrome + '证')!;
  if (syndrome.endsWith('证') && idx.has(syndrome.slice(0, -1))) return idx.get(syndrome.slice(0, -1))!;
  return null;
}

/** 疾病诊断标准结构化查找：精确 disease。 */
export function getDiseaseStandard(disease: string): DiseaseStandardRecord | null {
  return loadDiseaseStandard().get(disease) ?? null;
}

/** 统一疾病标准视图（tcm_diagnostic_2024 + 新 Diagnostic Release，按 source 分组，不 merge source text）。 */
export interface DiseaseStandardView {
  disease: string;
  specialty?: string;
  definition?: string;
  diagnosisBasis?: string;
  differentialDiagnosis?: string;
  westernCorrespondence?: string;
  tcmCorrespondence?: string;
  generalMechanism?: string;
  syndromes?: { name: string; criteria: string }[];
  source: {
    sourceId: string;
    sourceType: string;
    sourceStatus: string;
    verificationStatus: string;
    standardNo?: string;
    title?: string;
  };
}

/** 合并查询：现有 tcm_diagnostic_2024 + 新 Diagnostic Release，按 source 分组返回。
 * 支持 source-backed relation expansion：当 case context 出现 relation 任一端病名时，
 * 把 relation 两端病名一并加入查询（仅 case context 驱动，query relation alone 不扩展）。 */
export function getDiseaseStandards(disease: string, options?: { caseDiseaseContext?: string[] }): DiseaseStandardView[] {
  const diseases = new Set<string>([disease]);

  if (config.experiment.diagnosticRelease && options?.caseDiseaseContext && options.caseDiseaseContext.length > 0) {
    const ctxText = options.caseDiseaseContext.join(' ');
    for (const rel of getActivatedDiseaseRelations()) {
      if (rel.relation === 'TCM_CORRESPONDENCE') {
        const fromHit = rel.fromSurfaceForms.some((f) => f && ctxText.includes(f));
        const toHit = rel.toSurfaceForms.some((f) => f && ctxText.includes(f));
        if (fromHit || toHit) {
          diseases.add(rel.from);
          diseases.add(rel.to);
        }
      } else if (rel.relation === 'SUBTYPE_OF') {
        // from=subtype，to=supertype。case context 出现 subtype 时，让 supertype 标准可见；不反向、不合并 subtype。
        const fromHit = rel.fromSurfaceForms.some((f) => f && ctxText.includes(f));
        if (fromHit) diseases.add(rel.to);
      }
    }
  }

  const out: DiseaseStandardView[] = [];

  for (const d of diseases) {
    const existing = getDiseaseStandard(d);
    if (existing) {
      out.push({
        disease: existing.disease,
        specialty: existing.specialty || undefined,
        definition: existing.definition,
        diagnosisBasis: existing.diagnosisBasis,
        syndromes: existing.syndromes,
        source: {
          sourceId: existing.provenance.source,
          sourceType: 'standard',
          sourceStatus: 'NORMATIVE_CURRENT',
          verificationStatus: 'VERIFIED_ORIGINAL',
          title: existing.provenance.source,
        },
      });
    }

    if (config.experiment.diagnosticRelease) {
      for (const r of getReleaseDiseaseStandards(d)) {
        out.push({
          disease: r.disease,
          definition: r.definition?.text,
          diagnosisBasis: r.diagnosticBasis?.text,
          differentialDiagnosis: r.differentialDiagnosis?.text,
          westernCorrespondence: r.westernCorrespondence?.text,
          tcmCorrespondence: r.tcmCorrespondence?.text,
          generalMechanism: r.generalMechanism?.text,
          source: {
            sourceId: r.source.sourceId,
            sourceType: r.source.sourceType,
            sourceStatus: r.source.sourceStatus,
            verificationStatus: r.source.verificationStatus,
            standardNo: r.source.standardNo,
            title: r.source.title,
          },
        });
      }
    }
  }

  return out;
}

export function resetStandardRuntimeCache(): void {
  syndromeIndex = null;
  diseaseIndex = null;
}
