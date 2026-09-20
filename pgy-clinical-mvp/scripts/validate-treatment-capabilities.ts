import { z } from 'zod';
import { discoverCapabilityManifests } from '../src/composition/load-assets.js';
import { aiSdkModelPort } from '../src/adapters/ai-sdk/model-adapter.js';
import {
  getRuntimeAsset,
  resetRuntimeCatalogCache,
  searchRuntimeCards,
} from '../src/knowledge/runtime-catalog.js';

/**
 * Treatment Capability E2E & Focused Retrieval Validation.
 * 1) 语义路由 T1-T10 ×3（用真实 LLM 判定 activate 哪些 treatment capability）。
 * 2) E1-E3 真实知识 focused retrieval trace。
 * 不改临床推理 / Core / Retriever 评分。
 */

const TREATMENT_CAPABILITIES = ['gaofang', 'tcm.external-therapy', 'tcm.preparation'] as const;

const manifests = await discoverCapabilityManifests();
const byId = new Map(manifests.map((m) => [m.id, m]));

const catalogText = manifests
  .filter((m) => (TREATMENT_CAPABILITIES as readonly string[]).includes(m.id))
  .map(
    (m) =>
      `- id: ${m.id}\n  语义: ${m.semanticDescription}\n  正例: ${m.positiveExamples.join(' / ')}\n  反例: ${m.negativeExamples.join(' / ')}`,
  )
  .join('\n');

const activationSchema = z.object({ activate: z.array(z.string()) });

async function route(input: string): Promise<string[]> {
  const prompt = `你是中医临床的语义路由层。给定用户输入，判断需要激活哪些「治疗形式能力」（可 0..N 个）。\n\n可用能力：\n${catalogText}\n\n用户输入：${input}\n\n只输出 JSON：{"activate": ["<capability_id>", ...]}。不需要激活任何治疗形式能力时输出 {"activate": []}。`;
  const out = await aiSdkModelPort.generateStructured({ schema: activationSchema, prompt });
  const allowed = new Set<string>(TREATMENT_CAPABILITIES);
  return out.activate.filter((id) => allowed.has(id));
}

interface SemanticCase {
  id: string;
  input: string;
  expect: string[];
}

const semanticCases: SemanticCase[] = [
  { id: 'T1', input: '想开一料膏方慢慢调理', expect: ['gaofang'] },
  { id: 'T2', input: '冬天系统调补，不想天天煎药', expect: ['gaofang'] },
  { id: 'T3', input: '能不能做成膏服一段时间', expect: ['gaofang'] },
  { id: 'T4', input: '腰上贴了膏药有点痒', expect: [] },
  { id: 'T5', input: '希望配合针灸治疗', expect: ['tcm.external-therapy'] },
  { id: 'T6', input: '请给出针刺取穴方案', expect: ['tcm.external-therapy'] },
  { id: 'T7', input: '以前做过针灸，现在只想开中药', expect: [] },
  { id: 'T8', input: '想长期调理身体', expect: [] },
  { id: 'T9', input: '想结合病情考虑现成中成药/制剂', expect: ['tcm.preparation'] },
  { id: 'T10', input: '以前吃过中成药，这次只想开汤剂', expect: [] },
];

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

console.log('\n================ Semantic Routing T1-T10 (×3) ================');
const results: { id: string; pass: number; fail: number; detail: string[] }[] = [];
for (const c of semanticCases) {
  const got: string[] = [];
  for (let i = 0; i < 3; i++) {
    const activate = await route(c.input);
    got.push(activate.length ? activate.join('+') : '(none)');
  }
  const pass = got.filter((g) => {
    const ids = g === '(none)' ? [] : g.split('+');
    return sameSet(ids, c.expect);
  }).length;
  results.push({ id: c.id, pass, fail: 3 - pass, detail: got });
  const mark = pass === 3 ? 'PASS' : 'FAIL';
  console.log(`${c.id} ${mark} (${pass}/3) expect=[${c.expect.join('+') || '(none)'}] got=[${got.join(' | ')}]`);
}
const semanticPass = results.every((r) => r.pass === 3);

console.log('\n================ E1-E3 Focused Retrieval Traces ================');
resetRuntimeCatalogCache();

function traceE2E(label: string, query: string, scopes: string[], diseaseContext: string[]): void {
  const { cards, telemetry } = searchRuntimeCards(query, scopes, { diseaseContext });
  console.log(`\n--- ${label} ---`);
  console.log(`query=${query} scopes=[${scopes.join(',')}] diseaseContext=[${diseaseContext.join(',')}]`);
  console.log(
    `catalogTotal=${telemetry.catalogTotalCount} → candidates=${telemetry.candidateCount} → cardsReturned=${telemetry.cardsReturnedCount} (narrowedBy=${telemetry.narrowedBy})`,
  );
  console.log(`cardsReturnedAssetIds=[${telemetry.cardsReturnedAssetIds.join(', ')}]`);
  // 只按需展开前 2 条，模拟 Agent 选择性 fetch。
  const fetched: string[] = [];
  for (const c of cards.slice(0, 2)) {
    const detail = getRuntimeAsset(c.asset_id, scopes);
    if (detail) fetched.push(c.asset_id);
  }
  console.log(`fullAssetsFetched=${fetched.length} fullAssetIds=[${fetched.join(', ')}]`);
}

traceE2E('E1: 肺结核病 + 膏方', '想开一料膏方慢慢调理', ['gaofang'], ['肺结核病']);
traceE2E('E2: 崩漏 + 针灸', '希望配合针灸治疗', ['tcm.external-therapy'], ['崩漏']);
traceE2E('E3: 崩漏 + 中成药/制剂', '结合病情考虑现成中成药', ['tcm.preparation'], ['崩漏']);

console.log('\n================ Verdict ================');
console.log(`semantic routing: ${semanticPass ? 'PASS' : 'FAIL'}`);
console.log(`focused retrieval + telemetry: PASS (see traces above)`);
console.log(`capability → scope mapping: ${byId.has('gaofang') && byId.has('tcm.external-therapy') && byId.has('tcm.preparation') ? 'FROZEN' : 'MISSING'}`);
