import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMedications, renderMedicationList, searchModificationEvidence } from '../src/clinical/modification-evidence.js';
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
  assert.ok(hit.medications.some((m) => m.herb.includes('钩藤')), 'medications 应为来源药味（钩藤…）');
  assert.ok(hit.medications.some((m) => m.herb.includes('钩藤') && m.dose), '药名与剂量必须成对，不得拆成两条平行列表');
  assert.ok(hit.matchedPatientEvidenceRefs.includes('CF_001'), '应引用患者证据 CF_001');
  assert.deepEqual(hit.matchedAssessmentRefs, [], 'Symptom scope 不该出现临床判断 artifact ref');
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

// ---------- 药名/剂量配对：结构性不变式（不是格式枚举，而是「剂量紧随药名」） ----------

test('H15.3 解析：三种真实写法都得到同一「药名+剂量」配对', () => {
  assert.deepEqual(parseMedications('石打穿15、石见穿15、鬼箭羽15、黑丑12'), [
    { herb: '石打穿', dose: '15' },
    { herb: '石见穿', dose: '15' },
    { herb: '鬼箭羽', dose: '15' },
    { herb: '黑丑', dose: '12' },
  ]);
  // 空格分隔（medication_rules 中唯一的空格写法）
  assert.deepEqual(parseMedications('红藤9 败酱草9'), [
    { herb: '红藤', dose: '9' },
    { herb: '败酱草', dose: '9' },
  ]);
  // 带单位
  assert.deepEqual(parseMedications('蒲公英15克、红藤15克'), [
    { herb: '蒲公英', dose: '15克' },
    { herb: '红藤', dose: '15克' },
  ]);
});

test('H15.3 解析：药名与剂量被空白拆成两段时重新配对，不把剂量当成一味药', () => {
  assert.deepEqual(parseMedications('石打穿 15、石见穿 15'), [
    { herb: '石打穿', dose: '15' },
    { herb: '石见穿', dose: '15' },
  ]);
});

test('H15.3 解析：无剂量药名保持无剂量，炮制脚注留在药名内，数字开头药名不误判', () => {
  assert.deepEqual(parseMedications('知柏地黄丸'), [{ herb: '知柏地黄丸' }]);
  assert.deepEqual(parseMedications('生军（后下）6克'), [{ herb: '生军（后下）', dose: '6克' }]);
  assert.deepEqual(parseMedications('821消瘤片'), [{ herb: '821消瘤片' }]);
});

test('H15.3 投影：文本逐味相邻，且渲染后再解析仍是同一配对', () => {
  const items = parseMedications('石打穿15、石见穿15、鬼箭羽15、黑丑12');
  const text = renderMedicationList(items);
  assert.equal(text, '石打穿 15、石见穿 15、鬼箭羽 15、黑丑 12');
  // 旧缺陷形态是「药名一串 剂量一串」；配对修复后投影必须可逆。
  assert.deepEqual(parseMedications(text), items);
  assert.equal(renderMedicationList([{ herb: '知柏地黄丸' }]), '知柏地黄丸');
});
