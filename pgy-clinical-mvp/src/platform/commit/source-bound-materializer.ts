import type { CapabilityDeliveryObligation, ResolvedCapability } from '../../contracts/capability.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { treatmentDeliveryArtifacts } from '../../clinical/capability-delivery.js';
import { getRuntimeAsset } from '../../knowledge/runtime-catalog.js';
import { materializeSourceBoundAssets, type SourceBoundCoreResult } from './source-bound-core.js';

function hydratedAssetRefs(
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

export type SourceBoundMaterializationResult =
  | ({ ok: true; providerId: string } & Extract<SourceBoundCoreResult, { ok: true }>)
  | Extract<SourceBoundCoreResult, { ok: false }>;

/** Runtime adapter: receipts prove hydration; pure core binds and preserves exact asset payloads. */
export function materializeSourceBoundProduct(
  context: RuntimeContext,
  capability: ResolvedCapability,
  obligation: CapabilityDeliveryObligation,
  outcome: string,
): SourceBoundMaterializationResult {
  const decision = treatmentDeliveryArtifacts(context.workspace).find((item) => item.outcome === outcome);
  if (!decision) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
  const result = materializeSourceBoundAssets({
    obligation,
    outcome,
    decision,
    hydratedRefs: hydratedAssetRefs(context, capability, obligation),
    resolveAsset: (ref) => getRuntimeAsset(ref, capability.knowledgeScopes ?? context.knowledgeScopes),
  });
  return result.ok ? { ...result, providerId: capability.id } : result;
}
