import type { CapabilityDeliveryObligation, ResolvedCapability } from '../contracts/capability.js';
import type { RuntimeContext } from '../contracts/runtime.js';
import type { SourceBindingReceipt } from '../contracts/workspace.js';
import { getRuntimeAsset } from '../knowledge/runtime-catalog.js';
import { deliveryOutcomesFromGraphV21 } from '../platform/control-plane/control-plane-v21-session.js';

export interface SourceBoundOwner {
  capability: ResolvedCapability;
  obligation: CapabilityDeliveryObligation;
}

export function resolveSourceBoundOwner(context: RuntimeContext, outcome: string): SourceBoundOwner | null {
  const providers = context.capabilities.filter((capability) => capability.provides?.includes(outcome));
  if (providers.length !== 1) return null;
  const capability = providers[0];
  const obligations = (capability.deliveryObligations ?? []).filter((obligation) => obligation.materialization === 'SOURCE_BOUND');
  if (obligations.length !== 1) return null;
  return { capability, obligation: obligations[0] };
}

/**
 * 本次 run 中「确实可以 source.bind 的 exact outcome」清单。
 *
 * 由 obligation graph 的 treatment-delivery 义务派生（canonical outcome 词汇表），再用 resolveSourceBoundOwner
 * 过滤出当前有能力承接 SOURCE_BOUND 交付的那些。纯结构派生：没有硬编码业务 modality 名单，
 * 新增治疗形式只改 manifest。仅用于把失败原因表述成模型可自纠的反馈，不参与任何归属判定。
 */
export function sourceBindableOutcomes(context: RuntimeContext): string[] {
  const state = context.controlPlaneV21;
  if (!state) return [];
  return deliveryOutcomesFromGraphV21(state).filter((outcome) => resolveSourceBoundOwner(context, outcome) !== null);
}

/** Runtime-owned hydration evidence allowed to participate in this exact delivery obligation. */
export function hydratedSourceRefs(
  context: RuntimeContext,
  capability: ResolvedCapability,
  obligation: CapabilityDeliveryObligation,
): Set<string> {
  const hydrated = new Set<string>();
  const dependencyIds = new Set(
    obligation.dependsOnEvidenceObligationIds
      ?? (capability.evidenceObligations ?? []).map((item) => item.id),
  );
  const allowedHydrationTools = new Set(
    (capability.evidenceObligations ?? [])
      .filter((item) => dependencyIds.has(item.id))
      .flatMap((item) => item.hydrationToolIds ?? []),
  );
  for (const scope of capability.knowledgeScopes ?? []) {
    const receipt = context.workspace.capabilityEvidenceReceipts?.[scope];
    if (!receipt) continue;
    for (const [toolId, ids] of Object.entries(receipt.hydrationByTool)) {
      if (allowedHydrationTools.size > 0 && !allowedHydrationTools.has(toolId)) continue;
      for (const id of ids) hydrated.add(id);
    }
  }
  return hydrated;
}

export type SourceBindingResult =
  | { ok: true; receipt: SourceBindingReceipt; reused: boolean }
  | { ok: false; code: 'NO_PROVIDER' | 'SOURCE_BINDING_MISMATCH' | 'CANONICAL_HYDRATION_FAILED' | 'SOURCE_ALREADY_BOUND'; details: string[] };

/**
 * Candidate/evidence → canonical adoption transaction.
 *
 * The model may request this transaction with an exact outcome + hydrated asset id. Only Runtime validates
 * the hydration receipt, capability ownership, source identity and content hash, then writes the durable
 * SourceBindingReceipt. Generic reasoning DTOs never receive authority to manufacture source membership.
 */
export function bindCanonicalSources(
  context: RuntimeContext,
  outcome: string,
  requestedAssetRefs: string[],
  resolveAsset: (assetId: string, scopes: string[]) => Record<string, unknown> | null = getRuntimeAsset,
): SourceBindingResult {
  const owner = resolveSourceBoundOwner(context, outcome);
  if (!owner) {
    // 归属失败必须可自纠：把本 run 合法的 exact outcome 告诉调用方，避免模型用内部 artifact 拼写
    // 反复重试（同一失败无进展 → 触发 no_progress 终止）。词汇表由 graph/manifest 派生，不含业务枚举。
    const allowed = sourceBindableOutcomes(context);
    return {
      ok: false,
      code: 'NO_PROVIDER',
      details: [
        `no unique SOURCE_BOUND provider for outcome: ${outcome}`,
        ...(allowed.length > 0
          ? [`legal source-bindable outcomes (copy one exactly): ${allowed.join(', ')}`]
          : ['no SOURCE_BOUND treatment outcome is available in the current contract']),
      ],
    };
  }

  const assetRefs = [...new Set(requestedAssetRefs.map((ref) => ref.trim()).filter(Boolean))];
  if (assetRefs.length === 0) {
    return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: ['source.bind requires at least one hydrated canonical asset'] };
  }

  const existing = context.workspace.sourceBindingReceipts?.[outcome];
  if (existing) {
    const same = existing.capabilityId === owner.capability.id
      && existing.assetRefs.length === assetRefs.length
      && existing.assetRefs.every((ref, index) => ref === assetRefs[index]);
    if (same) return { ok: true, receipt: existing, reused: true };
    return {
      ok: false,
      code: 'SOURCE_ALREADY_BOUND',
      details: [`${outcome} already bound to ${existing.assetRefs.join(', ')}`],
    };
  }

  const hydrated = hydratedSourceRefs(context, owner.capability, owner.obligation);
  const contentHashes: Record<string, string> = {};
  for (const ref of assetRefs) {
    if (!hydrated.has(ref)) {
      return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: [`asset was not hydrated for this obligation: ${ref}`] };
    }
    const asset = resolveAsset(ref, owner.capability.knowledgeScopes ?? context.knowledgeScopes);
    if (!asset) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED', details: [`asset unavailable in provider scope: ${ref}`] };
    if (typeof asset.asset_id === 'string' && asset.asset_id !== ref) {
      return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: [`asset identity mismatch: requested=${ref}, hydrated=${asset.asset_id}`] };
    }
    if (typeof asset.content_hash === 'string' && asset.content_hash.trim()) contentHashes[ref] = asset.content_hash;
  }

  const receipt: SourceBindingReceipt = {
    outcome,
    capabilityId: owner.capability.id,
    assetRefs,
    contentHashes,
    workspaceVersion: context.workspaceStore.version + 1,
  };
  context.workspaceStore.append('source.binding.recorded', receipt as unknown as Record<string, unknown>);
  return { ok: true, receipt, reused: false };
}
