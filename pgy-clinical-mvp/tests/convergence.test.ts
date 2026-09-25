import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallLedger, stableStringify } from '../src/adapters/ai-sdk/tool-call-ledger.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { buildComparisonMatrix } from '../src/platform/workspace/deliberation-projection.js';
import { newTrace, addToolCall, finishTrace } from '../src/trace.js';
import { agentResultSchema } from '../src/contracts/result.js';

// ---------- ToolCallLedger：确定性去重 ----------

test('identical deterministic tool call 可复用结果', () => {
  const ledger = new ToolCallLedger();
  const input = { sourceId: 'P1:doc1' };

  // 首次执行
  assert.equal(ledger.reuse('knowledge.get_source', input), undefined);
  ledger.record('knowledge.get_source', input, { id: 'P1:doc1', title: 'x' });
  assert.equal(ledger.isReused('knowledge.get_source', input), false);

  // 第二次：复用
  const cached = ledger.reuse('knowledge.get_source', input);
  assert.ok(cached);
  assert.deepEqual(cached.output, { id: 'P1:doc1', title: 'x' });
  assert.equal(ledger.isReused('knowledge.get_source', input), true);
});

test('stateful reuse decision is captured at invocation time, not recomputed after state changes', () => {
  const ledger = new ToolCallLedger();
  const input = { outcome: 'modality:test' };
  assert.equal(ledger.reuse('workspace.record_deliberation', input, 'state:v1'), undefined);
  ledger.record('workspace.record_deliberation', input, { ok: false }, 'state:v1');
  assert.equal(ledger.consumeInvocationReuse('workspace.record_deliberation', input), false);

  const cached = ledger.reuse('workspace.record_deliberation', input, 'state:v1');
  assert.ok(cached);
  // Even if the mutable state has already moved to v2 by callback time, the invocation truth is stable.
  assert.equal(ledger.consumeInvocationReuse('workspace.record_deliberation', input), true);
  assert.equal(ledger.reuse('workspace.record_deliberation', input, 'state:v2'), undefined);
  assert.equal(ledger.consumeInvocationReuse('workspace.record_deliberation', input), false);
});

test('对象 key 顺序不影响 deterministic 身份', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.notEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ a: 1, b: 3 }));
});

test('repeated capability discovery 不产生重复真实执行（ledger 复用）', () => {
  const ledger = new ToolCallLedger();
  const input = {};
  assert.equal(ledger.reuse('capability.discover', input), undefined);
  ledger.record('capability.discover', input, [{ id: 'gaofang', active: false }]);
  const again = ledger.reuse('capability.discover', input);
  assert.ok(again);
  assert.equal(ledger.isReused('capability.discover', input), true);
});

// ---------- Candidate Pool vs Deliberation Frontier ----------

function presentCandidate(store: ClinicalWorkspaceStore, id: string) {
  store.append('candidate.presented', { id, formulaId: 'F', sourceId: 'P1:s', composition: ['药甲'], name: '方' });
}

test('presented candidate 不自动产生 deliberation obligation', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  assert.equal(ws.deliberationState.frontier.length, 0);
  assert.equal(ws.deliberationState.coverage.length, 0);
});

test('只有 frontier candidate 进入 coverage 与 comparison matrix', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentCandidate(store, 'c2');
  // 只 focus c1
  store.append('candidate.focused', { id: 'c1' });

  assert.deepEqual(ws.deliberationState.frontier, ['c1']);
  assert.equal(ws.deliberationState.coverage.length, 1);
  assert.equal(ws.deliberationState.coverage[0].candidateRef, 'c1');

  const matrix = buildComparisonMatrix(ws);
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].candidateRef, 'c1');
});

test('batch deliberation 一次记录多个 assessment / exclusion（frontier 由 focus_candidates 独占）', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-1');
  presentCandidate(store, 'c1');
  presentCandidate(store, 'c2');
  store.append('hypothesis.presented', { id: 'h1', label: 'h1', supportingEvidenceRefs: ['P1:x'] });

  // frontier 由 workspace.focus_candidates 独占写入
  for (const d of workspaceEventsForTool('workspace.focus_candidates', { candidateRefs: ['c1', 'c2'] }, undefined)) {
    store.append(d.type, d.payload);
  }

  const drafts = workspaceEventsForTool('workspace.record_deliberation', {
    assessments: [
      { candidateRef: 'c1', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'A', assessmentEvidenceRefs: ['P1:x'] },
      { candidateRef: 'c2', hypothesisRef: 'h1', supportingEvidenceRefs: ['P1:x'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: 'B', assessmentEvidenceRefs: ['P1:x'] },
    ],
    exclusions: [],
  }, undefined);

  assert.equal(drafts.filter((d) => d.type === 'candidate.assessed').length, 2);

  for (const d of drafts) store.append(d.type, d.payload);
  assert.equal(ws.deliberationState.assessments.length, 2);
  assert.deepEqual(ws.deliberationState.frontier.sort(), ['c1', 'c2']);
});

test('workspace.focus_candidates 生成 focused 事件', () => {
  const drafts = workspaceEventsForTool('workspace.focus_candidates', { candidateRefs: ['c1', 'c2'] }, undefined);
  assert.deepEqual(drafts.map((d) => d.type), ['candidate.focused', 'candidate.focused']);
  assert.deepEqual(drafts.map((d) => d.payload.id), ['c1', 'c2']);
});

// ---------- Proposal 直接来自 tool input ----------

test('proposal.submit 的 tool input 直接通过 agentResultSchema 校验', () => {
  const proposal = agentResultSchema.parse({
    mode: 'clinical',
    status: 'COMPLETED',
    disease: { name: 'x', confidence: 0.8, evidence_refs: ['P1:a'] },
    syndrome: { name: 'y', confidence: 0.7, evidence_refs: ['P1:a'] },
    treatment: { text: 'z', evidence_refs: ['P1:a'] },
    formula: { authority: 'NORMATIVE', formula_id: 'f', name: 'n', composition: ['药'], source_id: 'P1:a', candidate_ref: 'c', evidence_refs: ['P1:a'] },
    missing_information: [],
    safety: { status: 'PASS' },
  });
  assert.equal(proposal.mode, 'clinical');
});

// ---------- Trace 完整化：失败 trace 保留 agentLoop ----------

test('failure trace 保留 stepCount / finishReason / usage / tool calls', () => {
  const trace = newTrace('x');
  addToolCall(trace.runId, { toolName: 'knowledge.search', input: { query: 'q' }, output: [], ms: 3 });
  finishTrace(trace.runId, {
    error: '无法从输出中提取 JSON',
    agentLoop: {
      stepCount: 16,
      finishReason: 'tool-calls',
      terminationReason: 'resource_limit_fallback',
      proposalSubmitted: false,
      forcedFinalization: true,
      usage: { inputTokens: 100, outputTokens: 50 },
      finalStepHadToolCalls: true,
      toolCallLedger: [{ toolName: 'knowledge.search', normalizedInput: '{"query":"q"}', resultIdentity: '[]', reused: false, timestamp: '2026-09-18T00:00:00.000Z' }],
    },
  });

  assert.equal(trace.error, '无法从输出中提取 JSON');
  assert.equal(trace.agentLoop?.stepCount, 16);
  assert.equal(trace.agentLoop?.finishReason, 'tool-calls');
  assert.equal(trace.agentLoop?.terminationReason, 'resource_limit_fallback');
  assert.equal(trace.agentLoop?.forcedFinalization, true);
  assert.equal(trace.agentLoop?.usage?.inputTokens, 100);
  assert.equal(trace.toolCalls.length, 1);
});
