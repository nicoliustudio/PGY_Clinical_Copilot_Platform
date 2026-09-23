import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeDoc } from '../src/knowledge/types.js';
import { normalizeSourceModificationList } from '../src/knowledge/source-normalization.js';
import type { CapabilityDeliveryObligation, ResolvedCapability } from '../src/contracts/capability.js';
import { hydrateSourceFormulaSet } from '../src/clinical/source-formula-set.js';
import { projectFormulaSet } from '../src/control-plane-v2/result-projection.js';
import {
  deliverySatisfiesObligation,
  deriveCapabilityDeliveryClosures,
  missingRequiredDeliveryFields,
} from '../src/clinical/capability-delivery.js';
import { createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function p1Doc(formulas: KnowledgeDoc['formulas'], sourceModifications: string[] = []): KnowledgeDoc {
  return {
    id: 'P1:K1', text: 'D/S/T', sourceId: 'P1_GYN_MANUAL', source: 'manual', sourceFile: 'x.txt',
    sourceTier: 'P1', knowledgeRole: 'NORMATIVE_TREATMENT', prescriptionAuthority: true, scope: 'general',
    disease: 'D', syndrome: 'S', treatment: 'T', title: 'D｜S', formulas, sourceModifications,
    releaseVersion: 'r1', kind: 'normative',
  };
}

function formula(id: string, mods: string[] = []): KnowledgeDoc['formulas'][number] {
  return {
    id, name: `方${id}`, composition: `组成${id}`, sourceModifications: mods,
    sourceTier: 'P1_GYN_MANUAL', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE',
  };
}


test('delivery integrity: source modification normalization preserves structured release fields deterministically', () => {
  assert.deepEqual(
    normalizeSourceModificationList(
      '包块大，加鳖甲10克',
      [{ trigger: '肌肤甲错', medication: '大黄䗪虫丸', dose: '6克', action: '加' }],
      [{ text: '月经闭止，加桃仁10克' }],
    ),
    ['包块大，加鳖甲10克', '肌肤甲错：加大黄䗪虫丸6克', '月经闭止，加桃仁10克'],
  );
});

test('delivery integrity: source sibling completeness ignores PRIMARY_ONLY projection truncation', () => {
  const set = hydrateSourceFormulaSet([p1Doc([formula('F1'), formula('F2'), formula('F3')])], 'P1:K1::F1');
  assert.ok(set);
  assert.deepEqual(
    projectFormulaSet(set, { mode: 'PRIMARY_ONLY' }).map((x) => x.formulaId),
    ['F1', 'F2', 'F3'],
  );
});

test('delivery integrity: formula-local modification is preserved; true absence is explicit KNOWN_EMPTY', () => {
  const set = hydrateSourceFormulaSet([
    p1Doc([formula('F1', ['包块大，加鳖甲10克']), formula('F2')]),
  ], 'P1:K1::F1');
  assert.ok(set);
  const first = set.formulas.find((x) => x.formulaId === 'F1')!;
  const second = set.formulas.find((x) => x.formulaId === 'F2')!;
  assert.deepEqual(first.sourceModifications, ['包块大，加鳖甲10克']);
  assert.equal(first.modificationStatus, 'PRESENT');
  assert.deepEqual(second.sourceModifications, []);
  assert.equal(second.modificationStatus, 'KNOWN_EMPTY');
});

test('delivery integrity: parent-level modification is not copied across multiple siblings when attribution is ambiguous', () => {
  const set = hydrateSourceFormulaSet([
    p1Doc([formula('F1'), formula('F2')], ['性欲淡漠，加阳起石20克']),
  ], 'P1:K1::F1');
  assert.ok(set);
  assert.deepEqual(set.sourceLevelModifications, ['性欲淡漠，加阳起石20克']);
  assert(set.formulas.every((x) => x.modificationStatus === 'UNATTRIBUTED_SOURCE_RULES'));
  assert(set.formulas.every((x) => x.sourceModifications.length === 0));
});

test('delivery integrity: manifest-required fields gate delivery closure generically', () => {
  const obligation: CapabilityDeliveryObligation = {
    id: 'delivery', requiredArtifact: 'treatmentFormDecision',
    requiredFields: ['outcome', 'form', 'sourceEvidenceRefs'],
    requiredFieldsByOutcome: { 'modality:test': ['details.points', 'details.course'] },
  };
  const incomplete = {
    outcome: 'modality:test', form: 'test', sourceEvidenceRefs: ['E1'], details: { points: ['P1'] },
  };
  assert.deepEqual(missingRequiredDeliveryFields(incomplete, obligation, 'modality:test'), ['details.course']);
  assert.equal(deliverySatisfiesObligation(incomplete, obligation, 'modality:test'), false);
  assert.equal(deliverySatisfiesObligation({ ...incomplete, details: { points: ['P1'], course: '10次' } }, obligation, 'modality:test'), true);
});

test('delivery integrity: incomplete treatment payload cannot become DELIVERED', () => {
  const workspace = createClinicalWorkspace();
  workspace.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: '治法', treatmentTarget: '目标', evidenceRefs: [], version: 1,
    treatmentDeliveries: [{
      outcome: 'modality:test', form: 'test', disposition: 'CURRENTLY_SUITABLE', statement: '方案',
      sourceEvidenceRefs: ['E1'], details: { points: ['P1'] },
    }],
  };
  const capabilities: ResolvedCapability[] = [{
    id: 'test.cap', confidence: 1, reason: 'test', provides: ['modality:test'],
    deliveryObligations: [{
      id: 'delivery', requiredArtifact: 'treatmentFormDecision', requiredFields: ['details.points', 'details.course'],
    }],
  }];
  assert.deepEqual(deriveCapabilityDeliveryClosures(capabilities, workspace, []), []);
  workspace.clinicalDecisionSpine.treatmentPlan.treatmentDeliveries![0].details = { points: ['P1'], course: '10次' };
  assert.equal(deriveCapabilityDeliveryClosures(capabilities, workspace, [])[0]?.status, 'DELIVERED');
});

test('delivery integrity: production manifests declare completeness outside Core', () => {
  const gaofang = JSON.parse(readFileSync(join(root, 'capabilities/gaofang/capability.json'), 'utf8')) as any;
  const external = JSON.parse(readFileSync(join(root, 'capabilities/tcm.external-therapy/capability.json'), 'utf8')) as any;
  assert(gaofang.deliveryObligations[0].requiredFields.includes('preparation'));
  assert(gaofang.deliveryObligations[0].requiredFields.includes('usage'));
  assert(external.deliveryObligations[0].requiredFieldsByOutcome['modality:acupuncture'].includes('details.points'));
});
