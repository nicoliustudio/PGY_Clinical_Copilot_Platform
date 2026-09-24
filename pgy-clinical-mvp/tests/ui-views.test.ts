import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentResult } from '../src/contracts/result.js';
import type { AuthorityResult } from '../src/contracts/authority.js';
import type { ClinicalWorkspace } from '../src/contracts/workspace.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { newTrace, addToolCall, finishTrace } from '../src/trace.js';
import {
  buildKnowledgeSourceView,
  buildResultView,
  buildSessionView,
  buildTraceView,
  buildWorkspaceView,
} from '../src/ui/views.js';

function clinicalResult(overrides: Partial<AgentResult & { mode: 'clinical' }> = {}): AgentResult {
  return {
    mode: 'clinical',
    status: 'COMPLETED',
    disease: { name: '癥瘕', confidence: 0.9, evidence_refs: ['P1:a'] },
    syndrome: { name: '血热内盛', confidence: 0.8, evidence_refs: ['P1:a'] },
    treatment: { text: '清热凉血', evidence_refs: ['P1:a'] },
    formula: { authority: 'NORMATIVE', formula_id: 'f1', name: '先期汤', composition: ['生地黄'], source_id: 'P1:a', candidate_ref: 'c1', evidence_refs: ['P1:a'] },
    missing_information: ['舌脉'],
    safety: { status: 'PASS' },
    ...overrides,
  } as AgentResult;
}

function buildWorkspace(): { workspace: ClinicalWorkspace; store: ClinicalWorkspaceStore } {
  const workspace = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(workspace, 'run-1');
  workspace.facts = [{ kind: 'chief_complaint', value: '月经过多' }];
  workspace.informationGaps = ['舌脉未知'];
  workspace.uncertainties = ['病程'];
  store.append('evidence.added', { id: 'P1:a', sourceRef: 'P1:a', sourceType: 'P1', title: '月经过多', summary: '血热迫血妄行' });
  store.append('hypothesis.presented', { id: '血热内盛', label: '血热内盛', supportingEvidenceRefs: ['P1:a'] });
  store.append('candidate.presented', { id: 'c1', formulaId: 'f1', sourceId: 'P1:a', composition: ['生地黄'], name: '先期汤', originatingHypothesisRefs: ['血热内盛'] });
  store.append('candidate.selected', { id: 'c1' });
  store.append('candidate.assessed', { candidateRef: 'c1', hypothesisRef: '血热内盛', supportingEvidenceRefs: ['P1:a'], contradictingEvidenceRefs: [], unresolvedQuestions: [], assessmentSummary: '方证吻合', assessmentEvidenceRefs: ['P1:a'] });
  return { workspace, store };
}

const authority: AuthorityResult = {
  status: 'ALLOWED',
  proposal: clinicalResult(),
  decisions: [{ stage: 'safety.invariant', action: 'ALLOW', reasons: [] }, { stage: 'formula.authority', action: 'ALLOW', reasons: [] }],
};

test('buildResultView：clinical 输出映射病/证/法/方', () => {
  const view = buildResultView(clinicalResult());
  assert.equal(view.mode, 'clinical');
  assert.equal(view.disease?.name, '癥瘕');
  assert.equal(view.formula?.authority, 'NORMATIVE');
  assert.deepEqual(view.formula?.composition, ['生地黄']);
});

test('buildResultView：deterministic formula_set / treatment_deliveries 不得被 UI 丢弃', () => {
  const view = buildResultView(clinicalResult({
    formula_set: [
      {
        formula_ref: 'P1:a::f1', formula_id: 'f1', name: '先期汤', composition: '生地黄',
        source_ref: 'P1:a', modification_rules: [], modification_status: 'KNOWN_EMPTY',
        modification_text: '无加减', relation: 'PRIMARY_SELECTED',
      },
    ],
    treatment_deliveries: [
      {
        outcome: 'modality:acupuncture', form: 'acupuncture', disposition: 'CURRENTLY_SUITABLE',
        statement: 's', source_evidence_refs: ['AC-049'],
        details: { points: ['合谷'], operation: '平补平泻', frequency: '每日1次', course: '10次' },
      },
    ],
  }));
  assert.equal(view.formula_set?.length, 1);
  assert.equal(view.formula_set?.[0].formula_id, 'f1');
  assert.equal(view.treatment_deliveries?.length, 1);
  assert.equal(view.treatment_deliveries?.[0].outcome, 'modality:acupuncture');
  assert.deepEqual(view.treatment_deliveries?.[0].details, { points: ['合谷'], operation: '平补平泻', frequency: '每日1次', course: '10次' });
});

test('buildResultView：source products N→N 且三态/三类 modification facts 原样保留', () => {
  const mkFacts = (localPresence: 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN') => ({
    composition: { presence: 'PRESENT' as const, value: '药A 10g', provenance_refs: ['P1:a'] },
    preparation: { presence: 'UNKNOWN' as const, provenance_refs: ['P1:a'] },
    usage: { presence: 'KNOWN_EMPTY' as const, provenance_refs: ['P1:a'] },
    modifications: {
      formulaLocal: localPresence === 'PRESENT'
        ? { presence: 'PRESENT' as const, value: ['加味A'], provenance_refs: ['P1:a::f1'] }
        : { presence: localPresence, provenance_refs: ['P1:a::f1'] },
      sourceShared: { presence: 'PRESENT' as const, value: ['共享加减'], provenance_refs: ['P1:a'] },
      patientSpecific: { presence: 'UNKNOWN' as const, provenance_refs: [] },
    },
  });
  const view = buildResultView(clinicalResult({
    formula_set: [
      {
        formula_ref: 'P1:a::f1', formula_id: 'f1', name: '方一', composition: '药A 10g', source_ref: 'P1:a',
        modification_rules: ['加味A'], modification_status: 'PRESENT', modification_text: '加味A', relation: 'PRIMARY_SELECTED', facts: mkFacts('PRESENT'),
      },
      {
        formula_ref: 'P1:a::f2', formula_id: 'f2', name: '方二', composition: '药B 10g', source_ref: 'P1:a',
        modification_rules: [], modification_status: 'KNOWN_EMPTY', modification_text: '无加减', relation: 'SOURCE_ALTERNATIVE', facts: mkFacts('KNOWN_EMPTY'),
      },
      {
        formula_ref: 'P1:a::f3', formula_id: 'f3', name: '方三', composition: '药C 10g', source_ref: 'P1:a',
        modification_rules: [], modification_status: 'UNKNOWN', modification_text: 'UNKNOWN', relation: 'CLINICALLY_EXCLUDED', facts: mkFacts('UNKNOWN'),
      },
    ],
  }));

  assert.equal(view.formula_set?.length, 3, 'UI DTO must not drop clinically excluded source siblings');
  assert.equal(view.formula_set?.[2].relation, 'CLINICALLY_EXCLUDED');
  assert.equal(view.formula_set?.[0].facts?.modifications.formulaLocal.presence, 'PRESENT');
  assert.equal(view.formula_set?.[1].facts?.modifications.formulaLocal.presence, 'KNOWN_EMPTY');
  assert.equal(view.formula_set?.[2].facts?.modifications.formulaLocal.presence, 'UNKNOWN');
  assert.deepEqual(view.formula_set?.[0].facts?.modifications.sourceShared.value, ['共享加减']);
  assert.equal(view.formula_set?.[0].facts?.modifications.patientSpecific.presence, 'UNKNOWN');
});

test('buildResultView：urgent 输出映射 message + risks', () => {
  const view = buildResultView({ mode: 'urgent', message: '需立即就医', risks: [{ description: '出血', severity: 'high' }] } as AgentResult);
  assert.equal(view.mode, 'urgent');
  assert.equal(view.message, '需立即就医');
  assert.equal(view.risks?.length, 1);
});

test('buildWorkspaceView：映射证据/假设/候选状态', () => {
  const { workspace } = buildWorkspace();
  const view = buildWorkspaceView(workspace);
  assert.equal(view.evidence.length, 1);
  assert.equal(view.hypotheses[0].label, '血热内盛');
  assert.equal(view.candidates[0].status, 'selected');
  assert.equal(view.deliberation.assessments.length, 1);
});

test('buildKnowledgeSourceView：从 knowledge.get_source 还原 provenance', () => {
  const trace = newTrace('x');
  addToolCall(trace.runId, {
    toolName: 'knowledge.get_source',
    input: { sourceId: 'P1:a' },
    output: { id: 'P1:a', source: '《沈仲理医案》', sourceFile: 'cases.json', tier: 'P1', title: '月经过多', text: '原文…', formulas: [{ id: 'f1', name: '先期汤', composition: '生地黄…' }] },
    ms: 3,
  });
  finishTrace(trace.runId, {});
  const view = buildKnowledgeSourceView('P1:a', trace);
  assert.ok(view);
  assert.equal(view.source, '《沈仲理医案》');
  assert.equal(view.formulas?.[0].name, '先期汤');
});

test('trace DTO 不包含 hidden CoT（无模型推理文本）', () => {
  const trace = newTrace('x');
  addToolCall(trace.runId, { toolName: 'knowledge.search', input: { query: '月经过多' }, output: [], ms: 3 });
  finishTrace(trace.runId, { finalResult: clinicalResult() });
  const view = buildTraceView(trace);
  // 工具调用只含 toolName/input/output/error/ms，不含 text/reasoning/thought
  for (const c of view.toolCalls) {
    assert.ok(!('text' in c), 'tool call 不应包含模型文本');
    assert.ok(!('reasoning' in c));
    assert.ok(!('thought' in c));
  }
  // 结构化结果不含 CoT 字段
  const result = buildResultView(clinicalResult());
  assert.ok(!('thought' in result));
  assert.ok(!('reasoning' in result));
});

test('buildSessionView：聚合 result/authority/workspace/trace', () => {
  const { workspace } = buildWorkspace();
  const trace = newTrace('x');
  finishTrace(trace.runId, { finalResult: clinicalResult() });
  const session = buildSessionView({ result: clinicalResult(), workspace, authority, trace });
  assert.equal(session.runId, trace.runId);
  assert.equal(session.authority.status, 'ALLOWED');
  assert.equal(session.workspace.candidates[0].status, 'selected');
});
