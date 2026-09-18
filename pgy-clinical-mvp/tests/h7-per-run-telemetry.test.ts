import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCanonicalFormula,
  getFormulaHydrationStats,
  resetFormulaHydrationStats,
  recordFormulaValidation,
} from '../src/clinical/formula.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

function doc(id: string, formulaId: string, name: string, composition: string): KnowledgeDoc {
  return {
    id,
    sourceId: 'SRC',
    sourceTier: 'P1',
    knowledgeRole: 'NORMATIVE_TREATMENT',
    prescriptionAuthority: true,
    releaseVersion: 'test',
    kind: 'normative',
    source: 'S',
    sourceFile: 's.json',
    disease: 'd',
    syndrome: 's',
    treatment: 't',
    scope: 'general',
    title: name,
    text: name,
    formulas: [{ id: formulaId, name, composition, sourceTier: 'P1', knowledgeRole: 'normative' }],
    raw: {},
  };
}

test('两个连续 run 的 hydration telemetry 完全隔离', async () => {
  const srcId = 'P1:h7a1';
  const fid = 'F:h7a1';
  const docs = [doc(srcId, fid, '方A', '药甲')];
  resetFormulaHydrationStats('run-A');
  resetFormulaHydrationStats('run-B');

  await getCanonicalFormula(srcId, fid, 'run-A', docs);

  assert.equal(getFormulaHydrationStats('run-A').formulaHydrationCalls, 1);
  assert.equal(getFormulaHydrationStats('run-A').formulaHydrationCacheHitCount, 0);
  assert.equal(getFormulaHydrationStats('run-B').formulaHydrationCalls, 0);
  assert.equal(getFormulaHydrationStats('run-B').formulaHydrationCacheHitCount, 0);
});

test('run A hydration count 不进入 run B', async () => {
  const srcId = 'P1:h7a2';
  const fid = 'F:h7a2';
  const docs = [doc(srcId, fid, '方B', '药乙')];
  resetFormulaHydrationStats('run-A2');
  resetFormulaHydrationStats('run-B2');

  await getCanonicalFormula(srcId, fid, 'run-A2', docs);
  await getCanonicalFormula(srcId, fid, 'run-B2', docs);

  assert.equal(getFormulaHydrationStats('run-A2').formulaHydrationCalls, 1);
  assert.equal(getFormulaHydrationStats('run-A2').formulaHydrationCacheHitCount, 0);
  assert.equal(getFormulaHydrationStats('run-B2').formulaHydrationCalls, 0);
  assert.equal(getFormulaHydrationStats('run-B2').formulaHydrationCacheHitCount, 1);
});

test('cache 存在时 telemetry 仍按 run 统计', async () => {
  const srcId = 'P1:h7a3';
  const fid = 'F:h7a3';
  const docs = [doc(srcId, fid, '方C', '药丙')];
  resetFormulaHydrationStats('run-A3');
  resetFormulaHydrationStats('run-B3');

  await getCanonicalFormula(srcId, fid, 'run-A3', docs);
  await getCanonicalFormula(srcId, fid, 'run-A3', docs);
  await getCanonicalFormula(srcId, fid, 'run-B3', docs);

  assert.equal(getFormulaHydrationStats('run-A3').formulaHydrationCalls, 1);
  assert.equal(getFormulaHydrationStats('run-A3').formulaHydrationCacheHitCount, 1);
  assert.equal(getFormulaHydrationStats('run-B3').formulaHydrationCalls, 0);
  assert.equal(getFormulaHydrationStats('run-B3').formulaHydrationCacheHitCount, 1);
});

test('uniqueCandidatesValidated <= uniqueCandidatesHydrated', async () => {
  const srcId = 'P1:h7a4';
  const fid = 'F:h7a4';
  resetFormulaHydrationStats('run-C');
  await getCanonicalFormula(srcId, fid, 'run-C', [doc(srcId, fid, '方D', '药丁')]);
  recordFormulaValidation('run-C', `${srcId}::${fid}`);
  const s = getFormulaHydrationStats('run-C');
  assert.equal(s.uniqueCandidatesHydrated, 1);
  assert.equal(s.uniqueCandidatesValidated, 1);
  assert.ok(s.uniqueCandidatesValidated <= s.uniqueCandidatesHydrated);
});

test('同 candidate 多次 validate：unique 不重复计数，calls 正确增加', async () => {
  const srcId = 'P1:h7a5';
  const fid = 'F:h7a5';
  resetFormulaHydrationStats('run-D');
  await getCanonicalFormula(srcId, fid, 'run-D', [doc(srcId, fid, '方E', '药戊')]);
  recordFormulaValidation('run-D', `${srcId}::${fid}`);
  recordFormulaValidation('run-D', `${srcId}::${fid}`);
  const s = getFormulaHydrationStats('run-D');
  assert.equal(s.uniqueCandidatesValidated, 1);
  assert.equal(s.formulaValidationCalls, 2);
});

test('recordFormulaValidation 无 candidateKey 只增加 calls 不增加 unique validated', () => {
  resetFormulaHydrationStats('run-E');
  recordFormulaValidation('run-E');
  const s = getFormulaHydrationStats('run-E');
  assert.equal(s.formulaValidationCalls, 1);
  assert.equal(s.uniqueCandidatesValidated, 0);
});
