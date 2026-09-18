import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { embed } from '../model/adapter.js';
import { knowledgeManifest, NON_RUNTIME_ASSETS, RUNTIME_KNOWLEDGE_ROLES, type RuntimeLayer } from './manifest.js';
import { classifySourceSchool } from './source-school.js';
import type {
  IndexBreakdown,
  KnowledgeDoc,
  KnowledgeIndex,
  NormativeFormula,
} from './types.js';

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function loadJsonl(p: string): Record<string, unknown>[] {
  const text = readFileSync(p, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 从 release 的 manifest.json 解析发布版本；失败则回退目录名。 */
export function resolveReleaseVersion(dir: string): string {
  try {
    const m = loadJson<{ release?: string }>(path.join(dir, 'manifest.json'));
    if (m.release) return m.release;
  } catch {
    // fallback to basename
  }
  return path.basename(dir);
}

interface NormativeEntry {
  id?: string;
  source?: string;
  source_file?: string;
  disease?: string;
  syndrome?: string;
  symptoms?: string;
  treatment?: string;
  formulas?: {
    id?: string;
    name?: string;
    composition?: string;
    raw_composition?: string;
    source_tier?: string;
    knowledge_role?: string;
  }[];
}

interface CaseEntry {
  id?: string;
  source?: string;
  source_file?: string;
  specialty?: string;
  disease?: string;
  patient?: string;
  raw?: string;
  knowledge_domain?: string;
}

interface S1AnchorDoc {
  doc_id?: string;
  doc_type?: string;
  symptom?: string;
  text?: string;
  specialty?: string;
}

interface S1Differential {
  candidate_id?: string;
  symptom?: string;
  syndrome?: string;
  manifestation?: string;
  tongue?: string;
  pulse?: string;
  specialty?: string;
}

interface Std2024Entry {
  id?: string;
  disease?: string;
  specialty?: string;
  intro?: string;
  diagnosis_basis?: string;
  syndromes?: { name?: string; criteria?: string }[];
  source?: string;
  source_file?: string;
}

function baseDoc(
  layer: RuntimeLayer,
  overrides: Partial<KnowledgeDoc> & Pick<KnowledgeDoc, 'id' | 'text' | 'title' | 'kind' | 'disease' | 'syndrome' | 'treatment'>,
): KnowledgeDoc {
  return {
    sourceId: layer.sourceId,
    source: layer.source,
    sourceFile: '',
    sourceTier: layer.sourceTier,
    knowledgeRole: layer.role,
    prescriptionAuthority: layer.prescriptionAuthority,
    scope: layer.scope ?? 'general',
    formulas: [],
    releaseVersion: resolveReleaseVersion(config.kb.releaseDir),
    ...overrides,
  };
}

function loadNormative(layer: RuntimeLayer): KnowledgeDoc[] {
  const entries = loadJson<NormativeEntry[]>(path.join(config.kb.releaseDir, 'normative.json'));
  return entries.map((n) => {
    const formulas: NormativeFormula[] = (n.formulas ?? []).map((f) => ({
      id: str(f.id),
      name: str(f.name),
      composition: str(f.composition ?? f.raw_composition),
      sourceTier: str(f.source_tier),
      knowledgeRole: str(f.knowledge_role),
    }));
    const parts = [
      n.disease ? `病名：${n.disease}` : '',
      n.syndrome ? `证型：${n.syndrome}` : '',
      n.symptoms ? `症状：${n.symptoms}` : '',
      n.treatment ? `治法：${n.treatment}` : '',
      ...formulas.map((f) => `方剂：${f.name}（${f.composition}）`),
    ].filter(Boolean);
    return baseDoc(layer, {
      id: `P1:${n.id}`,
      text: parts.join('\n'),
      title: `${n.disease ?? ''}｜${n.syndrome ?? ''}`,
      kind: 'normative',
      disease: str(n.disease),
      syndrome: str(n.syndrome),
      treatment: str(n.treatment),
      source: str(n.source) || layer.source,
      sourceFile: str(n.source_file),
      sourceSchool: classifySourceSchool(str(n.source)),
      formulas,
      raw: n,
    });
  });
}

function loadCases(layer: RuntimeLayer): KnowledgeDoc[] {
  const entries = loadJson<CaseEntry[]>(path.join(config.kb.releaseDir, 'cases.json'));
  return entries.map((c) => {
    const domain = str(c.knowledge_domain) || layer.scope || 'general';
    return baseDoc(layer, {
      id: `P2:${c.id}`,
      text: str(c.raw),
      title: `${c.disease ?? ''}｜${c.patient ?? ''}`,
      kind: 'case',
      disease: str(c.disease),
      syndrome: '',
      treatment: '',
      source: str(c.source) || layer.source,
      sourceFile: str(c.source_file),
      sourceSchool: classifySourceSchool(str(c.source)),
      scope: domain,
      specialty: str(c.specialty) || undefined,
      raw: c,
    });
  });
}

function loadS1(layer: RuntimeLayer): KnowledgeDoc[] {
  const docs: KnowledgeDoc[] = [];
  const anchorFile = path.join(config.kb.releaseDir, 's1/symptom_anchor_docs.jsonl');
  if (existsSync(anchorFile)) {
    for (const a of loadJsonl(anchorFile) as S1AnchorDoc[]) {
      docs.push(baseDoc(layer, {
        id: `S1:${a.doc_id}`,
        text: str(a.text),
        title: `症状：${str(a.symptom)}`,
        kind: 'diagnostic',
        disease: '',
        syndrome: '',
        treatment: '',
        sourceFile: 's1/symptom_anchor_docs.jsonl',
        sourceSchool: classifySourceSchool(layer.source),
        specialty: str(a.specialty) || undefined,
        raw: a,
      }));
    }
  }
  const diffFile = path.join(config.kb.releaseDir, 's1/syndrome_differentials.jsonl');
  if (existsSync(diffFile)) {
    for (const d of loadJsonl(diffFile) as S1Differential[]) {
      const parts = [
        d.symptom ? `症状：${d.symptom}` : '',
        d.syndrome ? `证型：${d.syndrome}` : '',
        d.manifestation ? `表现：${d.manifestation}` : '',
        d.tongue ? `舌象：${d.tongue}` : '',
        d.pulse ? `脉象：${d.pulse}` : '',
      ].filter(Boolean);
      docs.push(baseDoc(layer, {
        id: `S1:${d.candidate_id}`,
        text: parts.join('\n'),
        title: `${str(d.symptom)}｜${str(d.syndrome)}`,
        kind: 'diagnostic',
        disease: '',
        syndrome: str(d.syndrome),
        treatment: '',
        sourceFile: 's1/syndrome_differentials.jsonl',
        sourceSchool: classifySourceSchool(layer.source),
        specialty: str(d.specialty) || undefined,
        raw: d,
      }));
    }
  }
  return docs;
}

function loadStandard2024(layer: RuntimeLayer): KnowledgeDoc[] {
  const entries = loadJson<Std2024Entry[]>(path.join(config.kb.releaseDir, 'tcm_diagnostic_2024.json'));
  return entries.map((e) => {
    const syndromeText = (e.syndromes ?? [])
      .map((s) => `证型：${str(s.name)}｜${str(s.criteria)}`)
      .join('\n');
    const parts = [
      e.intro ? `概述：${e.intro}` : '',
      e.diagnosis_basis ? `诊断依据：${e.diagnosis_basis}` : '',
      syndromeText,
    ].filter(Boolean);
    return baseDoc(layer, {
      id: `ZY2024:${e.id}`,
      text: parts.join('\n'),
      title: `诊断标准：${str(e.disease)}`,
      kind: 'standard',
      disease: str(e.disease),
      syndrome: '',
      treatment: '',
      source: str(e.source) || layer.source,
      sourceFile: str(e.source_file),
      sourceSchool: classifySourceSchool(str(e.source) || layer.source),
      specialty: str(e.specialty) || undefined,
      diseaseId: str(e.id) || undefined,
      raw: e,
    });
  });
}

/** 按 manifest layer 的 loader 解析文档。业务无 if/switch，只有文件形状分派。 */
function loadLayerDocs(layer: RuntimeLayer): KnowledgeDoc[] {
  switch (layer.loader) {
    case 'normative': return loadNormative(layer);
    case 'cases': return loadCases(layer);
    case 's1': return loadS1(layer);
    case 'standard-2024': return loadStandard2024(layer);
    default: return [];
  }
}

function emptyBreakdown(): IndexBreakdown {
  return {
    byRole: {
      DIAGNOSTIC_DIFFERENTIAL: 0,
      DIAGNOSTIC_STANDARD: 0,
      NORMATIVE_TREATMENT: 0,
      CLINICAL_CASE: 0,
    },
    bySourceTier: { P1: 0, P2: 0, AUX: 0 },
    bySourceSchool: {},
    prescriptionAuthority: { true: 0, false: 0 },
    blockedAssets: [...NON_RUNTIME_ASSETS.blocked],
    shadowAssets: [...NON_RUNTIME_ASSETS.shadow],
  };
}

function computeBreakdown(docs: KnowledgeDoc[]): IndexBreakdown {
  const b = emptyBreakdown();
  for (const d of docs) {
    b.byRole[d.knowledgeRole] = (b.byRole[d.knowledgeRole] ?? 0) + 1;
    b.bySourceTier[d.sourceTier] = (b.bySourceTier[d.sourceTier] ?? 0) + 1;
    const school = d.sourceSchool ?? 'unknown';
    b.bySourceSchool[school] = (b.bySourceSchool[school] ?? 0) + 1;
    if (d.prescriptionAuthority) b.prescriptionAuthority.true += 1;
    else b.prescriptionAuthority.false += 1;
  }
  return b;
}

function buildDocs(): KnowledgeDoc[] {
  const docs: KnowledgeDoc[] = [];
  for (const layer of knowledgeManifest) {
    if (!layer.runtime) continue;
    docs.push(...loadLayerDocs(layer));
  }
  return docs;
}

export async function buildIndex(force = false): Promise<KnowledgeIndex> {
  const releaseVersion = resolveReleaseVersion(config.kb.releaseDir);
  const cacheFile = path.join(config.kb.cacheDir, `index.${releaseVersion}.json`);
  if (!force && existsSync(cacheFile)) {
    const cached = loadJson<KnowledgeIndex>(cacheFile);
    // 旧 schema（无 breakdown / releaseVersion）不再兼容，自动重建。
    if (cached.breakdown && cached.releaseVersion && Array.isArray(cached.docs) && Array.isArray(cached.vectors)) {
      return cached;
    }
    console.log('[index] 检测到旧 schema 缓存，重建索引');
  }

  const docs = buildDocs();
  const breakdown = computeBreakdown(docs);
  const p1 = breakdown.bySourceTier.P1;
  const p2 = breakdown.bySourceTier.P2;
  console.log(`[index] release=${releaseVersion} 文档总数 ${docs.length}（P1 ${p1} / P2 ${p2} / AUX ${breakdown.bySourceTier.AUX}）`);
  console.log('[index] 开始向量化（embedding）...');

  const vectors = await embed(docs.map((d) => d.text));

  const index: KnowledgeIndex = {
    version: releaseVersion,
    releaseVersion,
    builtAt: new Date().toISOString(),
    docCount: docs.length,
    docs,
    vectors,
    breakdown,
  };

  mkdirSync(config.kb.cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(index));
  console.log(`[index] 已写入缓存 ${cacheFile}`);
  return index;
}

export async function loadIndex(): Promise<KnowledgeIndex> {
  return buildIndex(false);
}

function printReport(index: KnowledgeIndex): void {
  const b = index.breakdown;
  console.log('\n================ Index Build Report ================');
  console.log(`releaseVersion      ${index.releaseVersion}`);
  console.log(`totalDocuments      ${index.docCount}`);
  console.log('\nbyKnowledgeRole:');
  for (const role of RUNTIME_KNOWLEDGE_ROLES) console.log(`  ${role}: ${b.byRole[role] ?? 0}`);
  console.log('\nbySourceTier:');
  for (const [tier, n] of Object.entries(b.bySourceTier)) console.log(`  ${tier}: ${n}`);
  console.log('\nbySourceSchool:');
  for (const [school, n] of Object.entries(b.bySourceSchool)) console.log(`  ${school}: ${n}`);
  console.log('\nprescriptionAuthority:');
  console.log(`  true: ${b.prescriptionAuthority.true}`);
  console.log(`  false: ${b.prescriptionAuthority.false}`);
  console.log('\nblockedAssets:');
  for (const a of b.blockedAssets) console.log(`  ${a}`);
  console.log('\nshadowAssets:');
  for (const a of b.shadowAssets) console.log(`  ${a}`);
  console.log(`\nP1 normative count: ${b.bySourceTier.P1}`);
  console.log(`P2 case count:      ${b.bySourceTier.P2}`);
  console.log('===================================================\n');
}

// CLI 入口：`npm run build:index` 强制重建索引并输出报告
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildIndex(true).then(printReport).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
