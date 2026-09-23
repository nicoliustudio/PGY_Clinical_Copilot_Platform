import type { CapabilityDeliveryObligation, ResolvedCapability } from '../contracts/capability.js';
import type {
  CapabilityDeliveryClosure,
  CapabilityEvidenceClosure,
  ClinicalWorkspace,
} from '../contracts/workspace.js';
import { isArtifactSatisfied } from '../platform/workspace/clinical-workspace.js';

/**
 * H15.9 / Phase 3.5 Capability Delivery Obligation —— 通用治疗交付闭环（metadata 驱动，obligation-level）。
 *
 * 核心不变式：
 * - Capability Activated ≠ Evidence Acquired ≠ Delivery Completed。
 * - Evidence Closure 回答「知识有没有真的取得」；Delivery Closure 回答「用户要求的治疗结果有没有真的形成」。
 * - DELIVERED 必须由 durable artifact satisfaction（isArtifactSatisfied）投影，不由模型声明。
 * - NOT_DELIVERABLE 是合法终态：依赖的证据义务全部 SEARCHED_NONE 时，交付可合法地「无可支持资产」，
 *   不阻塞 readiness，也不允许模型脱离知识库编造方案。
 */

/** readiness 使用的 delivery artifact key（capabilityDelivery:<capabilityId>:<obligationId>）。 */


function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function meaningful(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/** Manifest-driven product completeness. Core never branches on modality names. */
export function requiredDeliveryFields(
  obligation: CapabilityDeliveryObligation,
  outcome?: string,
): string[] {
  return [...new Set([
    ...(obligation.requiredFields ?? []),
    ...(outcome ? (obligation.requiredFieldsByOutcome?.[outcome] ?? []) : []),
  ])];
}

export function missingRequiredDeliveryFields(
  delivery: Record<string, unknown>,
  obligation: CapabilityDeliveryObligation,
  outcome?: string,
): string[] {
  return requiredDeliveryFields(obligation, outcome).filter((field) => !meaningful(readPath(delivery, field)));
}

export function deliverySatisfiesObligation(
  delivery: Record<string, unknown>,
  obligation: CapabilityDeliveryObligation,
  outcome?: string,
): boolean {
  return missingRequiredDeliveryFields(delivery, obligation, outcome).length === 0;
}

export interface DeliveryCompleteness {
  complete: boolean;
  capabilityId?: string;
  obligationId?: string;
  missingFields: string[];
}

/** Resolve the unique semantic owner and evaluate its manifest-declared product schema. */
export function treatmentDeliveryCompleteness(
  capabilities: ResolvedCapability[],
  delivery: Record<string, unknown>,
): DeliveryCompleteness {
  const outcome = typeof delivery.outcome === 'string' ? delivery.outcome.trim() : '';
  const owners = capabilities.flatMap((capability) => {
    if (outcome && !capability.provides?.includes(outcome)) return [];
    return (capability.deliveryObligations ?? []).map((obligation) => ({ capability, obligation }));
  });
  if (owners.length !== 1) return { complete: false, missingFields: outcome ? ['semanticOwner'] : ['outcome'] };
  const [{ capability, obligation }] = owners;
  const missingFields = missingRequiredDeliveryFields(delivery, obligation, outcome || undefined);
  return { complete: missingFields.length === 0, capabilityId: capability.id, obligationId: obligation.id, missingFields };
}

export function deliveryArtifactKey(capabilityId: string, obligationId: string): string {
  return `capabilityDelivery:${capabilityId}:${obligationId}`;
}

/** 解析 delivery artifact key → { capabilityId, obligationId }。 */
export function parseDeliveryArtifactKey(artifact: string): { capabilityId: string; obligationId: string } | null {
  if (!artifact.startsWith('capabilityDelivery:')) return null;
  const rest = artifact.slice('capabilityDelivery:'.length);
  const idx = rest.lastIndexOf(':');
  if (idx <= 0) return null;
  return { capabilityId: rest.slice(0, idx), obligationId: rest.slice(idx + 1) };
}

/** Return all durable treatment-delivery payloads, with legacy single-value compatibility. */
export function treatmentDeliveryArtifacts(workspace: ClinicalWorkspace) {
  const plan = workspace.clinicalDecisionSpine.treatmentPlan;
  if (!plan) return [];
  if ((plan.treatmentDeliveries?.length ?? 0) > 0) return plan.treatmentDeliveries ?? [];
  return plan.treatmentFormDecision ? [plan.treatmentFormDecision] : [];
}

/**
 * Backward-compatible single outcome accessor. New closure logic consumes all deliveries.
 */
export function declaredArtifactOutcome(workspace: ClinicalWorkspace, artifact: string): string | undefined {
  if (artifact !== 'treatmentFormDecision') return undefined;
  const outcomes = treatmentDeliveryArtifacts(workspace)
    .map((x) => x.outcome?.trim())
    .filter((x): x is string => Boolean(x));
  return outcomes.length === 1 ? outcomes[0] : undefined;
}

export interface AttributedDelivery {
  capabilityId: string;
  obligationId: string;
  artifactRef: string;
  outcome?: string;
}

/**
 * V2.1.1 multi-value attribution.
 *
 * treatmentFormDecision is a legacy artifact key, but its durable payload is now a collection.
 * Every payload is attributed independently by semantic outcome. One delivery can close exactly
 * one provider/obligation; two deliveries can close two modalities in the same run.
 *
 * Historical single-capability runs without an outcome remain supported only when ownership is
 * unambiguous. Multi-capability runs without explicit outcome fail closed.
 */
export function attributeDeliveryObligations(
  capabilities: ResolvedCapability[],
  workspace: ClinicalWorkspace,
): AttributedDelivery[] {
  const groups = new Map<string, AttributedDelivery[]>();
  for (const c of capabilities) {
    for (const ob of c.deliveryObligations ?? []) {
      if (!isArtifactSatisfied(workspace, ob.requiredArtifact)) continue;
      const bucket = groups.get(ob.requiredArtifact) ?? [];
      bucket.push({ capabilityId: c.id, obligationId: ob.id, artifactRef: ob.requiredArtifact });
      groups.set(ob.requiredArtifact, bucket);
    }
  }

  const out: AttributedDelivery[] = [];
  const seen = new Set<string>();
  const push = (value: AttributedDelivery) => {
    const key = `${value.capabilityId}::${value.obligationId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  for (const [artifactRef, candidates] of groups) {
    if (artifactRef !== 'treatmentFormDecision') {
      // Generic artifact types retain the historical unambiguous-only rule.
      if (candidates.length === 1) push(candidates[0]);
      continue;
    }

    const deliveries = treatmentDeliveryArtifacts(workspace);
    if (deliveries.length === 0) continue;
    for (const delivery of deliveries) {
      const outcome = delivery.outcome?.trim();
      if (outcome) {
        const owners = candidates.filter((candidate) => {
          const capability = capabilities.find((c) => c.id === candidate.capabilityId);
          if (capability?.provides?.includes(outcome) !== true) return false;
          const obligation = capability.deliveryObligations?.find((ob) => ob.id === candidate.obligationId);
          return obligation !== undefined
            && deliverySatisfiesObligation(delivery as unknown as Record<string, unknown>, obligation, outcome);
        });
        if (owners.length === 1) push({ ...owners[0], outcome });
        continue;
      }
      // Legacy compatibility: only one possible owner may consume an untyped single delivery,
      // and even then its manifest-declared completeness requirements must be satisfied.
      if (candidates.length === 1 && deliveries.length === 1) {
        const candidate = candidates[0];
        const capability = capabilities.find((c) => c.id === candidate.capabilityId);
        const obligation = capability?.deliveryObligations?.find((ob) => ob.id === candidate.obligationId);
        if (obligation && deliverySatisfiesObligation(delivery as unknown as Record<string, unknown>, obligation)) push(candidate);
      }
    }
  }
  return out;
}

/**
 * 由 durable artifact satisfaction + 证据 closure 投影 delivery closure（纯函数，terminal 状态）。
 * - 归属成功 → DELIVERED（真实 durable state，非模型文本；且只归属唯一义务）。
 * - 依赖的证据义务全部 SEARCHED_NONE → NOT_DELIVERABLE（合法终态）。
 * - 否则不产生 closure（readiness 视为未满足，缺失 delivery artifact）。
 */
export function deriveCapabilityDeliveryClosures(
  capabilities: ResolvedCapability[],
  workspace: ClinicalWorkspace,
  evidenceClosures: CapabilityEvidenceClosure[],
): CapabilityDeliveryClosure[] {
  const out: CapabilityDeliveryClosure[] = [];
  const attributed = attributeDeliveryObligations(capabilities, workspace);
  for (const c of capabilities) {
    for (const ob of c.deliveryObligations ?? []) {
      const owned = attributed.find((a) => a.capabilityId === c.id && a.obligationId === ob.id);
      if (owned) {
        out.push({ capabilityId: c.id, obligationId: ob.id, status: 'DELIVERED', artifactRef: ob.requiredArtifact });
        continue;
      }
      const depIds = ob.dependsOnEvidenceObligationIds ?? (c.evidenceObligations ?? []).map((e) => e.id);
      const allSearchedNone = depIds.length > 0 && depIds.every((eid) => {
        const ev = evidenceClosures.find((x) => x.capabilityId === c.id && x.obligationId === eid);
        return ev !== undefined && ev.status === 'SEARCHED_NONE';
      });
      if (allSearchedNone) {
        out.push({ capabilityId: c.id, obligationId: ob.id, status: 'NOT_DELIVERABLE' });
      }
    }
  }
  return out;
}

/** readiness 判断：一个 required capabilityDelivery artifact 是否已有合法 terminal delivery closure。 */
export function isDeliveryClosureTerminal(closure: CapabilityDeliveryClosure | undefined): boolean {
  return closure !== undefined
    && (closure.status === 'DELIVERED' || closure.status === 'NOT_DELIVERABLE');
}
