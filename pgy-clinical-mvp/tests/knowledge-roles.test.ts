import test from 'node:test';
import assert from 'node:assert/strict';
import {
  knowledgeManifest,
  rolePrescriptionAuthority,
  isRuntimeKnowledgeRole,
  NON_RUNTIME_ASSETS,
} from '../src/knowledge/manifest.js';
import { filterDocsByRole } from '../src/knowledge/search.js';
import { validateNormativeFormulaInDocs } from '../src/clinical/formula-binding.js';
import type { KnowledgeDoc, KnowledgeRole, SourceTier } from '../src/knowledge/types.js';

function doc(overrides: {
  id: string;
  knowledgeRole: KnowledgeRole;
  sourceTier: SourceTier;
  formulas?: KnowledgeDoc['formulas'];
}): KnowledgeDoc {
  return {
    id: overrides.id,
    sourceId: 'TEST',
    source: 'S',
    sourceFile: 'f',
    sourceTier: overrides.sourceTier,
    knowledgeRole: overrides.knowledgeRole,
    prescriptionAuthority: rolePrescriptionAuthority(overrides.knowledgeRole),
    disease: '',
    syndrome: '',
    treatment: '',
    title: overrides.id,
    text: overrides.id,
    formulas: overrides.formulas ?? [],
    releaseVersion: 'test',
    kind: 'normative',
  };
}

test('处方权：仅 NORMATIVE_TREATMENT 为 true（fail-closed）', () => {
  assert.equal(rolePrescriptionAuthority('NORMATIVE_TREATMENT'), true);
  assert.equal(rolePrescriptionAuthority('DIAGNOSTIC_DIFFERENTIAL'), false);
  assert.equal(rolePrescriptionAuthority('DIAGNOSTIC_STANDARD'), false);
  assert.equal(rolePrescriptionAuthority('CLINICAL_CASE'), false);
});

test('isRuntimeKnowledgeRole：未知角色 fail-closed', () => {
  assert.equal(isRuntimeKnowledgeRole('NORMATIVE_TREATMENT'), true);
  assert.equal(isRuntimeKnowledgeRole('DIAGNOSTIC_DIFFERENTIAL'), true);
  assert.equal(isRuntimeKnowledgeRole('SHADOW_POLICY'), false);
  assert.equal(isRuntimeKnowledgeRole('EVALUATION_ONLY'), false);
});

test('manifest：P1 唯一处方权威，S1/Standard/P2 无处方权', () => {
  const byId = new Map(knowledgeManifest.map((l) => [l.sourceId, l]));

  const p1 = byId.get('P1_GYN_MANUAL');
  assert.ok(p1);
  assert.equal(p1.prescriptionAuthority, true);
  assert.equal(p1.sourceTier, 'P1');
  assert.equal(p1.role, 'NORMATIVE_TREATMENT');

  const p2 = byId.get('P2_SHEN_CASE');
  assert.ok(p2);
  assert.equal(p2.prescriptionAuthority, false);
  assert.equal(p2.sourceTier, 'P2');
  assert.equal(p2.role, 'CLINICAL_CASE');

  const s1 = byId.get('S1_SYMPTOM_DIFFERENTIAL');
  assert.ok(s1);
  assert.equal(s1.prescriptionAuthority, false);
  assert.equal(s1.sourceTier, 'AUX');
  assert.equal(s1.role, 'DIAGNOSTIC_DIFFERENTIAL');

  const std = byId.get('AUX_TCM_DIAGNOSTIC_2024');
  assert.ok(std);
  assert.equal(std.prescriptionAuthority, false);
  assert.equal(std.sourceTier, 'AUX');
  assert.equal(std.role, 'DIAGNOSTIC_STANDARD');

  assert.deepEqual(
    knowledgeManifest.filter((l) => l.prescriptionAuthority).map((l) => l.sourceId),
    ['P1_GYN_MANUAL'],
  );
});

test('Source priority：非 P1 层一律无处方权（未来新源默认 fail-closed）', () => {
  for (const layer of knowledgeManifest) {
    if (layer.sourceTier !== 'P1') {
      assert.equal(layer.prescriptionAuthority, false, `${layer.sourceId} 不应有处方权`);
    }
  }
});

test('role filter：NORMATIVE_TREATMENT 只召回 P1（Test A）', () => {
  const docs = [
    doc({ id: 'P1:a', knowledgeRole: 'NORMATIVE_TREATMENT', sourceTier: 'P1' }),
    doc({ id: 'P2:b', knowledgeRole: 'CLINICAL_CASE', sourceTier: 'P2' }),
    doc({ id: 'S1:c', knowledgeRole: 'DIAGNOSTIC_DIFFERENTIAL', sourceTier: 'AUX' }),
    doc({ id: 'ZY:d', knowledgeRole: 'DIAGNOSTIC_STANDARD', sourceTier: 'AUX' }),
  ];
  assert.deepEqual(filterDocsByRole(docs, 'NORMATIVE_TREATMENT').map((d) => d.id), ['P1:a']);
  assert.deepEqual(filterDocsByRole(docs, 'CLINICAL_CASE').map((d) => d.id), ['P2:b']);
  assert.deepEqual(filterDocsByRole(docs, 'DIAGNOSTIC_DIFFERENTIAL').map((d) => d.id), ['S1:c']);
  assert.deepEqual(filterDocsByRole(docs, 'DIAGNOSTIC_STANDARD').map((d) => d.id), ['ZY:d']);
  // 未指定 role：不过滤（由 Agent 自行决定是否跨 role）
  assert.equal(filterDocsByRole(docs, undefined).length, 4);
});

test('Formula authority：仅 P1 sourceTier 通过，P2 不得成为 NORMATIVE（Test F）', () => {
  const p1 = doc({
    id: 'P1:a', knowledgeRole: 'NORMATIVE_TREATMENT', sourceTier: 'P1',
    formulas: [{ id: 'F:1', name: '方', composition: '药甲', sourceTier: 'P1', knowledgeRole: 'normative' }],
  });
  const p2 = doc({
    id: 'P2:b', knowledgeRole: 'CLINICAL_CASE', sourceTier: 'P2',
    formulas: [{ id: 'F:2', name: '方', composition: '药乙', sourceTier: 'P2', knowledgeRole: 'case' }],
  });

  assert.equal(validateNormativeFormulaInDocs([p1], { sourceId: 'P1:a', formulaId: 'F:1', composition: '药甲' }).valid, true);
  assert.equal(validateNormativeFormulaInDocs([p2], { sourceId: 'P2:b', formulaId: 'F:2', composition: '药乙' }).valid, false);
});

test('Evaluation isolation：runtime layer 资产不引用评测资产', () => {
  const evalMarkers = ['gold.json', 'followup_gold.json', 'holdout', 'calibration', 'debug_microset', 'validation/'];
  for (const layer of knowledgeManifest) {
    for (const asset of layer.assets) {
      for (const m of evalMarkers) {
        assert.equal(asset.includes(m), false, `${layer.sourceId} 引用评测资产 ${asset}`);
      }
    }
  }
  assert.ok(NON_RUNTIME_ASSETS.evaluation.includes('gold.json'));
});
