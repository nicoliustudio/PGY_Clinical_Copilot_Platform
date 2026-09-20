import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverCapabilityManifests } from '../src/composition/load-assets.js';
import { PLATFORM_TOOLS } from '../src/composition/platform-assets.js';

test('H14 treatment-specific metadata is marked on capabilities, not core', async () => {
  const manifests = await discoverCapabilityManifests();
  const byId = new Map(manifests.map((m) => [m.id, m]));
  assert.equal(byId.get('gaofang')?.treatmentSpecific, true);
  assert.equal(byId.get('tcm.external-therapy')?.treatmentSpecific, true);
  assert.equal(byId.get('tcm.preparation')?.treatmentSpecific, true);
  // 非治疗形式能力不应被标记。
  assert.notEqual(byId.get('tcm.core')?.treatmentSpecific, true);
});

test('H14 treatment-specific metadata is marked on formula tool', () => {
  const formula = PLATFORM_TOOLS.find((t) => t.id === 'formula.search_normative');
  assert.equal(formula?.treatmentSpecific, true);
  // 通用诊断/目录工具不直接标记 treatmentSpecific（继承 capability）。
  const catalog = PLATFORM_TOOLS.find((t) => t.id === 'knowledge.search_cards');
  assert.notEqual(catalog?.treatmentSpecific, true);
});
