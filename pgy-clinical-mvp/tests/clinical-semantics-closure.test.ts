import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCaseFacts } from '../src/clinical/case-fact-normalization.js';
import {
  exactDiseaseFamilySourceIds,
  resolvedDiseaseIdentityNames,
} from '../src/clinical/formula-evidence.js';
import { hydrateSourceFormulaSetForCandidate } from '../src/clinical/source-formula-set.js';
import { normalizeSourceSequence, normalizeSourceTextList } from '../src/knowledge/source-normalization.js';
import {
  ClinicalWorkspaceStore,
  createClinicalWorkspace,
  validatePatternAssessmentPatientBacking,
} from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { buildWorkspaceView } from '../src/ui/views.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

function p1Doc(id: string, disease: string, syndrome = '证', scope = 'general'): KnowledgeDoc {
  return {
    id,
    text: `${disease} ${syndrome}`,
    sourceId: 'P1_GYN_MANUAL',
    source: '手册',
    sourceFile: 'manual.json',
    sourceTier: 'P1',
    knowledgeRole: 'NORMATIVE_TREATMENT',
    prescriptionAuthority: true,
    scope,
    disease,
    syndrome,
    treatment: '治法',
    title: `${disease}｜${syndrome}`,
    formulas: [{
      id: `${id}-F`,
      name: '方',
      composition: '药A、药B',
      sourceTier: 'P1',
      knowledgeRole: 'NORMATIVE_TREATMENT',
      entityStatus: 'ACTIVE',
    }],
    releaseVersion: 'r',
    kind: 'normative',
  };
}

test('Clinical Semantics: explicit old calendar event cannot remain CURRENT', () => {
  const [fact] = normalizeCaseFacts([
    { kind: 'examination', value: '1981年10月31日B超提示子宫增大', temporalRole: 'current', polarity: 'present' },
  ], new Date('2026-09-27T12:00:00Z'));
  assert.ok(fact);
  assert.equal(fact.eventTime, '1981-10-31');
  assert.equal(fact.temporalRole, 'historical');
  assert.equal(fact.reportedTemporalRole, 'current');
  assert.equal(fact.id, 'CF_001');
});

test('Clinical Semantics: CaseFact identity survives workspace snapshot JSON round-trip', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts = normalizeCaseFacts([
    { kind: 'symptom', value: '近日出血不多', temporalRole: 'current', polarity: 'present' },
    { kind: 'past_diagnosis', value: '既往血崩2次', temporalRole: 'historical', polarity: 'present' },
  ], new Date('2026-09-27T12:00:00Z'));
  ws.facts = ws.caseFacts.map((fact) => ({ ...fact }));
  const snapshot = JSON.parse(JSON.stringify(buildWorkspaceView(ws)));
  assert.deepEqual(snapshot.caseFacts.map((fact: { id: string }) => fact.id), ['CF_001', 'CF_002']);
  assert.deepEqual(snapshot.facts.map((fact: { id: string }) => fact.id), ['CF_001', 'CF_002']);
});

test('Clinical Semantics: decisive pattern claims require durable patient-fact backing', () => {
  const ws = createClinicalWorkspace();
  ws.caseFacts = [{ id: 'CF_001', kind: 'symptom', value: '带下色黄', evidenceKind: 'patient', polarity: 'present', temporalRole: 'current' }];
  ws.evidenceState.evidenceItems.push({
    id: 'S1:wet-heat', sourceRef: 'S1:wet-heat', sourceType: 'S1', evidenceKind: 'diagnostic_knowledge',
    relatedCandidates: [], supportingSignals: [], contradictingSignals: [],
  });
  const knowledgeOnly = {
    primary: { statement: '湿热', supportingEvidenceRefs: ['S1:wet-heat'] },
    currentDominantMechanism: { statement: '湿热为主导', supportingEvidenceRefs: ['S1:wet-heat'] },
  };
  assert.match(validatePatternAssessmentPatientBacking(ws, knowledgeOnly)[0]?.message ?? '', /patient-derived/);
  const factBacked = {
    primary: { statement: '湿热', supportingEvidenceRefs: ['CF_001', 'S1:wet-heat'] },
    currentDominantMechanism: { statement: '湿热为主导', supportingEvidenceRefs: ['CF_001', 'S1:wet-heat'] },
  };
  assert.deepEqual(validatePatternAssessmentPatientBacking(ws, factBacked), []);
});

test('Clinical Semantics: retrieval provenance is merged instead of letting repeated search overwrite epistemic context', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'run');
  ws.hypothesisState.hypotheses.push({ id: 'H1', label: 'A', supportingEvidenceRefs: [], contradictingEvidenceRefs: [], missingEvidence: [], status: 'active' });
  const hit = {
    sourceId: 'S1:1', authority: 'AUX', knowledgeRole: 'DIAGNOSTIC_DIFFERENTIAL', title: '证据', excerpt: '文本',
    provenance: { disease: '', syndrome: 'A', source: 's', sourceFile: 'f' }, formulas: [],
  };
  store.appendBatch(workspaceEventsForTool('knowledge.search', {
    query: 'A 鉴别', purpose: 'HYPOTHESIS_SUPPORT', hypothesisRefs: ['H1'],
  }, [hit]));
  store.appendBatch(workspaceEventsForTool('knowledge.search', {
    query: '反证', purpose: 'HYPOTHESIS_CHALLENGE', hypothesisRefs: ['H1'],
  }, [hit]));
  const contexts = ws.evidenceState.evidenceItems[0]?.retrievalContexts ?? [];
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts.map((x) => x.purpose).sort(), ['HYPOTHESIS_CHALLENGE', 'HYPOTHESIS_SUPPORT']);
});

test('Clinical Semantics: exact resolved disease family is complete and independent of topK ranking', () => {
  const docs = [
    p1Doc('P1:K_A', '子宫肌瘤', '气滞血瘀'),
    p1Doc('P1:K_B', '子宫肌瘤', '肝郁脾虚'),
    p1Doc('P1:K_C', '子宫肌瘤', '阴虚火旺'),
    p1Doc('P1:OTHER', '崩漏', '脾虚'),
  ];
  assert.deepEqual(exactDiseaseFamilySourceIds(docs, ['general'], ['子宫肌瘤']), ['P1:K_A', 'P1:K_B', 'P1:K_C']);

  const ws = createClinicalWorkspace();
  ws.clinicalDecisionSpine.diseaseAssessment = {
    statement: '子宫肌瘤',
    diseaseConcepts: [{ id: 'D1', label: '子宫肌瘤', status: 'RESOLVED', evidenceRefs: ['CF_001'] }],
    evidenceRefs: ['CF_001'], version: 1,
  };
  assert.deepEqual(resolvedDiseaseIdentityNames(ws), ['子宫肌瘤']);
});

test('Clinical Semantics: CandidateSet receipt fail-closes if an exact-family required member is truncated', () => {
  const okWs = createClinicalWorkspace();
  const okStore = new ClinicalWorkspaceStore(okWs, 'ok');
  for (const id of ['source-node:P1:K_A', 'source-node:P1:K_B']) {
    okStore.append('candidate.presented', { id, sourceId: id.slice('source-node:'.length), retrievalLanes: ['EXACT_DISEASE_FAMILY'] });
  }
  okStore.append('candidate.frontier.set', {
    candidateRefs: ['source-node:P1:K_A', 'source-node:P1:K_B'],
    requiredExactDiseaseCandidateRefs: ['source-node:P1:K_A', 'source-node:P1:K_B'],
    exactDiseaseNames: ['子宫肌瘤'],
  });
  assert.equal(okWs.candidateSetReceipt?.recallCompleteness, 'COMPLETE');

  const badWs = createClinicalWorkspace();
  const badStore = new ClinicalWorkspaceStore(badWs, 'bad');
  badStore.append('candidate.presented', { id: 'source-node:P1:K_A', sourceId: 'P1:K_A' });
  assert.throws(() => badStore.append('candidate.frontier.set', {
    candidateRefs: ['source-node:P1:K_A'],
    requiredExactDiseaseCandidateRefs: ['source-node:P1:K_A', 'source-node:P1:K_B'],
    exactDiseaseNames: ['子宫肌瘤'],
  }), /recall completeness invariant/);
});

test('Clinical Semantics: source-authored stage/condition/sequence remain separate from composition', () => {
  const doc = p1Doc('P1:STAGE', '产后病', '气虚血瘀');
  doc.stageGuidance = ['急性阶段先处理失血'];
  doc.conditionalGuidance = ['证情缓解后再随证施治'];
  doc.sequence = [{ order: 1, instruction: '先处理急性阶段' }, { order: 2, instruction: '再随当前证施治', transition: '证情缓解' }];
  doc.formulas[0]!.stageGuidance = ['本方用于缓解后阶段'];
  doc.formulas[0]!.conditionalGuidance = ['当前状态符合时采用'];
  doc.formulas[0]!.sequence = [{ order: 1, instruction: '阶段二方' }];
  const set = hydrateSourceFormulaSetForCandidate([doc], {
    id: 'source-node:P1:STAGE', sourceId: 'P1:STAGE', sourceKind: 'P1_NORMATIVE_SOURCE', sourceAuthority: 'P1',
  });
  assert.ok(set);
  assert.equal(set.formulas[0]!.composition, '药A、药B');
  assert.deepEqual(set.stageGuidance, ['急性阶段先处理失血']);
  assert.equal(set.sequence?.[1]?.transition, '证情缓解');
  assert.deepEqual(set.formulas[0]!.stageGuidance, ['本方用于缓解后阶段']);

  assert.deepEqual(normalizeSourceTextList(['A', { statement: 'B' }]), ['A', 'B']);
  assert.deepEqual(normalizeSourceSequence([{ order: 2, instruction: '后' }, { order: 1, instruction: '先' }]).map((x) => x.instruction), ['先', '后']);
});
