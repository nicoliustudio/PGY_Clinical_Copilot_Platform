import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  createClinicalWorkspace,
  ClinicalWorkspaceStore,
  validatePatternAssessmentRefs,
} from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { buildClinicalWorkingView, renderClinicalWorkingView } from '../src/platform/context/clinical-working-view.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import type { PatternAssessment } from '../src/contracts/workspace.js';

const originalFlag = config.experiment.patternAssessment;

function sampleAssessment(): PatternAssessment {
  return {
    primary: {
      hypothesisRef: 'H_primary',
      statement: '肝郁脾虚，瘀阻胞宫',
      supportingEvidenceRefs: ['CF_001'],
      contradictingEvidenceRefs: ['CF_002'],
      rationale: '情志不遂与瘀血并存，但当前以肝郁脾虚为组织轴',
    },
    secondary: [
      { hypothesisRef: 'H_stasis', statement: '血瘀阻胞', supportingEvidenceRefs: ['CF_003'] },
    ],
    sharedMechanisms: [
      { statement: '瘀阻胞宫', supportingEvidenceRefs: ['CF_003'] },
    ],
    rootBranch: { root: '肝脾失调', branch: '瘀阻胞宫', relationship: '本虚标实' },
    currentDominantMechanism: { statement: '瘀阻胞宫', supportingEvidenceRefs: ['CF_003'] },
    treatmentTarget: '疏肝健脾、化瘀散结',
    uncertainty: ['舌脉信息不全'],
  };
}

function seededWorkspace() {
  const ws = createClinicalWorkspace();
  ws.hypothesisState.hypotheses.push(
    { id: 'H_primary', label: '肝郁脾虚', supportingEvidenceRefs: [], contradictingEvidenceRefs: [], missingEvidence: [], status: 'active', origin: 'agent_reasoning' },
    { id: 'H_stasis', label: '血瘀阻胞', supportingEvidenceRefs: [], contradictingEvidenceRefs: [], missingEvidence: [], status: 'alternative', origin: 'agent_reasoning' },
  );
  ws.caseFacts.push(
    { id: 'CF_001', kind: 'tongue', value: '舌偏暗' },
    { id: 'CF_002', kind: 'symptom', value: '无明显腹痛' },
    { id: 'CF_003', kind: 'symptom', value: '血块较多' },
  );
  return ws;
}

test('PatternAssessment 契约字段为开放文本（statement/root/branch/relationship/treatmentTarget 任意中文）', () => {
  const pa = sampleAssessment();
  assert.equal(typeof pa.primary!.statement, 'string');
  assert.equal(typeof pa.rootBranch!.root, 'string');
  assert.equal(typeof pa.rootBranch!.branch, 'string');
  assert.equal(typeof pa.rootBranch!.relationship, 'string');
  assert.equal(typeof pa.currentDominantMechanism!.statement, 'string');
  assert.equal(typeof pa.treatmentTarget, 'string');
});

test('ClinicalWorkspaceStore 应用 pattern.assessment.recorded → workspace.patternAssessment 填充', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_test');
  store.append('pattern.assessment.recorded', sampleAssessment() as unknown as Record<string, unknown>);
  const pa = ws.patternAssessment;
  assert.ok(pa);
  assert.equal(pa.primary?.statement, '肝郁脾虚，瘀阻胞宫');
  assert.equal(pa.secondary?.length, 1);
  assert.equal(pa.sharedMechanisms?.length, 1);
  assert.equal(pa.rootBranch?.root, '肝脾失调');
});

test('workspaceEventsForTool(record_deliberation) 从 patternAssessment 生成 pattern.assessment.recorded', () => {
  const drafts = workspaceEventsForTool('workspace.record_deliberation', { patternAssessment: sampleAssessment() }, {});
  const recorded = drafts.filter((d) => d.type === 'pattern.assessment.recorded');
  assert.equal(recorded.length, 1);
  assert.equal((recorded[0].payload as PatternAssessment).primary?.statement, '肝郁脾虚，瘀阻胞宫');
});

test('validatePatternAssessmentRefs：合法引用通过，非法 hypothesisRef / evidenceRef 被拒绝', () => {
  const ws = seededWorkspace();
  const valid = sampleAssessment();
  assert.deepEqual(validatePatternAssessmentRefs(ws, valid), []);

  const badHyp = { ...valid, primary: { ...valid.primary!, hypothesisRef: 'H_missing' } };
  assert.ok(validatePatternAssessmentRefs(ws, badHyp).some((e) => e.includes('H_missing')));

  const badEv = { ...valid, primary: { ...valid.primary!, supportingEvidenceRefs: ['CF_nope'] } };
  assert.ok(validatePatternAssessmentRefs(ws, badEv).some((e) => e.includes('CF_nope')));
});

test('WorkingView：Pattern Structure ON 时渲染 Pattern Structure 区块', () => {
  config.experiment.patternAssessment = true;
  const ws = seededWorkspace();
  ws.patternAssessment = sampleAssessment();
  const view = buildClinicalWorkingView(ws, emptyClinicalStrategy());
  assert.ok(view.patternStructure);
  const rendered = renderClinicalWorkingView(view);
  assert.ok(rendered.includes('Pattern Structure'));
  assert.ok(rendered.includes('Primary Pattern'));
  assert.ok(rendered.includes('Shared / Common Mechanisms'));
  assert.ok(rendered.includes('Root / Branch'));
  assert.ok(rendered.includes('Current Dominant Mechanism'));
  assert.ok(rendered.includes('Treatment Target'));
});

test('WorkingView：Pattern Structure OFF 时不渲染 Pattern Structure 区块', () => {
  config.experiment.patternAssessment = false;
  const ws = seededWorkspace();
  ws.patternAssessment = sampleAssessment();
  const view = buildClinicalWorkingView(ws, emptyClinicalStrategy());
  assert.equal(view.patternStructure, undefined);
  const rendered = renderClinicalWorkingView(view);
  assert.ok(!rendered.includes('Pattern Structure'));
});

test.after(() => {
  config.experiment.patternAssessment = originalFlag;
});
