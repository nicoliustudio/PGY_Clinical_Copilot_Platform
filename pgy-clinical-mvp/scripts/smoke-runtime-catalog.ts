import { discoverCapabilityManifests } from '../src/composition/load-assets.js';
import {
  countRuntimeCards,
  getRuntimeAsset,
  resetRuntimeCatalogCache,
  searchRuntimeCards,
} from '../src/knowledge/runtime-catalog.js';

/**
 * Runtime Catalog 最小 Smoke Test —— 不调用 LLM，只验证
 * discover → activate → scoped card retrieval → asset_id detail fetch 的结构链路。
 */

const manifests = await discoverCapabilityManifests();
const byId = new Map(manifests.map((m) => [m.id, m]));

function activateScopes(ids: string[]): string[] {
  const scopes: string[] = [];
  for (const id of ids) {
    const cap = byId.get(id);
    if (!cap) throw new Error(`unknown capability: ${id}`);
    for (const scope of cap.knowledgeScopes) if (!scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

function report(title: string, fn: () => void): void {
  console.log(`\n=== ${title} ===`);
  fn();
}

resetRuntimeCatalogCache();

report('Chain 1: 想开膏方调理 → discover gaofang → activate → 只检索 gaofang cards → asset fetch', () => {
  const cap = byId.get('gaofang');
  console.log(`discover: ${cap?.id} (${cap?.description})`);
  const scopes = activateScopes(['gaofang']);
  console.log(`activate → knowledgeScopes = [${scopes.join(', ')}]`);
  console.log(`scoped card count = ${countRuntimeCards(scopes)}`);
  const cards = searchRuntimeCards('想开膏方调理', scopes, { topK: 3 }).cards;
  for (const c of cards) console.log(`  - ${c.asset_id} ${c.title}`);
  const detail = getRuntimeAsset('GF-001', scopes);
  console.log(`asset fetch GF-001 → asset_id=${(detail as Record<string, unknown>)?.asset_id}, can_decide_base_formula=${(detail as Record<string, unknown>)?.can_decide_base_formula}`);
});

report('Chain 2: 希望配合针灸 → discover tcm.external-therapy → 只检索 external-therapy cards', () => {
  const cap = byId.get('tcm.external-therapy');
  console.log(`discover: ${cap?.id} (${cap?.description})`);
  const scopes = activateScopes(['tcm.external-therapy']);
  console.log(`activate → knowledgeScopes = [${scopes.join(', ')}]`);
  console.log(`scoped card count = ${countRuntimeCards(scopes)}（AC-039/AC-046 不进入）`);
  const cards = searchRuntimeCards('希望配合针灸', scopes, { topK: 3 }).cards;
  for (const c of cards) console.log(`  - ${c.asset_id} ${c.title}`);
  console.log(`AC-039 deferred fetch = ${getRuntimeAsset('AC-039', scopes)}`);
});

report('Chain 3: 想了解某中成药/制剂 → discover tcm.preparation → 只检索 preparation cards', () => {
  const cap = byId.get('tcm.preparation');
  console.log(`discover: ${cap?.id} (${cap?.description})`);
  const scopes = activateScopes(['tcm.preparation']);
  console.log(`activate → knowledgeScopes = [${scopes.join(', ')}]`);
  console.log(`scoped card count = ${countRuntimeCards(scopes)}（PR-091 注射剂不进入）`);
  const cards = searchRuntimeCards('想了解某中成药', scopes, { topK: 3 }).cards;
  for (const c of cards) console.log(`  - ${c.asset_id} ${c.title}`);
  console.log(`PR-091 deferred fetch = ${getRuntimeAsset('PR-091', scopes)}`);
});

report('Chain 4: 普通辨证病例（未提出治疗形式要求）→ 不应无故加载这些 scope', () => {
  console.log(`baseline scope card count = ${countRuntimeCards(['general'])}`);
  console.log(`empty scope card count = ${countRuntimeCards([])}`);
  console.log(`gaofang scoped card count = ${countRuntimeCards(['gaofang'])}`);
  console.log(`external-therapy scoped card count = ${countRuntimeCards(['tcm.external-therapy'])}`);
  console.log(`preparation scoped card count = ${countRuntimeCards(['tcm.preparation'])}`);
});

console.log('\nSmoke test complete.');
