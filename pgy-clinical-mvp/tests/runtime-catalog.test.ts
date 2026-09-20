import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCapabilityManifests } from '../src/composition/load-assets.js';
import {
  countRuntimeCards,
  getRuntimeAsset,
  loadRuntimeCards,
  resetRuntimeCatalogCache,
  searchRuntimeCards,
} from '../src/knowledge/runtime-catalog.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

function uniqueScopes(cards: { activation_scope?: string | null }[]): string[] {
  return [...new Set(cards.map((c) => c.activation_scope ?? '').filter(Boolean))];
}

test('Capability manifests carry the correct runtime knowledge scope', async () => {
  const manifests = await discoverCapabilityManifests();
  const byId = new Map(manifests.map((m) => [m.id, m]));
  assert.deepEqual(byId.get('gaofang')?.knowledgeScopes, ['gaofang']);
  assert.deepEqual(byId.get('tcm.external-therapy')?.knowledgeScopes, ['tcm.external-therapy']);
  assert.deepEqual(byId.get('tcm.preparation')?.knowledgeScopes, ['tcm.preparation']);
});

test('gaofang boundary: long-term regulation alone must not activate', async () => {
  const manifests = await discoverCapabilityManifests();
  const gaofang = manifests.find((m) => m.id === 'gaofang');
  assert.ok(gaofang);
  assert.ok(gaofang.negativeExamples.includes('想长期调理身体，没有特别指定剂型'));
  assert.ok(gaofang.semanticDescription.includes('膏滋') || gaofang.semanticDescription.includes('剂型'));
});

test('gaofang scope returns only 22 gaofang cards', () => {
  resetRuntimeCatalogCache();
  const cards = loadRuntimeCards(['gaofang']);
  assert.equal(cards.length, 22);
  assert.deepEqual(uniqueScopes(cards), ['gaofang']);
  assert.ok(cards.every((c) => c.asset_id.startsWith('GF-')));
  assert.ok(cards.every((c) => c.can_decide_base_formula === false));
});

test('external-therapy scope returns 69 cards and defers AC-039/AC-046', () => {
  resetRuntimeCatalogCache();
  const cards = loadRuntimeCards(['tcm.external-therapy']);
  assert.equal(cards.length, 69);
  assert.deepEqual(uniqueScopes(cards), ['tcm.external-therapy']);
  const ids = cards.map((c) => c.asset_id);
  assert.ok(!ids.includes('AC-039'));
  assert.ok(!ids.includes('AC-046'));
});

test('preparation scope returns 282 cards and defers PR-091 (INJECTABLE)', () => {
  resetRuntimeCatalogCache();
  const cards = loadRuntimeCards(['tcm.preparation']);
  assert.equal(cards.length, 282);
  assert.deepEqual(uniqueScopes(cards), ['tcm.preparation']);
  const ids = cards.map((c) => c.asset_id);
  assert.ok(!ids.includes('PR-091'));
  assert.ok(cards.every((c) => c.subtype !== 'INJECTABLE'));
});

test('no cross-scope pollution and no accidental baseline loading', () => {
  resetRuntimeCatalogCache();
  assert.equal(loadRuntimeCards([]).length, 0);
  assert.equal(loadRuntimeCards(['general']).length, 0);

  const gaofangIds = new Set(loadRuntimeCards(['gaofang']).map((c) => c.asset_id));
  const externalIds = new Set(loadRuntimeCards(['tcm.external-therapy']).map((c) => c.asset_id));
  const prepIds = new Set(loadRuntimeCards(['tcm.preparation']).map((c) => c.asset_id));

  // 三个 scope 的资产 ID 空间彼此不相交。
  assert.equal([...gaofangIds].filter((id) => externalIds.has(id)).length, 0);
  assert.equal([...gaofangIds].filter((id) => prepIds.has(id)).length, 0);
  assert.equal([...externalIds].filter((id) => prepIds.has(id)).length, 0);
});

test('full asset fetch by asset_id respects scope and deferral', () => {
  resetRuntimeCatalogCache();
  const gaofang = getRuntimeAsset('GF-001', ['gaofang']);
  assert.ok(gaofang);
  assert.equal((gaofang as Record<string, unknown>).asset_id, 'GF-001');
  assert.equal((gaofang as Record<string, unknown>).can_decide_base_formula, false);

  const acupuncture = getRuntimeAsset('AC-001', ['tcm.external-therapy']);
  assert.ok(acupuncture);
  assert.equal((acupuncture as Record<string, unknown>).asset_id, 'AC-001');

  // 跨 scope 不允许读取。
  assert.equal(getRuntimeAsset('GF-001', ['tcm.external-therapy']), null);
  assert.equal(getRuntimeAsset('AC-001', ['gaofang']), null);

  // deferred 资产不允许读取。
  assert.equal(getRuntimeAsset('AC-039', ['tcm.external-therapy']), null);
  assert.equal(getRuntimeAsset('AC-046', ['tcm.external-therapy']), null);
  assert.equal(getRuntimeAsset('PR-091', ['tcm.preparation']), null);
});

test('scoped card retrieval ranks by knowledge relevance only', () => {
  resetRuntimeCatalogCache();
  const { cards: hits } = searchRuntimeCards('肺结核 咳嗽 膏方调理', ['gaofang'], { topK: 22 });
  assert.equal(hits.length, 22);
  assert.ok(hits.every((h) => h.activation_scope === 'gaofang'));
  // 每个命中都是 lean card：不携带患者匹配分 / best syndrome / best formula。
  assert.ok(hits.every((h) => !('patientMatchScore' in h)));
  assert.ok(hits.every((h) => !('bestSyndrome' in h)));
  assert.ok(hits.every((h) => !('bestFormula' in h)));
  // relevance 单调非增（知识相关性排序）。
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].relevance >= hits[i].relevance);
});

test('E1 focused retrieval: 肺结核病 + gaofang does not return the whole catalog', () => {
  resetRuntimeCatalogCache();
  const { cards, telemetry } = searchRuntimeCards('想开一料膏方调理', ['gaofang'], { diseaseContext: ['肺结核病'] });
  assert.equal(telemetry.catalogTotalCount, 22);
  assert.ok(telemetry.candidateCount < 22);
  assert.equal(telemetry.narrowedBy, 'disease');
  assert.ok(cards.length <= 8);
  assert.ok(cards.every((c) => c.activation_scope === 'gaofang'));
  assert.ok(cards.every((c) => c.asset_id.startsWith('GF-')));
});

test('E2 focused retrieval: 崩漏 + external-therapy narrows away from 69 cards', () => {
  resetRuntimeCatalogCache();
  const { cards, telemetry } = searchRuntimeCards('希望配合针灸治疗', ['tcm.external-therapy'], { diseaseContext: ['崩漏'] });
  assert.equal(telemetry.catalogTotalCount, 69);
  assert.ok(telemetry.candidateCount < 69);
  assert.equal(telemetry.narrowedBy, 'disease');
  assert.ok(cards.length > 0 && cards.length < 69);
  assert.ok(cards.every((c) => c.activation_scope === 'tcm.external-therapy'));
});

test('E3 focused retrieval: 崩漏 + preparation narrows away from 282 cards', () => {
  resetRuntimeCatalogCache();
  const { cards, telemetry } = searchRuntimeCards('结合病情考虑现成中成药', ['tcm.preparation'], { diseaseContext: ['崩漏'] });
  assert.equal(telemetry.catalogTotalCount, 282);
  assert.ok(telemetry.candidateCount < 282);
  assert.equal(telemetry.narrowedBy, 'disease');
  assert.ok(cards.length > 0 && cards.length < 282);
  assert.ok(cards.every((c) => c.activation_scope === 'tcm.preparation'));
});

test('focused retrieval telemetry exposes catalogTotal -> candidates -> cards', () => {
  resetRuntimeCatalogCache();
  const { cards, telemetry } = searchRuntimeCards('崩漏希望配合针灸', ['tcm.external-therapy'], { diseaseContext: ['崩漏'] });
  assert.ok(Array.isArray(telemetry.activeScopes));
  assert.equal(typeof telemetry.catalogTotalCount, 'number');
  assert.equal(typeof telemetry.candidateCount, 'number');
  assert.equal(typeof telemetry.cardsReturnedCount, 'number');
  assert.deepEqual(telemetry.cardsReturnedAssetIds, cards.map((c) => c.asset_id));
  assert.equal(telemetry.cardsReturnedCount, cards.length);
  assert.ok(telemetry.candidateCount >= telemetry.cardsReturnedCount);
});

test('Harness activation injects the scope without core pre-routing', async () => {
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      const discoverable = context.harness.listCapabilities();
      assert.ok(discoverable.some((c) => c.id === 'tcm.preparation'));
      assert.ok(discoverable.some((c) => c.id === 'tcm.external-therapy'));
      context.harness.activateCapability('tcm.preparation', 'explicit preparation request');
      context.harness.activateCapability('tcm.external-therapy', 'explicit acupuncture request');
      return { ...clinicalProposal(), missing_information: context.knowledgeScopes };
    },
  });

  const { authority } = await runtime.run('希望配合针灸，也想了解某中成药');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.ok(authority.proposal.missing_information.includes('tcm.preparation'));
  assert.ok(authority.proposal.missing_information.includes('tcm.external-therapy'));
});

test('countRuntimeCards reports the acceptance counts', () => {
  resetRuntimeCatalogCache();
  assert.equal(countRuntimeCards(['gaofang']), 22);
  assert.equal(countRuntimeCards(['tcm.external-therapy']), 69);
  assert.equal(countRuntimeCards(['tcm.preparation']), 282);
});
