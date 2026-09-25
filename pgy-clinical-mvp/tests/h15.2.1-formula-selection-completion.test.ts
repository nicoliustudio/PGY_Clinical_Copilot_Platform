import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClinicalWorkspace,
  ClinicalWorkspaceStore,
  checkClinicalCompletion,
} from '../src/platform/workspace/clinical-workspace.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';

/** 构造一个 clinical core 已完整、无 unresolved formal hypothesis 的 workspace。 */
function coreCompleteWorkspace() {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '当前应辨何证、以何法治之', version: 0 };
  store.append('disease.assessment.recorded', { statement: '痛经', evidenceRefs: ['CF_001'] });
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('pattern.assessment.recorded', { primary: { statement: '血瘀为主', hypothesisRef: 'H_a' } });
  store.append('treatment.plan.recorded', { primaryPrinciple: '活血化瘀', treatmentTarget: '止痛' });
  return { ws, store };
}

test('H15.2.1 completion: formulaSelection with empty selectedCandidateRef is NOT satisfied', () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('completion.obligation.recorded', {
    requestedOutcome: '辨证并开方',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment', 'formulaSelection'],
  });
  // 存在 formulaSelection 但 selectedCandidateRef 为空（机械漏洞：以前被判为完成）。
  store.append('formula.selection.recorded', { selectedCandidateRef: undefined, rationale: '待定' });

  const result = checkClinicalCompletion(ws);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingArtifacts, ['formulaSelection']);
});

test('H15.2.1 completion: formulaSelection with non-empty selectedCandidateRef is satisfied', () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('completion.obligation.recorded', {
    requestedOutcome: '辨证并开方',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment', 'formulaSelection'],
  });
  store.append('formula.selection.recorded', { selectedCandidateRef: 'P1:demo::formula' });

  const result = checkClinicalCompletion(ws);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingArtifacts, []);
});

test('H15.2.1 completion: no formulaSelection declared -> no formula obligation', () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('completion.obligation.recorded', {
    requestedOutcome: '帮我辨证',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment'],
  });
  // 未声明 formulaSelection，即使没有选方也不应被要求。
  const result = checkClinicalCompletion(ws);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingArtifacts, []);
});

test('H15.2.1 proposal.submit: empty formulaSelection returns FORMULA_SELECTION_INCOMPLETE', async () => {
  const { ws, store } = coreCompleteWorkspace();
  store.append('completion.obligation.recorded', {
    requestedOutcome: '辨证并开方',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment', 'formulaSelection'],
  });
  store.append('formula.selection.recorded', { selectedCandidateRef: undefined });

  // 最小上下文：proposal.submit 只消费 workspace 与 understanding.interaction.mode。
  const context = { workspace: ws, understanding: { interaction: { mode: 'clinical' } } } as any;
  const submit = DEFAULT_AI_SDK_TOOL_BINDINGS['proposal.submit'](context as any) as any;
  const out = await submit.execute({
    mode: 'clinical',
    disease: { name: '痛经' },
    syndrome: { name: '气滞血瘀' },
    treatment: { text: '活血化瘀' },
  }, {});

  assert.equal((out as { notReady?: boolean }).notReady, true);
  assert.equal((out as { code?: string }).code, 'FORMULA_SELECTION_INCOMPLETE');
});
