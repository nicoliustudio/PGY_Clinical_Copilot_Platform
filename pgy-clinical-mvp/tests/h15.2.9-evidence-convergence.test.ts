import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  createClinicalWorkspace,
  ClinicalWorkspaceStore,
  checkClinicalCoreCompletion,
} from '../src/platform/workspace/clinical-workspace.js';
import { buildClinicalWorkingView, renderClinicalWorkingView } from '../src/platform/context/clinical-working-view.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';
import { RetrievalDisciplineTracker } from '../src/adapters/ai-sdk/retrieval-discipline.js';

/**
 * H15.2.9 —— Minimal Evidence Convergence Check
 * 确定性：submit hard-required artifact 可写/可见/可达；formula 检索信息增量反馈。
 */

const originalFlag = config.experiment.patternAssessment;

// === 架构 invariant（Section 5） ===

test('H15.2.9 invariant: default config 下 patternAssessment 仍可写（record_deliberation schema 不因 flag 关闭）', () => {
  config.experiment.patternAssessment = false;
  const factory = DEFAULT_AI_SDK_TOOL_BINDINGS['workspace.record_deliberation'];
  const tool = factory({} as any) as any;
  const shape = tool?.inputSchema?.shape;
  assert.ok(shape && typeof shape === 'object', 'record_deliberation inputSchema 应可检查');
  assert.ok('patternAssessment' in shape, 'patternAssessment 字段在 default config 下必须可写');
});

test('H15.2.9 invariant: 写入四个 hard-required artifact 后 clinical core 可达 complete', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run_invariant');
  // clinicalQuestion（seed）+ diseaseAssessment + formalHypotheses + patternAssessment。
  ws.clinicalDecisionSpine.clinicalQuestion = { statement: '求诊', version: 1 };
  store.append('disease.assessment.recorded', { statement: '胃痛', evidenceRefs: [], version: 1 });
  store.append('pattern.assessment.recorded', { primary: { statement: '湿热中阻', supportingEvidenceRefs: ['CF_1'] } });
  store.append('hypothesis.presented', { id: 'H_1', label: '湿热中阻', origin: 'agent_reasoning' });
  const core = checkClinicalCoreCompletion(ws);
  assert.equal(core.ok, true, `clinical core 应可达 complete，实际 missing=${core.missing.join(',')}`);
});

test('H15.2.9 invariant: WorkingView 可见 patternStructure / completion / formula decision state', () => {
  config.experiment.patternAssessment = false;
  const ws = createClinicalWorkspace();
  ws.patternAssessment = { primary: { statement: '湿热中阻', supportingEvidenceRefs: ['CF_1'] } };
  const view = buildClinicalWorkingView(ws, emptyClinicalStrategy());
  assert.ok(view.patternStructure, 'patternStructure 在 flag off 时仍可见');
  assert.ok(view.clinicalCompletionState, 'clinicalCompletionState 可见');
  assert.ok(view.formulaDecisionState, 'formulaDecisionState 可见');
  const rendered = renderClinicalWorkingView(view);
  assert.ok(rendered.includes('Pattern Structure'));
  assert.ok(rendered.includes('Clinical Completion State'));
  assert.ok(rendered.includes('Formula Decision State'));
});

// === Formula Decision State 反馈 ===

test('H15.2.9: 重复无信息 formula 检索 → feedback 标记 NO_NEW_INFORMATION', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordToolExecution({
    toolName: 'formula.search_candidates',
    reused: false,
    decisionImpact: 'none',
    rawOutput: { candidates: [] },
    candidateIdsBefore: new Set(),
    evidenceIdsBefore: new Set(),
    newCandidateCount: 0,
    newEvidenceCount: 0,
  });
  const fb = tracker.feedback();
  assert.equal(fb.lastFormulaRetrieval?.info, 'NO_NEW_INFORMATION');
  assert.equal(fb.lastFormulaRetrieval?.tool, 'formula.search_candidates');
});

test('H15.2.9: 有新 candidate/evidence 的 formula 检索 → 标记 NEW_INFORMATION', () => {
  const tracker = new RetrievalDisciplineTracker();
  tracker.recordToolExecution({
    toolName: 'formula.get_evidence',
    reused: false,
    decisionImpact: 'reinforced',
    rawOutput: {},
    candidateIdsBefore: new Set(),
    evidenceIdsBefore: new Set(),
    newCandidateCount: 0,
    newEvidenceCount: 1,
  });
  const fb = tracker.feedback();
  assert.equal(fb.lastFormulaRetrieval?.info, 'NEW_INFORMATION');
  assert.equal(fb.lastFormulaRetrieval?.newEvidenceCount, 1);
});

test('H15.2.9: Formula Decision State 反映 candidates/evidence/selection 事实', () => {
  const ws = createClinicalWorkspace();
  ws.candidates.push(
    { id: 'c1', kind: 'formula', formulaId: 'f1', sourceId: 's1' },
    { id: 'c2', kind: 'formula', formulaId: 'f2', sourceId: 's2' },
  );
  ws.evidenceState.evidenceItems.push(
    { id: 'e1', sourceRef: 's1', sourceType: 'P2', relatedCandidates: [], supportingSignals: [], contradictingSignals: [], evidenceKind: 'treatment_knowledge' },
  );
  const view = buildClinicalWorkingView(ws, emptyClinicalStrategy());
  assert.equal(view.formulaDecisionState.candidateCount, 2);
  assert.equal(view.formulaDecisionState.evidenceCount, 1);
  assert.equal(view.formulaDecisionState.selectedCandidateRef, undefined);
  const rendered = renderClinicalWorkingView(view);
  assert.ok(rendered.includes('formula candidates: 2'));
  assert.ok(rendered.includes('selection: unresolved'));
});

test.after(() => {
  config.experiment.patternAssessment = originalFlag;
});
