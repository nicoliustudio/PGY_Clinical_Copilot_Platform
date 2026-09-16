import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { embed } from '../model/adapter.js';
import type { KnowledgeDoc, KnowledgeIndex, NormativeFormula } from './types.js';

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

interface NormativeEntry {
  id: string;
  source?: string;
  source_file?: string;
  disease?: string;
  syndrome?: string;
  symptoms?: string;
  treatment?: string;
  formulas?: {
    id: string;
    name: string;
    composition?: string;
    raw_composition?: string;
    source_tier?: string;
    knowledge_role?: string;
  }[];
}

interface CaseEntry {
  id: string;
  source?: string;
  source_file?: string;
  disease?: string;
  patient?: string;
  raw?: string;
  knowledge_domain?: string;
}

/** 从 V2 release 结构化资产构建检索文档。gold/evaluation 数据绝不进入索引。 */
function buildDocs(): KnowledgeDoc[] {
  const dir = config.kb.releaseDir;
  const docs: KnowledgeDoc[] = [];

  // P1 规范条目（唯一处方权威）
  const normative = loadJson<NormativeEntry[]>(path.join(dir, 'normative.json'));
  for (const n of normative) {
    const formulas: NormativeFormula[] = (n.formulas ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      composition: f.composition ?? f.raw_composition ?? '',
      sourceTier: f.source_tier ?? '',
      knowledgeRole: f.knowledge_role ?? '',
    }));
    const parts = [
      n.disease ? `病名：${n.disease}` : '',
      n.syndrome ? `证型：${n.syndrome}` : '',
      n.symptoms ? `症状：${n.symptoms}` : '',
      n.treatment ? `治法：${n.treatment}` : '',
      ...formulas.map((f) => `方剂：${f.name}（${f.composition}）`),
    ].filter(Boolean);
    docs.push({
      id: `P1:${n.id}`,
      tier: 'P1',
      kind: 'normative',
      source: n.source ?? '',
      sourceFile: n.source_file ?? '',
      disease: n.disease ?? '',
      syndrome: n.syndrome ?? '',
      treatment: n.treatment ?? '',
      title: `${n.disease ?? ''}｜${n.syndrome ?? ''}`,
      text: parts.join('\n'),
      formulas,
      raw: n,
    });
  }

  // P2 沈仲理病例（观察性历史案例；膏方需显式 intent，MVP 第一版索引排除）
  const cases = loadJson<CaseEntry[]>(path.join(dir, 'cases.json'));
  for (const c of cases) {
    const isGaofang =
      c.knowledge_domain === 'gaofang' || (c.raw ?? '').includes('膏方');
    if (isGaofang) continue; // 膏方路由后续单独实现，此处不进入普通检索
    docs.push({
      id: `P2:${c.id}`,
      tier: 'P2',
      kind: 'case',
      source: c.source ?? '',
      sourceFile: c.source_file ?? '',
      disease: c.disease ?? '',
      syndrome: '',
      treatment: '',
      title: `${c.disease ?? ''}｜${c.patient ?? ''}`,
      text: c.raw ?? '',
      formulas: [],
      raw: c,
    });
  }

  return docs;
}

export async function buildIndex(force = false): Promise<KnowledgeIndex> {
  const cacheFile = path.join(config.kb.cacheDir, 'index.json');
  if (!force && existsSync(cacheFile)) {
    return loadJson<KnowledgeIndex>(cacheFile);
  }

  const docs = buildDocs();
  const p1 = docs.filter((d) => d.tier === 'P1').length;
  const p2 = docs.filter((d) => d.tier === 'P2').length;
  console.log(`[index] 文档总数 ${docs.length}（P1 ${p1} / P2 ${p2}）`);
  console.log('[index] 开始向量化（embedding）...');

  const vectors = await embed(docs.map((d) => d.text));

  const index: KnowledgeIndex = {
    version: '2026.09.4-kb-parity-r1',
    builtAt: new Date().toISOString(),
    docCount: docs.length,
    docs,
    vectors,
  };

  mkdirSync(config.kb.cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(index));
  console.log(`[index] 已写入缓存 ${cacheFile}`);
  return index;
}

export async function loadIndex(): Promise<KnowledgeIndex> {
  return buildIndex(false);
}

// CLI 入口：`npm run build:index` 强制重建索引
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildIndex(true).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
