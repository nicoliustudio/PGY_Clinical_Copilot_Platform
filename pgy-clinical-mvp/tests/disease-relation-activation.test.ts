import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { getDiseaseStandards } from '../src/knowledge/standard-runtime.js';
import { resolveDiseaseConcepts } from '../src/knowledge/disease-concepts.js';
import { getActivatedDiseaseRelations, resetDiagnosticReleaseCache } from '../src/knowledge/diagnostic-release.js';

const originalFlag = config.experiment.diagnosticRelease;

test('Test A: query=痛经 + case context=子宫腺肌病 → 返回痛经 + 子宫腺肌病 standard', () => {
  config.experiment.diagnosticRelease = true;
  const result = getDiseaseStandards('痛经', { caseDiseaseContext: ['子宫腺肌病'] });
  const diseases = result.map((r) => r.disease);
  const sources = result.map((r) => r.source.sourceId);
  assert.ok(diseases.includes('痛经'));
  assert.ok(diseases.includes('子宫腺肌病'));
  assert.ok(sources.includes('ZY_T_3_1_2025_DYSMENORRHEA'));
  assert.ok(sources.includes('T_GDACM_0117_2022_ADENOMYOSIS'));
});

test('Test B: query=痛经 + case context=[] → 不返回子宫腺肌病 standard', () => {
  config.experiment.diagnosticRelease = true;
  const result = getDiseaseStandards('痛经', { caseDiseaseContext: [] });
  const sources = result.map((r) => r.source.sourceId);
  assert.ok(!sources.includes('T_GDACM_0117_2022_ADENOMYOSIS'));
});

test('Test C: query=癥瘕 + case context=子宫腺肌病 → 子宫腺肌病 standard 可见', () => {
  config.experiment.diagnosticRelease = true;
  const result = getDiseaseStandards('癥瘕', { caseDiseaseContext: ['子宫腺肌病'] });
  const sources = result.map((r) => r.source.sourceId);
  assert.ok(sources.includes('T_GDACM_0117_2022_ADENOMYOSIS'));
});

test('别名匹配：case context 用「子宫腺肌症」别名 → 仍匹配「子宫腺肌病」relation 端点', () => {
  config.experiment.diagnosticRelease = true;
  const result = getDiseaseStandards('痛经', { caseDiseaseContext: ['子宫腺肌症'] });
  const sources = result.map((r) => r.source.sourceId);
  assert.ok(sources.includes('T_GDACM_0117_2022_ADENOMYOSIS'));
});

test('Test D: relation lookup 是纯函数，不产生 hypothesis / disease / syndrome / formula mutation', () => {
  const relations = getActivatedDiseaseRelations();
  assert.ok(relations.length >= 4);
  for (const rel of relations) {
    assert.ok(rel.relation === 'TCM_CORRESPONDENCE' || rel.relation === 'SUBTYPE_OF');
    assert.notEqual(rel.provenance.sourceId, '');
    assert.ok(rel.provenance.pageOrSection);
    assert.ok(rel.provenance.evidenceText);
  }
  // resolveDiseaseConcepts 纯函数只返回 concepts，不写 workspace。
  const concepts = resolveDiseaseConcepts({
    queryDisease: '痛经',
    caseDiseaseContext: ['子宫腺肌病'],
    docs: [],
    relations,
  });
  const diseases = concepts.map((c) => c.disease);
  assert.ok(diseases.includes('子宫腺肌病'));
  assert.ok(diseases.includes('痛经'));
});

test('RELATED / WESTERN_CORRESPONDENCE 不激活（防止泥石流）', () => {
  const relations = getActivatedDiseaseRelations();
  // 只应激活 TCM_CORRESPONDENCE（痛经/月经过多/癥瘕）与 SUBTYPE_OF（子宫腺肌瘤→子宫腺肌病），
  // RELATED（崩漏/经期延长/不孕）与 WESTERN_CORRESPONDENCE 不激活。
  for (const rel of relations) {
    assert.notEqual(rel.relation, 'RELATED');
    assert.notEqual(rel.relation, 'WESTERN_CORRESPONDENCE');
  }
});

test('SUBTYPE_OF：query=痛经 + case context=子宫腺肌瘤 → 子宫腺肌病 standard 可见（T_GDACM 召回）', () => {
  config.experiment.diagnosticRelease = true;
  const result = getDiseaseStandards('痛经', { caseDiseaseContext: ['子宫腺肌瘤'] });
  const sources = result.map((r) => r.source.sourceId);
  assert.ok(sources.includes('T_GDACM_0117_2022_ADENOMYOSIS'));
});

test('SUBTYPE_OF：query=癥瘕 + case context=子宫腺肌瘤 → 子宫腺肌病 standard 可见', () => {
  config.experiment.diagnosticRelease = true;
  const result = getDiseaseStandards('癥瘕', { caseDiseaseContext: ['子宫腺肌瘤'] });
  const sources = result.map((r) => r.source.sourceId);
  assert.ok(sources.includes('T_GDACM_0117_2022_ADENOMYOSIS'));
});

test('SUBTYPE_OF：resolve(子宫腺肌瘤) → 解析出 子宫腺肌病（SUBTYPE_OF），且不合并 subtype', () => {
  const relations = getActivatedDiseaseRelations();
  const concepts = resolveDiseaseConcepts({
    queryDisease: '痛经',
    caseDiseaseContext: ['子宫腺肌瘤'],
    docs: [],
    relations,
  });
  const supertype = concepts.find((c) => c.disease === '子宫腺肌病');
  assert.ok(supertype);
  assert.equal(supertype.relation, 'SUBTYPE_OF');
  // subtype 不并入 supertype：子宫腺肌瘤 不以 canonical 形式被 push（非同义词，不 auto-canonicalize）。
  assert.ok(!concepts.some((c) => c.disease === '子宫腺肌瘤'));
});

test('SUBTYPE_OF 方向性：case context=子宫腺肌病 不反向扩展出 子宫腺肌瘤', () => {
  config.experiment.diagnosticRelease = true;
  const result = getDiseaseStandards('痛经', { caseDiseaseContext: ['子宫腺肌病'] });
  const diseases = result.map((r) => r.disease);
  // 子宫腺肌病（supertype）不应反向带出 子宫腺肌瘤（subtype 无独立标准）。
  assert.ok(!diseases.includes('子宫腺肌瘤'));
  assert.ok(diseases.includes('子宫腺肌病'));
});

test.after(() => {
  config.experiment.diagnosticRelease = originalFlag;
  resetDiagnosticReleaseCache();
});
