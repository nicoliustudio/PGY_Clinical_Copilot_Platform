import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { KnowledgeDoc } from './types.js';

/**
 * Disease Concept Resolver —— 病名身份与关系解析（Crosswalk Smoke Test）。
 *
 * 职责边界：
 * - 只解决「知识身份」：把 free-text 病名 / 病例中明确的西医病名，解析为 Knowledge Store 中的规范病名。
 * - 只保留关系语义（EXACT / ALIAS / TCM_CORRESPONDENCE / RELATED），不做 synonym 合并。
 * - 不判断患者是什么病 / 什么证，不给 disease 排名、不给 syndrome 打分。
 *
 * 复用现有 crosswalk：integration/disease_recall_mappings.json 的 diagnosis_map（西医名/别名 → 规范中医病名）。
 * 人工新增医学 mapping = 0。
 */

export type DiseaseRelation = 'EXACT' | 'ALIAS' | 'TCM_CORRESPONDENCE' | 'SUBTYPE_OF' | 'RELATED';

export interface ResolvedDiseaseConcept {
  /** 规范病名（Knowledge Store 中 disease 字段的取值）。 */
  disease: string;
  relation: DiseaseRelation;
  provenance: string;
}

/** source-backed disease relation（已核对的、来自权威 source 的疾病对应关系）。 */
export interface SourceBackedRelation {
  from: string;
  to: string;
  relation: string;
  /** 端点病名的 surface forms（canonical + aliases）。缺省时退化为 canonical 精确匹配。 */
  fromSurfaceForms?: string[];
  toSurfaceForms?: string[];
  provenance: { sourceId: string; pageOrSection?: string };
}

interface DiagnosisMapEntry {
  pattern: string;
  targets: string[];
}

interface RecallMappings {
  diagnosis_map?: DiagnosisMapEntry[];
}

let recallMappingsCache: RecallMappings | null = null;

function loadRecallMappings(): RecallMappings {
  if (recallMappingsCache) return recallMappingsCache;
  try {
    const p = join(config.kb.releaseDir, 'integration/disease_recall_mappings.json');
    recallMappingsCache = JSON.parse(readFileSync(p, 'utf8')) as RecallMappings;
  } catch {
    recallMappingsCache = {};
  }
  return recallMappingsCache;
}

/** 用现有 diagnosis_map 的正则 pattern 匹配 free-text，返回命中的规范病名。 */
function matchDiagnosisMap(text: string): string[] {
  const map = loadRecallMappings().diagnosis_map ?? [];
  const out: string[] = [];
  for (const entry of map) {
    let re: RegExp;
    try {
      re = new RegExp(entry.pattern);
    } catch {
      continue;
    }
    if (re.test(text)) {
      for (const t of entry.targets) if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** 纯函数：从规范病名集中，找出包含 query 的病名（用于 query 本身无法被 crosswalk 命中的 fallback）。 */
function exactDiseaseMatches(docs: KnowledgeDoc[], query: string): string[] {
  const out: string[] = [];
  for (const d of docs) {
    if (d.sourceTier !== 'P1') continue;
    if (d.disease.includes(query) && !out.includes(d.disease)) out.push(d.disease);
  }
  return out;
}

export interface ResolveDiseaseConceptsInput {
  /** Agent 查询的中医病名（如「癥瘕」）。 */
  queryDisease: string;
  /** 病例中已明确存在的疾病上下文（西医病名原文，如「子宫肌瘤、子宫腺肌瘤」）。 */
  caseDiseaseContext?: string[];
  /** 当前 Knowledge Store 的 P1 docs（用于 query 的 exact fallback）。 */
  docs: KnowledgeDoc[];
  /** source-backed disease relations（仅由 case context 驱动的 TCM_CORRESPONDENCE 扩展）。 */
  relations?: SourceBackedRelation[];
}

/**
 * 解析病名身份：query disease + 病例 disease context + source-backed relation → 规范病名概念集合。
 * - query 经 diagnosis_map 命中的 → ALIAS；经 P1 病名字段 exact 命中的 → EXACT。
 * - case context 经 diagnosis_map 命中的（且非 query 已覆盖）→ TCM_CORRESPONDENCE。
 * - source-backed relation：仅当 case context 出现 relation 任一端病名时，才把两端都加入（TCM_CORRESPONDENCE）。
 *   （query relation alone 不扩展，防止普通痛经病例被灌入腺肌病证型。）
 */
export function resolveDiseaseConcepts(input: ResolveDiseaseConceptsInput): ResolvedDiseaseConcept[] {
  const concepts: ResolvedDiseaseConcept[] = [];
  const push = (disease: string, relation: DiseaseRelation, provenance: string) => {
    if (!disease || concepts.some((c) => c.disease === disease)) return;
    concepts.push({ disease, relation, provenance });
  };

  // 1) query 的 P1 exact fallback（「癥瘕」→「女性生殖系统肿瘤-癥瘕」）优先，标记 EXACT。
  for (const d of exactDiseaseMatches(input.docs, input.queryDisease)) {
    push(d, 'EXACT', 'p1.disease.exact');
  }

  // 2) query 本身的 crosswalk 命中（西医名/别名 → 规范病名），标记 ALIAS（仅当 exact 未覆盖）。
  for (const d of matchDiagnosisMap(input.queryDisease)) {
    push(d, 'ALIAS', 'integration/disease_recall_mappings.json#diagnosis_map');
  }

  // 3) 病例中已明确存在的 disease context → 规范病名（与 query 病名是不同实体，中医对应关系）。
  for (const ctx of input.caseDiseaseContext ?? []) {
    for (const d of matchDiagnosisMap(ctx)) {
      push(d, 'TCM_CORRESPONDENCE', 'integration/disease_recall_mappings.json#diagnosis_map@case-context');
    }
  }

  // 4) source-backed relation expansion：仅由 case context 驱动（query relation alone 不扩展）。
  const ctxText = (input.caseDiseaseContext ?? []).join(' ');
  for (const rel of input.relations ?? []) {
    if (rel.relation === 'TCM_CORRESPONDENCE') {
      // 双向：case context 出现任一端病名，两端标准一并可见。
      const fromForms = rel.fromSurfaceForms?.length ? rel.fromSurfaceForms : [rel.from];
      const toForms = rel.toSurfaceForms?.length ? rel.toSurfaceForms : [rel.to];
      const fromInContext = fromForms.some((f) => f && ctxText.includes(f));
      const toInContext = toForms.some((f) => f && ctxText.includes(f));
      if (!fromInContext && !toInContext) continue;
      const prov = `${rel.provenance.sourceId}#${rel.provenance.pageOrSection ?? ''}`;
      push(rel.from, 'TCM_CORRESPONDENCE', prov);
      push(rel.to, 'TCM_CORRESPONDENCE', prov);
    } else if (rel.relation === 'SUBTYPE_OF') {
      // 方向性：from=subtype，to=supertype。仅当 case context 出现 subtype 时，解析出 supertype。
      // subtype 不并入 supertype（非同义词），不自动改写患者诊断。
      const fromForms = rel.fromSurfaceForms?.length ? rel.fromSurfaceForms : [rel.from];
      const fromInContext = fromForms.some((f) => f && ctxText.includes(f));
      if (!fromInContext) continue;
      const prov = `${rel.provenance.sourceId}#${rel.provenance.pageOrSection ?? ''}`;
      push(rel.to, 'SUBTYPE_OF', prov);
    }
  }

  return concepts;
}

export function resetRecallMappingsCache(): void {
  recallMappingsCache = null;
}
