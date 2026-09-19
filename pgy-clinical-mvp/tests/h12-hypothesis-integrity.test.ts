import test from 'node:test';
import assert from 'node:assert/strict';
import { ClinicalWorkspaceStore, createClinicalWorkspace, findUnresolvedFormalHypotheses } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { buildClinicalWorkingView } from '../src/platform/context/clinical-working-view.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';

// ---------- A. Retrieval does not create patient hypothesis ----------

test('A: knowledge.search 不产生 patient hypothesis，但保留 evidence + sourceInterpretation', () => {
  const drafts = workspaceEventsForTool('knowledge.search', { query: '血瘀' }, [
    { sourceId: 'P1:a', title: 'A', authority: 'P1', excerpt: 'x', provenance: { disease: '崩漏', syndrome: '血瘀', sourceSchool: 'general_tcm' }, formulas: [] },
  ]);
  assert.equal(drafts.some((d) => d.type === 'hypothesis.presented'), false);
  const evidence = drafts.find((d) => d.type === 'evidence.added');
  assert.ok(evidence, 'evidence retained');
  assert.equal(evidence.payload.sourceSyndrome, '血瘀');
  assert.equal(evidence.payload.sourceDisease, '崩漏');
});

// ---------- B. Multiple labels do not populate Active Hypotheses ----------

test('B: 多个 syndrome labels 只进入 Retrieved Interpretations，不进入 Active Patient Hypotheses', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const drafts = workspaceEventsForTool('knowledge.search', { query: 'x' }, [
    { sourceId: 'P1:a', title: 'A', authority: 'P1', excerpt: '', provenance: { syndrome: '血瘀' }, formulas: [] },
    { sourceId: 'P1:b', title: 'B', authority: 'P1', excerpt: '', provenance: { syndrome: '肝郁脾虚' }, formulas: [] },
    { sourceId: 'P1:c', title: 'C', authority: 'P1', excerpt: '', provenance: { syndrome: '阴虚火旺' }, formulas: [] },
  ]);
  for (const d of drafts) store.append(d.type, d.payload);

  assert.equal(ws.hypothesisState.hypotheses.length, 0);
  const view = buildClinicalWorkingView(ws, emptyClinicalStrategy());
  assert.equal(view.retrievedInterpretations.length, 3);
  assert.equal(view.leadingHypotheses.length, 0);
});

// ---------- C. Agent-created hypothesis persists ----------

test('C: Agent 显式建立的 hypothesis 持久化并进入 WorkingView', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const drafts = workspaceEventsForTool('workspace.consider_hypotheses', { hypotheses: [{ label: '肝郁脾虚', role: 'leading' }] }, undefined);
  for (const d of drafts) store.append(d.type, d.payload);

  const h = ws.hypothesisState.hypotheses.find((x) => x.label === '肝郁脾虚');
  assert.ok(h);
  assert.equal(h.status, 'active');
  const view = buildClinicalWorkingView(ws, emptyClinicalStrategy());
  assert.ok(view.leadingHypotheses.some((x) => x.label === '肝郁脾虚'));
});

// ---------- D. Hypothesis origin ----------

test('D: Agent-created hypothesis origin 为 agent_reasoning，非 retrieval', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  const drafts = workspaceEventsForTool('workspace.consider_hypotheses', { hypotheses: [{ label: '肝郁脾虚', role: 'alternative' }] }, undefined);
  for (const d of drafts) store.append(d.type, d.payload);
  const h = ws.hypothesisState.hypotheses[0];
  assert.equal(h.origin, 'agent_reasoning');
  assert.notEqual(h.origin, 'retrieval_suggested');
});

// ---------- E. Submit with all formal hypotheses resolved ----------

test('E: 所有 formal hypothesis 都 resolution 后 coverage check 通过', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  store.append('hypothesis.presented', { id: 'H_A', label: 'A', origin: 'agent_reasoning' });
  store.append('hypothesis.presented', { id: 'H_B', label: 'B', origin: 'agent_reasoning' });
  store.append('hypothesis.presented', { id: 'H_C', label: 'C', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_A' });
  store.append('hypothesis.rejected', { id: 'H_B' });
  store.append('hypothesis.preserved_as_uncertainty', { id: 'H_C' });
  assert.deepEqual(findUnresolvedFormalHypotheses(ws), []);
});

// ---------- F. Submit with unresolved formal alternative ----------

test('F: unresolved formal alternative 被 coverage check 识别（非 Authority/Safety block）', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  store.append('hypothesis.presented', { id: 'H_A', label: 'A', origin: 'agent_reasoning' });
  store.append('hypothesis.presented', { id: 'H_B', label: 'B', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_A' });
  const unresolved = findUnresolvedFormalHypotheses(ws);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, 'H_B');
  assert.equal(unresolved[0].status, 'alternative');
});

// ---------- G. Retrieval labels not subject to coverage invariant ----------

test('G: retrieval_suggested labels 不进入 coverage invariant（只检查 formal）', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  for (let i = 0; i < 12; i++) {
    store.append('hypothesis.presented', { id: `H_r${i}`, label: `retrieval_${i}`, origin: 'retrieval_suggested' });
  }
  store.append('hypothesis.presented', { id: 'H_A', label: 'A', origin: 'agent_reasoning' });
  store.append('hypothesis.presented', { id: 'H_B', label: 'B', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_A' });
  const unresolved = findUnresolvedFormalHypotheses(ws);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, 'H_B');
});

// ---------- preserved_as_uncertainty 语义 ----------

test('preserved_as_uncertainty 从 alternatives 投影中排除', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  store.append('hypothesis.presented', { id: 'H_A', label: 'A', origin: 'agent_reasoning' });
  store.append('hypothesis.presented', { id: 'H_B', label: 'B', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_A' });
  store.append('hypothesis.preserved_as_uncertainty', { id: 'H_B' });
  const h = ws.hypothesisState.hypotheses.find((x) => x.id === 'H_B');
  assert.equal(h?.status, 'preserved_as_uncertainty');
  const view = buildClinicalWorkingView(ws, emptyClinicalStrategy());
  assert.equal(view.leadingHypotheses.some((x) => x.id === 'H_B'), false);
});
