import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildP2CandidateCards,
  p2FormulaIdentity,
} from '../src/clinical/formula-evidence.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { canonicalizeProposalSubmit } from '../src/adapters/ai-sdk/proposal-canonicalizer.js';

/**
 * H15.2.7 —— P2 Formula Candidate Normalization
 * 目标：把 P2 病例的方药证据规范化为 formula-level candidate（encounter-level），
 * 不再用 case title 冒充方名，不跨诊次合并，不自动选方/升权。
 */

function encounterHit(overrides: Record<string, unknown> = {}): any {
  return {
    sourceId: 'P2:E_v1',
    title: '肺系病证-咳嗽｜张某,女,42岁｜初诊',
    authority: 'P2',
    sourceTier: 'P2',
    knowledgeRole: 'CLINICAL_CASE',
    prescriptionAuthority: false,
    excerpt: '病名:肺系病证-咳嗽...方药:麻黄6g,杏仁9g',
    score: 0.9,
    provenance: {
      source: '沈仲理临证医集',
      sourceFile: 'x.txt',
      disease: '肺系病证-咳嗽',
      syndrome: '风痰恋肺',
      treatment: '疏风化痰',
    },
    formulas: [],
    kind: 'case-formula',
    caseId: 'C_cough001',
    visit: '初诊',
    composition: '麻黄6g,杏仁9g',
    sourceSpanId: 'SPAN_1',
    patient: '张某,女,42岁',
    symptoms: '咳嗽3周',
    ...overrides,
  };
}

// === A：有明确方名 ===

test('H15.2.7 A: P2 单诊病例有明确方名 → formulaName = 原方名，provenance 保留', () => {
  const cards = buildP2CandidateCards([encounterHit({ formulaName: '止嗽散' })]);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.formulaName, '止嗽散');
  assert.equal(c.sourceAuthority, 'P2_CASE_DERIVED');
  assert.equal(c.sourceCaseRef, 'P2:C_cough001');
  assert.equal(c.sourceEvidenceRef, 'E_v1');
});

// === B：多诊病例不合并 ===

test('H15.2.7 B: 多诊病例初诊方 != 二诊方 → 不同 candidateRef，不跨诊次合并', () => {
  const v1 = encounterHit({ sourceId: 'P2:E_v1', visit: '初诊', composition: '麻黄6g' });
  const v2 = encounterHit({ sourceId: 'P2:E_v2', visit: '二诊', composition: '桂枝9g' });
  const cards = buildP2CandidateCards([v1, v2]);
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].candidateRef, cards[1].candidateRef);
  assert.equal(cards[0].visitRef, 'E_v1');
  assert.equal(cards[1].visitRef, 'E_v2');
  assert.equal(cards[0].stage, '初诊');
  assert.equal(cards[1].stage, '二诊');
});

// === C：无正式方名 → 稳定 identity，不用 case title 冒充方名 ===

test('H15.2.7 C: 无正式方名 → 稳定 identity，不得用 case title 作 formulaName', () => {
  const cards = buildP2CandidateCards([encounterHit()]);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.formulaName, '病例方（原案无正式方名）');
  assert.notEqual(c.formulaName, '肺系病证-咳嗽｜张某,女,42岁｜初诊');
  assert.equal(c.formulaId, p2FormulaIdentity('P2:C_cough001', 'E_v1'));
  assert.ok(c.candidateRef.startsWith('case-visit:P2:E_v1'));
});

// === D：不升级 authority ===

test('H15.2.7 D: P2 candidate 不升级（sourceAuthority=P2_CASE_DERIVED，authority=GENERATED_DRAFT）', async () => {
  const cards = buildP2CandidateCards([encounterHit()]);
  const c = cards[0];
  assert.equal(c.sourceAuthority, 'P2_CASE_DERIVED');

  const mockDocs = [{
    id: c.sourceId,
    sourceTier: 'P2',
    kind: 'case-formula',
    composition: '麻黄6g,杏仁9g',
    formulaName: undefined,
  }];

  const result = await canonicalizeProposalSubmit(
    {
      mode: 'clinical',
      disease: { name: '咳嗽', confidence: 0.8 },
      syndrome: { name: '风痰恋肺', confidence: 0.8 },
      treatment: { text: '疏风化痰' },
      candidate_ref: c.candidateRef,
    },
    {
      runId: 'r1',
      workspace: {
        candidates: [{
          id: c.candidateRef,
          kind: 'formula',
          formulaId: c.formulaId,
          sourceId: c.sourceId,
          name: c.formulaName,
          sourceAuthority: 'P2_CASE_DERIVED',
          sourceCaseRef: c.sourceCaseRef,
          visitRef: c.visitRef,
          sourceEvidenceRef: c.sourceEvidenceRef,
        }],
      },
    } as any,
    mockDocs as any,
  );

  assert.equal(result.mode, 'clinical');
  const formula = (result as any).formula;
  assert.equal(formula.authority, 'GENERATED_DRAFT');
  assert.equal(formula.source_authority, 'P2_CASE_DERIVED');
  assert.deepEqual(formula.composition, ['麻黄6g,杏仁9g']);
  assert.equal(formula.source_case_ref, 'P2:C_cough001');
  assert.equal(formula.visit_ref, 'E_v1');
});

// === E：检索不自动选方 / 不自动假设 / 不自动提交 ===

test('H15.2.7 E: formula.search_candidates 只产生 presented，不自动 selected/hypothesis/submit', () => {
  const cards = buildP2CandidateCards([encounterHit()]);
  const drafts = workspaceEventsForTool(
    'formula.search_candidates',
    { topK: 5 },
    { candidates: cards },
  );
  const types = drafts.map((d) => d.type);
  assert.ok(types.includes('candidate.presented'));
  assert.ok(!types.includes('candidate.selected'));
  assert.ok(!types.includes('hypothesis.presented'));
  assert.ok(!types.includes('formula.selection.recorded'));
});

// === F：typed builder preserves source role boundaries ===

test('H15.2.7 F: P1 hit 不会被 P2 builder 误标成 CASE_ANALOG', () => {
  const p1Hit = encounterHit({ sourceId: 'P1:norm_1', authority: 'P1', sourceTier: 'P1', kind: undefined });
  assert.deepEqual(buildP2CandidateCards([p1Hit]), []);
});

// === G：无可确认方药 → 不 hallucinate ===

test('H15.2.7 G: P2 病例无方药 → 不得生成 formula candidate', () => {
  const emptyFormula = encounterHit({ composition: '   ' });
  assert.deepEqual(buildP2CandidateCards([emptyFormula]), []);
});
