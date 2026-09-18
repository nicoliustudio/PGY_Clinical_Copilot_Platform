import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RetrievalDisciplineTracker,
  isRetrievalTool,
  isViableFormulaCandidate,
  isFormulaSearchReuse,
  isEvidenceReuse,
} from '../src/adapters/ai-sdk/retrieval-discipline.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { buildDecisionState } from '../src/platform/workspace/decision-state-projection.js';
import { buildClinicalWorkingView, renderClinicalWorkingView } from '../src/platform/context/clinical-working-view.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';

function workspaceWithCandidate(): ClinicalWorkspace {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  store.append('candidate.presented', { id: 'P1:a::F:1', formulaId: 'F:1', sourceId: 'P1:a', name: '方A' });
  return ws;
}

test('FirstViableCandidate 可正确记录', () => {
  const ws = workspaceWithCandidate();
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordViableCandidateIfAbsent(ws, 2, 1000);
  const m = tracker.metrics();
  assert.equal(m.firstViableCandidateRef, 'P1:a::F:1');
  assert.equal(m.firstViableCandidateStep, 2);
  assert.ok(m.firstViableCandidateAt);
});

test('firstViableCandidate 不依赖 confidence threshold', () => {
  assert.equal(isViableFormulaCandidate({ kind: 'formula', formulaId: 'F:1', sourceId: 'P1:a' }), true);
  assert.equal(isViableFormulaCandidate({ kind: 'formula', formulaId: 'F:1' }), false);
  assert.equal(isViableFormulaCandidate({ kind: 'formula', sourceId: 'P1:a' }), false);
  assert.equal(isViableFormulaCandidate({ kind: 'syndrome', formulaId: 'F:1', sourceId: 'P1:a' }), false);
});

test('retrieval 前可看到 current DecisionState（frontier + evidence refs）', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  store.append('evidence.added', { id: 'P1:a', sourceId: 'P1:a' });
  store.append('candidate.presented', { id: 'c1', formulaId: 'F:1', sourceId: 'P1:a', name: '方A' });
  store.append('candidate.focused', { id: 'c1' });
  const ds = buildDecisionState(ws, emptyClinicalStrategy());
  assert.deepEqual(ds.currentFrontier, ['c1']);
  assert.ok(ds.currentEvidenceRefs.includes('P1:a'));
});

test('已存在 evidence 可复用', () => {
  const evidenceIds = new Set(['P1:a', 'P1:b']);
  assert.equal(isEvidenceReuse([{ sourceId: 'P1:a' }, { sourceId: 'P1:b' }], evidenceIds), true);
  assert.equal(isEvidenceReuse([{ sourceId: 'P1:a' }, { sourceId: 'P1:new' }], evidenceIds), false);
  assert.equal(isEvidenceReuse([], evidenceIds), false);
});

test('相同 get_source 使用 cache（reused 统计）', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordToolExecution({
    toolName: 'knowledge.get_source', reused: true, decisionImpact: 'none', rawOutput: null,
    candidateIdsBefore: new Set(), evidenceIdsBefore: new Set(),
  });
  assert.equal(tracker.metrics().getSourceReuseCount, 1);
});

test('相同 canonical candidate 不重复创建（formula search reuse）', () => {
  const candidateIds = new Set(['P1:a::F:1']);
  assert.equal(isFormulaSearchReuse([{ candidateRef: 'P1:a::F:1' }], candidateIds), true);
  assert.equal(isFormulaSearchReuse([{ candidateRef: 'P1:a::F:2' }], candidateIds), false);
  assert.equal(isFormulaSearchReuse([], candidateIds), false);
});

test('formula search reuse 正确统计', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordToolExecution({
    toolName: 'formula.search_normative', reused: false, decisionImpact: 'changed',
    rawOutput: [{ candidateRef: 'P1:a::F:1' }],
    candidateIdsBefore: new Set(['P1:a::F:1']), evidenceIdsBefore: new Set(),
  });
  assert.equal(tracker.metrics().formulaSearchReuseCount, 1);
});

test('viable candidate 后仍允许必要 retrieval（非 none）', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordViableCandidateIfAbsent(workspaceWithCandidate(), 1, 0);
  tracker.recordToolExecution({
    toolName: 'knowledge.search', reused: false, decisionImpact: 'changed',
    rawOutput: [{ sourceId: 'P1:new' }],
    candidateIdsBefore: new Set(), evidenceIdsBefore: new Set(),
  });
  const m = tracker.metrics();
  assert.equal(m.retrievalsAfterFirstViableCandidate, 1);
  assert.equal(m.nonDecisionChangingRetrievalsAfterViable, 0);
});

test('viable candidate 后非必要 retrieval 记录为 none', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordViableCandidateIfAbsent(workspaceWithCandidate(), 1, 0);
  tracker.recordToolExecution({
    toolName: 'knowledge.search', reused: false, decisionImpact: 'none', rawOutput: [],
    candidateIdsBefore: new Set(), evidenceIdsBefore: new Set(),
  });
  const m = tracker.metrics();
  assert.equal(m.retrievalsAfterFirstViableCandidate, 1);
  assert.equal(m.nonDecisionChangingRetrievalsAfterViable, 1);
});

test('nonDecisionChangingRetrievalsBefore/AfterViable 分别统计', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordToolExecution({
    toolName: 'knowledge.search', reused: false, decisionImpact: 'none', rawOutput: [],
    candidateIdsBefore: new Set(), evidenceIdsBefore: new Set(),
  });
  tracker.recordViableCandidateIfAbsent(workspaceWithCandidate(), 2, 0);
  tracker.recordToolExecution({
    toolName: 'knowledge.search', reused: false, decisionImpact: 'none', rawOutput: [],
    candidateIdsBefore: new Set(), evidenceIdsBefore: new Set(),
  });
  const m = tracker.metrics();
  assert.equal(m.retrievalsBeforeFirstViableCandidate, 1);
  assert.equal(m.retrievalsAfterFirstViableCandidate, 1);
  assert.equal(m.nonDecisionChangingRetrievalsBeforeViable, 1);
  assert.equal(m.nonDecisionChangingRetrievalsAfterViable, 1);
});

test('stepsFromFirstViableCandidateToSubmit 正确', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordViableCandidateIfAbsent(workspaceWithCandidate(), 2, 1000);
  tracker.recordSubmit(4, 2000);
  assert.equal(tracker.metrics().stepsFromFirstViableCandidateToSubmit, 2);
});

test('timeFromFirstViableCandidateToSubmitMs 正确', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordViableCandidateIfAbsent(workspaceWithCandidate(), 2, 1000);
  tracker.recordSubmit(4, 3500);
  assert.equal(tracker.metrics().timeFromFirstViableCandidateToSubmitMs, 2500);
});

test('isRetrievalTool 只识别三类检索工具', () => {
  assert.equal(isRetrievalTool('knowledge.search'), true);
  assert.equal(isRetrievalTool('knowledge.get_source'), true);
  assert.equal(isRetrievalTool('formula.search_normative'), true);
  assert.equal(isRetrievalTool('proposal.submit'), false);
  assert.equal(isRetrievalTool('workspace.focus_candidates'), false);
});

test('WorkingView 注入极简 retrieval feedback 与 post-viable 提示', () => {
  const view = buildClinicalWorkingView(workspaceWithCandidate(), emptyClinicalStrategy(), [], {
    lastImpact: 'none',
    recentNonDecisionChangingRetrievals: 2,
    recentEvidenceReuseCount: 1,
    firstViableCandidateRef: 'P1:a::F:1',
  });
  assert.equal(view.retrievalFeedback?.firstViableCandidateRef, 'P1:a::F:1');
  const rendered = renderClinicalWorkingView(view);
  assert.ok(rendered.includes('firstViableCandidateRef'));
  assert.ok(rendered.includes('A defensible canonical candidate already exists'));
});
