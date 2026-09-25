import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityDescriptor } from '../src/contracts/capability.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { ClinicalRequestIR, FormulaCardinality } from '../src/control-plane-v2/types.js';
import { normalizeClinicalRequestIR } from '../src/control-plane-v2/request-ir.js';
import { RuntimePreparer } from '../src/platform/runtime/runtime-preparer.js';
import { CapabilityRegistry } from '../src/platform/registry/capability-registry.js';
import { SkillRegistry } from '../src/platform/registry/skill-registry.js';
import { ToolRegistry } from '../src/platform/registry/tool-registry.js';
import { RiskHypothesisSafetyPort } from '../src/platform/authority/risk-safety-port.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import {
  BASELINE_KNOWLEDGE_SCOPES,
  BASELINE_SKILL_IDS,
  BASELINE_TOOL_IDS,
  PLATFORM_TOOLS,
} from '../src/composition/platform-assets.js';
import { CONTROL_PLANE_V21_POLICY } from '../src/composition/control-plane-v21-policy.js';
import { discoverCapabilityManifests, loadSkills } from '../src/composition/load-assets.js';
import { projectControlPlaneV21Surface } from '../src/adapters/ai-sdk/agent-runtime.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS } from '../src/adapters/ai-sdk/tool-bindings.js';
import { evaluateProposalReadiness } from '../src/platform/workspace/proposal-readiness.js';
import { projectFormulaSet } from '../src/control-plane-v2/result-projection.js';
import { structuralGraphV21 } from '../src/platform/control-plane/control-plane-v21-session.js';
import {
  admissibleEffects,
  applyEvidenceNeedBlocker,
  notDeliverableOutcomes,
  refreshControlPlaneV21,
  runnableObligations,
  unmetObligationsV21,
} from '../src/platform/control-plane/control-plane-v21-session.js';
import type { ObligationNodeV21 } from '../src/control-plane-v21/types.js';
import { stubRequestCompiler } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function manifest(id: string): CapabilityDescriptor {
  return JSON.parse(readFileSync(join(root, `capabilities/${id}/capability.json`), 'utf8')) as CapabilityDescriptor;
}

function request(required: string[], overrides: {
  exclusive?: boolean;
  excluded?: string[];
  formulaCardinality?: FormulaCardinality;
  knowledgeSource?: 'KB_ONLY' | 'KB_PREFERRED' | 'MODEL_ALLOWED';
} = {}): ClinicalRequestIR {
  return normalizeClinicalRequestIR({
    version: 1,
    goal: 'treatment',
    outcomes: {
      required,
      preferred: [],
      excluded: overrides.excluded ?? [],
      exclusive: overrides.exclusive ?? false,
    },
    outputPolicy: { formulaCardinality: overrides.formulaCardinality ?? { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: overrides.knowledgeSource ?? 'KB_PREFERRED' },
    hardConstraints: [],
    preferences: [],
  });
}

async function prepareContext(
  requestIR: ClinicalRequestIR,
  extraCapabilities: CapabilityDescriptor[] = [],
): Promise<RuntimeContext> {
  const manifests = [...(await discoverCapabilityManifests()), ...extraCapabilities];
  const capabilities = new CapabilityRegistry(manifests);
  const skills = new SkillRegistry(await loadSkills([...manifests.flatMap((m) => m.skillIds), ...BASELINE_SKILL_IDS]));
  const tools = new ToolRegistry(PLATFORM_TOOLS);
  const preparer = new RuntimePreparer({
    understanding: {
      understand: async () => ({
        interaction: { mode: 'clinical' as const },
        facts: [],
        intents: [],
        risks: [],
        informationGaps: [],
        capabilityNeeds: [],
        uncertainties: [],
      }),
    },
    safety: new RiskHypothesisSafetyPort(),
    planner: { plan: async () => emptyClinicalStrategy() },
    capabilities,
    skills,
    tools,
    model: { id: 'test:control-plane' },
    baselineToolIds: BASELINE_TOOL_IDS,
    baselineSkillIds: BASELINE_SKILL_IDS,
    baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
    controlPlane: { compiler: stubRequestCompiler(requestIR), policy: CONTROL_PLANE_V21_POLICY },
  });
  return preparer.prepare('test-input', 'run-control-plane-test');
}

/** 关闭 Minimum Clinical Core（使 core 义务可满足）。 */
function satisfyClinicalCore(context: RuntimeContext): void {
  const spine = context.workspace.clinicalDecisionSpine;
  spine.clinicalQuestion = { statement: 'q', version: 1 };
  spine.diseaseAssessment = { statement: 'd', evidenceRefs: ['P1:x'], version: 1 };
  spine.patternHypothesisRefs = ['h1'];
  spine.patternAssessmentRef = 'h1';
  spine.treatmentPlan = { primaryPrinciple: '治法', treatmentTarget: '靶点', evidenceRefs: ['P1:x'], version: 1 };
}

/** 产生一条诊断知识证据（关闭 diagnostic-evidence 义务）。 */
function satisfyDiagnosticEvidence(context: RuntimeContext): void {
  context.workspace.evidenceState.evidenceItems.push({
    id: 'E1',
    sourceRef: 'P1:std',
    sourceType: 'knowledge',
    relatedCandidates: [],
    supportingSignals: [],
    contradictingSignals: [],
  });
}

function satisfyFormulaEvidence(context: RuntimeContext): void {
  context.workspace.candidates.push({
    id: 'source-node:P1:x', kind: 'formula', formulaId: 'F1', sourceId: 'P1:x',
    sourceAuthority: 'P1', sourceKind: 'P1_NORMATIVE_SOURCE', selectionUnit: 'SOURCE_NODE',
  });
  context.workspace.evidenceState.evidenceItems.push({
    id: 'formula-evidence:source-node:P1:x',
    sourceRef: 'P1:x', sourceType: 'P1', relatedCandidates: ['source-node:P1:x'],
    supportingSignals: [], contradictingSignals: [],
  });
  context.workspace.deliberationState.frontier = ['source-node:P1:x'];
  context.workspace.candidateSetReceipt = {
    candidateRefs: ['source-node:P1:x'],
    evidenceBindings: [{
      candidateRef: 'source-node:P1:x',
      evidenceRefs: ['formula-evidence:source-node:P1:x'],
      sourceRefs: ['P1:x'],
    }],
    workspaceVersion: 1,
  };
}

function nodeOf(context: RuntimeContext, type: string, outcome?: string): ObligationNodeV21 | undefined {
  return context.controlPlaneV21!.graph.nodes.find(
    (n) => n.target.type === type && (outcome === undefined || n.target.qualifiers.outcome === outcome),
  );
}

function commitOutcome(context: RuntimeContext, outcome: string, providerId: string): void {
  context.commitLedger.append({
    outcome,
    semanticIdentity: outcome,
    providerId,
    deliveryStatus: 'DELIVERED',
    executionClearance: 'CLEARED',
    provenance: { kind: 'MODEL_DERIVED', sourceRefs: [], providerId },
    product: { outcome },
  });
  refreshControlPlaneV21(context);
}

const ALL_INTERNAL_TOOLS = [...BASELINE_TOOL_IDS];

// ---------------------------------------------------------------------------
// Phase 2 / 3：Request IR → generic obligation graph（无 modality 分支）
// ---------------------------------------------------------------------------

test('只针灸：exclusive Request IR 只产生针灸交付义务，不产生方剂义务', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  assert.equal(context.controlPlaneV21!.compileStatus, 'COMPILED');
  assert.equal(nodeOf(context, 'artifact:clinical-core') !== undefined, true);
  assert.equal(nodeOf(context, 'artifact:diagnostic-evidence') !== undefined, true);
  assert.equal(nodeOf(context, 'artifact:treatment-evidence', 'modality:acupuncture') !== undefined, true);
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture') !== undefined, true);
  assert.equal(nodeOf(context, 'artifact:formula-selection') !== undefined, false);
  assert.equal(nodeOf(context, 'artifact:formula-evidence') !== undefined, false);
  assert.deepEqual(context.controlPlaneV21!.graph.issues, []);
});

test('只针灸：初始 action surface 只有诊断/针灸取证工具，方剂工具被收口', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  const internals = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(internals.includes('knowledge.search'));
  assert(internals.includes('knowledge.get_source'));
  assert(internals.includes('knowledge.search_cards'));
  assert(!internals.includes('knowledge.get_asset'), 'hydration should stay closed until discovery produced an asset');
  assert(!internals.includes('formula.search_candidates'));
  assert(!internals.includes('formula.get_evidence'));
  assert(!internals.includes('formula.validate'));
});

test('针灸+膏方：共享同一个 clinical-core，且交付义务互相独立', async () => {
  const context = await prepareContext(request(['modality:acupuncture', 'modality:gaofang']));
  const graph = context.controlPlaneV21!.graph;
  assert.equal(graph.nodes.filter((n) => n.target.type === 'artifact:clinical-core').length, 1);
  assert.equal(graph.nodes.filter((n) => n.target.type === 'artifact:treatment-delivery').length, 2);
  assert.equal(graph.nodes.filter((n) => n.target.type === 'artifact:treatment-evidence').length, 2);
  assert.deepEqual(graph.issues, []);
});

test('V2.1.1 provider 由 graph 确定性激活，capability discover/activate 不再进入执行面', async () => {
  const context = await prepareContext(request(['modality:acupuncture', 'modality:gaofang']));
  assert(context.capabilities.some((c) => c.id === 'tcm.core'));
  assert(context.capabilities.some((c) => c.id === 'tcm.external-therapy'));
  assert(context.capabilities.some((c) => c.id === 'gaofang'));
  const surface = projectControlPlaneV21Surface(context, [...ALL_INTERNAL_TOOLS, 'capability.discover', 'capability.activate']);
  assert(!surface.includes('capability.discover'));
  assert(!surface.includes('capability.activate'));
});

test('V2.1.1 discovery→hydration 是单向状态推进：发现资产后关闭重复 search_cards', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  let surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(surface.includes('knowledge.search_cards'));
  assert(!surface.includes('knowledge.get_asset'));
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': [] },
    },
  };
  surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(!surface.includes('knowledge.search_cards'));
  assert(surface.includes('knowledge.get_asset'));
});

test('V2.1.1 发现资产全部水合后关闭 get_asset：不允许 hydrate→hydrate 无状态循环', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
  };
  refreshControlPlaneV21(context);
  const surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(!surface.includes('knowledge.get_asset'), '义务已 terminal 时 hydration 不可能再推进状态');
  assert(!surface.includes('knowledge.search_cards'), '已 discovery 的义务不得重复 discovery');
});

test('V2.1.1 多证据义务：一条待水合不得饿死另一条的 discovery', async () => {
  const context = await prepareContext(request(['modality:acupuncture', 'modality:gaofang']));
  context.workspace.capabilityEvidenceReceipts = {
    // gaofang 已发现未水合（sort 在前的义务）→ 只有 hydration 能前进。
    gaofang: {
      scope: 'gaofang',
      discoveryByTool: { 'knowledge.search_cards': ['GF-013'] },
      hydrationByTool: { 'knowledge.get_asset': [] },
    },
    // tcm.external-therapy 尚未 discovery → 只有 discovery 能前进。
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: {},
      hydrationByTool: {},
    },
  };
  refreshControlPlaneV21(context);
  const surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(surface.includes('knowledge.get_asset'), '待水合义务仍需要 hydration');
  assert(surface.includes('knowledge.search_cards'), '尚未 discovery 的义务不得被另一义务的待水合状态关闭');
});

test('精确 closure：针灸交付完成不会关闭膏方交付', async () => {
  const context = await prepareContext(request(['modality:acupuncture', 'modality:gaofang']));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  // 两个能力都被激活，但只有针灸取得证据并完成交付。
  context.harness.activateCapability('tcm.external-therapy', 'test');
  context.harness.activateCapability('gaofang', 'test');
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
    gaofang: { scope: 'gaofang', discoveryByTool: {}, hydrationByTool: {} },
  };
  context.workspace.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: 'p',
    treatmentTarget: 't',
    evidenceRefs: [],
    treatmentFormDecision: { outcome: 'modality:acupuncture', form: 'acupuncture', disposition: 'CURRENTLY_SUITABLE', statement: 's', sourceEvidenceRefs: ['AC-049'], details: { points: ['合谷'], operation: '平补平泻', frequency: '每日1次', course: '10次' } },
    version: 1,
  };
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:treatment-evidence', 'modality:acupuncture')!.status, 'SATISFIED');
  assert.equal(nodeOf(context, 'artifact:treatment-evidence', 'modality:gaofang')!.status, 'OPEN');
  assert.equal(nodeOf(context, 'artifact:treatment-draft', 'modality:acupuncture')!.status, 'SATISFIED');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'OPEN', 'Workspace draft must not close terminal delivery');
  commitOutcome(context, 'modality:acupuncture', 'tcm.external-therapy');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'SATISFIED');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:gaofang')!.status, 'OPEN');
  const unmet = unmetObligationsV21(context.controlPlaneV21!);
  assert.equal(unmet.length > 0, true);
  assert(unmet.every((n) => n.target.qualifiers.outcome !== 'modality:acupuncture'));
});

test('V2.1.1 多治疗 delivery 可同时关闭针灸与膏方两个独立义务', async () => {
  const context = await prepareContext(request(['modality:acupuncture', 'modality:gaofang']));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
    gaofang: {
      scope: 'gaofang',
      discoveryByTool: { 'knowledge.search_cards': ['GF-013'] },
      hydrationByTool: { 'knowledge.get_asset': ['GF-013'] },
    },
  };
  context.workspace.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: 'p', treatmentTarget: 't', evidenceRefs: [], version: 1,
    treatmentDeliveries: [
      { outcome: 'modality:acupuncture', form: 'acupuncture', disposition: 'CURRENTLY_SUITABLE', statement: 'a', sourceEvidenceRefs: ['AC-049'], details: { points: ['合谷'], operation: '平补平泻', frequency: '每日1次', course: '10次' } },
      { outcome: 'modality:gaofang', form: 'gaofang', disposition: 'CURRENTLY_SUITABLE', statement: 'g', sourceEvidenceRefs: ['GF-013'], advisoryComposition: ['阿胶', '鹿角胶'], preparation: '炼蜜收膏', usage: '每日一勺，温水冲服' },
    ],
  };
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:treatment-draft', 'modality:acupuncture')!.status, 'SATISFIED');
  assert.equal(nodeOf(context, 'artifact:treatment-draft', 'modality:gaofang')!.status, 'SATISFIED');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'OPEN');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:gaofang')!.status, 'OPEN');
  commitOutcome(context, 'modality:acupuncture', 'tcm.external-therapy');
  commitOutcome(context, 'modality:gaofang', 'gaofang');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'SATISFIED');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:gaofang')!.status, 'SATISFIED');
});

test('交付 artifact 不含 outcome 时 fail-closed：一个通用 artifact 不得同时关闭多个交付义务', async () => {
  const context = await prepareContext(request(['modality:acupuncture', 'modality:gaofang']));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  context.harness.activateCapability('tcm.external-therapy', 'test');
  context.harness.activateCapability('gaofang', 'test');
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
    gaofang: {
      scope: 'gaofang',
      discoveryByTool: { 'knowledge.search_cards': ['GF-013'] },
      hydrationByTool: { 'knowledge.get_asset': ['GF-013'] },
    },
  };
  // 未声明 outcome：两个交付义务都不得被判为 DELIVERED。
  context.workspace.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: 'p',
    treatmentTarget: 't',
    evidenceRefs: [],
    treatmentFormDecision: { form: '膏方', disposition: 'CURRENTLY_SUITABLE', statement: 's', sourceEvidenceRefs: ['GF-013'] },
    version: 1,
  };
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'OPEN');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:gaofang')!.status, 'OPEN');
});

test('artifact before phase：prerequisite 未 terminal 时 final artifact 不得关闭义务', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  // 直接把 final delivery artifact 写入，但 treatment-evidence / clinical-core 均未取得。
  context.harness.activateCapability('tcm.external-therapy', 'test');
  context.workspace.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: 'p',
    treatmentTarget: 't',
    evidenceRefs: [],
    treatmentFormDecision: { outcome: 'modality:acupuncture', form: 'acupuncture', disposition: 'CURRENTLY_SUITABLE', statement: 's', sourceEvidenceRefs: [] },
    version: 1,
  };
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'OPEN');
  assert.equal(nodeOf(context, 'artifact:treatment-evidence', 'modality:acupuncture')!.status, 'OPEN');
});

test('KB 不足：SEARCHED_NONE 使交付合法终结为 NOT_DELIVERABLE，且不阻塞完成', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  context.harness.activateCapability('tcm.external-therapy', 'test');
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': [] },
      hydrationByTool: {},
    },
  };
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:treatment-evidence', 'modality:acupuncture')!.status, 'NOT_DELIVERABLE');
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'NOT_DELIVERABLE');
  assert.deepEqual(unmetObligationsV21(context.controlPlaneV21!), []);
  assert.deepEqual(notDeliverableOutcomes(context.controlPlaneV21!), ['modality:acupuncture']);
});

test('typed blocker 是重新打开检索的唯一通道，且只重开定向检索', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  context.harness.activateCapability('tcm.external-therapy', 'test');
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
  };
  refreshControlPlaneV21(context);
  // 取证已完成 → broad treatment discovery 收口。
  const before = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(!before.includes('knowledge.search_cards'));
  assert(!before.includes('knowledge.search'));

  const runnable = runnableObligations(context.controlPlaneV21!);
  const synthesis = runnable.find((n) => n.allowedEffects.some((e) => e.op === 'commit'));
  assert(synthesis !== undefined);
  assert.equal(applyEvidenceNeedBlocker(context.controlPlaneV21!, context.workspace, synthesis!.id, 'need discrimination'), true);
  refreshControlPlaneV21(context);

  const after = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(after.includes('knowledge.search'), 'typed blocker 应重开定向检索');
  assert(!after.includes('knowledge.search_cards'), 'typed blocker 不得重开 treatment discovery');
  assert(!after.includes('formula.search_candidates'));
  const admissible = admissibleEffects(context.controlPlaneV21!);
  assert(admissible.some((e) => e.target?.type === 'artifact:evidence-gap'));
});

test('V2.1.1 typed blocker 只增加定向取证义务，不得移除父义务的 commit effect（死锁回归）', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
  };
  refreshControlPlaneV21(context);
  const delivery = nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!;
  assert.equal(delivery.status, 'OPEN');
  assert.equal(applyEvidenceNeedBlocker(context.controlPlaneV21!, context.workspace, delivery.id, 'need discrimination'), true);
  refreshControlPlaneV21(context);

  // blocker 生效：父义务仍然可执行（commit 面保留），同时定向检索打开。
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'OPEN');
  const surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(surface.includes('workspace.commit_clinical_model'), 'typed blocker 不得删除父义务自身的 commit effect');
  assert(surface.includes('knowledge.search'), 'typed blocker 应同时重开定向检索');
  assert.equal(runnableObligations(context.controlPlaneV21!).some((n) => n.target.type === 'artifact:evidence-gap'), true);
  // 未放宽提交约束：义务未 terminal 时 readiness 仍阻断。
  assert.equal(evaluateProposalReadiness(context).ready, false);

  // 定向取证到达（新证据）→ gap 关闭、blocker 释放。
  context.workspace.evidenceState.evidenceItems.push({
    id: 'E2', sourceRef: 'P1:x2', sourceType: 'knowledge',
    relatedCandidates: [], supportingSignals: [], contradictingSignals: [],
  });
  refreshControlPlaneV21(context);
  const released = nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!;
  assert.equal(released.blocker, undefined);
  assert.equal(context.controlPlaneV21!.graph.nodes.some((n) => n.source === 'blocker'), false);
});

test('V2.1.1 一次调用内补齐 clinical core 并写 delivery 不得被整体拒绝（闭合仍由 artifact-before-phase 把关）', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  satisfyDiagnosticEvidence(context);
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
  };
  refreshControlPlaneV21(context);
  // core 未 terminal → delivery 义务此刻不可执行；但同一次调用补齐 core + 写 delivery 是合法原子写。
  assert.equal(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture')!.status, 'OPEN');
  const factory = DEFAULT_AI_SDK_TOOL_BINDINGS['workspace.record_deliberation'];
  const tool = factory(context) as unknown as { execute: (input: unknown) => Promise<unknown> };
  await tool.execute({
    diseaseAssessment: { statement: 'd', evidenceRefs: ['P1:x'] },
    patternAssessment: { primary: { statement: 'p', supportingEvidenceRefs: ['E1'] } },
    treatmentPlan: {
      primaryPrinciple: 'p',
      treatmentTarget: 't',
      evidenceRefs: ['P1:x'],
      treatmentDeliveries: [{
        form: 'acupuncture',
        disposition: 'CURRENTLY_SUITABLE',
        statement: 's',
        sourceEvidenceRefs: ['AC-049'],
        outcome: 'modality:acupuncture',
      }],
    },
  });
  // 未抛错即为通过：该 payload 是合法的原子 durable 写（闭合由 artifact-before-phase 把关）。
});

test('V2.1.1 声明契约外的 delivery outcome 必须 fail-closed（不得静默写入不可归属交付）', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  satisfyDiagnosticEvidence(context);
  refreshControlPlaneV21(context);
  const factory = DEFAULT_AI_SDK_TOOL_BINDINGS['workspace.commit_clinical_model'];
  const tool = factory(context) as unknown as { execute: (input: unknown) => Promise<unknown> };
  await assert.rejects(() => tool.execute({
    diseaseAssessment: { statement: 'd', evidenceRefs: ['P1:x'] },
    patternAssessment: { primary: { statement: 'p', supportingEvidenceRefs: ['E1'] } },
    treatmentPlan: {
      primaryPrinciple: 'p',
      treatmentTarget: 't',
      evidenceRefs: [],
      treatmentDeliveries: [{
        form: 'acupuncture',
        disposition: 'CURRENTLY_SUITABLE',
        statement: 's',
        sourceEvidenceRefs: [],
        outcome: 'outcome:modality:acupuncture',
      }],
    },
  }), /unknown treatment delivery outcome/);
});

test('新增一个全新 modality 只需 manifest 数据，planner 无业务分支', async () => {
  const base = manifest('tcm.external-therapy');
  const clone: CapabilityDescriptor = JSON.parse(JSON.stringify(base));
  clone.id = 'demo.cupping';
  clone.displayName = 'Cupping Demo';
  clone.provides = ['modality:cupping'];
  for (const rule of clone.controlPlaneV21?.rules ?? []) {
    if (rule.forOutcomes) rule.forOutcomes = ['modality:cupping'];
  }
  const descriptors = [...(await discoverCapabilityManifests()), clone];
  const graph = structuralGraphV21(request(['modality:cupping']), descriptors, CONTROL_PLANE_V21_POLICY);
  assert.deepEqual(graph.issues, []);
  assert(graph.nodes.some((n) => n.target.type === 'artifact:treatment-delivery' && n.target.qualifiers.outcome === 'modality:cupping'));
  assert.equal(graph.nodes.filter((n) => n.target.type === 'artifact:clinical-core').length, 1);

  // 同一 outcome 两个 provider → 必须是 typed ambiguity，而不是任意选择。
  const duplicate: CapabilityDescriptor = JSON.parse(JSON.stringify(clone));
  duplicate.id = 'demo.cupping.alt';
  const ambiguous = structuralGraphV21(request(['modality:cupping']), [...descriptors, duplicate], CONTROL_PLANE_V21_POLICY);
  assert(ambiguous.issues.some((i) => i.type === 'AMBIGUOUS_PROVIDER'));

  const plannerSource = readFileSync(join(root, 'src/control-plane-v21/planner.ts'), 'utf8');
  for (const forbidden of ['cupping', 'moxibustion', 'acupuncture', 'gaofang', 'herbal-formula']) {
    assert(!plannerSource.includes(forbidden), `planner leaked domain token: ${forbidden}`);
  }
});

test('cardinality / generation policy 与 obligation 拓扑正交', async () => {
  const a = await prepareContext(request(['modality:herbal-formula'], { formulaCardinality: { mode: 'PRIMARY_ONLY' } }));
  const b = await prepareContext(request(['modality:herbal-formula'], { formulaCardinality: { mode: 'AT_LEAST', count: 3 } }));
  const c = await prepareContext(request(['modality:herbal-formula'], { knowledgeSource: 'MODEL_ALLOWED' }));
  const key = (context: RuntimeContext): string[] =>
    context.controlPlaneV21!.graph.nodes.map((n) => `${n.target.type}|${n.target.qualifiers.outcome ?? ''}`).sort();
  assert.deepEqual(key(a), key(b));
  assert.deepEqual(key(a), key(c));
});

test('多个方：formulaCardinality 由确定性投影表达，同源方不会被 silent drop', () => {
  const set = {
    parentRecordRef: 'P1:p',
    disease: 'd',
    syndrome: 's',
    treatmentMethod: 'm',
    completeness: 'COMPLETE' as const,
    sourceLevelModifications: [],
    formulas: [
      { formulaRef: 'a', formulaId: 'fa', formulaName: 'A', composition: 'x', sourceModifications: [], modificationStatus: 'KNOWN_EMPTY' as const, relation: 'PRIMARY_SELECTED' as const, applicableModifications: [] },
      { formulaRef: 'b', formulaId: 'fb', formulaName: 'B', composition: 'y', sourceModifications: [], modificationStatus: 'KNOWN_EMPTY' as const, relation: 'SOURCE_ALTERNATIVE' as const, applicableModifications: [] },
      { formulaRef: 'c', formulaId: 'fc', formulaName: 'C', composition: 'z', sourceModifications: [], modificationStatus: 'KNOWN_EMPTY' as const, relation: 'SOURCE_ALTERNATIVE' as const, applicableModifications: [] },
      { formulaRef: 'd', formulaId: 'fd', formulaName: 'D', composition: 'w', sourceModifications: [], modificationStatus: 'KNOWN_EMPTY' as const, relation: 'CLINICALLY_EXCLUDED' as const, applicableModifications: [] },
    ],
  };
  assert.deepEqual(projectFormulaSet(set, { mode: 'PRIMARY_ONLY' }).map((f) => f.formulaRef), ['a', 'b', 'c', 'd']);
  assert.deepEqual(projectFormulaSet(set, { mode: 'AT_LEAST', count: 3 }).map((f) => f.formulaRef), ['a', 'b', 'c', 'd']);
  assert.deepEqual(projectFormulaSet(set, { mode: 'ALL_ELIGIBLE' }).map((f) => f.formulaRef), ['a', 'b', 'c', 'd']);
  assert.equal(projectFormulaSet(set, { mode: 'PRIMARY_ONLY' })[3]?.relation, 'CLINICALLY_EXCLUDED');
});

test('typed planning blocker 阻断提交：未安装 provider 的 outcome 不得被静默降级', async () => {
  const context = await prepareContext(request(['modality:not-installed']));
  const graph = context.controlPlaneV21!.graph;
  assert(graph.issues.some((i) => i.type === 'UNSUPPORTED_OUTCOME'));
  const notDeliverable = graph.nodes.filter((n) => n.required && n.status === 'NOT_DELIVERABLE');
  assert.equal(notDeliverable.length, 1);
  const readiness = evaluateProposalReadiness(context);
  assert.equal(readiness.ready, false);
  assert(readiness.terminalShortfalls.length > 0, 'terminal shortfall 必须在 readiness 中被显式报告');
});

test('V2.1.1 formula retrieval is atomic: search_candidates remains the only baseline evidence action until CandidateSet receipt closes', async () => {
  const context = await prepareContext(request(['modality:herbal-formula']));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  let surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(surface.includes('formula.search_candidates'));
  assert(!surface.includes('formula.get_evidence'));

  satisfyFormulaEvidence(context);
  refreshControlPlaneV21(context);
  surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(!surface.includes('formula.search_candidates'));
  assert(!surface.includes('formula.get_evidence'));
  assert(surface.includes('formula.select'));
});

test('formula-evidence closes only from a complete CandidateSet/evidence receipt, not from arbitrary evidence', async () => {
  const context = await prepareContext(request(['modality:herbal-formula']));
  satisfyClinicalCore(context);
  context.workspace.candidates.push({ id: 'source-node:P1:x', kind: 'formula', formulaId: 'F1', sourceId: 'P1:x' });
  context.workspace.evidenceState.evidenceItems.push({
    id: 'E2', sourceRef: 'P1:x', sourceType: 'knowledge', relatedCandidates: ['source-node:P1:x'], supportingSignals: [], contradictingSignals: [],
  });
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:formula-evidence', 'modality:herbal-formula')!.status, 'OPEN');
  const surfaceBeforeReceipt = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(surfaceBeforeReceipt.includes('formula.search_candidates'));
  assert(!surfaceBeforeReceipt.includes('formula.get_evidence'));

  satisfyFormulaEvidence(context);
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:formula-evidence', 'modality:herbal-formula')!.status, 'SATISFIED');
  assert.equal(nodeOf(context, 'artifact:formula-selection', 'modality:herbal-formula')!.status, 'OPEN');
});

test('V2.1.1 open alternative hypothesis remains review uncertainty and does not reopen a completed clinical core', async () => {
  const context = await prepareContext(request([]));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  context.workspace.hypothesisState.hypotheses.push({
    id: 'h1', label: 'alt', supportingEvidenceRefs: [], contradictingEvidenceRefs: [], missingEvidence: [],
    status: 'alternative', origin: 'agent_reasoning',
  });
  refreshControlPlaneV21(context);
  assert.equal(nodeOf(context, 'artifact:clinical-core')!.status, 'SATISFIED');
});

test('V2.1.1 未知显式 modality 保留为 typed unsupported，不得吸附到最近 provider', async () => {
  const ir = request([]);
  ir.outcomes.unresolved = ['拔罐'];
  const context = await prepareContext(ir);
  assert(context.controlPlaneV21!.graph.issues.some((issue) => issue.type === 'UNSUPPORTED_OUTCOME' && issue.message.includes('拔罐')));
  assert(context.controlPlaneV21!.graph.nodes.some((node) => node.status === 'NOT_DELIVERABLE' && node.target.qualifiers.outcome === 'unresolved:拔罐'));
});

// ---------------------------------------------------------------------------
// Phase 7：readiness 与 runtime scheduler 使用同一份未满足义务
// ---------------------------------------------------------------------------

test('readiness 与 obligation graph 报告同一缺失集（单一真源）', async () => {
  const context = await prepareContext(request(['modality:acupuncture', 'modality:gaofang']));
  const readiness = evaluateProposalReadiness(context);
  assert.equal(readiness.ready, false);
  const controlBlockers = readiness.blockers.filter((b) => b.message.startsWith('control plane'));
  assert(controlBlockers.length > 0);
  assert.deepEqual(controlBlockers[0].missing, readiness.missingArtifacts);
  assert(readiness.missingArtifacts.includes('capabilityDelivery:tcm.external-therapy:treatment-form-delivery'));
  assert(readiness.missingArtifacts.includes('capabilityDelivery:gaofang:treatment-form-delivery'));
  // 证据类义务没有 workspace artifact key，必须由图直接兜底（否则闸门可被绕过）。
  const graphMissing = unmetObligationsV21(context.controlPlaneV21!);
  assert.equal(graphMissing.length > 0, true);
  assert(
    controlBlockers.some((b) => (b.missing ?? []).some((m) => m.includes('artifact:treatment-evidence'))),
    'unmet evidence obligation 必须出现在某个 control plane blocker 中',
  );
});

test('证据义务未 terminal 时不得提交（即便交付 artifact 已写入）', async () => {
  const context = await prepareContext(request(['modality:herbal-formula']));
  satisfyClinicalCore(context);
  // 已选方（formulaSelection artifact 满足），但 formula-evidence 仍未取得。
  context.workspace.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'C1', version: 1 };
  const readiness = evaluateProposalReadiness(context);
  assert.equal(readiness.ready, false);
  assert(
    readiness.blockers.some((b) => (b.missing ?? []).some((m) => m.includes('artifact:formula-evidence'))),
    'unmet formula-evidence 必须阻断提交',
  );
});

test('Request IR 是执行契约：planner 的 provisional 预判不得要求被请求排除的产物', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  // 模拟 planner 过度预判（历史行为：凡临床必要求 formulaSelection / treatmentFormDecision）。
  context.strategy.provisionalRequiredArtifacts = ['diseaseAssessment', 'formulaSelection', 'formulaReview', 'treatmentFormDecision'];
  const readiness = evaluateProposalReadiness(context);
  assert.equal(readiness.requiredArtifacts.includes('formulaSelection'), false);
  assert.equal(readiness.requiredArtifacts.includes('formulaReview'), false);
  assert.equal(readiness.missingArtifacts.includes('formulaSelection'), false);
  assert.equal(
    readiness.requiredArtifacts.includes('capabilityDelivery:tcm.external-therapy:treatment-form-delivery'),
    true,
  );
});

test('graph 完整后 readiness 不再报 control plane blocker，且 runtime 无缺失义务', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], { exclusive: true }));
  satisfyClinicalCore(context);
  satisfyDiagnosticEvidence(context);
  context.harness.activateCapability('tcm.external-therapy', 'test');
  context.workspace.capabilityEvidenceReceipts = {
    'tcm.external-therapy': {
      scope: 'tcm.external-therapy',
      discoveryByTool: { 'knowledge.search_cards': ['AC-049'] },
      hydrationByTool: { 'knowledge.get_asset': ['AC-049'] },
    },
  };
  context.workspace.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: 'p',
    treatmentTarget: 't',
    evidenceRefs: [],
    treatmentFormDecision: { outcome: 'modality:acupuncture', form: 'acupuncture', disposition: 'CURRENTLY_SUITABLE', statement: 's', sourceEvidenceRefs: ['AC-049'], details: { points: ['合谷'], operation: '平补平泻', frequency: '每日1次', course: '10次' } },
    version: 1,
  };
  refreshControlPlaneV21(context);
  // Workspace 只产出 treatment-draft；terminal treatment-delivery 必须由 Kernel CommitRecord 关闭。
  commitOutcome(context, 'modality:acupuncture', 'tcm.external-therapy');
  assert.deepEqual(unmetObligationsV21(context.controlPlaneV21!), []);
  const readiness = evaluateProposalReadiness(context);
  assert.equal(readiness.blockers.some((b) => b.message.startsWith('control plane incomplete')), false);
});

// ---------------------------------------------------------------------------
// Phase 8：确定性结果装配（端到端 Runtime 路径）
// ---------------------------------------------------------------------------

test('Phase 8：NOT_DELIVERABLE outcome 显式进入最终结果，不被静默丢弃', async () => {
  const { buildTestRuntime, baseUnderstanding, clinicalProposal } = await import('./helpers.js');
  const runtime = await buildTestRuntime({
    understand: () => baseUnderstanding('clinical'),
    requestIR: request(['modality:acupuncture'], { exclusive: true }),
    propose: (context) => {
      satisfyClinicalCore(context);
      satisfyDiagnosticEvidence(context);
      context.harness.activateCapability('tcm.external-therapy', 'test');
      context.workspace.capabilityEvidenceReceipts = {
        'tcm.external-therapy': {
          scope: 'tcm.external-therapy',
          discoveryByTool: { 'knowledge.search_cards': [] },
          hydrationByTool: {},
        },
      };
      return clinicalProposal();
    },
  });
  const result = await runtime.run('只做针灸，知识库没有就不要自拟');
  assert(result.controlPlane !== undefined);
  const coverage = result.controlPlane!.outcomeCoverage;
  const acupuncture = coverage.find((o) => o.outcome === 'modality:acupuncture');
  assert.equal(acupuncture?.status, 'NOT_DELIVERABLE');
  const proposal = result.authority.proposal;
  assert.equal(proposal.mode, 'clinical');
  if (proposal.mode === 'clinical') {
    assert(proposal.missing_information.some((m) => m.includes('modality:acupuncture') && m.includes('NOT_DELIVERABLE')));
  }
});
