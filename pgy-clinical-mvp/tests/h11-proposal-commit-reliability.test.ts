import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProposalDraft, countProposalDraftFields } from '../src/platform/workspace/proposal-draft.js';
import { canonicalizeProposalSubmit } from '../src/adapters/ai-sdk/proposal-canonicalizer.js';
import {
  buildMinimalFinalizationPrompt,
  buildRetryPrompt,
  countFinalizationContextItems,
  tryParseProposalSubmit,
} from '../src/adapters/ai-sdk/minimal-finalization.js';
import { proposalSubmitInputSchema, type ProposalSubmitInput } from '../src/contracts/result.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { buildDecisionState } from '../src/platform/workspace/decision-state-projection.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

function makeDoc(id: string, sourceId: string, formulaId: string, name: string, composition: string): KnowledgeDoc {
  return {
    id, sourceId, sourceTier: 'P1', knowledgeRole: 'NORMATIVE_TREATMENT',
    prescriptionAuthority: true, releaseVersion: 'test', kind: 'normative',
    source: 'S', sourceFile: `${id}.json`, disease: 'd', syndrome: 's', treatment: 't',
    scope: 'general', title: id, text: id,
    formulas: [{ id: formulaId, name, composition, sourceTier: 'P1', knowledgeRole: 'normative' }],
    raw: {},
  };
}

const DOCS: KnowledgeDoc[] = [
  makeDoc('P1:A', 'P1:A', 'F:A', '方A', '药甲10g，药乙6g'),
  makeDoc('P1:B', 'P1:B', 'F:B', '方B', '药丙10g，药丁6g'),
];

function workspaceWithCandidate(frontierRefs: string[] = ['P1:A::F:A']): { ws: ReturnType<typeof createClinicalWorkspace>; store: ClinicalWorkspaceStore } {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run-h11');
  store.append('candidate.presented', { id: 'P1:A::F:A', formulaId: 'F:A', sourceId: 'P1:A', name: '方A' });
  store.append('hypothesis.presented', { id: 'H_1', label: '气滞血瘀' });
  store.append('candidate.focused', { id: 'P1:A::F:A' });
  return { ws, store };
}

function context(ws: ReturnType<typeof createClinicalWorkspace>): RuntimeContext {
  return { runId: 'run-h11', workspace: ws } as unknown as RuntimeContext;
}

const MINIMAL_CLINICAL: ProposalSubmitInput = {
  mode: 'clinical',
  disease: { name: '子宫肌瘤' },
  syndrome: { name: '气滞血瘀' },
  treatment: { text: '理气活血化瘀' },
  candidate_ref: 'P1:A::F:A',
  uncertainty: ['贫血程度未明'],
};

// ---------- 1/2. ProposalDraft 投影 ----------

test('ProposalDraft 正确从 Workspace 投影（syndrome/selectedCandidateRef/uncertainty）', () => {
  const { ws, store } = workspaceWithCandidate();
  store.append('uncertainty.resolved', { resolvedRefs: [], remainingRefs: ['贫血程度未明'] });
  const draft = buildProposalDraft(ws);
  assert.equal(draft.syndrome, '气滞血瘀');
  assert.equal(draft.selectedCandidateRef, 'P1:A::F:A');
  assert.deepEqual(draft.uncertainty, ['贫血程度未明']);
});

test('ProposalDraft 不创建新 clinical decision（disease/treatment 保持 undefined）', () => {
  const { ws } = workspaceWithCandidate();
  const draft = buildProposalDraft(ws);
  assert.equal(draft.disease, undefined);
  assert.equal(draft.treatment, undefined);
});

test('ProposalDraft 不在多候选间自行选择（frontier>1 → selectedCandidateRef undefined）', () => {
  const { ws } = workspaceWithCandidate();
  ws.deliberationState.frontier = ['P1:A::F:A', 'P1:B::F:B'];
  const draft = buildProposalDraft(ws);
  assert.equal(draft.selectedCandidateRef, undefined);
});

test('countProposalDraftFields 正确统计非空字段', () => {
  assert.equal(countProposalDraftFields({ syndrome: 'x', selectedCandidateRef: 'c', uncertainty: ['u'] }), 3);
  assert.equal(countProposalDraftFields({}), 0);
});

// ---------- 3/4/5/6. canonicalizeProposalSubmit ----------

test('proposal.submit 使用 candidate_ref canonical hydrate（Runtime ownership）', async () => {
  const { ws } = workspaceWithCandidate();
  const out = await canonicalizeProposalSubmit(MINIMAL_CLINICAL, context(ws), DOCS);
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.formula.authority, 'NORMATIVE');
  assert.equal(out.formula.formula_id, 'F:A');
  assert.equal(out.formula.source_id, 'P1:A');
  assert.equal(out.formula.composition[0], '药甲10g，药乙6g');
  assert.equal(out.formula.candidate_ref, 'P1:A::F:A');
});

test('无 candidate_ref 时 Runtime 判定 GENERATED_DRAFT（不伪造 formula identity）', async () => {
  const { ws } = workspaceWithCandidate();
  const out = await canonicalizeProposalSubmit({ ...MINIMAL_CLINICAL, candidate_ref: undefined }, context(ws), DOCS);
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.formula.authority, 'GENERATED_DRAFT');
  assert.equal(out.formula.formula_id, '');
  assert.equal(out.formula.source_id, '');
});

test('canonical safety 不由模型控制（minimal schema 无 safety，输出占位 PASS）', async () => {
  const { ws } = workspaceWithCandidate();
  const out = await canonicalizeProposalSubmit(MINIMAL_CLINICAL, context(ws), DOCS);
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.safety.status, 'PASS');
  // minimal schema 不需要 safety / formula，模型无法通过 submit 注入 authority 或 safety。
  const parsed = proposalSubmitInputSchema.safeParse(MINIMAL_CLINICAL);
  assert.equal(parsed.success, true);
});

test('主动 submit 成功路径：minimal clinical → 完整 AgentResult', async () => {
  const { ws } = workspaceWithCandidate();
  const out = await canonicalizeProposalSubmit(MINIMAL_CLINICAL, context(ws), DOCS);
  if (out.mode !== 'clinical') throw new Error('expected clinical');
  assert.equal(out.disease.name, '子宫肌瘤');
  assert.equal(out.syndrome.name, '气滞血瘀');
  assert.equal(out.treatment.text, '理气活血化瘀');
  assert.equal(out.status, 'COMPLETED');
  assert.deepEqual(out.missing_information, ['贫血程度未明']);
});

test('clarification submit 正常（不被强制转成 prescription）', async () => {
  const { ws } = workspaceWithCandidate();
  const out = await canonicalizeProposalSubmit({ mode: 'clarification', questions: ['请补充经量'] }, context(ws), DOCS);
  assert.equal(out.mode, 'clarification');
});

test('finalization 不生成新 candidate（canonicalize 只读 workspace）', async () => {
  const { ws } = workspaceWithCandidate();
  const before = ws.candidates.length;
  await canonicalizeProposalSubmit(MINIMAL_CLINICAL, context(ws), DOCS);
  assert.equal(ws.candidates.length, before);
});

// ---------- 13/19. deterministic parse ----------

test('tryParseProposalSubmit 提取唯一 JSON object 并保留 clinical 字段', () => {
  const text = '```json\n{"mode":"clarification","questions":["a"]}\n```';
  const r = tryParseProposalSubmit(text);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { mode: 'clarification', questions: ['a'] });
});

test('malformed JSON → parse failure（stage=parse）', () => {
  const r = tryParseProposalSubmit('{"mode": "clinical", "disease": ');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.stage, 'parse');
});

test('合法 JSON 但 schema 不符 → schema failure', () => {
  const r = tryParseProposalSubmit('{"mode":"clinical"}');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.stage, 'schema');
});

// ---------- 9/10/14. minimal finalization context ----------

test('minimal finalization 不包含完整 Trace / 历史 tool results', () => {
  const { ws } = workspaceWithCandidate();
  const draft = buildProposalDraft(ws);
  const ds = buildDecisionState(ws, emptyClinicalStrategy());
  const prompt = buildMinimalFinalizationPrompt(context(ws), draft, ds);
  assert.ok(!prompt.includes('Evidence Projection'));
  assert.ok(!prompt.includes('toolCalls'));
  assert.ok(!prompt.includes('Candidate Comparison Matrix'));
  assert.ok(prompt.includes('ProposalDraft'));
});

test('retry 使用 minimal context（不含完整病例/历史）', () => {
  const draft = buildProposalDraft(workspaceWithCandidate().ws);
  const prompt = buildRetryPrompt(draft, 'parse error');
  assert.ok(!prompt.includes('Evidence Projection'));
  assert.ok(!prompt.includes('工具'));
  assert.ok(prompt.includes('ProposalDraft'));
  assert.ok(prompt.includes('parse error'));
});

test('countFinalizationContextItems 统计 context 条目', () => {
  const { ws } = workspaceWithCandidate();
  const draft = buildProposalDraft(ws);
  const ds = buildDecisionState(ws, emptyClinicalStrategy());
  assert.equal(countFinalizationContextItems(draft, ds), countProposalDraftFields(draft) + ds.currentFrontier.length + ds.currentEvidenceRefs.length + ds.decisionChangingUnknowns.length);
});
