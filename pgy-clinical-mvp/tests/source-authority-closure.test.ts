import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDeliveryObligation, CapabilityDescriptor } from '../src/contracts/capability.js';
import type { ClinicalRequestIR } from '../src/control-plane-v2/types.js';
import { validateRequestSemantics } from '../src/control-plane-v2/semantic-validator.js';
import { effectiveRequestedOutcomesV21 } from '../src/control-plane-v21/planner.js';
import { CONTROL_PLANE_V21_POLICY } from '../src/composition/control-plane-v21-policy.js';
import { materializeSourceBoundAssets } from '../src/platform/commit/source-bound-core.js';
import { CandidateHandleRegistry } from '../src/platform/commit/candidate-handle-registry.js';
import { CommitLedger } from '../src/platform/commit/commit-ledger.js';
import { CommitCoordinator } from '../src/platform/commit/commit-coordinator.js';
import { projectClinicalResult } from '../src/platform/commit/result-projector.js';
import { buildResultView } from '../src/ui/views.js';
import { patientFactRecallQuery, projectionToQuery, buildFormulaRetrievalProjection } from '../src/clinical/formula-evidence.js';
import { createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';

const sourceBoundObligation: CapabilityDeliveryObligation = {
  id: 'treatment-form-delivery',
  requiredArtifact: 'treatmentFormDecision',
  requiredFields: ['outcome', 'form', 'disposition', 'statement', 'sourceEvidenceRefs'],
  materialization: 'SOURCE_BOUND',
  sourceRequiredFields: ['asset_id', 'title', 'disease.name', 'indication_text', 'treatment_method', 'provenance.raw_text', 'content_hash'],
  sourceRequiredFieldsByOutcome: {
    'modality:acupuncture': ['protocol.modalities', 'protocol.points', 'protocol.technique', 'protocol.regimens', 'protocol.raw'],
    'modality:gaofang': ['patient', 'syndrome_pattern', 'treatment_method', 'composition.raw', 'preparation_process', 'usage'],
  },
};

const ac049 = {
  asset_type: 'ACUPUNCTURE',
  subtype: 'MANUAL_ACUPUNCTURE',
  title: '月经病-痛经-针灸',
  disease: { name: '月经病-痛经', specialty: '月经病' },
  indication_text: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。',
  treatment_method: '疏肝理气，调经止痛。',
  protocol: {
    source_tag: '针灸',
    modalities: ['耳针', '体针', '针刺'],
    points: ['三阴交', '关元', '合谷穴', '子宫', '交感', '生殖区穴', '八髎穴'],
    technique: '体针 取三阴交、关元、合谷穴，留针20分；耳针 取子宫、交感、生殖区穴，留针20分。',
    regimens: [
      '体针 取三阴交、关元、合谷穴，留针20分。经前3～7天开始针刺，每日1次。',
      '耳针 取子宫、交感、生殖区穴，留针20分。',
      '水针 取八髎穴。于经前3～7天，每日1次，每次2穴。',
    ],
    raw: '体针...\n耳针...\n水针...',
  },
  provenance: { book: '中医妇科临床手册', raw_text: '体针...耳针...水针...' },
  asset_id: 'AC-049',
  content_hash: 'ba32b6e34c2c',
};

const gf001 = {
  asset_type: 'GAOFANG',
  subtype: 'PASTE_FORMULA',
  title: '内科病膏方-肺结核病',
  disease: { name: '肺结核病', specialty: '内科' },
  patient: '王某某，男，43岁',
  syndrome_pattern: '肺虚阴液不足，肺虚肾亏，气血两亏',
  indication_text: '潮热时轻时重，自汗不止，容易感冒咳嗽、胸闷泛吐、心悸早搏、头晕欠清。',
  treatment_method: '调养肺肾，益气养阴，滋补气血',
  composition: { raw: '蛤蚧1对；冬虫夏草30g；生晒参50g；黄芪300g；……生谷芽150g' },
  preparation_process: '上药共32味药，浸1宿，煎熬3次，取浓汁，收膏。',
  usage: '每日早晚各服1至2匙，用白开水冲服',
  contraindication: '伤风、发热、食滞时暂缓。',
  provenance: { book: '沈仲理临证医集', raw_text: '完整膏方原文...' },
  asset_id: 'GF-001',
  content_hash: 'be0936c5cafc',
};

function ir(required: string[], excluded: string[] = [], mentions: ClinicalRequestIR['outcomes']['mentions'] = []): ClinicalRequestIR {
  return {
    version: 1,
    goal: 'clinical treatment',
    outcomes: { required, preferred: [], allowed: [], excluded, mentions, unresolved: [], unresolvedPreferred: [], exclusive: false },
    outputPolicy: { formulaCardinality: { mode: 'ALL_ELIGIBLE' } },
    generationPolicy: { knowledgeSource: 'KB_ONLY' },
    hardConstraints: [],
    preferences: [],
  };
}

const semanticCapabilities: CapabilityDescriptor[] = [
  {
    id: 'tcm.external-therapy', version: '1', description: '', semanticDescription: '', provides: ['modality:acupuncture'],
    positiveExamples: [], negativeExamples: [], knowledgeScopes: [], skillIds: [], toolIds: [],
    semanticOntology: { terms: [{ term: 'modality:acupuncture', aliases: ['针灸'] }] },
  },
  {
    id: 'tcm.core', version: '1', description: '', semanticDescription: '', provides: ['outcome:clinical-assessment', 'modality:herbal-formula'],
    positiveExamples: [], negativeExamples: [], knowledgeScopes: [], skillIds: [], toolIds: [],
  },
];

describe('Truth Genesis / Source Authority closure', () => {
  it('binds AC-049 as exact source truth and preserves all regimen siblings without flattening', () => {
    const result = materializeSourceBoundAssets({
      obligation: sourceBoundObligation,
      outcome: 'modality:acupuncture',
      decision: {
        outcome: 'modality:acupuncture', form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: '适合针灸',
        sourceEvidenceRefs: ['AC-049', 'P1:diagnostic-support'], sourceAssetRefs: ['AC-049'],
        details: { patientSpecificNote: '经前介入' },
      },
      hydratedRefs: new Set(['AC-049']),
      resolveAsset: (ref) => ref === 'AC-049' ? ac049 : null,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.sourceBundle.products.length, 1);
    assert.deepEqual(result.sourceBundle.products[0].payload, ac049, 'source payload must be exact, not regenerated');
    assert.deepEqual((result.sourceBundle.sourceFacts as any).contentHashes, { 'AC-049': 'ba32b6e34c2c' });
    const payload = result.sourceBundle.products[0].payload as typeof ac049;
    assert.deepEqual(payload.protocol.regimens, ac049.protocol.regimens);
    assert.match(payload.protocol.regimens[0], /三阴交、关元、合谷穴/);
    assert.match(payload.protocol.regimens[1], /子宫、交感、生殖区穴/);
    assert.equal((result.product as any).protocol, undefined, 'source-owned execution facts must not leak into reasoning-owned envelope');
    assert.equal((result.product as any).patientSpecificDetails, undefined, 'untyped reasoning details must not become a second authoritative execution namespace');
    assert.deepEqual((result.product as any).sourceAssetRefs, ['AC-049']);
  });

  it('binds GF-001 complete source case instead of a reasoning-authored advisory substitute', () => {
    const result = materializeSourceBoundAssets({
      obligation: sourceBoundObligation,
      outcome: 'modality:gaofang',
      decision: {
        outcome: 'modality:gaofang', form: '膏方（以膏代煎）', disposition: 'TREAT_FIRST_THEN_FORM', statement: '需医生审阅',
        sourceEvidenceRefs: ['GF-001', 'P1:other-support'], sourceAssetRefs: ['GF-001'],
        advisoryComposition: ['模型不应把这行当 source truth'], preparation: '模型草稿', usage: '模型草稿',
      },
      hydratedRefs: new Set(['GF-001']),
      resolveAsset: (ref) => ref === 'GF-001' ? gf001 : null,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.sourceBundle.products[0].payload, gf001);
    assert.equal((result.sourceBundle.products[0].payload as typeof gf001).patient, '王某某，男，43岁');
    assert.equal((result.sourceBundle.products[0].payload as typeof gf001).composition.raw, gf001.composition.raw);
    assert.equal((result.product as any).preparation, undefined);
    assert.equal((result.product as any).usage, undefined);
  });

  it('fails closed when a selected source asset was not actually hydrated by Runtime', () => {
    const result = materializeSourceBoundAssets({
      obligation: sourceBoundObligation,
      outcome: 'modality:acupuncture',
      decision: { outcome: 'modality:acupuncture', form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: 'x', sourceEvidenceRefs: ['AC-049'], sourceAssetRefs: ['AC-049'] },
      hydratedRefs: new Set(),
      resolveAsset: () => ac049,
    });
    assert.deepEqual(result, { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: ['unhydrated source asset: AC-049'] });
  });

  it('does not promote a hydrated citation into product truth without explicit source adoption', () => {
    const result = materializeSourceBoundAssets({
      obligation: sourceBoundObligation,
      outcome: 'modality:acupuncture',
      decision: { outcome: 'modality:acupuncture', form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: 'x', sourceEvidenceRefs: ['AC-049'] },
      hydratedRefs: new Set(['AC-049']),
      resolveAsset: () => ac049,
    });
    assert.deepEqual(result, { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: ['SOURCE_BOUND delivery requires explicit sourceAssetRefs selection'] });
  });

  it('fails closed when canonical source cannot satisfy provider-declared source fields', () => {
    const broken = { ...ac049, protocol: { ...ac049.protocol, regimens: [] } };
    const result = materializeSourceBoundAssets({
      obligation: sourceBoundObligation,
      outcome: 'modality:acupuncture',
      decision: { outcome: 'modality:acupuncture', form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: 'x', sourceEvidenceRefs: ['AC-049'], sourceAssetRefs: ['AC-049'] },
      hydratedRefs: new Set(['AC-049']),
      resolveAsset: () => broken,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'MISSING_REQUIRED_FIELDS');
      assert.ok(result.details?.includes('AC-049:protocol.regimens'));
    }
  });

  it('CommitCoordinator records SOURCE_BOUND products as CANONICAL_SOURCE and Final/UI preserve the source bundle', async () => {
    const core = materializeSourceBoundAssets({
      obligation: sourceBoundObligation,
      outcome: 'modality:acupuncture',
      decision: { outcome: 'modality:acupuncture', form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: 'x', sourceEvidenceRefs: ['AC-049'], sourceAssetRefs: ['AC-049'] },
      hydratedRefs: new Set(['AC-049']),
      resolveAsset: () => ac049,
    });
    assert.equal(core.ok, true);
    if (!core.ok) return;
    const ledger = new CommitLedger();
    const coordinator = new CommitCoordinator(new CandidateHandleRegistry(), ledger);
    const committed = await coordinator.commit({ outcome: 'modality:acupuncture', sourceBound: true }, {
      safety: { status: 'PASS', reviewRequired: false, reasons: [] },
      readReasoningProduct: () => undefined,
      validateDelivery: () => ({ ok: true, providerId: 'tcm.external-therapy' }),
      hydrateSourceBoundProduct: () => ({ ...core, providerId: 'tcm.external-therapy' }),
      hydrateCanonicalCandidate: async () => ({ ok: false, code: 'CANONICAL_HYDRATION_FAILED' }),
    });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    assert.equal(committed.record.provenance.kind, 'CANONICAL_SOURCE');
    assert.deepEqual(committed.record.sourceBundle?.products[0].payload, ac049);

    const result = projectClinicalResult({ disease: { name: '痛经' } }, ledger.all());
    assert.deepEqual(result.deliveries[0].source_bundle?.products[0].payload, ac049);
    const view = buildResultView({
      mode: 'clinical', status: 'COMPLETED', disease: { name: '痛经', confidence: 0, evidence_refs: [] }, syndrome: { name: '气滞', confidence: 0, evidence_refs: [] },
      treatment: { text: '疏肝理气，调经止痛', evidence_refs: [] }, deliveries: result.deliveries as any,
      missing_information: [], safety: { status: 'PASS' },
    });
    assert.deepEqual(view.deliveries?.[0].source_bundle?.products[0].payload, ac049);
  });

  it('reconciles one unknown REQUIRED surface witness to the compiler canonical identity without alias enumeration', () => {
    const input = ir(['modality:acupuncture'], ['modality:herbal-formula'], [{ name: '针灸治疗', commitment: 'REQUIRED', canonicalTerm: 'modality:acupuncture' }]);
    const validated = validateRequestSemantics(input, semanticCapabilities, CONTROL_PLANE_V21_POLICY.baselineOutcomes);
    assert.deepEqual(validated.ir.outcomes.unresolved, []);
    assert.equal(validated.resolutions[0].relation, 'COMPILER_BOUND');
    assert.equal(validated.resolutions[0].term, 'modality:acupuncture');
  });

  it('never binds a second unknown mention merely because only one canonical required outcome exists', () => {
    const input = ir(['modality:acupuncture'], [], [
      { name: '针灸', commitment: 'REQUIRED', canonicalTerm: 'modality:acupuncture' },
      { name: '神秘疗法', commitment: 'REQUIRED' },
    ]);
    const validated = validateRequestSemantics(input, semanticCapabilities, CONTROL_PLANE_V21_POLICY.baselineOutcomes);
    assert.deepEqual(validated.ir.outcomes.unresolved, ['神秘疗法']);
    assert.equal(validated.resolutions.find((r) => r.mention === '神秘疗法')?.relation, 'UNKNOWN');
  });

  it('never hides compiler-declared unresolved semantics behind reconciliation', () => {
    const input = ir(['modality:acupuncture'], [], [{ name: '不可表示治疗', commitment: 'REQUIRED' }]);
    input.outcomes.unresolved = ['不可表示治疗'];
    const validated = validateRequestSemantics(input, semanticCapabilities, CONTROL_PLANE_V21_POLICY.baselineOutcomes);
    assert.deepEqual(validated.ir.outcomes.unresolved, ['不可表示治疗']);
    assert.equal(validated.resolutions[0].relation, 'UNKNOWN');
  });


  it('patient-fact source recall is independent from model pattern/treatment hypothesis', () => {
    const workspace = createClinicalWorkspace();
    workspace.facts = [
      { kind: 'symptom', value: '月经超前而至', polarity: 'present' },
      { kind: 'symptom', value: '小腹胀痛', polarity: 'present' },
      { kind: 'past_diagnosis', value: '子宫肌瘤肌壁间型', polarity: 'present' },
    ];
    workspace.clinicalDecisionSpine.diseaseAssessment = { statement: '子宫肌瘤', evidenceRefs: [], version: 1 };
    workspace.patternAssessment = { primary: { statement: '脾气虚弱', supportingEvidenceRefs: [] } };
    workspace.clinicalDecisionSpine.treatmentPlan = {
      primaryPrinciple: '健脾益气', treatmentTarget: '脾气虚弱', evidenceRefs: [], version: 1,
    };
    const factQuery = patientFactRecallQuery(workspace, ['子宫肌瘤']);
    assert.match(factQuery, /子宫肌瘤/);
    assert.match(factQuery, /月经超前而至/);
    assert.match(factQuery, /小腹胀痛/);
    assert.doesNotMatch(factQuery, /脾气虚弱|健脾益气/);
    const projection = buildFormulaRetrievalProjection(workspace, ['子宫肌瘤']);
    assert.ok(projection);
    assert.match(projectionToQuery(projection!), /脾气虚弱/);
    assert.match(projectionToQuery(projection!), /健脾益气/);
  });

  it('baseline treatment contract defaults to herbal treatment but exact user modality specializes instead of accumulating it', () => {
    assert.deepEqual(
      effectiveRequestedOutcomesV21(ir([]), CONTROL_PLANE_V21_POLICY),
      ['outcome:clinical-assessment', 'modality:herbal-formula'],
    );
    assert.deepEqual(
      effectiveRequestedOutcomesV21(ir(['modality:acupuncture'], ['modality:herbal-formula']), CONTROL_PLANE_V21_POLICY),
      ['outcome:clinical-assessment', 'modality:acupuncture'],
    );
    assert.deepEqual(
      effectiveRequestedOutcomesV21(ir(['modality:gaofang']), CONTROL_PLANE_V21_POLICY),
      ['outcome:clinical-assessment', 'modality:gaofang'],
    );
  });
});
