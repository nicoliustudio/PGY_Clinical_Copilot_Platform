import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diseaseCoreName,
  isApplicableDisease,
  buildP2CandidateCards,
} from '../src/clinical/formula-evidence.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';

// === applicability 判断（A / C） ===

test('H15.2.6 A: 妇科适用 P1 的 disease 核心匹配 → applicable', () => {
  assert.equal(isApplicableDisease('月经病-痛经', ['痛经']), true);
  assert.equal(isApplicableDisease('月经病-月经后期', ['月经后期']), true);
});

test('H15.2.6 C: P1 语义相似但 context 不适用 → not applicable', () => {
  // 普通咳嗽不应被「妊娠咳嗽」P1 命中判为 applicable。
  assert.equal(isApplicableDisease('妊娠病-妊娠咳嗽', ['咳嗽']), false);
  assert.equal(diseaseCoreName('妊娠病-妊娠咳嗽'), '妊娠咳嗽');
  assert.equal(diseaseCoreName('肺系病证-咳嗽'), '咳嗽');
});

// === P2 candidate 形成（B / D / F） ===

function p2Hit(overrides: Record<string, unknown> = {}): any {
  return {
    sourceId: 'P2:C_cough001',
    title: '肺系病证-咳嗽｜张某,女,42岁',
    authority: 'P2',
    sourceTier: 'P2',
    knowledgeRole: 'CLINICAL_CASE',
    prescriptionAuthority: false,
    excerpt: '辨证分型:风痰恋肺...方药:...',
    score: 0.9,
    provenance: { source: '沈仲理临证医集', sourceFile: 'x.txt', disease: '肺系病证-咳嗽', syndrome: '', treatment: '' },
    formulas: [],
    ...overrides,
  };
}

test('H15.2.6 B: P2 case hit → case-derived formula candidate', () => {
  const cards = buildP2CandidateCards([p2Hit()]);
  assert.equal(cards.length, 1);
});

test('H15.2.6 D: P2 candidate 保留 provenance（candidateRef/sourceCaseRef/sourceAuthority）', () => {
  const cards = buildP2CandidateCards([p2Hit()]);
  const c = cards[0];
  assert.equal(c.candidateRef, 'P2:C_cough001::case');
  assert.equal(c.sourceCaseRef, 'P2:C_cough001');
  assert.equal(c.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(c.fallbackReason, 'NO_APPLICABLE_P1');
  assert.equal(c.sourceTier, 'P2');
});

test('H15.2.6 F: 无 P1 且无 P2 hit → 空 candidates（不 hallucinate）', () => {
  assert.deepEqual(buildP2CandidateCards([]), []);
});

test('H15.2.6: P1 hit 不进入 P2 candidate（只 P2 case 形成 candidate）', () => {
  const cards = buildP2CandidateCards([p2Hit({ sourceTier: 'P1', authority: 'P1', sourceId: 'P1:xxx' })]);
  assert.deepEqual(cards, []);
});

// === P2 retrieval 不自动选方（E） ===

test('H15.2.6 E: formula.search_candidates 只产生 presented，不自动 selected', () => {
  const drafts = workspaceEventsForTool(
    'formula.search_candidates',
    { topK: 5 },
    { candidates: [{ candidateRef: 'P2:C_cough001::case', formulaId: 'P2:C_cough001', sourceId: 'P2:C_cough001', formulaName: '咳嗽病例', sourceAuthority: 'P2_CASE_DERIVED', sourceCaseRef: 'P2:C_cough001' }] },
  );
  const types = drafts.map((d) => d.type);
  assert.ok(types.includes('candidate.presented'));
  assert.ok(!types.includes('candidate.selected'));
  assert.ok(!types.includes('formula.selection.recorded'));
});
