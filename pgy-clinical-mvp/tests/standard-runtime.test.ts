import test from 'node:test';
import assert from 'node:assert/strict';
import { getDiseaseStandard, getSyndromeStandard, resetStandardRuntimeCache } from '../src/knowledge/standard-runtime.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';

test('Syndrome standard：气滞血瘀 → 返回 GB/T 16751.2 规范证候证据', () => {
  const r = getSyndromeStandard('气滞血瘀');
  assert.ok(r, '应查到气滞血瘀证');
  assert.equal(r!.canonicalName, '气滞血瘀证');
  assert.ok(r!.definition);
  assert.ok(r!.etiologyMechanism);
  assert.ok(r!.characteristicEvidence.length > 0);
  assert.ok(r!.tongueEvidence.length > 0);
  assert.ok(r!.pulseEvidence.length > 0);
  assert.ok(r!.provenance.definitionStandard.includes('16751'));
});

test('Syndrome standard：肝郁脾虚 → 规范证候（复合证型可查）', () => {
  const r = getSyndromeStandard('肝郁脾虚');
  assert.ok(r, '应查到肝郁脾虚证');
  assert.equal(r!.canonicalName, '肝郁脾虚证');
  assert.ok(r!.definition);
});

test('Syndrome standard：返回不含 formula / bestMatch / score / recommendedSyndrome', () => {
  const r = getSyndromeStandard('气滞血瘀');
  const json = JSON.stringify(r);
  for (const forbidden of ['formula', 'candidateRef', 'composition', 'bestMatch', 'recommendedSyndrome', '"score"', '妇2号方', '桂枝茯苓丸']) {
    assert.ok(!json.includes(forbidden), `不应出现 ${forbidden}`);
  }
});

test('Disease standard：崩漏 → 返回定义/诊断依据/证候分类', () => {
  const r = getDiseaseStandard('崩漏');
  assert.ok(r, '应查到崩漏标准');
  assert.ok(r!.definition);
  assert.ok(r!.diagnosisBasis);
  assert.ok(r!.syndromes.length > 0);
  assert.equal(typeof r!.syndromes[0].name, 'string');
  assert.equal(typeof r!.syndromes[0].criteria, 'string');
});

test('Disease standard：返回不含方剂', () => {
  const r = getDiseaseStandard('崩漏');
  const json = JSON.stringify(r);
  assert.ok(!json.includes('formula'));
  assert.ok(!json.includes('composition'));
});

test('标准检索不产生 patient hypothesis（H12）', () => {
  const syn = getSyndromeStandard('气滞血瘀');
  const dis = getDiseaseStandard('崩漏');
  assert.deepEqual(workspaceEventsForTool('knowledge.get_syndrome_standard', { syndrome: '气滞血瘀' }, syn), []);
  assert.deepEqual(workspaceEventsForTool('knowledge.get_disease_standard', { disease: '崩漏' }, dis), []);
});

test('未知证型/病名 fail-closed 返回 null（不臆造）', () => {
  assert.equal(getSyndromeStandard('不存在的证型XYZ'), null);
  assert.equal(getDiseaseStandard('不存在的病名XYZ'), null);
});

test.after(() => resetStandardRuntimeCache());
