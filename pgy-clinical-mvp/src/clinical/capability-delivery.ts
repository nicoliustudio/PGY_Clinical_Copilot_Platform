import type { ResolvedCapability } from '../contracts/capability.js';
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

/** 当前已激活且声明交付义务的 capability → readiness 必须验证的 artifact keys（obligation 粒度）。 */
export function deriveRequiredDeliveryArtifacts(capabilities: ResolvedCapability[]): string[] {
  const keys: string[] = [];
  for (const c of capabilities) {
    for (const ob of c.deliveryObligations ?? []) {
      keys.push(deliveryArtifactKey(c.id, ob.id));
    }
  }
  return keys;
}

/**
 * 由 durable artifact satisfaction + 证据 closure 投影 delivery closure（纯函数，terminal 状态）。
 * - requiredArtifact 已满足 → DELIVERED（真实 durable state，非模型文本）。
 * - 依赖的证据义务全部 SEARCHED_NONE → NOT_DELIVERABLE（合法终态）。
 * - 否则不产生 closure（readiness 视为未满足，缺失 delivery artifact）。
 */
export function deriveCapabilityDeliveryClosures(
  capabilities: ResolvedCapability[],
  workspace: ClinicalWorkspace,
  evidenceClosures: CapabilityEvidenceClosure[],
): CapabilityDeliveryClosure[] {
  const out: CapabilityDeliveryClosure[] = [];
  for (const c of capabilities) {
    for (const ob of c.deliveryObligations ?? []) {
      if (isArtifactSatisfied(workspace, ob.requiredArtifact)) {
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
