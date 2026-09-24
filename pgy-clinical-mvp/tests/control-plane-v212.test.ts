import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDescriptor } from '../src/contracts/capability.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { ClinicalRequestIR, OutcomeCommitment } from '../src/control-plane-v2/types.js';
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
import { projectControlPlaneV21Surface, dynamicInstructions } from '../src/adapters/ai-sdk/agent-runtime.js';
import {
  refreshControlPlaneV21,
  structuralGraphV21,
  contractResolved,
  contractSatisfied,
} from '../src/platform/control-plane/control-plane-v21-session.js';
import type { ObligationNodeV21 } from '../src/control-plane-v21/types.js';
import { validateRequestSemantics, resolveMention, buildSemanticOntology } from '../src/control-plane-v2/semantic-validator.js';
import { stubRequestCompiler } from './helpers.js';

/**
 * Control Plane V2.1.2 — Closure invariants（deterministic，小集合）。
 *
 * 只覆盖本轮真正新增的核心语义：
 * 1. cardinality 未满足不能 closure
 * 2. cardinality 满足后 closure
 * 3. MODEL_ALLOWED 只能由 typed insufficiency 开放（且 provenance 不被抹平）
 * 4. family semantic 不能冒充 exact semantic
 * 5. frontier mutation 必须受 runnable obligation 控制
 */

function request(
  required: string[],
  overrides: {
    mentions?: Array<{ name: string; commitment: OutcomeCommitment }>;
    preferred?: string[];
    excluded?: string[];
    cardinality?: { mode: 'PRIMARY_ONLY' } | { mode: 'AT_LEAST'; count: number };
    knowledgeSource?: 'KB_ONLY' | 'KB_PREFERRED' | 'MODEL_ALLOWED';
  } = {},
): ClinicalRequestIR {
  return normalizeClinicalRequestIR({
    version: 1,
    goal: 'treatment',
    outcomes: {
      required,
      preferred: overrides.preferred ?? [],
      allowed: [],
      excluded: overrides.excluded ?? [],
      mentions: overrides.mentions ?? [],
      unresolved: [],
      unresolvedPreferred: [],
      exclusive: false,
    },
    outputPolicy: { formulaCardinality: overrides.cardinality ?? { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: overrides.knowledgeSource ?? 'KB_PREFERRED' },
    hardConstraints: [],
    preferences: [],
  });
}

async function prepareContext(requestIR: ClinicalRequestIR): Promise<RuntimeContext> {
  const manifests = await discoverCapabilityManifests();
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
    model: { id: 'test:control-plane-v212' },
    baselineToolIds: BASELINE_TOOL_IDS,
    baselineSkillIds: BASELINE_SKILL_IDS,
    baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
    controlPlane: { compiler: stubRequestCompiler(requestIR), policy: CONTROL_PLANE_V21_POLICY },
  });
  return preparer.prepare('test-input', 'run-control-plane-v212');
}

function satisfyClinicalCore(context: RuntimeContext): void {
  const spine = context.workspace.clinicalDecisionSpine;
  spine.clinicalQuestion = { statement: 'q', version: 1 };
  spine.diseaseAssessment = { statement: 'd', evidenceRefs: ['P1:x'], version: 1 };
  spine.patternHypothesisRefs = ['h1'];
  spine.patternAssessmentRef = 'h1';
}

function satisfyFormulaEvidence(context: RuntimeContext): void {
  context.workspace.candidates.push({ id: 'C1', kind: 'formula', formulaId: 'F1', sourceId: 'P1:x' });
  context.workspace.deliberationState.frontier = ['C1'];
  context.workspace.evidenceState.evidenceItems.push({
    id: 'E1', sourceRef: 'P1:x', sourceType: 'knowledge',
    relatedCandidates: ['C1'], supportingSignals: [], contradictingSignals: [],
  });
}

/** 3 个同源方里只有 `eligible` 个合格（其余显式排除）。 */
function setSourceFormulas(context: RuntimeContext, eligible: number, excluded = 0): void {
  context.workspace.sourceFormulaSet = {
    parentRecordRef: 'P1:x',
    disease: 'd',
    syndrome: 's',
    treatmentMethod: 'm',
    completeness: 'COMPLETE',
    sourceLevelModifications: [],
    formulas: [
      ...Array.from({ length: eligible }, (_, i) => ({
        formulaRef: `F${i}`, formulaId: `F${i}`, formulaName: `方${i}`, composition: 'c',
        sourceModifications: [], modificationStatus: 'KNOWN_EMPTY' as const,
        relation: 'PRIMARY_SELECTED' as const, applicableModifications: [],
      })),
      ...Array.from({ length: excluded }, (_, i) => ({
        formulaRef: `X${i}`, formulaId: `X${i}`, formulaName: `排除方${i}`, composition: 'c',
        sourceModifications: [], modificationStatus: 'KNOWN_EMPTY' as const,
        relation: 'CLINICALLY_EXCLUDED' as const, applicableModifications: [],
      })),
    ],
  };
}

function nodeOf(context: RuntimeContext, type: string, outcome?: string): ObligationNodeV21 | undefined {
  return context.controlPlaneV21!.graph.nodes.find(
    (n) => n.target.type === type && (outcome === undefined || n.target.qualifiers.outcome === outcome),
  );
}

const ALL_INTERNAL_TOOLS = [...BASELINE_TOOL_IDS];

// ---------------------------------------------------------------------------
// 1 / 2. AT_LEAST N 是 artifact 级 postcondition，不是公式专用流程
// ---------------------------------------------------------------------------

test('V2.1.2 invariant: cardinality 未满足时 formula-selection 不得 closure', async () => {
  const context = await prepareContext(request(['modality:herbal-formula'], {
    cardinality: { mode: 'AT_LEAST', count: 3 },
  }));
  satisfyClinicalCore(context);
  satisfyFormulaEvidence(context);
  setSourceFormulas(context, 2);
  context.workspace.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'C1', version: 1 };
  refreshControlPlaneV21(context);

  const node = nodeOf(context, 'artifact:formula-selection', 'modality:herbal-formula')!;
  assert.deepEqual(node.postconditions, [{ kind: 'minCount', collection: 'eligibleSourceFormulas', min: 3 }]);
  assert.notEqual(node.status, 'SATISFIED', 'cardinality 未满足不得 closure');
});

test('V2.1.2 invariant: cardinality 满足后 formula-selection closure', async () => {
  const context = await prepareContext(request(['modality:herbal-formula'], {
    cardinality: { mode: 'AT_LEAST', count: 3 },
  }));
  satisfyClinicalCore(context);
  satisfyFormulaEvidence(context);
  setSourceFormulas(context, 3);
  context.workspace.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'C1', version: 1 };
  refreshControlPlaneV21(context);

  assert.equal(nodeOf(context, 'artifact:formula-selection', 'modality:herbal-formula')!.status, 'SATISFIED');
});

// ---------------------------------------------------------------------------
// 3. MODEL_ALLOWED 只能由 typed insufficiency 开放
// ---------------------------------------------------------------------------

test('V2.1.2 invariant: KB 未穷尽时不得开放 model generation', async () => {
  const context = await prepareContext(request(['modality:herbal-formula'], {
    cardinality: { mode: 'AT_LEAST', count: 3 },
    knowledgeSource: 'MODEL_ALLOWED',
  }));
  satisfyClinicalCore(context);
  // 证据未穷尽（没有候选/未 hydrate）→ 不能宣称知识库不足。
  setSourceFormulas(context, 1);
  refreshControlPlaneV21(context);
  assert.equal(
    context.controlPlaneV21!.graph.nodes.some((n) => n.source === 'insufficiency'),
    false,
    'KB 仍可推进时不得产生 model-generation 义务',
  );
});

test('V2.1.2 invariant: KB 穷尽 + MODEL_ALLOWED 才产生 model-generation 义务，且 provenance 分离', async () => {
  const base = request(['modality:herbal-formula'], {
    cardinality: { mode: 'AT_LEAST', count: 3 },
    knowledgeSource: 'MODEL_ALLOWED',
  });
  const allowed = await prepareContext(base);
  satisfyClinicalCore(allowed);
  satisfyFormulaEvidence(allowed);
  setSourceFormulas(allowed, 2);
  refreshControlPlaneV21(allowed);
  const childAllowed = allowed.controlPlaneV21!.graph.nodes.find((n) => n.source === 'insufficiency');
  assert(childAllowed !== undefined, 'KB 穷尽 + MODEL_ALLOWED → 必须产生 model-generation 义务');
  assert.equal(childAllowed!.status, 'OPEN');
  assert.equal(childAllowed!.provenance, 'MODEL_GENERATED');
  // KB 路径显式终止为 NOT_DELIVERABLE（typed insufficiency 已记录），不得假装满足。
  assert.equal(nodeOf(allowed, 'artifact:formula-selection', 'modality:herbal-formula')!.status, 'NOT_DELIVERABLE');

  const blocked = await prepareContext(request(['modality:herbal-formula'], {
    cardinality: { mode: 'AT_LEAST', count: 3 },
    knowledgeSource: 'KB_ONLY',
  }));
  satisfyClinicalCore(blocked);
  satisfyFormulaEvidence(blocked);
  setSourceFormulas(blocked, 2);
  refreshControlPlaneV21(blocked);
  const childBlocked = blocked.controlPlaneV21!.graph.nodes.find((n) => n.source === 'insufficiency')!;
  assert.equal(childBlocked.status, 'BLOCKED', 'policy 不允许时 model generation 必须关闭');
});

test('V2.1.2 invariant: 知识库来源的产物不得关闭 model-generation 义务', async () => {
  const context = await prepareContext(request(['modality:herbal-formula'], {
    cardinality: { mode: 'AT_LEAST', count: 3 },
    knowledgeSource: 'MODEL_ALLOWED',
  }));
  satisfyClinicalCore(context);
  satisfyFormulaEvidence(context);
  setSourceFormulas(context, 2);
  // 已选方来自知识库候选 C1 → provenance = KNOWLEDGE_BASE
  context.workspace.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: 'C1', version: 1 };
  refreshControlPlaneV21(context);
  const child = context.controlPlaneV21!.graph.nodes.find((n) => n.source === 'insufficiency')!;
  assert.notEqual(child.status, 'SATISFIED', 'KNOWLEDGE_BASE 产物不得关闭 model-generation 义务');
});

// ---------------------------------------------------------------------------
// 4. family semantic 不能冒充 exact semantic
// ---------------------------------------------------------------------------

test('V2.1.2 invariant: 家族项不得顶替用户点名的具体形式（fail-closed 到 unresolved）', async () => {
  const descriptors = await discoverCapabilityManifests();
  const ontology = buildSemanticOntology(descriptors);
  // 声明关系（数据）而非 Core 业务词：具体技法 vs 更宽的家族项 / 声明别名。
  const mention = resolveMention(ontology, '拔罐');
  assert.equal(mention.relation, 'FAMILY');
  assert.equal(mention.term, 'modality:external-therapy');
  assert.equal(resolveMention(ontology, '针灸').relation, 'ALIAS');
  assert.equal(resolveMention(ontology, '针灸').term, 'modality:acupuncture');
  assert.equal(resolveMention(ontology, '不存在的疗法').relation, 'UNKNOWN');

  // 用户点名「拔罐」但编译器把它顶替成家族项 → validator 必须移除 required 并显式 unresolved。
  const validated = validateRequestSemantics(
    request(['modality:external-therapy'], { mentions: [{ name: '拔罐', commitment: 'REQUIRED' }] }),
    descriptors,
    CONTROL_PLANE_V21_POLICY.baselineOutcomes,
  );
  assert.deepEqual(validated.ir.outcomes.required, []);
  assert.deepEqual(validated.ir.outcomes.unresolved, ['拔罐']);
  assert.deepEqual(validated.rejected, [{ term: 'modality:external-therapy', mention: '拔罐', relation: 'FAMILY' }]);

  // 校验后的 IR 在 planner 上只能产生 typed UNSUPPORTED_OUTCOME，不得产生家族交付义务。
  const graph = structuralGraphV21(validated.ir, descriptors, CONTROL_PLANE_V21_POLICY);
  assert(graph.issues.some((issue) => issue.type === 'UNSUPPORTED_OUTCOME' && issue.outcome === 'unresolved:拔罐'));
  assert.equal(
    graph.nodes.some((n) =>
      n.target.type === 'artifact:treatment-delivery' &&
      n.rootOutcomes.some((o) => o === 'modality:external-therapy' || o === 'unresolved:拔罐'),
    ),
    false,
    '家族项不得被当作精确满足而产生交付义务',
  );
});

test('V2.1.2 invariant: 声明别名/字面命中不得被误判为家族顶替', async () => {
  const descriptors = await discoverCapabilityManifests();
  const validated = validateRequestSemantics(
    request(['modality:acupuncture'], { mentions: [{ name: '针灸', commitment: 'REQUIRED' }] }),
    descriptors,
    CONTROL_PLANE_V21_POLICY.baselineOutcomes,
  );
  assert.deepEqual(validated.ir.outcomes.required, ['modality:acupuncture']);
  assert.deepEqual(validated.ir.outcomes.unresolved, []);
  assert.deepEqual(validated.rejected, []);
});

// ---------------------------------------------------------------------------
// 6. V2.1.3 Outcome Commitment（REQUIRED / PREFERRED / ALLOWED / EXCLUDED）
// ---------------------------------------------------------------------------

test('V2.1.3 invariant: REQUIRED + unsupported → BLOCKED，且不阻断其他 required outcome', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], {
    mentions: [
      { name: '针灸', commitment: 'REQUIRED' },
      { name: '拔罐', commitment: 'REQUIRED' },
    ],
  }));

  assert.deepEqual(context.controlPlaneV21!.requestIR.outcomes.required, ['modality:acupuncture']);
  assert.deepEqual(context.controlPlaneV21!.requestIR.outcomes.unresolved, ['拔罐']);
  assert.deepEqual(context.controlPlaneV21!.requestIR.outcomes.unresolvedPreferred, []);

  const blocked = context.controlPlaneV21!.graph.nodes.find(
    (n) => n.target.qualifiers.outcome === 'unresolved:拔罐',
  );
  assert(blocked !== undefined, 'REQUIRED 且不可表示必须产生 typed blocker');
  assert.equal(blocked!.status, 'BLOCKED');
  assert.equal(blocked!.blocker?.type, 'UNSUPPORTED_OUTCOME');

  // required 的针灸仍有 provider 义务，且没有被拔罐的 blocker 传播为 BLOCKED。
  const acupuncture = nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture');
  assert(acupuncture !== undefined);
  assert.notEqual(acupuncture!.status, 'BLOCKED');
});

test('V2.1.3 invariant: contractResolved 与 contractSatisfied 分离（required 无 provider）', async () => {
  const context = await prepareContext(request(['modality:no-such-modality']));
  satisfyClinicalCore(context);
  context.workspace.evidenceState.evidenceItems.push({
    id: 'E1', sourceRef: 'P1:std', sourceType: 'knowledge', relatedCandidates: [], supportingSignals: [], contradictingSignals: [],
  });
  refreshControlPlaneV21(context);
  const state = context.controlPlaneV21!;
  // 无 provider 的 required outcome 是 BLOCKED 终态：已到终态（resolved），但不满足合同（satisfied=false）。
  assert.equal(contractResolved(state), true, 'unsupported required outcome 是终态 → resolved');
  assert.equal(contractSatisfied(state), false, 'unsupported required outcome 不得伪装成 satisfied');
});

test('V2.1.3 invariant: ALLOWED + unsupported 不阻断 required outcome；PREFERRED 仅报告 shortfall', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], {
    mentions: [
      { name: '针灸', commitment: 'REQUIRED' },
      { name: '拔罐', commitment: 'ALLOWED' },
      { name: '刮痧', commitment: 'PREFERRED' },
    ],
  }));

  const outcomes = context.controlPlaneV21!.requestIR.outcomes;
  assert.deepEqual(outcomes.unresolved, [], 'ALLOWED / PREFERRED 不可表示不得升级为 blocking unresolved');
  assert.deepEqual(outcomes.unresolvedPreferred, ['刮痧'], 'PREFERRED shortfall 必须显式报告');
  assert.deepEqual(outcomes.allowed, []);

  assert.equal(
    context.controlPlaneV21!.graph.issues.some((issue) => issue.type === 'UNSUPPORTED_OUTCOME'),
    false,
    'ALLOWED / PREFERRED 不产生 UNSUPPORTED_OUTCOME 义务',
  );
  assert.equal(
    context.controlPlaneV21!.graph.nodes.some((n) => n.status === 'BLOCKED'),
    false,
    'ALLOWED unsupported 不得阻断 required outcome',
  );
  assert(nodeOf(context, 'artifact:treatment-delivery', 'modality:acupuncture') !== undefined);
  // shortfall 只经 semanticValidation 显式报告，不进入 workspace 缺失集。
  assert.deepEqual(
    context.controlPlaneV21!.semanticValidation!.preferredShortfalls,
    ['刮痧'],
  );
});

test('V2.1.3 invariant: EXCLUDED 不产生 delivery obligation', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], {
    mentions: [
      { name: '针灸', commitment: 'REQUIRED' },
      { name: '拔罐', commitment: 'EXCLUDED' },
    ],
  }));

  const outcomes = context.controlPlaneV21!.requestIR.outcomes;
  assert.deepEqual(outcomes.unresolved, []);
  assert.deepEqual(outcomes.unresolvedPreferred, []);
  assert.equal(
    context.controlPlaneV21!.graph.nodes.some((n) => n.target.type === 'artifact:treatment-delivery'
      && n.target.qualifiers.outcome !== 'modality:acupuncture'),
    false,
    'EXCLUDED 形式不得产生任何交付义务',
  );
  assert.equal(
    context.controlPlaneV21!.graph.issues.some((issue) => issue.type === 'UNSUPPORTED_OUTCOME'),
    false,
    'EXCLUDED 不产生 blocking obligation',
  );
});

// ---------------------------------------------------------------------------
// 5. frontier mutation 必须受 runnable obligation 控制
// ---------------------------------------------------------------------------

test('V2.1.2 invariant: frontier/assessment mutation 由 obligation graph 决定可见性', async () => {
  const context = await prepareContext(request(['modality:herbal-formula']));

  // clinical-core 未完成 → formula-evidence 不可执行 → frontier mutation 必须不可见。
  let surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(!surface.includes('workspace.focus_candidates'), '上游义务未终态时 frontier mutation 不得可见');
  assert(!surface.includes('workspace.record_candidate_assessment'));

  satisfyClinicalCore(context);
  satisfyFormulaEvidence(context);
  refreshControlPlaneV21(context);

  // formula-evidence 已终态 → 推进到 selection：frontier mutation 收口，候选评估开放。
  surface = projectControlPlaneV21Surface(context, ALL_INTERNAL_TOOLS);
  assert(!surface.includes('workspace.focus_candidates'), 'formula-evidence 终态后 discovery/frontier 应推进');
  assert(surface.includes('workspace.record_candidate_assessment'), 'selection 义务可执行时候选评估应开放');
  assert(surface.includes('workspace.record_candidate_exclusion'));
  assert(surface.includes('workspace.record_deliberation'));
});

// ---------------------------------------------------------------------------
// 7. Treatment-form fidelity（交付内容必须落实其声明的 outcome）
// ---------------------------------------------------------------------------

test('V2.1.3 invariant: 临床结论类措辞（辨证/治法）不得产生 blocking unresolved', async () => {
  const descriptors = await discoverCapabilityManifests();
  const validated = validateRequestSemantics(
    request(['outcome:clinical-assessment'], {
      mentions: [
        { name: '辨证', commitment: 'REQUIRED' },
        { name: '治法', commitment: 'REQUIRED' },
        { name: '开方', commitment: 'EXCLUDED' },
      ],
    }),
    descriptors,
    CONTROL_PLANE_V21_POLICY.baselineOutcomes,
  );

  assert.deepEqual(validated.unresolved, [], '临床结论不可表示不代表缺少治疗形式，不得阻断');
  assert.deepEqual(validated.ir.outcomes.unresolved, []);
  assert.equal(
    structuralGraphV21(validated.ir, descriptors, CONTROL_PLANE_V21_POLICY).issues
      .some((issue) => issue.type === 'UNSUPPORTED_OUTCOME'),
    false,
  );
});

test('V2.1.3 invariant: pending treatment-delivery 时 instructions 注入形式保真约束', async () => {
  const context = await prepareContext(request(['modality:acupuncture'], {
    mentions: [{ name: '针灸', commitment: 'REQUIRED' }],
  }));
  satisfyClinicalCore(context);
  refreshControlPlaneV21(context);

  const instructions = dynamicInstructions('base', context);
  // 未交付的 modality outcome 必须被列出，且必须显式约束「交付即所声明的形式」。
  assert(instructions.includes('modality:acupuncture'));
  assert(instructions.includes('must implement the very treatment form its `outcome` names'));
  assert(instructions.includes('stand in for the requested form'));
});

test('V2.1.3 invariant: tcm-clinical-cognition 声明治疗形式保真方法', async () => {
  const [skill] = await loadSkills(['tcm-clinical-cognition']);
  assert(skill !== undefined);
  assert(skill.instruction.includes('## Treatment Form Fidelity'));
  assert(skill.instruction.includes('never stands in for a specifically requested form'));
});

test('V2.1.3 invariant: semantic identity 稳定（display surface 归一化到 canonical id）', async () => {
  const descriptors = await discoverCapabilityManifests();
  const ontology = buildSemanticOntology(descriptors);
  // 同一语义的不同 surface 形式必须 resolve 到同一个 canonical identity。
  assert.equal(resolveMention(ontology, '膏方').term, 'modality:gaofang');
  assert.equal(resolveMention(ontology, '以膏代煎').term, 'modality:gaofang');
  assert.equal(resolveMention(ontology, '膏方（以膏代煎）').term, 'modality:gaofang');
});

test('V2.1.3 invariant: no-progress terminal —— blocked required + open=0 时 proposal.submit 移除', async () => {
  const context = await prepareContext(request(['modality:no-such-modality']));
  satisfyClinicalCore(context);
  context.workspace.evidenceState.evidenceItems.push({
    id: 'E1', sourceRef: 'P1:std', sourceType: 'knowledge', relatedCandidates: [], supportingSignals: [], contradictingSignals: [],
  });
  refreshControlPlaneV21(context);
  // blocked required > 0 且 open = 0：无任何 legal effect 能改善 satisfaction。
  const surface = projectControlPlaneV21Surface(context, ['proposal.submit']);
  assert.deepEqual(surface, [], 'blocked required + open=0 时 proposal.submit 必须从 legal surface 消失');
});
