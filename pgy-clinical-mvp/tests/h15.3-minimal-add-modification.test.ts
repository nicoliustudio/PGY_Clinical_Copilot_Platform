import test from 'node:test';
import assert from 'node:assert/strict';
import { searchModificationEvidence } from '../src/clinical/modification-evidence.js';
import { createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { BASELINE_TOOL_IDS } from '../src/composition/platform-assets.js';

/**
 * H15.3 —— Minimal ADD Modification Integration
 * 确定性：命中 / 不命中 / 同义词 alias / tool surface / provenance。
 */

// Case A：明确 ADD trigger（SYMPTOM 头晕 → 钩藤等）
test('H15.3 Case A: 明确 SYMPTOM trigger → FOUND + 命中患者证据 ref + 药味/剂量', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '头晕' });
  const r = searchModificationEvidence(ws);
  assert.equal(r.result, 'FOUND');
  assert.ok(r.candidates.length > 0);
  const hit = r.candidates.find((c) => c.trigger === '头晕');
  assert.ok(hit, '应命中 trigger=头晕 的规则');
  assert.ok(hit.medication.includes('钩藤'), 'medication 应为来源药味（钩藤…）');
  assert.ok(hit.dose.length > 0, 'dose 应有剂量');
  assert.ok(hit.matchedPatientEvidenceRefs.includes('CF_001'), '应引用患者证据 CF_001');
  assert.ok(hit.sourceRef.length > 0, '应有来源 provenance');
  assert.ok(hit.modificationEvidenceRef.startsWith('R_'), 'modificationEvidenceRef 应为规则 id');
});

// Case B：无适用 trigger → NONE
test('H15.3 Case B: 无适用 trigger → NONE，零干扰', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '无明显特殊不适' });
  const r = searchModificationEvidence(ws);
  assert.equal(r.result, 'NONE');
  assert.deepEqual(r.candidates, []);
});

// Case C：同义 alias trigger（trigger 内部同义词列表）
test('H15.3 Case C: 多同义词 trigger 命中其一（癥瘕）', () => {
  const ws = createClinicalWorkspace();
  ws.clinicalDecisionSpine.diseaseAssessment = { statement: '癥瘕', evidenceRefs: [], version: 1 };
  const r = searchModificationEvidence(ws);
  assert.equal(r.result, 'FOUND');
  assert.ok(r.candidates.some((c) => c.trigger.includes('癥瘕')), '应命中含「癥瘕」同义词的 DISEASE 规则');
});

// Tool surface：新增 1 个 Agent-visible tool，不影响基础方 authority
test('H15.3 tool surface: 新增 formula.get_modification_evidence 为 Agent-visible', () => {
  assert.ok(BASELINE_TOOL_IDS.includes('formula.get_modification_evidence'));
});

// 检索到 ≠ 采用：纯函数不改 workspace，不写 ModificationPlan，不动 base composition
test('H15.3 纯函数：searchModificationEvidence 不改 workspace 状态（不自动采用）', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '头晕' });
  const before = JSON.stringify(ws.clinicalDecisionSpine);
  searchModificationEvidence(ws);
  const after = JSON.stringify(ws.clinicalDecisionSpine);
  assert.equal(before, after, '检索不应产生任何 workspace mutation');
  assert.equal(ws.clinicalDecisionSpine.modificationPlan, undefined);
});
