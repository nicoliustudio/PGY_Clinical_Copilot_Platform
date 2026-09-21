import test from 'node:test';
import assert from 'node:assert/strict';
import { createClinicalWorkspace, computeClinicalClosure } from '../src/platform/workspace/clinical-workspace.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';

/**
 * H15.5.1 — Deterministic Clinical Closure（纯函数 unit tests）。
 */

function coreComplete(): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  ws.safetyDisposition = 'routine';
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: 'q', version: 0 };
  ws.clinicalDecisionSpine.diseaseAssessment = { statement: 'd', diseaseRefs: [], evidenceRefs: [], uncertainty: [], version: 1 };
  ws.clinicalDecisionSpine.patternHypothesisRefs = ['H_1'];
  ws.clinicalDecisionSpine.patternAssessmentRef = 'PA_1';
  ws.clinicalDecisionSpine.treatmentPlan = { primaryPrinciple: 'p', treatmentTarget: 't', evidenceRefs: [], version: 1 };
  ws.candidates.push({ id: 'c1', kind: 'formula', formulaId: 'F:1', sourceId: 'P1:a', name: '方A' });
  ws.evidenceState.evidenceItems.push({ id: 'e1', sourceRef: 'e1', sourceType: 'P1', relatedCandidates: [], supportingSignals: [], contradictingSignals: [] });
  return ws;
}

test('H15.5.1 closure: core + candidate + evidence + non-urgent → required', () => {
  const s = computeClinicalClosure(coreComplete());
  assert.equal(s.required, true);
});

test('H15.5.1 closure: urgent 不触发（不降低 Safety）', () => {
  const ws = coreComplete();
  ws.safetyDisposition = 'urgent';
  assert.equal(computeClinicalClosure(ws).required, false);
});

test('H15.5.1 closure: core 不完整不触发', () => {
  const ws = coreComplete();
  ws.clinicalDecisionSpine.diseaseAssessment = undefined;
  assert.equal(computeClinicalClosure(ws).required, false);
});

test('H15.5.1 closure: 无 formula candidate 不触发', () => {
  const ws = coreComplete();
  ws.candidates = [];
  assert.equal(computeClinicalClosure(ws).required, false);
});

test('H15.5.1 closure: 无 evidence surface 不触发', () => {
  const ws = coreComplete();
  ws.evidenceState.evidenceItems = [];
  assert.equal(computeClinicalClosure(ws).required, false);
});
