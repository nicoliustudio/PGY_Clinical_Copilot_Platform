import test from 'node:test';
import assert from 'node:assert/strict';
import { splitInlineFormulaModification } from '../src/knowledge/source-normalization.js';
import { executionClearance } from '../src/platform/authority/execution-clearance.js';
import { materializeSourceBoundAssets } from '../src/platform/commit/source-bound-core.js';
import { createClinicalWorkspace, ClinicalWorkspaceStore } from '../src/platform/workspace/clinical-workspace.js';
import { workspaceEventsForTool } from '../src/adapters/ai-sdk/workspace-events.js';
import { formulaSelectionReady, missingFocusedFormulaEvidence } from '../src/clinical/formula-selection.js';
import { bindCanonicalSources } from '../src/clinical/source-binding.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { CapabilityDeliveryObligation } from '../src/contracts/capability.js';

test('canonical ingestion splits inline 加减 into formula-local ownership', () => {
  const parsed = splitInlineFormulaModification('桂枝6克，茯苓10克。加减：包块大，加鳖甲；肌肤甲错，加三棱。');
  assert.equal(parsed.composition, '桂枝6克，茯苓10克');
  assert.equal(parsed.presence, 'PRESENT');
  assert.deepEqual(parsed.modifications, ['包块大，加鳖甲；肌肤甲错，加三棱']);
  assert.equal(parsed.composition.includes('加减'), false);
});

test('complete raw composition without inline modification becomes explicit KNOWN_EMPTY', () => {
  const parsed = splitInlineFormulaModification('桂枝6克，茯苓10克。');
  assert.equal(parsed.presence, 'KNOWN_EMPTY');
  assert.deepEqual(parsed.modifications, []);
});

test('delivery and clinical execution timing are independent', () => {
  assert.equal(executionClearance({ status: 'PASS', reviewRequired: false, reasons: [] }, 'CURRENTLY_SUITABLE'), 'CLEARED');
  assert.equal(executionClearance({ status: 'PASS', reviewRequired: false, reasons: [] }, 'DEFERRED'), 'REVIEW_REQUIRED');
  assert.equal(executionClearance({ status: 'PASS', reviewRequired: false, reasons: [] }, 'CURRENTLY_NOT_SUITABLE'), 'BLOCKED');
});

test('SOURCE_BOUND preserves canonical payload while TREAT_FIRST_THEN_FORM becomes DEFERRED, not missing source', () => {
  const obligation: CapabilityDeliveryObligation = {
    id: 'gaofang-delivery',
    requiredArtifact: 'treatmentFormDecision',
    requiredFields: ['outcome', 'form', 'disposition', 'statement', 'sourceEvidenceRefs'],
    materialization: 'SOURCE_BOUND',
    sourceRequiredFields: ['asset_id', 'content_hash', 'composition.raw'],
  };
  const asset = {
    asset_id: 'GF-001',
    content_hash: 'hash-1',
    title: '肺结核病膏方',
    composition: { raw: '原始完整膏方' },
    usage: '原始用法',
  };
  const result = materializeSourceBoundAssets({
    obligation,
    outcome: 'modality:gaofang',
    decision: {
      outcome: 'modality:gaofang',
      form: '膏方',
      disposition: 'TREAT_FIRST_THEN_FORM',
      statement: '临床上先处理当前问题后再使用',
      sourceEvidenceRefs: ['GF-001'],
    },
    boundRefs: ['GF-001'],
    hydratedRefs: new Set(['GF-001']),
    resolveAsset: () => asset,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.clinicalApplicability, 'DEFERRED');
  assert.equal(result.sourceBundle.products.length, 1);
  assert.deepEqual(result.sourceBundle.products[0]?.payload, asset);
  assert.equal(result.sourceBundle.products[0]?.qualification, 'PRIMARY_SELECTED');
  assert.equal((result.product as Record<string, unknown>).statement, undefined);
});

test('sibling formula evidence identity is candidate-scoped and closes the whole focused frontier', () => {
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'test-run');
  const a = 'P1:K_PARENT::F_A';
  const b = 'P1:K_PARENT::F_B';
  store.append('candidate.presented', { id: a, kind: 'formula', sourceId: 'P1:K_PARENT', formulaId: 'F_A', label: 'A' });
  store.append('candidate.presented', { id: b, kind: 'formula', sourceId: 'P1:K_PARENT', formulaId: 'F_B', label: 'B' });
  store.append('candidate.focused', { id: a });
  store.append('candidate.focused', { id: b });

  const ea = workspaceEventsForTool('formula.get_evidence', { candidateRef: a }, { sourceId: 'P1:K_PARENT', formulaId: 'F_A', formulaName: 'A' });
  const eb = workspaceEventsForTool('formula.get_evidence', { candidateRef: b }, { sourceId: 'P1:K_PARENT', formulaId: 'F_B', formulaName: 'B' });
  store.appendBatch([...ea, ...eb]);

  const ids = ws.evidenceState.evidenceItems.map((item) => item.id);
  assert.deepEqual(ids.sort(), [`formula-evidence:${a}`, `formula-evidence:${b}`].sort());
  assert.deepEqual(missingFocusedFormulaEvidence(ws), []);
  assert.equal(formulaSelectionReady(ws), true);
});

test('generic knowledge.search cannot manufacture selectable formula candidates', () => {
  const events = workspaceEventsForTool('knowledge.search', { query: '子宫肌瘤' }, [{
    sourceId: 'P1:K_460013ecebf1',
    kind: 'normative',
    knowledgeRole: 'NORMATIVE_TREATMENT',
    formulas: [{ id: 'F1' }],
    title: '子宫肌瘤｜气滞血瘀',
    text: '证据',
  }]);
  assert.equal(events.some((event) => event.type === 'candidate.presented'), false);
  assert.equal(events.some((event) => event.type === 'evidence.added'), true);
});

test('CommitCoordinator records DELIVERED + DEFERRED + REVIEW_REQUIRED as independent axes', async () => {
  const { CommitCoordinator } = await import('../src/platform/commit/commit-coordinator.js');
  const { CommitLedger } = await import('../src/platform/commit/commit-ledger.js');
  const { CandidateHandleRegistry } = await import('../src/platform/commit/candidate-handle-registry.js');
  const coordinator = new CommitCoordinator(new CandidateHandleRegistry(), new CommitLedger());
  const result = await coordinator.commit(
    { outcome: 'modality:gaofang', sourceBound: true },
    {
      safety: { status: 'PASS', reviewRequired: false, reasons: [] },
      readReasoningProduct: () => undefined,
      validateDelivery: () => ({ ok: false, code: 'NO_PROVIDER' }),
      hydrateCanonicalCandidate: async () => ({ ok: false, code: 'CANONICAL_HYDRATION_FAILED' }),
      hydrateSourceBoundProduct: () => ({
        ok: true,
        providerId: 'gaofang',
        product: { outcome: 'modality:gaofang' },
        sourceBundle: { sourceId: 'GF-001', products: [], sourceFacts: {} },
        sourceRefs: ['GF-001'],
        clinicalApplicability: 'DEFERRED',
      }),
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.deliveryStatus, 'DELIVERED');
  assert.equal(result.record.clinicalApplicability, 'DEFERRED');
  assert.equal(result.record.executionClearance, 'REVIEW_REQUIRED');
});


test('source.bind is the only transaction that creates durable SOURCE_BOUND membership', () => {
  const ws = createClinicalWorkspace();
  ws.capabilityEvidenceReceipts = {
    acupuncture: {
      scope: 'acupuncture',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
  };
  const store = new ClinicalWorkspaceStore(ws, 'bind-run');
  const context = {
    workspace: ws,
    workspaceStore: store,
    knowledgeScopes: ['acupuncture'],
    capabilities: [{
      id: 'tcm.external-therapy',
      confidence: 1,
      reason: 'test',
      provides: ['modality:acupuncture'],
      knowledgeScopes: ['acupuncture'],
      evidenceObligations: [{
        id: 'treatment-evidence', evidenceType: 'asset',
        discoveryToolIds: ['knowledge.search_cards'], hydrationToolIds: ['knowledge.get_asset'],
      }],
      deliveryObligations: [{
        id: 'treatment-delivery', requiredArtifact: 'treatmentFormDecision', materialization: 'SOURCE_BOUND',
        dependsOnEvidenceObligationIds: ['treatment-evidence'],
      }],
    }],
  } as unknown as RuntimeContext;

  const result = bindCanonicalSources(
    context,
    'modality:acupuncture',
    ['AC-049'],
    () => ({ asset_id: 'AC-049', content_hash: 'hash-ac049', protocol: { points: ['三阴交'] } }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reused, false);
  assert.deepEqual(result.receipt.assetRefs, ['AC-049']);
  assert.deepEqual(result.receipt.contentHashes, { 'AC-049': 'hash-ac049' });
  assert.deepEqual(ws.sourceBindingReceipts?.['modality:acupuncture']?.assetRefs, ['AC-049']);

  const reused = bindCanonicalSources(
    context,
    'modality:acupuncture',
    ['AC-049'],
    () => ({ asset_id: 'AC-049', content_hash: 'hash-ac049' }),
  );
  assert.equal(reused.ok, true);
  if (reused.ok) assert.equal(reused.reused, true);
});

test('formula.select preserves N source siblings from one source-node candidate and materializes matched patient-specific ADD rules', async () => {
  const { selectCanonicalFormula } = await import('../src/clinical/formula-selection-transaction.js');
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'formula-select-run');
  const candidateRef = 'source-node:P1:K_PARENT';
  const productRefs = ['P1:K_PARENT::F1', 'P1:K_PARENT::F2', 'P1:K_PARENT::F3'];
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: [{
      candidateRef,
      formulaId: 'F1',
      formulaName: '方一',
      sourceId: 'P1:K_PARENT',
      sourceTier: 'P1',
      sourceAuthority: 'P1',
      sourceKind: 'P1_NORMATIVE_SOURCE',
      selectionUnit: 'SOURCE_NODE',
      sourceProductRefs: productRefs,
      sourceProductNames: ['方1', '方2', '方3'],
      sourceProductCount: 3,
    }],
    hydratedEvidence: [{
      candidateRef,
      evidence: { sourceId: 'P1:K_PARENT', sourceTier: 'P1', formulaId: 'F1', formulaName: '方一' },
    }],
  }));

  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef,
    candidateDecisions: [{ candidateRef, disposition: 'CONSIDERED', rationale: 'best source-node fit' }],
  }, {
    loadIndex: async () => ({ docs: [] } as never),
    hydrateSourceFormulaSet: () => ({
      parentRecordRef: 'P1:K_PARENT',
      disease: '测试病',
      syndrome: '测试证',
      treatmentMethod: '测试治法',
      completeness: 'COMPLETE',
      sourceLevelModifications: ['病证共享加减'],
      sourceLevelModificationPresence: 'PRESENT',
      formulas: productRefs.map((ref, index) => ({
        formulaRef: ref,
        formulaId: `F${index + 1}`,
        formulaName: `方${index + 1}`,
        composition: `组成${index + 1}`,
        compositionPresence: 'PRESENT',
        sourceModifications: index === 0 ? ['方内加减'] : [],
        formulaLocalModificationPresence: index === 0 ? 'PRESENT' : 'KNOWN_EMPTY',
        modificationStatus: index === 0 ? 'PRESENT' : 'KNOWN_EMPTY',
        relation: index === 0 ? 'PRIMARY_SELECTED' : 'SOURCE_ALTERNATIVE',
        applicableModifications: [],
      })),
    }),
    searchModificationEvidence: () => ({
      result: 'FOUND',
      candidates: [{
        modificationEvidenceRef: 'MR-1',
        trigger: '腹痛',
        matchedPatientEvidenceRefs: ['CF-1'],
        medication: '延胡索',
        dose: '10克',
        sourceRef: 'RULE-SOURCE',
      }],
    }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sourceFormulaCount, 3);
  assert.equal(result.modificationState, 'PRESENT');
  assert.equal(ws.sourceFormulaSet?.formulas.length, 3);
  assert.equal(ws.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef, candidateRef);
  assert.equal(ws.clinicalDecisionSpine.formulaSelection?.selectedSourceRef, 'P1:K_PARENT');
  assert.equal(ws.clinicalDecisionSpine.formulaSelection?.primaryFormulaRef, 'P1:K_PARENT::F1');
  assert.deepEqual(ws.clinicalDecisionSpine.modificationPlan?.items, [{
    statement: '延胡索 10克',
    patientEvidenceRefs: ['CF-1'],
    sourceEvidenceRefs: ['MR-1', 'RULE-SOURCE'],
  }]);
  assert.equal(ws.modificationEvidenceClosure?.status, 'FOUND');
});

test('formula.select fails closed before durable selection when modification rule storage is unavailable', async () => {
  const { selectCanonicalFormula } = await import('../src/clinical/formula-selection-transaction.js');
  const ws = createClinicalWorkspace();
  const store = new ClinicalWorkspaceStore(ws, 'formula-select-unavailable');
  const candidateRef = 'source-node:P1:K_PARENT';
  store.appendBatch(workspaceEventsForTool('formula.search_candidates', { topK: 5 }, {
    candidates: [{
      candidateRef, formulaId: 'F1', formulaName: '方1', sourceId: 'P1:K_PARENT', sourceTier: 'P1',
      sourceAuthority: 'P1', sourceKind: 'P1_NORMATIVE_SOURCE', selectionUnit: 'SOURCE_NODE',
      sourceProductRefs: ['P1:K_PARENT::F1'], sourceProductNames: ['方1'], sourceProductCount: 1,
    }],
    hydratedEvidence: [{ candidateRef, evidence: { sourceId: 'P1:K_PARENT', sourceTier: 'P1', formulaId: 'F1', formulaName: '方1' } }],
  }));

  const context = { workspace: ws, workspaceStore: store } as unknown as RuntimeContext;
  const result = await selectCanonicalFormula(context, {
    candidateRef,
    candidateDecisions: [{ candidateRef, disposition: 'CONSIDERED' }],
  }, {
    loadIndex: async () => ({ docs: [] } as never),
    hydrateSourceFormulaSet: () => ({
      parentRecordRef: 'P1:K_PARENT', disease: '测试病', syndrome: '测试证', treatmentMethod: '测试治法',
      completeness: 'COMPLETE', sourceLevelModifications: [], sourceLevelModificationPresence: 'KNOWN_EMPTY',
      formulas: [{
        formulaRef: 'P1:K_PARENT::F1', formulaId: 'F1', formulaName: '方1', composition: '组成', compositionPresence: 'PRESENT',
        sourceModifications: [], formulaLocalModificationPresence: 'KNOWN_EMPTY', modificationStatus: 'KNOWN_EMPTY',
        relation: 'PRIMARY_SELECTED', applicableModifications: [],
      }],
    }),
    searchModificationEvidence: () => ({ result: 'UNAVAILABLE', candidates: [], reason: 'rule store missing' }),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'MODIFICATION_EVIDENCE_UNAVAILABLE');
  assert.equal(ws.sourceFormulaSet, undefined);
  assert.equal(ws.clinicalDecisionSpine.formulaSelection, undefined);
  assert.equal(ws.clinicalDecisionSpine.modificationPlan, undefined);
});

test('workspace.record_deliberation cannot bypass frontier authority with focusedCandidates', () => {
  const events = workspaceEventsForTool(
    'workspace.record_deliberation',
    { focusedCandidates: ['P1:K_PARENT::F1'] },
    { accepted: true, updatedArtifacts: [] },
  );
  assert.equal(events.some((event) => event.type === 'candidate.focused'), false);
});
