import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClinicalWorkspace,
  ClinicalWorkspaceStore,
  findUnresolvedFormalHypotheses,
  checkClinicalCompletion,
  checkClinicalCoreCompletion,
} from '../src/platform/workspace/clinical-workspace.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';

// === Fix A: FormalHypothesis disposition contract ===

test('H15.2.3: primary (active) disposition → resolved', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'r');
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  assert.deepEqual(findUnresolvedFormalHypotheses(ws), []);
});

test('H15.2.3: secondary/accompanying disposition → resolved', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'r');
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  // H_a 仍为 alternative 状态，但已被 PatternAssessment.secondary 通过 hypothesisRef 引用 → 有 disposition。
  store.append('pattern.assessment.recorded', { secondary: [{ statement: '气滞血瘀', hypothesisRef: 'H_a' }] });
  assert.deepEqual(findUnresolvedFormalHypotheses(ws), []);
});

test('H15.2.3: rejected → resolved', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'r');
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('hypothesis.rejected', { id: 'H_a' });
  assert.deepEqual(findUnresolvedFormalHypotheses(ws), []);
});

test('H15.2.3: preserved_as_uncertainty → resolved', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'r');
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('hypothesis.preserved_as_uncertainty', { id: 'H_a' });
  assert.deepEqual(findUnresolvedFormalHypotheses(ws), []);
});

test('H15.2.3: no disposition → remains unresolved', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'r');
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  assert.deepEqual(findUnresolvedFormalHypotheses(ws).map((h) => h.id), ['H_a']);
});

test('H15.2.3: 不依赖证型名称字符串匹配（只认 hypothesisRef identity）', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'r');
  store.append('hypothesis.presented', { id: 'H_1', label: '血虚', origin: 'agent_reasoning' });
  // secondary 只有 statement 文本（无 hypothesisRef），即使 statement 与 label 文本相同，也不应据此判定 resolved。
  store.append('pattern.assessment.recorded', { secondary: [{ statement: '血虚' }] });
  assert.deepEqual(findUnresolvedFormalHypotheses(ws).map((h) => h.id), ['H_1']);
});

// === Fix B: treatment knowledge acquisition gate removal ===

test('H15.2.3: knowledge.search_cards 不因固定 clinical sequence 未完成而 hard block', async () => {
  const ctx = {
    workspace: createClinicalWorkspace(),
    understanding: { facts: [] },
    runId: 'r',
    knowledgeScopes: [] as string[],
  } as never;
  const tool = DEFAULT_AI_SDK_TOOL_BINDINGS['knowledge.search_cards'](ctx as never) as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  const out = await tool.execute({ query: '痛经', topK: 1 }, {});
  assert.ok(!(out && typeof out === 'object' && (out as Record<string, unknown>).notReady === true), '不应返回 notReady receipt');
  assert.ok(Array.isArray(out), '应返回 cards 数组而非 hard block');
});

test('H15.2.3: formula.search_candidates 只产生 presented，不自动选方', () => {
  const drafts = workspaceEventsForTool(
    'formula.search_candidates',
    { topK: 5 },
    { candidates: [{ candidateRef: 'P1::f', formulaId: 'f', sourceId: 'P1', formulaName: '某方' }] },
  );
  const types = drafts.map((d) => d.type);
  assert.ok(types.includes('candidate.presented'));
  assert.ok(!types.includes('candidate.selected'));
  assert.ok(!types.includes('formula.selection.recorded'));
});

// === 不退化：commit/submit 边界 ===

test('H15.2.3: formulaSelection required + empty selectedCandidateRef 仍失败', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'r');
  store.append('completion.obligation.recorded', {
    requestedOutcome: '辨证并开方',
    requiredArtifacts: ['diseaseAssessment', 'patternAssessment', 'formulaSelection'],
  });
  store.append('disease.assessment.recorded', { statement: '痛经' });
  store.append('pattern.assessment.recorded', { primary: { statement: '气滞血瘀', hypothesisRef: 'H_a' } });
  store.append('hypothesis.presented', { id: 'H_a', label: '气滞血瘀', origin: 'agent_reasoning' });
  store.append('hypothesis.selected', { id: 'H_a' });
  store.append('formula.selection.recorded', { selectedCandidateRef: undefined });
  const result = checkClinicalCompletion(ws);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingArtifacts, ['formulaSelection']);
});

test('H15.2.3: evidence-insufficient 空 spine 仍被 Clinical Core 保护', () => {
  const ws = createClinicalWorkspace();
  const core = checkClinicalCoreCompletion(ws);
  assert.equal(core.ok, false);
  assert.deepEqual(core.missing, ['clinicalQuestion', 'diseaseAssessment', 'patternAssessment', 'treatmentPlan']);
});
