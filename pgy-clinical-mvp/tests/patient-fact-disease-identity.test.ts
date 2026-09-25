import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaseDiseaseNames } from '../src/knowledge/disease-concepts.js';
import {
  patientDiseaseIdentityNames,
  isApplicableDisease,
  diseaseCoreName,
} from '../src/clinical/formula-evidence.js';
import { createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';

/**
 * Patient Fact / Disease Identity Authority —— 通用不变量测试。
 *
 * 用户明确提供的疾病身份（kind=past_diagnosis）必须：
 * 1. 经 diagnosis_map 确定性解析为 Knowledge Store 规范病名；
 * 2. 成为独立于 Agent diseaseAssessment 的检索事实，reasoning 无法覆盖；
 * 3. 使 canonical source 的 applicability 判定命中其 core 病名。
 *
 * 本套件不使用任何 case-specific 特判：仅验证「机制」本身。
 */

test('resolveCaseDiseaseNames：用户明说的西医病名 → 规范中医病名（diagnosis_map）', () => {
  // 子宫肌瘤（西医名）应交叉映射到规范病名「女性生殖系统肿瘤-子宫肌瘤」。
  const names = resolveCaseDiseaseNames(['子宫肌瘤肌壁间型']);
  assert.ok(names.includes('女性生殖系统肿瘤-子宫肌瘤'), `actual=${JSON.stringify(names)}`);
});

test('resolveCaseDiseaseNames：无命中时返回空（不伪造 identity）', () => {
  const names = resolveCaseDiseaseNames(['不存在的病名xyz']);
  assert.deepEqual(names, []);
});

test('patientDiseaseIdentityNames：从 past_diagnosis 事实解析出 surface + canonical + core', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts = [
    { id: 'CF_001', kind: 'past_diagnosis', value: '子宫肌瘤肌壁间型', evidenceKind: 'patient' },
    { id: 'CF_002', kind: 'symptom', value: '经期延长', evidenceKind: 'patient' },
  ];
  const names = patientDiseaseIdentityNames(ws);
  assert.ok(names.includes('子宫肌瘤肌壁间型'), 'surface form 应保留');
  assert.ok(names.includes('女性生殖系统肿瘤-子宫肌瘤'), 'canonical 应解析出');
  assert.ok(names.includes('子宫肌瘤'), 'core 病名应解析出');
});

test('patientDiseaseIdentityNames：无 past_diagnosis 时 symptom 无 canonical 映射则仅保留 surface form（不伪造 identity）', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts = [{ id: 'CF_001', kind: 'symptom', value: '经期延长', evidenceKind: 'patient' }];
  // 「经期延长」在 diagnosis_map 无映射，不得伪造 canonical；但 surface form 仍作为召回信号保留。
  assert.deepEqual(patientDiseaseIdentityNames(ws), ['经期延长']);
});

test('patientDiseaseIdentityNames：症状含病名信号时经 diagnosis_map 解析出 canonical（纯症状输入）', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts = [{ id: 'CF_001', kind: 'symptom', value: '带下色黄有腥味，虽轻未止', evidenceKind: 'patient' }];
  const names = patientDiseaseIdentityNames(ws);
  assert.ok(names.includes('带下病-黄带'), `canonical 应解析出: actual=${JSON.stringify(names)}`);
  assert.ok(names.includes('黄带'), `core 病名应解析出: actual=${JSON.stringify(names)}`);
});

test('core 病名命中 canonical source：isApplicableDisease 与 diseaseCoreName 闭合', () => {
  const canonical = '女性生殖系统肿瘤-子宫肌瘤';
  assert.equal(diseaseCoreName(canonical), '子宫肌瘤');
  // 患者疾病身份（core）必须命中 canonical source。
  assert.equal(isApplicableDisease(canonical, ['子宫肌瘤']), true);
  // 未命中其他病种时不得误判。
  assert.equal(isApplicableDisease('月经病-崩漏', ['子宫肌瘤']), false);
});

test('reasoning 独立性：patientDiseaseIdentityNames 不读取 diseaseAssessment', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts = [{ id: 'CF_001', kind: 'past_diagnosis', value: '子宫肌瘤', evidenceKind: 'patient' }];
  // 即使 Agent 把病写成「崩漏」（reasoning 覆盖），患者疾病身份仍必须可解析。
  ws.clinicalDecisionSpine.diseaseAssessment = { statement: '月经病-崩漏', diseaseRefs: [], evidenceRefs: [], version: 1 };
  const names = patientDiseaseIdentityNames(ws);
  assert.ok(names.includes('子宫肌瘤'), 'reasoning 的 diseaseAssessment 不得覆盖用户疾病身份');
});
