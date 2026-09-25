import type { CapabilityDeliveryObligation, ResolvedCapability } from '../../contracts/capability.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { treatmentDeliveryArtifacts } from '../../clinical/capability-delivery.js';
import { getRuntimeAsset } from '../../knowledge/runtime-catalog.js';
import { hydratedSourceRefs } from '../../clinical/source-binding.js';
import { materializeSourceBoundAssets, type SourceBoundCoreResult } from './source-bound-core.js';

export type SourceBoundMaterializationResult =
  | ({ ok: true; providerId: string } & Extract<SourceBoundCoreResult, { ok: true }>)
  | Extract<SourceBoundCoreResult, { ok: false }>;

/**
 * Runtime adapter: source binding is consumed from a Kernel-owned SourceBindingReceipt.
 * Hydration proves evidence acquisition; source.bind proves adoption. Neither reasoning text nor
 * treatmentPlan.sourceAssetRefs can silently manufacture canonical membership.
 */
export function materializeSourceBoundProduct(
  context: RuntimeContext,
  capability: ResolvedCapability,
  obligation: CapabilityDeliveryObligation,
  outcome: string,
): SourceBoundMaterializationResult {
  const decision = treatmentDeliveryArtifacts(context.workspace).find((item) => item.outcome === outcome);
  if (!decision) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
  const binding = context.workspace.sourceBindingReceipts?.[outcome];
  if (!binding || binding.capabilityId !== capability.id) {
    return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: [`missing Kernel SourceBindingReceipt for ${outcome}`] };
  }
  const result = materializeSourceBoundAssets({
    obligation,
    outcome,
    decision,
    boundRefs: binding.assetRefs,
    hydratedRefs: hydratedSourceRefs(context, capability, obligation),
    resolveAsset: (ref) => getRuntimeAsset(ref, capability.knowledgeScopes ?? context.knowledgeScopes),
  });
  return result.ok ? { ...result, providerId: capability.id } : result;
}
