import type { ClinicalRequestIR } from '../../control-plane-v2/types.js';
import type { CapabilityDescriptor } from '../../contracts/capability.js';
import type { AppliedBlockerV21, RuntimeContext } from '../../contracts/runtime.js';
import type { ClinicalWorkspace } from '../../contracts/workspace.js';
import type { DurableArtifactEnvelopeV21, EffectTerm, ObligationGraphV21, ObligationNodeV21 } from '../../control-plane-v21/types.js';
import { buildObligationGraphV21, effectiveRequestedOutcomesV21, graphCompleteV21, runnableObligationsV21 } from '../../control-plane-v21/planner.js';
import { admissibleEffectsV21, projectedToolIdsV21 } from '../../control-plane-v21/action-surface.js';
import { projectOutcomeCoverageV21, type OutcomeProjectionV21 } from '../../control-plane-v21/result-projection.js';
import type { ControlPlanePolicyV21 } from '../../control-plane-v21/types.js';
import { deriveCapabilityEvidenceClosures } from '../../clinical/capability-evidence.js';
import { deriveCapabilityDeliveryClosures } from '../../clinical/capability-delivery.js';
import type { CommitLedger } from '../commit/commit-ledger.js';
import {
  collectBoundArtifactsV21,
  evidenceVolume,
  projectBlockersV21,
  projectGraphV21,
  projectInsufficiencyFallbacks,
  targetedEvidenceEffect,
} from './artifact-bridge.js';

/**
 * Control Plane V2.1 Session —— 单一控制平面的运行期门面。
 *
 * 不变式：
 * 1. 图 = f(Request IR, enabled providers, durable Workspace state)。没有第二份手工维护的调度账本。
 * 2. 检索是否开放 = 当前 unmet/runnable obligation，而不是「搜了几次」。
 * 3. 只有 typed blocker 能创建定向 evidence obligation 并重新打开检索。
 * 4. 交付闭包绑定 obligationId + provider + semantic outcome，不因「某个通用 artifact 存在」而互相满足。
 */

/**
 * The compiled Request IR is immutable audit truth. Runtime adoption extends only the effective
 * required-outcome set; it never rewrites what the user originally requested/excluded.
 */
export function effectiveRequestIRV21(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
): ClinicalRequestIR {
  const adopted = state.adoptedOutcomes ?? [];
  if (adopted.length === 0) return state.requestIR;
  return {
    ...state.requestIR,
    outcomes: {
      ...state.requestIR.outcomes,
      required: [...new Set([...state.requestIR.outcomes.required, ...adopted])],
    },
  };
}

export function effectiveRequiredOutcomesV21(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
): string[] {
  return effectiveRequestedOutcomesV21(effectiveRequestIRV21(state), state.policy);
}

export function structuralGraphV21(
  requestIR: ClinicalRequestIR,
  capabilityDescriptors: CapabilityDescriptor[],
  policy: ControlPlanePolicyV21,
): ObligationGraphV21 {
  return buildObligationGraphV21(requestIR, capabilityDescriptors, policy);
}

/** 结构图 → durable state 投影 → typed blocker 叠加 → insufficiency/model-generation 义务。纯函数，可重复调用。 */
export function deriveGraphV21(
  requestIR: ClinicalRequestIR,
  capabilityDescriptors: CapabilityDescriptor[],
  workspace: ClinicalWorkspace,
  appliedBlockers: AppliedBlockerV21[],
  policy: ControlPlanePolicyV21,
  ledger?: CommitLedger,
): ObligationGraphV21 {
  const structural = structuralGraphV21(requestIR, capabilityDescriptors, policy);
  const withTruth = projectGraphV21(structural, workspace, capabilityDescriptors, ledger);
  const withBlockers = projectBlockersV21(withTruth, appliedBlockers, workspace);
  return projectInsufficiencyFallbacks(withBlockers, workspace, requestIR, policy);
}

/**
 * 每个 agent step 之前刷新 V2.1 状态。
 * 这是 V2.1 与 Workspace 的唯一同步点，因此不会出现「runtime 说没有义务、readiness 说缺一堆产物」。
 */
export function refreshControlPlaneV21(context: RuntimeContext): void {
  const state = context.controlPlaneV21;
  if (!state) return;
  // 先由 durable receipts 确定性重算证据/交付闭环，使图不依赖「readiness 是否已跑过」。
  // 与 evaluateProposalReadiness 使用同一对纯函数 → 同一真源、同一缺失集。
  const evidenceClosures = deriveCapabilityEvidenceClosures(
    context.capabilities,
    context.workspace.capabilityEvidenceReceipts,
  );
  context.workspace.capabilityEvidenceClosures = evidenceClosures;
  context.workspace.capabilityDeliveryClosures = deriveCapabilityDeliveryClosures(
    context.capabilities,
    context.workspace,
    evidenceClosures,
  );
  const graph = deriveGraphV21(
    effectiveRequestIRV21(state),
    state.capabilityDescriptors,
    context.workspace,
    state.appliedBlockers,
    state.policy,
    context.commitLedger,
  );
  state.graph = graph;
  state.durableArtifacts = collectBoundArtifactsV21(graph, context.workspace);
}

/** 当前可执行的 obligation（依赖已 terminal）。 */
export function openObligationsV21(state: NonNullable<RuntimeContext['controlPlaneV21']>): ObligationNodeV21[] {
  return state.graph.nodes.filter((node) => node.status === 'OPEN');
}

export function blockedObligationsV21(state: NonNullable<RuntimeContext['controlPlaneV21']>): ObligationNodeV21[] {
  return state.graph.nodes.filter((node) => node.status === 'BLOCKED');
}

/** 仍未满足的 required obligation —— readiness 的单一缺失集口径。 */
export function unmetObligationsV21(state: NonNullable<RuntimeContext['controlPlaneV21']>): ObligationNodeV21[] {
  return state.graph.nodes.filter((node) => node.required && node.status !== 'SATISFIED' && node.status !== 'NOT_DELIVERABLE');
}

export function graphComplete(state: NonNullable<RuntimeContext['controlPlaneV21']>): boolean {
  return graphCompleteV21(state.graph);
}

export function runnableObligations(state: NonNullable<RuntimeContext['controlPlaneV21']>): ObligationNodeV21[] {
  return runnableObligationsV21(state.graph);
}

export function admissibleEffects(state: NonNullable<RuntimeContext['controlPlaneV21']>): EffectTerm[] {
  return admissibleEffectsV21(state.graph);
}

/**
 * V2.1 action surface 投影（结构化 effect pattern 匹配）。
 * 只约束**声明了 V2.1 pattern 的工具**；未声明的工具（proposal.submit / capability.*）不受影响。
 */
export function v21ToolSurface(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
  toolIds: string[],
  patternsFor: (toolId: string) => EffectTerm[] | undefined,
): { allowed: string[]; closed: string[] } {
  const descriptors = toolIds
    .map((id) => ({ id, effectPatterns: patternsFor(id) ?? [] }))
    .filter((d) => d.effectPatterns.length > 0);
  const allowed = new Set(projectedToolIdsV21(state.graph, descriptors));
  const closed = toolIds.filter((id) => {
    const patterns = patternsFor(id);
    return patterns !== undefined && patterns.length > 0 && !allowed.has(id);
  });
  return { allowed: [...allowed], closed };
}

/**
 * 定向取证：当可执行的合成义务缺乏证据时，由 Runtime 创建 NEED_EVIDENCE 子义务。
 * 这是重新打开检索的**唯一**通道（不基于搜索次数阈值）。
 */
export function applyEvidenceNeedBlocker(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
  workspace: ClinicalWorkspace,
  obligationId: string,
  question: string,
  concepts: string[] = [],
): boolean {
  const node = state.graph.nodes.find((n) => n.id === obligationId);
  if (!node || node.status !== 'OPEN') return false;
  if (state.appliedBlockers.some((b) => b.obligationId === obligationId)) return false;
  const need = targetedEvidenceEffect();
  state.appliedBlockers.push({
    obligationId,
    evidenceVersion: evidenceVolume(workspace),
    blocker: { type: 'NEED_EVIDENCE', question, evidenceNeed: { ...need!, concepts } },
  });
  return true;
}

/** 最终结果装配输入：outcome coverage（确定性，不由模型重新总结）。 */
export function outcomeCoverage(state: NonNullable<RuntimeContext['controlPlaneV21']>): OutcomeProjectionV21[] {
  return projectOutcomeCoverageV21(state.graph, state.durableArtifacts);
}

/**
 * P0 Cutover：outcome coverage 的唯一 DELIVERED 真相来自 Kernel CommitLedger。
 * Workspace durableArtifacts / treatmentDeliveries / completion state 只能决定 NOT_DELIVERABLE/INCOMPLETE，
 * 不得再直接产生 DELIVERED。No matching CommitRecord → never DELIVERED。
 */
export function ledgerOutcomeCoverage(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
  ledger: CommitLedger,
): OutcomeProjectionV21[] {
  return outcomeCoverage(state).map((item) => {
    if (ledger.delivered(item.outcome).length > 0) return { ...item, status: 'DELIVERED' as const };
    if (item.status === 'DELIVERED') return { ...item, status: 'INCOMPLETE' as const };
    return item;
  });
}

/** P0：completion（satisfied）唯一真相 = graph terminal + CommitLedger。 */
export function ledgerContractSatisfied(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
  ledger: CommitLedger,
): boolean {
  const required = new Set(effectiveRequiredOutcomesV21(state));
  const coverage = ledgerOutcomeCoverage(state, ledger);
  return [...required].every((outcome) => coverage.find((item) => item.outcome === outcome)?.status === 'DELIVERED');
}

/** P0：resolved（terminal）唯一真相 = CommitLedger DELIVERED ∪ graph NOT_DELIVERABLE ∪ graph BLOCKED。 */
export function ledgerContractResolved(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
  ledger: CommitLedger,
): boolean {
  const required = new Set(effectiveRequiredOutcomesV21(state));
  return [...required].every((outcome) => {
    if (ledger.delivered(outcome).length > 0) return true;
    return state.graph.nodes.some((n) => n.rootOutcomes.includes(outcome) && (n.status === 'NOT_DELIVERABLE' || n.status === 'BLOCKED'));
  });
}


/**
 * Contract resolution and satisfaction are intentionally distinct.
 *
 * `resolved` means the required contract has reached a terminal state: every required
 * outcome's terminating obligation is non-OPEN. BLOCKED (unsupported / no provider /
 * unsatisfiable) is terminal — no legal effect can further improve satisfaction — so it is
 * `resolved` but NOT `satisfied`. OPEN means a legal effect could still advance the outcome.
 */
export function contractResolved(state: NonNullable<RuntimeContext['controlPlaneV21']>): boolean {
  const required = new Set(effectiveRequiredOutcomesV21(state));
  return [...required].every((outcome) => {
    // Mirror terminalNodesFor: prefer a node whose target carries the outcome qualifier,
    // else the shared unscoped root (e.g. clinical-core for the baseline assessment outcome).
    const requestNodes = state.graph.nodes.filter((n) =>
      n.rootOutcomes.includes(outcome) && (n.source === 'request' || n.source === 'insufficiency'));
    const scoped = requestNodes.filter((n) => n.target.qualifiers?.outcome === outcome);
    const roots = scoped.length > 0 ? scoped : requestNodes.filter((n) => n.target.qualifiers?.outcome === undefined);
    if (roots.length === 0) return false;
    return roots.every((n) => n.status !== 'OPEN');
  });
}

/** A required user contract is satisfied only when every required/baseline outcome is DELIVERED. */
export function contractSatisfied(state: NonNullable<RuntimeContext['controlPlaneV21']>): boolean {
  const required = new Set(effectiveRequiredOutcomesV21(state));
  const coverage = outcomeCoverage(state);
  return [...required].every((outcome) => coverage.find((item) => item.outcome === outcome)?.status === 'DELIVERED');
}

/** 交付终态（NOT_DELIVERABLE）的 outcome 列表：必须在最终结果中显式表达，而不是静默消失。 */
export function notDeliverableOutcomes(state: NonNullable<RuntimeContext['controlPlaneV21']>): string[] {
  return outcomeCoverage(state).filter((o) => o.status === 'NOT_DELIVERABLE').map((o) => o.outcome);
}

/**
 * obligation graph → readiness 使用的 workspace artifact key（Phase 7 单一真源）。
 *
 * 领域适配：planner 不认识这些名字，只有这里把「控制语义」映射成「durable artifact key」。
 * 效果：required artifacts 不再由 planner 的 provisional 预判决定，而是**由 Request IR + 图**决定，
 * 因此“用户明确只要针灸”时不会再被 planner 预判强行要求 formulaSelection。
 */
export function requiredArtifactsFromGraphV21(
  state: NonNullable<RuntimeContext['controlPlaneV21']>,
): string[] {
  const keys = new Set<string>();
  const descriptorOf = (capabilityId: string | undefined): CapabilityDescriptor | undefined =>
    state.capabilityDescriptors.find((c) => c.id === capabilityId);
  for (const node of state.graph.nodes) {
    if (!node.required) continue;
    const capabilityId = node.target.producerCapabilityId;
    const descriptor = descriptorOf(capabilityId);
    if (node.target.type === 'artifact:formula-selection') {
      keys.add('formulaSelection');
      continue;
    }
    // 证据/交付义务 id 一律来自 manifest 声明，不在 Core 里写死业务 id。
    if (node.target.type === 'artifact:treatment-evidence' && descriptor) {
      for (const ob of descriptor.evidenceObligations ?? []) {
        keys.add(`capabilityEvidence:${descriptor.id}:${ob.id}`);
      }
      continue;
    }
    if (node.target.type === 'artifact:treatment-draft' && descriptor) {
      for (const ob of descriptor.deliveryObligations ?? []) {
        keys.add(`capabilityDelivery:${descriptor.id}:${ob.id}`);
      }
      continue;
    }
    // clinical-core / diagnostic-evidence / formula-evidence 由结构检查与证据存在性覆盖，不额外登记 key。
  }
  return [...keys];
}

/** 未完成（INCOMPLETE）的 required outcome：提交必须被阻断。 */
export function incompleteOutcomes(state: NonNullable<RuntimeContext['controlPlaneV21']>): string[] {
  return outcomeCoverage(state).filter((o) => o.status === 'INCOMPLETE').map((o) => o.outcome);
}
