import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutionRole } from '../src/adapters/ai-sdk/agent-runtime.js';
import { workspaceEventsForTool, applyToolExecutionResult } from '../src/adapters/ai-sdk/workspace-events.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore, validateCandidateAssessmentRefs } from '../src/platform/workspace/clinical-workspace.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { WorkspaceEventDraft } from '../src/contracts/workspace.js';

function seedWorkspace(store: ClinicalWorkspaceStore): void {
  store.append('candidate.presented', { id: 'c1', formulaId: 'F:1', sourceId: 'P1:a', name: '方A' });
  store.append('candidate.presented', { id: 'c2', formulaId: 'F:2', sourceId: 'P1:b', name: '方B' });
  store.append('hypothesis.presented', { id: 'H_1', label: '气虚', supportingEvidenceRefs: ['P1:a'] });
  store.append('evidence.added', { id: 'P1:a', sourceId: 'P1:a', sourceRef: 'P1:a' });
  store.append('evidence.added', { id: 'CF_001', sourceId: 'P1:a', sourceRef: 'CF_001' });
}

function makeContext(): RuntimeContext {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  return { workspace, workspaceStore: store, runId: 'run-1' } as unknown as RuntimeContext;
}

// ---------- Execution role classification ----------

test('classifyExecutionRole 正确分类六类角色', () => {
  assert.equal(classifyExecutionRole('knowledge.search'), 'RETRIEVAL');
  assert.equal(classifyExecutionRole('knowledge.get_source'), 'RETRIEVAL');
  assert.equal(classifyExecutionRole('formula.search_normative'), 'RETRIEVAL');
  assert.equal(classifyExecutionRole('workspace.record_deliberation'), 'COGNITIVE_MUTATION');
  assert.equal(classifyExecutionRole('workspace.focus_candidates'), 'COGNITIVE_MUTATION');
  assert.equal(classifyExecutionRole('workspace.record_candidate_assessment'), 'COGNITIVE_MUTATION');
  assert.equal(classifyExecutionRole('workspace.record_candidate_exclusion'), 'COGNITIVE_MUTATION');
  assert.equal(classifyExecutionRole('formula.validate'), 'VALIDATION');
  assert.equal(classifyExecutionRole('delivery.commit'), 'COMMIT');
  assert.equal(classifyExecutionRole('proposal.submit'), 'OTHER');
  assert.equal(classifyExecutionRole('capability.activate'), 'CAPABILITY');
  assert.equal(classifyExecutionRole('unknown.tool'), 'OTHER');
});

// ---------- Batch deliberation → multiple events ----------

test('一个 batch deliberation 可同时 focus 多个 candidate', () => {
  const drafts = workspaceEventsForTool('workspace.record_deliberation', {
    focusedCandidates: ['c1', 'c2'],
  }, undefined);
  assert.deepEqual(drafts.filter((d) => d.type === 'candidate.focused').map((d) => d.payload.id), ['c1', 'c2']);
});

test('一个 batch 可记录多个 candidate assessment', () => {
  const drafts = workspaceEventsForTool('workspace.record_deliberation', {
    assessments: [
      { candidateRef: 'c1', hypothesisRef: 'H_1', supportingEvidenceRefs: ['P1:a'] },
      { candidateRef: 'c2', hypothesisRef: 'H_1', contradictingEvidenceRefs: ['P1:b'] },
    ],
  }, undefined);
  assert.equal(drafts.filter((d) => d.type === 'candidate.assessed').length, 2);
});

test('一个 batch 可更新 hypothesis（status + evidence）', () => {
  const drafts = workspaceEventsForTool('workspace.record_deliberation', {
    hypothesisUpdates: [
      { hypothesisRef: 'H_1', status: 'active' },
      { hypothesisRef: 'H_1', supportingEvidenceRefs: ['P1:a'], contradictingEvidenceRefs: ['P1:b'] },
    ],
  }, undefined);
  const types = drafts.map((d) => d.type);
  assert.ok(types.includes('hypothesis.selected'));
  assert.ok(types.includes('hypothesis.supported'));
  assert.ok(types.includes('hypothesis.challenged'));
});

test('一个 batch 可更新 uncertainty', () => {
  const drafts = workspaceEventsForTool('workspace.record_deliberation', {
    resolvedUncertaintyRefs: ['u1'],
    remainingDecisionChangingUnknowns: ['u2'],
  }, undefined);
  assert.ok(drafts.some((d) => d.type === 'uncertainty.resolved'));
  assert.deepEqual(drafts.find((d) => d.type === 'uncertainty.resolved')?.payload.resolvedRefs, ['u1']);
});

// ---------- Atomic batch ----------

test('一个 mutation action 可产生多个 Workspace events，且属于同一 batch', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  seedWorkspace(store);

  const drafts: WorkspaceEventDraft[] = [
    { type: 'candidate.focused', payload: { id: 'c1' } },
    { type: 'candidate.focused', payload: { id: 'c2' } },
  ];
  const result = store.appendBatch(drafts, 'batch-1');
  assert.equal(result.written, 2);
  assert.equal(result.deduped, 0);
  const batchEvents = store.trace().filter((e) => e.batchId === 'batch-1');
  assert.equal(batchEvents.length, 2);
  assert.deepEqual(workspace.deliberationState.frontier, ['c1', 'c2']);
});

test('batch 只写一次，不产生重复 projection（appendBatch 是纯状态写入）', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  seedWorkspace(store);
  const before = store.trace().length;
  store.appendBatch([
    { type: 'candidate.focused', payload: { id: 'c1' } },
    { type: 'candidate.focused', payload: { id: 'c2' } },
  ], 'batch-p');
  // 只新增 2 个 event，没有额外 projection/重复写入
  assert.equal(store.trace().length, before + 2);
});

// ---------- Dedupe / effective vs noop ----------

test('相同 mutation 重复提交 → dedupe，不写重复 events', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  seedWorkspace(store);
  store.appendBatch([{ type: 'candidate.focused', payload: { id: 'c1' } }], 'b1');
  const before = store.trace().length;
  const result = store.appendBatch([{ type: 'candidate.focused', payload: { id: 'c1' } }], 'b2');
  assert.equal(result.written, 0);
  assert.equal(result.deduped, 1);
  assert.equal(store.trace().length, before);
});

test('DecisionState 未变但首次 persistence 不算 noop（written>0）', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  seedWorkspace(store);
  // 首次 focus c1：frontier 从空变为 [c1]
  const first = store.appendBatch([{ type: 'candidate.focused', payload: { id: 'c1' } }], 'b1');
  assert.equal(first.written, 1);
  // 重复 focus c1：noop
  const second = store.appendBatch([{ type: 'candidate.focused', payload: { id: 'c1' } }], 'b2');
  assert.equal(second.written, 0);
  assert.equal(second.deduped, 1);
});

test('applyToolExecutionResult 返回 batchResult（written/deduped）', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  seedWorkspace(store);
  const applied = applyToolExecutionResult(
    'workspace.record_deliberation',
    { focusedCandidates: ['c1'] },
    { type: 'tool-result', output: { focusedCandidates: ['c1'] } },
    store,
  );
  assert.ok(applied.batchResult);
  assert.equal(applied.batchResult.written, 1);
});

// ---------- Identity / provenance preservation ----------

test('batch 保留 H_xxx / candidateRef / CF_xxx / sourceRef 身份链', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  seedWorkspace(store);
  workspace.caseFacts = [{ id: 'CF_001', kind: 'symptom', value: '经量过多' }];

  store.appendBatch([
    { type: 'candidate.focused', payload: { id: 'c1' } },
    {
      type: 'candidate.assessed',
      payload: {
        candidateRef: 'c1',
        hypothesisRef: 'H_1',
        supportingEvidenceRefs: ['P1:a'],
        contradictingEvidenceRefs: [],
        unresolvedQuestions: [],
        assessmentSummary: '支持',
        assessmentEvidenceRefs: ['CF_001'],
      },
    },
  ], 'batch-id');

  const assessment = workspace.deliberationState.assessments.find((a) => a.candidateRef === 'c1');
  assert.ok(assessment);
  assert.equal(assessment.hypothesisRef, 'H_1');
  assert.ok(assessment.supportingEvidenceRefs.includes('P1:a'));
  assert.ok(assessment.assessmentEvidenceRefs.includes('CF_001'));
  assert.ok(workspace.candidates.some((c) => c.id === 'c1' && c.sourceId === 'P1:a'));
});

// ---------- Fail-closed validation ----------

test('batch 中非法 candidateRef / hypothesisRef → validate 报错（fail-closed）', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  seedWorkspace(store);

  const errors = validateCandidateAssessmentRefs(workspace, {
    candidateRef: 'INVALID',
    hypothesisRef: 'H_1',
    supportingEvidenceRefs: [],
    contradictingEvidenceRefs: [],
    assessmentEvidenceRefs: [],
  });
  assert.ok(errors.some((e) => e.includes('unknown candidateRef')));

  const errors2 = validateCandidateAssessmentRefs(workspace, {
    candidateRef: 'c1',
    hypothesisRef: 'INVALID_H',
    supportingEvidenceRefs: [],
    contradictingEvidenceRefs: [],
    assessmentEvidenceRefs: [],
  });
  assert.ok(errors2.some((e) => e.includes('unknown hypothesisRef')));
});

test('record_deliberation tool 对非法 hypothesisRef fail-closed（无 partial commit）', async () => {
  const context = makeContext();
  const store = context.workspaceStore as ClinicalWorkspaceStore;
  seedWorkspace(store);

  const binding = DEFAULT_AI_SDK_TOOL_BINDINGS['workspace.record_deliberation'](context);
  const executeFn = binding.execute as unknown as (input: unknown) => Promise<unknown>;
  await assert.rejects(() => executeFn({ hypothesisUpdates: [{ hypothesisRef: 'INVALID_H' }] }));

  // 校验失败，workspace 未新增任何 mutation event（无 partial commit）
  assert.equal(store.trace().filter((e) => e.type !== 'candidate.presented' && e.type !== 'hypothesis.presented' && e.type !== 'evidence.added').length, 0);
});

// ---------- Legacy compatibility ----------

test('旧 workspace.focus_candidates 仍兼容', () => {
  const drafts = workspaceEventsForTool('workspace.focus_candidates', { candidateRefs: ['c1', 'c2'] }, undefined);
  assert.deepEqual(drafts.map((d) => d.type), ['candidate.focused', 'candidate.focused']);
});

test('旧 workspace.record_candidate_assessment 仍兼容', () => {
  const drafts = workspaceEventsForTool('workspace.record_candidate_assessment', {
    candidateRef: 'c1',
    hypothesisRef: 'H_1',
    supportingEvidenceRefs: [],
    contradictingEvidenceRefs: [],
    unresolvedQuestions: [],
    assessmentSummary: 's',
    assessmentEvidenceRefs: [],
  }, { candidateRef: 'c1', hypothesisRef: 'H_1', supportingEvidenceRefs: [], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 's', assessmentEvidenceRefs: [] });
  assert.ok(drafts.some((d) => d.type === 'candidate.assessed'));
});
