import test from 'node:test';
import assert from 'node:assert/strict';
import { getReleaseDiseaseStandards, getReleaseDiagnosticPatterns, getReleaseCrosswalkCandidates, resetDiagnosticReleaseCache } from '../src/knowledge/diagnostic-release.js';
import { qaIngestion } from '../src/knowledge/diagnostic-qa.js';
import { projectDiagnosticRecord } from '../src/knowledge/diagnostic-schema.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';

const DYSMENORRHEA_SYNDROMES = ['气滞血瘀证', '寒凝血瘀证', '湿热瘀阻证', '气血亏虚证', '肝肾亏损证', '阳虚内寒证'];
const ADENOMYOSIS_SYNDROMES = ['气滞血瘀证', '寒凝血瘀证', '湿热瘀阻证', '痰瘀互结证', '气虚血瘀证', '肾虚血瘀证'];

test('A: getReleaseDiseaseStandards("痛经") 返回 ZY/T 3.1-2025（定义/诊断依据/鉴别）', () => {
  const standards = getReleaseDiseaseStandards('痛经');
  assert.equal(standards.length, 1);
  const s = standards[0];
  assert.equal(s.source.sourceId, 'ZY_T_3_1_2025_DYSMENORRHEA');
  assert.equal(s.source.standardNo, 'ZY/T 3.1-2025');
  assert.ok(s.definition?.text);
  assert.ok(s.diagnosticBasis?.text);
  assert.ok(s.differentialDiagnosis?.text);
  assert.equal(s.source.sourceStatus, 'NORMATIVE_CURRENT');
  assert.equal(s.source.sourceType, 'standard');
});

test('B: getReleaseDiagnosticPatterns("痛经") 返回 6 型', () => {
  const patterns = getReleaseDiagnosticPatterns('痛经');
  const syndromes = patterns.map((p) => p.syndrome.name).sort();
  assert.deepEqual(syndromes, [...DYSMENORRHEA_SYNDROMES].sort());
});

test('C: getReleaseDiseaseStandards("子宫腺肌病") 返回 T/GDACM 0117-2022（团体标准）', () => {
  const standards = getReleaseDiseaseStandards('子宫腺肌病');
  assert.equal(standards.length, 1);
  const s = standards[0];
  assert.equal(s.source.sourceId, 'T_GDACM_0117_2022_ADENOMYOSIS');
  assert.equal(s.source.standardNo, 'T/GDACM 0117-2022');
  assert.ok(s.generalMechanism?.text);
  assert.equal(s.source.sourceStatus, 'LOCAL_STANDARD');
  assert.equal(s.source.sourceType, 'local_standard');
});

test('D: getReleaseDiagnosticPatterns("子宫腺肌病") 返回 6 型', () => {
  const patterns = getReleaseDiagnosticPatterns('子宫腺肌病');
  const syndromes = patterns.map((p) => p.syndrome.name).sort();
  assert.deepEqual(syndromes, [...ADENOMYOSIS_SYNDROMES].sort());
});

test('来源等级区分：行业标准 NORMATIVE_CURRENT ≠ 团体标准 LOCAL_STANDARD', () => {
  const dy = getReleaseDiseaseStandards('痛经')[0];
  const ad = getReleaseDiseaseStandards('子宫腺肌病')[0];
  assert.notEqual(dy.source.sourceStatus, ad.source.sourceStatus);
  assert.notEqual(dy.source.sourceType, ad.source.sourceType);
});

test('field-level provenance 原样保留（气滞血瘀证 舌/脉/诊断依据/病机 各有 provenance）', () => {
  const patterns = getReleaseDiagnosticPatterns('子宫腺肌病');
  const qzy = patterns.find((p) => p.syndrome.name === '气滞血瘀证');
  assert.ok(qzy);
  assert.equal(qzy!.manifestations?.tongue?.provenance.sourceId, 'T_GDACM_0117_2022_ADENOMYOSIS');
  assert.equal(qzy!.manifestations?.pulse?.provenance.sourceId, 'T_GDACM_0117_2022_ADENOMYOSIS');
  assert.equal(qzy!.diagnosticBasis?.provenance.sourceId, 'T_GDACM_0117_2022_ADENOMYOSIS');
  assert.equal(qzy!.mechanism?.provenance.sourceId, 'T_GDACM_0117_2022_ADENOMYOSIS');
  assert.equal(qzy!.treatmentPrinciple?.provenance.sourceId, 'T_GDACM_0117_2022_ADENOMYOSIS');
});

test('E/F: 诊断投影 formula-free，且调用不产生 patient hypothesis', () => {
  const patterns = getReleaseDiagnosticPatterns('子宫腺肌病');
  for (const p of patterns) {
    const proj = projectDiagnosticRecord(p);
    const json = JSON.stringify(proj);
    for (const forbidden of ['formula', 'composition', 'candidateRef', 'bestMatch', 'recommendedSyndrome', '"score"', '主方', '中成药']) {
      assert.ok(!json.includes(forbidden), `${p.syndrome.name} 不应出现 ${forbidden}`);
    }
    const drafts = workspaceEventsForTool('knowledge.get_diagnostic_patterns', { disease: '子宫腺肌病' }, [proj]);
    assert.equal(drafts.length, 0);
  }
});

test('crosswalk candidates 保持 runtimeReady=false（不 activate 成 runtime relation）', () => {
  const candidates = getReleaseCrosswalkCandidates();
  assert.ok(candidates.length >= 7);
  for (const c of candidates) {
    assert.equal(c.runtimeReady, false);
    assert.equal(c.reviewStatus, 'SOURCE_SUPPORTED_CANDIDATE');
  }
});

test('qaIngestion 跑 ZIP 数据：8 项检查全过', () => {
  const patterns = [...getReleaseDiagnosticPatterns('痛经'), ...getReleaseDiagnosticPatterns('子宫腺肌病')];
  const qa = qaIngestion(patterns, { resolvedDiseaseNames: new Set(['痛经', '子宫腺肌病']) });
  assert.equal(qa.ok, true, qa.errors.join('; '));
  assert.deepEqual(qa.errors, []);
});

test.after(() => resetDiagnosticReleaseCache());
