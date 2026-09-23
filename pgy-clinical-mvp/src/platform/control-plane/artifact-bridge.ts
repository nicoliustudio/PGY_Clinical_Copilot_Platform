import type { CapabilityDescriptor } from '../../contracts/capability.js';
import type { AppliedBlockerV21 } from '../../contracts/runtime.js';
import type { ClinicalWorkspace } from '../../contracts/workspace.js';
import type {
  ControlPlanePolicyV21,
  DurableArtifactEnvelopeV21,
  NodePostconditionV21,
  ObligationGraphV21,
  ObligationNodeV21,
  ProvenanceV21,
  TypedBlockerV21,
} from '../../control-plane-v21/types.js';
import type { ClinicalRequestIR } from '../../control-plane-v2/types.js';
import { applyTypedBlockerV21 } from '../../control-plane-v21/blockers.js';
import { importedArtifact } from '../../control-plane-v21/artifacts.js';
import { stableToken } from '../../control-plane-v21/terms.js';
import { checkClinicalCoreCompletion, isArtifactSatisfied } from '../workspace/clinical-workspace.js';

/**
 * Workspace → V2.1 Artifact Bridge（Phase 4）。
 *
 * 职责：把**已持久化的 Workspace durable facts**投影成 V2.1 artifact ledger，并据此重建 obligation graph。
 * 这是「控制平面唯一真源」的落点：图不是模型声明的，也不是 runtime 记的账，而是 durable state 的纯投影。
 *
 * 边界：
 * - 本模块属于**领域适配层**（domain adapter / 领域插件），允许认识产品级 artifact 名称；
 * - `control-plane-v21/planner.ts` 永远不认识这些名字，Generic Resolver 也不认识；
 * - 新增一种治疗形式（如 moxibustion）只需要 manifest 声明 modality + rule，本文件不需要改；
 * - 只有引入**全新的 artifact 语义类别**时才在这里登记一行 truth reader（表格驱动，非分支）。
 */

export type NodeTruth = 'SATISFIED' | 'NOT_DELIVERABLE' | 'OPEN';

interface TruthContext {
  workspace: ClinicalWorkspace;
  capabilities: CapabilityDescriptor[];
}

/** 某个 obligation 节点在**当前 durable state** 下的终态。 */
type TruthReader = (node: ObligationNodeV21, ctx: TruthContext) => NodeTruth;

function outcomeProvider(node: ObligationNodeV21, capabilities: CapabilityDescriptor[]): CapabilityDescriptor | undefined {
  const outcome = node.target.qualifiers?.outcome;
  if (typeof outcome !== 'string') return undefined;
  return capabilities.find((c) => c.enabled !== false && c.provides.includes(outcome));
}

/** 声明了 evidenceObligations 的能力：证据义务是否有合法终态（EVIDENCE_ACQUIRED / SEARCHED_NONE）。 */
function capabilityEvidenceTruth(capability: CapabilityDescriptor, workspace: ClinicalWorkspace): NodeTruth | undefined {
  const obligations = capability.evidenceObligations ?? [];
  if (obligations.length === 0) return undefined;
  const closures = workspace.capabilityEvidenceClosures ?? [];
  const statuses = obligations.map((ob) => closures.find((c) => c.capabilityId === capability.id && c.obligationId === ob.id)?.status);
  if (statuses.some((s) => s === 'EVIDENCE_ACQUIRED' || s === 'NOT_APPLICABLE')) return 'SATISFIED';
  if (statuses.every((s) => s === 'SEARCHED_NONE')) return 'NOT_DELIVERABLE';
  return 'OPEN';
}

/** 交付义务：治疗形式产物是否已形成 durable artifact。 */
function capabilityDeliveryTruth(capability: CapabilityDescriptor, workspace: ClinicalWorkspace): NodeTruth | undefined {
  const obligations = capability.deliveryObligations ?? [];
  if (obligations.length === 0) return undefined;
  const closures = workspace.capabilityDeliveryClosures ?? [];
  const statuses = obligations.map((ob) => closures.find((c) => c.capabilityId === capability.id && c.obligationId === ob.id)?.status);
  if (statuses.some((s) => s === 'DELIVERED')) return 'SATISFIED';
  if (statuses.length > 0 && statuses.every((s) => s === 'NOT_DELIVERABLE')) return 'NOT_DELIVERABLE';
  return 'OPEN';
}

/** 采集到的证据条目数（用于判断 typed blocker 之后是否真的有新证据到达）。 */
export function evidenceVolume(workspace: ClinicalWorkspace): number {
  return workspace.evidenceState.evidenceItems.length + workspace.evidenceRefs.length;
}

/** 方剂证据完整性：与 legacy formula decision surface 使用同一判定（frontier 证据是否展开完毕）。 */
function formulaEvidenceComplete(workspace: ClinicalWorkspace): boolean {
  const candidates = workspace.candidates.filter((c) => c.kind === 'formula');
  if (candidates.length === 0) return false;
  const frontier = workspace.deliberationState.frontier.filter((ref) => candidates.some((c) => c.id === ref));
  if (frontier.length === 0) return false;
  return frontier.every((ref) =>
    workspace.evidenceState.evidenceItems.some((item) => item.relatedCandidates.includes(ref)));
}

// ---------------------------------------------------------------------------
// V2.1.2 —— postcondition / provenance / insufficiency 的 domain adapter 侧实现。
//
// 这些表格把 Core 传来的**类型化参数**（artifact type / collection 名）解析为真实 durable 读数。
// Core 与 planner 不认识这里的任何业务名称；新增一种交付形式只需要在 policy + 本表登记。
// ---------------------------------------------------------------------------

/** `collection` → durable 计数（用于 `minCount` postcondition）。未知集合 fail-closed。 */
const COLLECTION_COUNTERS: Record<string, (workspace: ClinicalWorkspace) => number> = {
  /** 合格同源方数量：not selected ≠ clinically rejected，只有显式排除才不计入。 */
  eligibleSourceFormulas: (workspace) =>
    (workspace.sourceFormulaSet?.formulas ?? []).filter((formula) => formula.relation !== 'CLINICALLY_EXCLUDED').length,
};

/** artifact type → durable 产物来源（用于 provenance 审计与 model-generation 判定）。 */
const PROVENANCE_READERS: Record<string, (workspace: ClinicalWorkspace) => ProvenanceV21> = {
  'artifact:formula-selection': (workspace) => {
    const ref = workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef;
    const fromKnowledgeBase = typeof ref === 'string'
      && ref.trim() !== ''
      && workspace.candidates.some((candidate) => candidate.id === ref);
    return fromKnowledgeBase ? 'KNOWLEDGE_BASE' : 'MODEL_GENERATED';
  },
};

/** artifact type → workspace artifact key（用于判定 durable 产物是否已经形成）。 */
const ARTIFACT_KEYS: Record<string, string> = {
  'artifact:formula-selection': 'formulaSelection',
};

/**
 * artifact type → KB 路径是否已经穷尽。
 * 用于区分「模型还没做完」与「闭世界知识库确实无法满足」，后者才允许 typed insufficiency。
 */
const KB_EXHAUSTION_READERS: Record<string, (workspace: ClinicalWorkspace) => boolean> = {
  'artifact:formula-selection': (workspace) => formulaEvidenceComplete(workspace),
};

/** artifact type → durable 产物来源（未登记的 artifact 类型没有 provenance 结论）。 */
export function artifactProvenance(targetType: string, workspace: ClinicalWorkspace): ProvenanceV21 | undefined {
  return PROVENANCE_READERS[targetType]?.(workspace);
}

/** 未满足的 postcondition（未知集合视为未满足 → fail-closed）。 */
export function unmetPostconditions(node: ObligationNodeV21, workspace: ClinicalWorkspace): NodePostconditionV21[] {
  return (node.postconditions ?? []).filter((postcondition) => {
    const counter = COLLECTION_COUNTERS[postcondition.collection];
    if (!counter) return true;
    return counter(workspace) < postcondition.min;
  });
}

/** 人类可读的 postcondition 不足描述（供 trace / 显式报告使用）。 */
export function describePostconditionShortfall(node: ObligationNodeV21, workspace: ClinicalWorkspace): string[] {
  return unmetPostconditions(node, workspace).map((postcondition) => {
    const counter = COLLECTION_COUNTERS[postcondition.collection];
    const actual = counter ? counter(workspace) : 0;
    return `${postcondition.collection}: need >= ${postcondition.min}, have ${actual}`;
  });
}

/**
 * V2.1.1 观测：方剂候选已取得证据、但没有任何候选进入 deliberation frontier。
 *
 * 此时 `formula-evidence` 在结构上无法闭合（closure 要求 frontier ⊆ hydrated），而 hydration
 * 又无法自己创造 frontier，因此这是模型必须显式执行 `workspace.focus_candidates` 的状态。
 * 真实 E2E 已复现：模型连续 29 次 formula.get_evidence 而从不 focus → 义务永不闭合。
 * 这是「可执行但未执行的下一步」，不是可自动闭合的终态，因此不改变 closure 语义，只把它显式暴露。
 */
export function formulaFrontierPending(workspace: ClinicalWorkspace): boolean {
  const candidates = workspace.candidates.filter((c) => c.kind === 'formula');
  if (candidates.length === 0) return false;
  const frontier = workspace.deliberationState.frontier.filter((ref) => candidates.some((c) => c.id === ref));
  if (frontier.length > 0) return false;
  const hydrated = new Set(workspace.evidenceState.evidenceItems.flatMap((item) => item.relatedCandidates));
  return candidates.some((c) => hydrated.has(c.id));
}

/**
 * artifact 语义类别 → truth reader。
 * 全部按 artifact type 命名空间登记；不含任何 modality 词。
 */
const TRUTH_READERS: Record<string, TruthReader> = {
  // 临床核心：由 Minimum Clinical Core 结构完整性投影。
  'artifact:clinical-core': (_node, { workspace }) => checkClinicalCoreCompletion(workspace).ok ? 'SATISFIED' : 'OPEN',
  // 诊断证据：真实存在诊断类知识证据。
  'artifact:diagnostic-evidence': (_node, { workspace }) => workspace.evidenceState.evidenceItems.length > 0 ? 'SATISFIED' : 'OPEN',
  // 方剂证据：候选已聚焦且证据已展开（否则方剂检索保持开放）。
  'artifact:formula-evidence': (_node, { workspace }) => formulaEvidenceComplete(workspace) ? 'SATISFIED' : 'OPEN',
  // 方剂交付：durable formulaSelection 已选方**且**满足参数化完成要求（如 AT_LEAST N）。
  // cardinality 未满足时不得 closure —— 这里保持 OPEN，由 insufficiency 投影决定后续（见下）。
  'artifact:formula-selection': (node, { workspace }) => {
    if (!isArtifactSatisfied(workspace, 'formulaSelection')) return 'OPEN';
    return unmetPostconditions(node, workspace).length === 0 ? 'SATISFIED' : 'OPEN';
  },
  // 治疗证据：由声明 evidenceObligations 的能力闭环投影（outcome → capability）。
  'artifact:treatment-evidence': (node, { workspace, capabilities }) => {
    const capability = outcomeProvider(node, capabilities);
    if (!capability) return 'OPEN';
    return capabilityEvidenceTruth(capability, workspace) ?? 'OPEN';
  },
  // 治疗交付：由声明 deliveryObligations 的能力闭环投影（outcome → capability）。
  'artifact:treatment-delivery': (node, { workspace, capabilities }) => {
    const capability = outcomeProvider(node, capabilities);
    if (!capability) return 'OPEN';
    return capabilityDeliveryTruth(capability, workspace) ?? 'OPEN';
  },
};

/**
 * V2.1.2 —— KB 路径 typed insufficiency → model-generation 义务。
 *
 * 只有当（a）产物已形成但**参数化完成要求未满足**、（b）该 artifact 的 KB 路径确实已经穷尽
 * （adapter 从 durable state 判定）、（c）policy 声明了 generationFallback 时，才产生
 * model-generation 义务。KB 路径本身在此合法终止为 NOT_DELIVERABLE（typed insufficiency 记录在 blocker 上），
 * 因此「KB 不足」与「模型可以补」在图上显式分离，provenance 不会被抹平。
 *
 * 生成策略不允许模型生成时，model-generation 义务是 BLOCKED（required）→ 运行必须显式失败，
 * 不得假装满足 cardinality。
 */
export function projectInsufficiencyFallbacks(
  graph: ObligationGraphV21,
  workspace: ClinicalWorkspace,
  ir: ClinicalRequestIR,
  policy: ControlPlanePolicyV21,
): ObligationGraphV21 {
  const fallback = policy.generationFallback;
  if (!fallback) return graph;
  const allowsModel = ir.generationPolicy.knowledgeSource === fallback.requiresPolicy;
  const replaced = new Map<string, ObligationNodeV21>();
  const added: ObligationNodeV21[] = [];
  for (const node of graph.nodes) {
    if (node.status !== 'OPEN' || !node.required) continue;
    if (!fallback.artifactTypes.includes(node.target.type)) continue;
    const shortfall = describePostconditionShortfall(node, workspace);
    if (shortfall.length === 0) continue;
    if (!(KB_EXHAUSTION_READERS[node.target.type]?.(workspace) ?? false)) continue;
    const question = `knowledge base cannot satisfy ${node.target.type} (${shortfall.join('; ')}); `
      + `model generation ${allowsModel ? 'permitted' : 'not permitted'} by the request generation policy`;
    const key = ARTIFACT_KEYS[node.target.type];
    const provenance = PROVENANCE_READERS[node.target.type]?.(workspace);
    const modelSatisfied = Boolean(key) && isArtifactSatisfied(workspace, key)
      && provenance !== undefined && provenance !== 'KNOWLEDGE_BASE';
    replaced.set(node.id, {
      ...node,
      status: 'NOT_DELIVERABLE',
      blocker: { type: 'OTHER', question },
    });
    added.push({
      id: `insufficiency::${stableToken(node.id)}`,
      source: 'insufficiency',
      target: node.target,
      required: true,
      dependsOn: [],
      allowedEffects: [{ op: 'commit', target: node.target }],
      status: modelSatisfied ? 'SATISFIED' : (allowsModel ? 'OPEN' : 'BLOCKED'),
      rootOutcomes: [...node.rootOutcomes],
      parentObligationId: node.id,
      provenance: fallback.provenance,
      blocker: { type: 'OTHER', question },
    });
  }
  if (added.length === 0) return graph;
  return { ...graph, nodes: [...graph.nodes.map((node) => replaced.get(node.id) ?? node), ...added] };
}

/** 由 durable state 投影单个节点的终态。 */
export function nodeTruth(node: ObligationNodeV21, ctx: TruthContext): NodeTruth {
  if (node.source === 'blocker') return 'OPEN';
  if (node.source === 'insufficiency') {
    // V2.1.2：model-generation 义务只接受**标记为 model 来源**的 durable 产物。
    // 知识库来源的产物不得用来关闭它（否则 provenance 会被抹平）。
    const key = ARTIFACT_KEYS[node.target.type];
    const provenance = PROVENANCE_READERS[node.target.type]?.(ctx.workspace);
    if (!key || provenance === undefined || provenance === 'KNOWLEDGE_BASE') return 'OPEN';
    if (!isArtifactSatisfied(ctx.workspace, key)) return 'OPEN';
    return unmetPostconditions(node, ctx.workspace).length === 0 ? 'SATISFIED' : 'OPEN';
  }
  const reader = TRUTH_READERS[node.target.type];
  return reader ? reader(node, ctx) : 'OPEN';
}

/**
 * 把结构图（generic planner 产物）投影为**当前 durable state 下的真实 graph**：
 * - 已由 durable artifact 满足的节点 → SATISFIED；
 * - 合法终态（知识库确实无可用资产）→ NOT_DELIVERABLE，不阻塞完成，也不允许脱离知识库编造；
 * - 其余保持 OPEN，由 runnableObligationsV21 决定当前可执行义务。
 *
 * 关键不变式（artifact before phase）：一个 artifact **不得**在其 prerequisite 尚未 terminal 时关闭该义务。
 * 否则「提前写入 final artifact」会绕过依赖顺序，使证据义务形同虚设。
 */
export function projectGraphV21(
  structural: ObligationGraphV21,
  workspace: ClinicalWorkspace,
  capabilities: CapabilityDescriptor[],
): ObligationGraphV21 {
  const ctx: TruthContext = { workspace, capabilities };
  const byId = new Map(structural.nodes.map((node) => [node.id, node]));
  const resolved = new Map<string, NodeTruth>();

  const resolve = (node: ObligationNodeV21): NodeTruth => {
    const cached = resolved.get(node.id);
    if (cached) return cached;
    // 先占位，避免环导致无限递归（结构性环已由 planner 变成 BLOCKED 节点）。
    resolved.set(node.id, 'OPEN');
    if (node.status !== 'OPEN') {
      const terminal: NodeTruth = node.status === 'SATISFIED' ? 'SATISFIED' : node.status === 'NOT_DELIVERABLE' ? 'NOT_DELIVERABLE' : 'OPEN';
      resolved.set(node.id, terminal);
      return terminal;
    }
    const dependenciesTerminal = node.dependsOn.every((id) => {
      const dependency = byId.get(id);
      if (!dependency) return false;
      const status = resolve(dependency);
      return status === 'SATISFIED' || status === 'NOT_DELIVERABLE';
    });
    const truth = dependenciesTerminal ? nodeTruth(node, ctx) : 'OPEN';
    resolved.set(node.id, truth);
    return truth;
  };

  return {
    ...structural,
    nodes: structural.nodes.map((node) => {
      if (node.status !== 'OPEN') return node;
      const truth = resolve(node);
      if (truth === 'OPEN') return node;
      return { ...node, status: truth, blocker: undefined };
    }),
  };
}

/**
 * V2.1.1：施加 typed NEED_EVIDENCE 时**只增加**定向 gap 子义务，不得移除父义务自身的合法 effect。
 *
 * `applyTypedBlockerV21` 会把父义务标成 BLOCKED，而 BLOCKED 不在 runnableObligations 里，
 * 于是父义务自己的 commit effect 会从 legal effect surface 上消失。结果是：唯一能真正完成该义务的
 * 动作被删除，只剩「reopen 出来的检索」，而检索本身并不能直接让父义务 terminal —— 形成死锁，
 * 直到预算耗尽（真实 E2E 已复现：delivery 义务 BLOCKED + evidence-gap 检索空转）。
 *
 * typed blocker 的语义是「重新打开定向检索」，不是「撤销合成路径」。readiness 仍会因为该义务未 terminal
 * 而阻断提交，因此这里不放宽任何提交约束。
 */
function applyEvidenceGapBlocker(
  graph: ObligationGraphV21,
  obligationId: string,
  blocker: TypedBlockerV21,
): ObligationGraphV21 {
  const withChild = applyTypedBlockerV21(graph, obligationId, blocker);
  return {
    ...withChild,
    nodes: withChild.nodes.map((node) =>
      node.id === obligationId ? { ...node, status: 'OPEN' as const, blocker } : node),
  };
}

/**
 * Runtime 拥有的 typed blocker 施加（纯投影：每次刷新都由 durable state 重新判定是否仍然必要）。
 *
 * 模型不能自行「再搜一次」；只有 runtime 认定存在 NEED_EVIDENCE 时，才创建定向 evidence-gap 子义务。
 *
 * V2.1.1：图每次刷新都从结构图重建，因此 blocker 的**释放**必须在这里判定，而不能依赖上一轮的图里
 * 是否已存在 gap 子义务。释放条件 = 定向取证确实带来了新证据（evidenceVolume 超过施加时的快照），
 * 或父义务已合法终结。
 */
export function projectBlockersV21(
  graph: ObligationGraphV21,
  blockers: AppliedBlockerV21[],
  workspace: ClinicalWorkspace,
): ObligationGraphV21 {
  let next = graph;
  for (const applied of blockers) {
    const parent = next.nodes.find((n) => n.id === applied.obligationId);
    if (!parent) continue;
    const served = parent.status === 'SATISFIED'
      || parent.status === 'NOT_DELIVERABLE'
      || evidenceVolume(workspace) > applied.evidenceVersion;
    // blocker 已完成使命 → 不叠加 gap，也不保留 blocker 标记。
    if (served) continue;
    next = applyEvidenceGapBlocker(next, applied.obligationId, applied.blocker);
  }
  return next;
}

/** 定向证据检索的默认 effect（与 knowledge.search 的 V2.1 pattern 对齐；不含业务语义）。 */
export function targetedEvidenceEffect(): TypedBlockerV21['evidenceNeed'] {
  return { concepts: [], preferredEffect: { op: 'retrieve', target: { type: 'artifact:evidence-gap' } } };
}

/** 已满足的节点 → durable artifact envelope（供 Phase 8 确定性结果装配使用）。 */
export function collectBoundArtifactsV21(
  graph: ObligationGraphV21,
  workspace: ClinicalWorkspace,
): DurableArtifactEnvelopeV21[] {
  const artifacts: DurableArtifactEnvelopeV21[] = [];
  for (const node of graph.nodes) {
    if (node.status !== 'SATISFIED') continue;
    const evidenceRefs = node.target.type === 'artifact:treatment-evidence'
      ? (workspace.capabilityEvidenceClosures ?? [])
          .filter((c) => c.capabilityId === node.target.producerCapabilityId)
          .flatMap((c) => c.assetRefs)
      : [];
    // V2.1.2：来源必须随 artifact 一起落账（KNOWLEDGE_BASE / MODEL_GENERATED / HYBRID）。
    const provenance = node.provenance ?? artifactProvenance(node.target.type, workspace);
    artifacts.push({
      ...importedArtifact(node.target, { obligationId: node.id, status: node.status }, evidenceRefs),
      ...(provenance ? { provenance } : {}),
    });
  }
  return artifacts;
}
