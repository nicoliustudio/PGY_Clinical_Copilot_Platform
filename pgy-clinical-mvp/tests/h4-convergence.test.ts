import test from 'node:test';
import assert from 'node:assert/strict';
import { clinicalStrategySchema, emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { buildDecisionState } from '../src/platform/workspace/decision-state-projection.js';
import { BASELINE_SKILL_IDS } from '../src/composition/platform-assets.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore, validateCandidateAssessmentRefs } from '../src/platform/workspace/clinical-workspace.js';
import { buildClinicalWorkingView } from '../src/platform/context/clinical-working-view.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

test('Planner 使用最小 schema（无 primaryQuestion/evidenceNeeds/stoppingCriteria）', () => {
  const parsed = clinicalStrategySchema.parse({
    goal: 'g',
    decisionQuestion: 'q',
    criticalEvidenceNeeds: ['n'],
    stopWhen: ['s'],
    uncertainty: [],
  });
  assert.equal(parsed.decisionQuestion, 'q');
  assert.ok(!('primaryQuestion' in parsed));
  assert.ok(!('evidenceNeeds' in parsed));
  assert.ok(!('stoppingCriteria' in parsed));
});

test('DecisionState 是从 Strategy/Hypothesis/Evidence 投影的纯函数', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('evidence.added', { id: 'P1:a', sourceId: 'P1:a' });
  store.append('hypothesis.presented', { id: 'H_1', label: '气虚下陷', supportingEvidenceRefs: ['P1:a'] });

  const strategy = { goal: 'g', decisionQuestion: '当前主证是什么？', criticalEvidenceNeeds: [], stopWhen: [], uncertainty: [{ item: '病程', reason: '' }] };
  const ds = buildDecisionState(workspace, strategy);
  assert.equal(ds.question, '当前主证是什么？');
  assert.ok(ds.leadingExplanations.length >= 1);
  assert.ok(ds.currentEvidenceRefs.includes('P1:a'));
});

test('runtime 只注入 tcm-clinical-cognition 作为 baseline skill', () => {
  assert.deepEqual(BASELINE_SKILL_IDS, ['tcm-clinical-cognition']);
});

test('hypothesis 使用稳定 H_xxx ID（非 label/sourceId）', () => {
  const drafts = workspaceEventsForTool('workspace.consider_hypotheses', { hypotheses: [{ label: '气虚下陷', role: 'alternative' }] }, undefined);
  const hyp = drafts.find((d) => d.type === 'hypothesis.presented');
  assert.ok(hyp);
  const id = hyp.payload.id as string;
  assert.ok(id.startsWith('H_'), `expected H_xxx, got ${id}`);
  assert.notEqual(id, '气虚下陷');
  // 相同 label 得到相同稳定 ID
  const drafts2 = workspaceEventsForTool('workspace.consider_hypotheses', { hypotheses: [{ label: '气虚下陷', role: 'alternative' }] }, undefined);
  const hyp2 = drafts2.find((d) => d.type === 'hypothesis.presented');
  assert.equal(hyp2?.payload.id, id);
});

test('knowledge.search 已返回 P1 formula 时直接 canonical hydrate 为 candidate', () => {
  const drafts = workspaceEventsForTool('knowledge.search', { query: '崩漏' }, [
    { sourceId: 'P1:a', title: '崩漏', authority: 'P1', excerpt: 'x', provenance: { source: '', sourceFile: '', disease: '', syndrome: '气虚下陷', treatment: '' }, formulas: [{ id: 'F:1', name: '补中益气汤', composition: '黄芪 党参', sourceTier: 'P1', knowledgeRole: 'normative' }] },
  ]);
  const cand = drafts.find((d) => d.type === 'candidate.presented');
  assert.ok(cand, '应直接 hydrate 出 candidate');
  assert.equal(cand.payload.id, 'P1:a::F:1');
  assert.equal(cand.payload.formulaId, 'F:1');
});

test('CaseFactRef（CF_xxx）可被 deliberation 引用', () => {
  const workspace = createClinicalWorkspace();
  workspace.caseFacts = [{ id: 'CF_001', kind: 'symptom', value: '经量过多' }];
  workspace.candidates = [{ id: 'c1', kind: 'formula', formulaId: 'F:1', sourceId: 'P1:a', composition: ['x'], name: '方' }];
  workspace.hypothesisState.hypotheses = [{ id: 'H_1', label: '气虚', supportingEvidenceRefs: [], contradictingEvidenceRefs: [], missingEvidence: [], status: 'active' }];

  const errors = validateCandidateAssessmentRefs(workspace, {
    candidateRef: 'c1',
    hypothesisRef: 'H_1',
    supportingEvidenceRefs: ['CF_001'],
    contradictingEvidenceRefs: [],
    assessmentEvidenceRefs: ['CF_001'],
  });
  assert.deepEqual(errors, []);
});

test('WorkingView 收缩后不含完整 event history / 全部 raw tool outputs', () => {
  const workspace = createClinicalWorkspace();
  workspace.caseFacts = [{ id: 'CF_001', kind: 'symptom', value: '经量过多' }];
  const view = buildClinicalWorkingView(workspace, emptyClinicalStrategy());
  assert.ok(!('events' in view));
  assert.ok(!('workspaceEvents' in view));
  assert.ok(!('toolCalls' in view));
  assert.equal(view.caseFrame[0].id, 'CF_001');
});

test('model proposal 不覆盖 canonical safety truth', async () => {
  // canonical safety = routine（无 risk），但模型声称 BLOCK，应被归一化为 PASS
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    propose: () => ({ ...clinicalProposal({ authority: 'GENERATED_DRAFT' }), safety: { status: 'BLOCK' } }),
  });
  const { authority } = await runtime.run('demo');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(authority.proposal.safety.status, 'PASS');
});
