import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDiagnosticPatterns } from '../src/knowledge/diagnostic-patterns.js';
import { resolveDiseaseConcepts, resetRecallMappingsCache } from '../src/knowledge/disease-concepts.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

function makeDoc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: 'P1:K_test',
    text: '',
    sourceId: 'P1_GYN_MANUAL',
    source: '《中医妇科临床手册》',
    sourceFile: '女性生殖系统肿瘤.txt',
    sourceTier: 'P1',
    knowledgeRole: 'NORMATIVE_TREATMENT',
    prescriptionAuthority: true,
    scope: 'general',
    disease: '',
    syndrome: '',
    treatment: '',
    title: '',
    formulas: [],
    releaseVersion: 'test',
    kind: 'normative',
    ...overrides,
  };
}

const docs: KnowledgeDoc[] = [
  makeDoc({ id: 'P1:K_460013ecebf1', disease: '女性生殖系统肿瘤-子宫肌瘤', syndrome: '气滞血瘀', treatment: '理气活血化瘀', raw: { symptoms: '经前乳胀，下腹胀痛…苔薄，舌淡，脉细弦。' }, formulas: [{ id: 'F_033933373d17', name: '桂枝茯苓丸加味', composition: '桂枝6克…', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA' }] }),
  makeDoc({ id: 'P1:K_ba9520cb8cd8', disease: '女性生殖系统肿瘤-子宫肌瘤', syndrome: '肝郁脾虚型', treatment: '健脾升清，疏肝散结', raw: { symptoms: '月经正常，或经行后期，量多如崩…舌质淡白或薄白，脉濡细或弦细。' }, formulas: [{ id: 'F_10a0a15f5929', name: '妇2号方', composition: '人参9克…', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA' }] }),
  makeDoc({ id: 'P1:K_03fbdc8801bd', disease: '女性生殖系统肿瘤-子宫肌瘤', syndrome: '阴虚火旺型', treatment: '凉血止血、化瘀消瘤', raw: { symptoms: '月经先期…舌质红少津，脉弦细或细数。' }, formulas: [{ id: 'F_360d41920857', name: '妇3号方', composition: '北沙参9克…', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA' }] }),
  makeDoc({ id: 'P1:K_16f610427794', disease: '女性生殖系统肿瘤-子宫肌瘤', syndrome: '寒痰凝结', treatment: '软坚散寒，化瘀消癥', raw: { symptoms: '胞宫癥块…苔薄，舌淡，脉细滑。' }, formulas: [{ id: 'F_241a980afcf8', name: '苍附导痰丸加味', composition: '苍术10克…', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA' }] }),
  makeDoc({ id: 'P1:K_1f7cee3af547', disease: '女性生殖系统肿瘤-癥瘕', syndrome: '痰湿', treatment: '化痰消积', raw: { symptoms: '下腹肿块，固定不移。' }, formulas: [{ id: 'F_c363eba20e3a', name: '苍附导痰丸加味', composition: '苍术10克…', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA' }] }),
  makeDoc({ id: 'P1:K_3bdde528336c', disease: '月经病-经期延长', syndrome: '气虚', treatment: '益气固冲摄血', raw: { symptoms: '经期延长…' }, formulas: [{ id: 'F_d7f2208eb43f', name: '固冲煎', composition: '黄芪12克…', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA' }] }),
];

test('Test 1: query「子宫肌瘤」exact 解析为「女性生殖系统肿瘤-子宫肌瘤」', () => {
  const concepts = resolveDiseaseConcepts({ queryDisease: '子宫肌瘤', caseDiseaseContext: [], docs });
  const diseases = concepts.map((c) => c.disease);
  assert.ok(diseases.includes('女性生殖系统肿瘤-子宫肌瘤'));
  // 不应把「癥瘕」或「经期延长」混入。
  assert.ok(!diseases.includes('女性生殖系统肿瘤-癥瘕'));
  assert.ok(!diseases.includes('月经病-经期延长'));

  const records = projectDiagnosticPatterns(docs, diseases);
  const syndromes = records.map((r) => r.syndrome).sort();
  assert.deepEqual(syndromes, ['寒痰凝结', '气滞血瘀', '肝郁脾虚型', '阴虚火旺型']);
});

test('Test 2: query「癥瘕」+ case context「子宫肌瘤」扩展召回子宫肌瘤证型（含肝郁脾虚）', () => {
  const concepts = resolveDiseaseConcepts({ queryDisease: '癥瘕', caseDiseaseContext: ['子宫肌瘤、子宫腺肌瘤'], docs });
  const diseases = concepts.map((c) => c.disease);
  assert.ok(diseases.includes('女性生殖系统肿瘤-癥瘕'), '应含癥瘕病种');
  assert.ok(diseases.includes('女性生殖系统肿瘤-子宫肌瘤'), '应经 crosswalk 召回子宫肌瘤病种');

  const records = projectDiagnosticPatterns(docs, diseases);
  const refs = records.map((r) => r.patternRef);
  assert.ok(refs.includes('P1:K_ba9520cb8cd8'), '肝郁脾虚型（子宫肌瘤）必须进入结果');
  const syndromes = records.map((r) => r.syndrome);
  assert.ok(syndromes.includes('肝郁脾虚型'));
  assert.ok(syndromes.includes('痰湿'), '癥瘕病种的痰湿证也应保留');
});

test('Test 3: 不把「癥瘕」与「子宫肌瘤」合并为同一 disease（保留 relation）', () => {
  const concepts = resolveDiseaseConcepts({ queryDisease: '癥瘕', caseDiseaseContext: ['子宫肌瘤'], docs });
  const byDisease = new Map(concepts.map((c) => [c.disease, c.relation]));
  assert.ok(byDisease.has('女性生殖系统肿瘤-癥瘕'));
  assert.ok(byDisease.has('女性生殖系统肿瘤-子宫肌瘤'));
  // 是两个不同 disease，不是 synonym 合并。
  assert.notEqual('女性生殖系统肿瘤-癥瘕', '女性生殖系统肿瘤-子宫肌瘤');
  // relation 语义保留（癥瘕=EXACT，子宫肌瘤来自 case context=TCM_CORRESPONDENCE）。
  assert.equal(byDisease.get('女性生殖系统肿瘤-癥瘕'), 'EXACT');
  assert.equal(byDisease.get('女性生殖系统肿瘤-子宫肌瘤'), 'TCM_CORRESPONDENCE');
});

test('Test 5: 诊断模式查询不产生 patient hypothesis（H12）', () => {
  const concepts = resolveDiseaseConcepts({ queryDisease: '癥瘕', caseDiseaseContext: ['子宫肌瘤'], docs });
  const records = projectDiagnosticPatterns(docs, concepts.map((c) => c.disease));
  const drafts = workspaceEventsForTool('knowledge.get_diagnostic_patterns', { disease: '癥瘕' }, records);
  assert.equal(drafts.length, 0);
  assert.ok(!drafts.some((d) => d.type.startsWith('hypothesis')));
  assert.ok(!drafts.some((d) => d.type.startsWith('candidate')));
});

test('Test 2b: 诊断内容不含 formula/bestMatch/score（crosswalk 后仍成立）', () => {
  const concepts = resolveDiseaseConcepts({ queryDisease: '癥瘕', caseDiseaseContext: ['子宫肌瘤'], docs });
  const records = projectDiagnosticPatterns(docs, concepts.map((c) => c.disease));
  const serialized = JSON.stringify(records);
  for (const forbidden of ['formulaId', 'candidateRef', 'composition', 'bestMatch', 'recommendedSyndrome', '"score"', '妇2号方', '桂枝茯苓丸']) {
    assert.ok(!serialized.includes(forbidden), `不应出现 ${forbidden}`);
  }
});

test('Test 3b: 无病例 context 时 query「癥瘕」不召回子宫肌瘤（不臆造关系）', () => {
  const concepts = resolveDiseaseConcepts({ queryDisease: '癥瘕', caseDiseaseContext: [], docs });
  const diseases = concepts.map((c) => c.disease);
  assert.ok(diseases.includes('女性生殖系统肿瘤-癥瘕'));
  assert.ok(!diseases.includes('女性生殖系统肿瘤-子宫肌瘤'), '无 case context 不应臆造癥瘕→子宫肌瘤关系');
});

// 清理 resolver 缓存（测试间隔离）。
test.after(() => resetRecallMappingsCache());
