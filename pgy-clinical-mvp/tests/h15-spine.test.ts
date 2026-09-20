import test from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalWorkspace, ClinicalWorkspaceStore, checkTreatmentRetrievalContext, checkClinicalCompletion, checkClinicalCoreCompletion, checkPatternAssessmentReadiness } from '../src/platform/workspace/clinical-workspace.js';

function storeWithSpine() {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '当前应辨何证、以何法治之', version: 0 };
  store.append('disease.assessment.recorded', { statement: '子宫腺肌病/癥瘕', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('pattern.assessment.recorded', { primary: { statement: '血瘀为主', hypothesisRef: 'H_a' }, treatmentTarget: '化瘀止血' });
  store.append('treatment.plan.recorded', { primaryPrinciple: '活血化瘀', treatmentTarget: '化瘀止血' });
  return { ws, store };
}

test('H15 gate: empty spine is incomplete', () => {
  const ws = createClinicalWorkspace();
  const result = checkTreatmentRetrievalContext(ws);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('clinical question'));
  assert.ok(result.missing.includes('disease assessment'));
  assert.ok(result.missing.includes('formal pattern hypotheses'));
  assert.ok(result.missing.includes('pattern assessment'));
  assert.ok(result.missing.includes('treatment plan'));
});

test('H15 gate: complete spine passes', () => {
  const { ws } = storeWithSpine();
  const result = checkTreatmentRetrievalContext(ws);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('H15 gate: stale version rejected', () => {
  const { ws } = storeWithSpine();
  const spine = ws.clinicalDecisionSpine;
  const result = checkTreatmentRetrievalContext(ws, {
    clinicalQuestionRef: 'q',
    diseaseAssessmentVersion: spine.diseaseAssessment!.version + 1,
    patternAssessmentRef: spine.patternAssessmentRef!,
    treatmentPlanVersion: spine.treatmentPlan!.version,
  });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('stale disease assessment version'));
});

test('H15 spine: disease/treatmentPlan written via events', () => {
  const { ws } = storeWithSpine();
  assert.ok(ws.clinicalDecisionSpine.diseaseAssessment);
  assert.ok(ws.clinicalDecisionSpine.treatmentPlan);
  assert.equal(ws.clinicalDecisionSpine.patternHypothesisRefs.length, 1);
  assert.ok(ws.clinicalDecisionSpine.patternAssessmentRef);
});

test('H15.1 completion: no obligation passes (nothing declared)', () => {
  const ws = createClinicalWorkspace();
  assert.deepEqual(checkClinicalCompletion(ws), { ok: true, missingArtifacts: [] });
});

test('H15.1 completion: declared artifacts are checked structurally', () => {
  const { ws } = storeWithSpine();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  store.append('completion.obligation.recorded', {
    requestedOutcome: '辨证并开方',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment', 'treatmentPlan', 'formulaSelection', 'formulaReview'],
  });
  const result = checkClinicalCompletion(ws);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingArtifacts, ['formulaSelection', 'formulaReview']);
});

test('H15.1 completion: satisfied when all declared artifacts present', () => {
  const { ws } = storeWithSpine();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  store.append('completion.obligation.recorded', {
    requestedOutcome: '辨证并开方',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment', 'treatmentPlan'],
  });
  assert.deepEqual(checkClinicalCompletion(ws), { ok: true, missingArtifacts: [] });
});

test('H15.1 completion: only-differentiate request does not force formula', () => {
  const { ws } = storeWithSpine();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  store.append('completion.obligation.recorded', {
    requestedOutcome: '帮我辨证',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment'],
  });
  // 没有 formulaSelection 也不会缺失，因为未声明。
  assert.deepEqual(checkClinicalCompletion(ws), { ok: true, missingArtifacts: [] });
});

test('H15.2 minimum core: empty spine is incomplete', () => {
  const ws = createClinicalWorkspace();
  const result = checkClinicalCoreCompletion(ws);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['clinicalQuestion', 'diseaseAssessment', 'formalHypotheses', 'patternAssessment']);
});

test('H15.2 minimum core: only-differentiate spine passes without treatmentPlan', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '当前应辨何证', version: 0 };
  store.append('disease.assessment.recorded', { statement: '痛经', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('pattern.assessment.recorded', { primary: { statement: '血瘀为主', hypothesisRef: 'H_a' } });
  // 未写 treatmentPlan，但 minimum core 不要求 treatmentPlan。
  assert.deepEqual(checkClinicalCoreCompletion(ws), { ok: true, missing: [] });
});

test('H15.2 readiness: primary without patient evidence is incomplete', () => {
  const { ws } = storeWithSpine();
  // storeWithSpine 的 primary 无 supportingEvidenceRefs。
  const result = checkPatternAssessmentReadiness(ws);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('primary.supportingEvidenceRefs'));
});

test('H15.2 readiness: primary with patient evidence passes', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  ws.caseFacts.push({ id: 'CF_001', kind: 'symptom', value: '经行腹痛拒按', evidenceKind: 'patient', temporalRole: 'current', polarity: 'present' });
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: '血瘀为主', hypothesisRef: 'H_a', supportingEvidenceRefs: ['CF_001'] } });
  const result = checkPatternAssessmentReadiness(ws);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});
