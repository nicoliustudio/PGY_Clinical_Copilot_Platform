import test from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { formulaSearchStateSignature } from '../src/clinical/formula-evidence.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';

/**
 * H15.5 — Execution Convergence（deterministic tests）。
 * Test A（stateful cache signature）/ D（candidate dedup）/ E（evidence dedup）/ F（compact receipt 不破坏事件生成）。
 */

// ---- Test A：stateful formula.search_candidates 签名随临床状态变化 ----
test('H15.5 Test A: formulaSearchStateSignature 随 pattern/treatment 变化', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const sig0 = formulaSearchStateSignature(ws);

  store.append('pattern.assessment.recorded', { primary: { statement: '气虚' } });
  const sig1 = formulaSearchStateSignature(ws);
  assert.notEqual(sig1, sig0, 'pattern assessment 变化应改变签名');

  store.append('treatment.plan.recorded', { primaryPrinciple: '益气升提', treatmentTarget: '止带' });
  const sig2 = formulaSearchStateSignature(ws);
  assert.notEqual(sig2, sig1, 'treatment plan 变化应改变签名');
});

// ---- Test D：candidate dedup ----
test('H15.5 Test D: 同一 candidate 重复 present 只写一次', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const draft = { type: 'candidate.presented' as const, payload: { id: 'P1:a::F:1', formulaId: 'F:1', sourceId: 'P1:a', name: '方A' } };

  const r1 = store.appendBatch([draft], 'b1');
  const r2 = store.appendBatch([draft], 'b2');
  assert.equal(r1.written, 1);
  assert.equal(r2.written, 0, '重复 present 应被 dedup');
  assert.equal(r2.deduped, 1);
  assert.equal(ws.candidates.length, 1);
});

// ---- Test E：evidence dedup ----
test('H15.5 Test E: 同一 evidence 被多个 query 命中只形成一条 canonical item', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const draft = { type: 'evidence.added' as const, payload: { id: 'P1:x', sourceId: 'P1:x', sourceType: 'P1' } };

  store.appendBatch([draft], 'b1');
  const r2 = store.appendBatch([draft], 'b2');
  const r3 = store.appendBatch([draft], 'b3');

  assert.equal(r2.written, 0, '第二次 evidence.added 应 dedup');
  assert.equal(r3.written, 0, '第三次 evidence.added 应 dedup');
  assert.equal(ws.evidenceState.evidenceItems.length, 1);
  assert.equal(ws.evidenceRefs.length, 1, 'evidenceRefs 也不应有重复');
});

// ---- Test F：record_deliberation compact receipt 不破坏事件生成 ----
test('H15.5 Test F: record_deliberation 事件仍由完整 input 生成（compact output 不影响）', () => {
  const input = {
    diseaseAssessment: { statement: '带下病' },
    treatmentPlan: { primaryPrinciple: '益气升提', treatmentTarget: '止带' },
    patternAssessment: { primary: { statement: '脾肾气虚' } },
  };
  // compact receipt（tool execute 返回值）不参与事件生成
  const compactOutput = { accepted: true, updatedArtifacts: ['diseaseAssessment', 'treatmentPlan', 'patternAssessment'], remainingDecisionChangingUnknowns: [] };

  const drafts = workspaceEventsForTool('workspace.record_deliberation', input, compactOutput);
  const types = drafts.map((d) => d.type);
  assert.ok(types.includes('disease.assessment.recorded'));
  assert.ok(types.includes('treatment.plan.recorded'));
  assert.ok(types.includes('pattern.assessment.recorded'));
  assert.ok(!types.includes('formula.selection.recorded'), 'formula.selection 只能由 formula.select 写入');
});
