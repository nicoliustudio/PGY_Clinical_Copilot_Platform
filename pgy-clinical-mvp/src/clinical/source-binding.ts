import type { CapabilityDeliveryObligation, ResolvedCapability } from '../contracts/capability.js';
import type { RuntimeContext } from '../contracts/runtime.js';
import type { SourceBindingReceipt } from '../contracts/workspace.js';
import { getRuntimeAsset } from '../knowledge/runtime-catalog.js';

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
  if (!owner) return { ok: false, code: 'NO_PROVIDER', details: [`no unique SOURCE_BOUND provider for ${outcome}`] };

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
