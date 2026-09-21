import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_TOOL_IDS, PLATFORM_TOOLS } from '../src/composition/platform-assets.js';
import { discoverCapabilityManifests } from '../src/composition/load-assets.js';
import { isApplicableDisease, diseaseCoreName, buildP2CandidateCards, p2FormulaIdentity } from '../src/clinical/formula-evidence.js';
import { RetrievalDisciplineTracker } from '../src/adapters/ai-sdk/retrieval-discipline.js';

/**
 * H15.2.10 —— Formula Retrieval Surface Consolidation
 * 目标：基础临床只保留一个 primary formula search entry（formula.search_candidates），
 *       legacy search_normative 降为 gaofang 专用；authority 语义不变。
 */

function encounterHit(overrides: Record<string, unknown> = {}): any {
  return {
    sourceId: 'P2:E_v1',
    title: '脾胃肠系病证-胃痛｜某,男,38岁｜初诊',
    authority: 'P2',
    sourceTier: 'P2',
    knowledgeRole: 'CLINICAL_CASE',
    prescriptionAuthority: false,
    excerpt: '辨证分型:...方药:...',
    score: 0.9,
    provenance: { source: '沈仲理临证医集', sourceFile: 'x.txt', disease: '脾胃肠系病证-胃痛', syndrome: '湿热中阻', treatment: '清化湿热' },
    formulas: [],
    kind: 'case-formula',
    caseId: 'C_stomach001',
    visit: '初诊',
    composition: '半夏9g,黄连6g',
    ...overrides,
  };
}

// === D：Tool Surface 收敛 ===

test('H15.2.10 D: baseline 不含 legacy search_normative，保留 search_candidates + get_evidence', () => {
  assert.ok(BASELINE_TOOL_IDS.includes('formula.search_candidates'));
  assert.ok(BASELINE_TOOL_IDS.includes('formula.get_evidence'));
  assert.ok(BASELINE_TOOL_IDS.includes('formula.validate'));
  assert.ok(!BASELINE_TOOL_IDS.includes('formula.search_normative'), 'legacy search_normative 不应在基础临床 baseline');
});

test('H15.2.10 D2: tcm.core 不再引用 search_normative；gaofang 仍保留', async () => {
  const manifests = await discoverCapabilityManifests();
  const tcmCore = manifests.find((m) => m.id === 'tcm.core');
  const gaofang = manifests.find((m) => m.id === 'gaofang');
  assert.ok(tcmCore, 'tcm.core 应存在');
  assert.ok(gaofang, 'gaofang 应存在');
  assert.ok(!tcmCore.toolIds.includes('formula.search_normative'), 'tcm.core 不应引用 legacy search_normative');
  assert.ok(gaofang.toolIds.includes('formula.search_normative'), 'gaofang 保留 search_normative（膏方基础方 P1 检索）');
});

// === A/B/C：search_candidates 的 P1 优先 / P2 fallback / provenance ===

test('H15.2.10 A: applicable P1 → 不被 P2 fallback 冒充（disease 核心匹配）', () => {
  assert.equal(isApplicableDisease('脾胃肠系病证-胃痛', ['胃痛']), true);
  assert.equal(diseaseCoreName('脾胃肠系病证-胃痛'), '胃痛');
});

test('H15.2.10 B: 无 applicable P1 场景下 P2 fallback 形成 formula-level candidate', () => {
  const cards = buildP2CandidateCards([encounterHit()]);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(c.fallbackReason, 'NO_APPLICABLE_P1');
  assert.equal(c.formulaId, p2FormulaIdentity('P2:C_stomach001', 'E_v1'));
});

test('H15.2.10 C: P1/P2 provenance 保持（P2 不升权、candidateRef 可被 get_evidence 解析）', () => {
  const c = buildP2CandidateCards([encounterHit()])[0];
  assert.equal(c.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(c.sourceTier, 'P2');
  assert.ok(c.candidateRef.split('::')[0] === 'P2:E_v1', 'candidateRef 保留 sourceId 前缀供 get_evidence 解析');
  assert.equal(c.sourceCaseRef, 'P2:C_stomach001');
});

// === F：NEW/NO_NEW_INFORMATION 机制保持 ===

test('H15.2.10 F: 无信息 formula 检索仍标记 NO_NEW_INFORMATION', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordToolExecution({
    toolName: 'formula.search_candidates',
    reused: false,
    decisionImpact: 'none',
    rawOutput: { candidates: [] },
    candidateIdsBefore: new Set(),
    evidenceIdsBefore: new Set(),
    newCandidateCount: 0,
    newEvidenceCount: 0,
  });
  assert.equal(tracker.feedback().lastFormulaRetrieval?.info, 'NO_NEW_INFORMATION');
});
