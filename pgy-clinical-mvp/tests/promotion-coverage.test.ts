import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { buildHypothesisProjection, resolveWorkItemRef } from '../src/platform/workspace/hypothesis-projection.js';
import { reasoningPassCount } from '../src/adapters/ai-sdk/agent-runtime.js';

test('workItemRef deterministically resolves hypothesisRef', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('hypothesis.presented', { id: 'h1', label: '阴虚火旺型', supportingEvidenceRefs: ['P1:x'] });

  const item = resolveWorkItemRef(workspace, 'work:h1');
  assert.ok(item);
  assert.equal(item.hypothesisRef, 'h1');
  assert.equal(item.id, 'work:h1');
});

test('invalid workItemRef is rejected', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('hypothesis.presented', { id: 'h1', label: '阴虚火旺型', supportingEvidenceRefs: ['P1:x'] });

  assert.throws(() => resolveWorkItemRef(workspace, 'work:nope'), /invalid promotionWorkItemRef/);
  // 旧的 LLM 手写 hypothesis id 数组在这里不可用：raw hypothesis id 不是合法 work item ref。
  assert.throws(() => resolveWorkItemRef(workspace, 'h1'), /invalid promotionWorkItemRef/);
});

test('formula search attribution does not depend on LLM-provided hypothesis IDs', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('hypothesis.presented', { id: 'h1', label: '阴虚火旺型', supportingEvidenceRefs: ['P1:x'] });

  // 未提供 workItemRef 时不产生任何 attribution（不会从 LLM 输出复制 hypothesis id）。
  assert.equal(resolveWorkItemRef(workspace, undefined), null);
  // 只有 opaque work item ref 能解析出真实 hypothesis identity。
  assert.equal(resolveWorkItemRef(workspace, 'work:h1')?.hypothesisRef, 'h1');
});

test('returned candidate inherits originatingHypothesisRefs from work item', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  store.append('hypothesis.presented', { id: 'h1', label: '阴虚火旺型', supportingEvidenceRefs: ['P1:x'] });

  // Runtime 解析 work item → hypothesisRef，然后把该 ref 写入 candidate。
  const workItem = resolveWorkItemRef(workspace, 'work:h1');
  store.append('candidate.presented', {
    id: 'c1',
    formulaId: 'F1',
    sourceId: 'P1:x',
    composition: ['药甲'],
    name: '方A',
    originatingHypothesisRefs: workItem ? [workItem.hypothesisRef] : [],
  });

  const candidate = workspace.candidates.find((c) => c.id === 'c1');
  assert.deepEqual(candidate?.originatingHypothesisRefs, ['h1']);
  assert.ok(resolveWorkItemRef(workspace, 'work:h1')?.candidateRefs.includes('c1'));
});

test('new candidate does not overwrite selected/preferred candidate', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');

  store.append('candidate.presented', { id: 'c1', formulaId: 'F1', sourceId: 'P1:a', composition: ['药甲'], name: '方A' });
  store.append('candidate.selected', { id: 'c1' });
  // 新的 formula search 只增加 candidate，不得改动已 selected 的 c1。
  store.append('candidate.presented', { id: 'c2', formulaId: 'F2', sourceId: 'P1:b', composition: ['药乙'], name: '方B' });

  const comparisons = workspace.evidenceState.candidateComparisons;
  assert.equal(comparisons.find((c) => c.candidateRef === 'c1')?.status, 'selected');
  assert.equal(comparisons.find((c) => c.candidateRef === 'c2')?.status, 'presented');
  assert.equal(workspace.candidates.length, 2);
});

test('promotion gap does not automatically trigger an extra unrestricted Agent pass', () => {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  // 有证据支持、未拒绝、无 candidate → 仍是一个 unresolved promotion gap。
  store.append('hypothesis.presented', { id: 'h1', label: '阴虚火旺型', supportingEvidenceRefs: ['P1:x'] });

  const projection = buildHypothesisProjection(workspace);
  assert.equal(projection.promotionWorkItems.length, 1);
  // 但 gap 只作为 projection/diagnostics，reasoning loop 始终只有一轮。
  assert.equal(reasoningPassCount(workspace), 1);
});

test('replay reconstructs identical work-item attribution', () => {
  const a = createClinicalWorkspace();
  const storeA = new ClinicalWorkspaceStore(a, 'run-1');
  storeA.append('hypothesis.presented', { id: 'h1', label: '阴虚火旺型', supportingEvidenceRefs: ['P1:x'] });
  storeA.append('candidate.presented', { id: 'c1', formulaId: 'F1', sourceId: 'P1:x', composition: ['药甲'], name: '方A', originatingHypothesisRefs: ['h1'] });

  const b = createClinicalWorkspace();
  const storeB = new ClinicalWorkspaceStore(b, 'run-1');
  for (const event of storeA.trace()) storeB.append(event.type, event.payload);

  assert.deepEqual(b.promotionState, a.promotionState);
  assert.deepEqual(b.candidates, a.candidates);
});
