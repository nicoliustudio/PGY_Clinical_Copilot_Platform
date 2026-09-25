import type { CapabilityDeliveryObligation } from '../../contracts/capability.js';
import type { ClinicalApplicability, CommittedSourceBundle, CommittedSourceProduct } from '../../contracts/commit.js';
import type { TreatmentFormDecision } from '../../contracts/workspace.js';

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

function requiredSourceFields(obligation: CapabilityDeliveryObligation, outcome: string): string[] {
  return [...new Set([
    ...(obligation.sourceRequiredFields ?? []),
    ...(obligation.sourceRequiredFieldsByOutcome?.[outcome] ?? []),
  ])];
}

function assetName(asset: Record<string, unknown>, ref: string): string {
  for (const key of ['title', 'name', 'asset_id']) {
    const value = asset[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return ref;
}

function clinicalApplicability(decision: TreatmentFormDecision): ClinicalApplicability {
  if (decision.disposition === 'TREAT_FIRST_THEN_FORM') return 'DEFERRED';
  if (decision.disposition === 'CURRENTLY_NOT_SUITABLE') return 'CURRENTLY_NOT_SUITABLE';
  return 'CURRENTLY_SUITABLE';
}

export type SourceBoundCoreResult =
  | {
      ok: true;
      product: Readonly<Record<string, unknown>>;
      sourceBundle: CommittedSourceBundle;
      sourceRefs: readonly string[];
      clinicalApplicability: ClinicalApplicability;
    }
  | {
      ok: false;
      code: 'CANONICAL_HYDRATION_FAILED' | 'SOURCE_BINDING_MISMATCH' | 'MISSING_REQUIRED_FIELDS';
      details?: readonly string[];
    };

/** Pure closed-world materialization. The resolver must return the exact canonical asset for ref. */
export function materializeSourceBoundAssets(input: {
  obligation: CapabilityDeliveryObligation;
  outcome: string;
  decision: TreatmentFormDecision;
  /** Kernel SourceBindingReceipt membership; never a model-authored DTO field. */
  boundRefs: readonly string[];
  hydratedRefs: ReadonlySet<string>;
  resolveAsset: (ref: string) => Record<string, unknown> | null;
}): SourceBoundCoreResult {
  const requiredDraft = [...new Set([
    ...(input.obligation.requiredFields ?? []),
    ...(input.obligation.requiredFieldsByOutcome?.[input.outcome] ?? []),
  ])];
  const missingDraft = requiredDraft.filter((path) => !meaningful(readPath(input.decision, path)));
  if (missingDraft.length > 0) return { ok: false, code: 'MISSING_REQUIRED_FIELDS', details: missingDraft };

  const refs = [...new Set(input.boundRefs.filter(Boolean))];
  if (refs.length === 0) {
    return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: ['SOURCE_BOUND delivery requires a Kernel SourceBindingReceipt'] };
  }

  const applicability = clinicalApplicability(input.decision);
  const products: CommittedSourceProduct[] = [];
  const missing: string[] = [];
  for (const [index, ref] of refs.entries()) {
    if (!input.hydratedRefs.has(ref)) return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: [`unhydrated source asset: ${ref}`] };
    const resolved = input.resolveAsset(ref);
    if (!resolved) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED', details: [`asset unavailable: ${ref}`] };
    // Commit owns an immutable snapshot, never the Runtime Catalog/cache object itself.
    const asset = structuredClone(resolved) as Record<string, unknown>;
    if (typeof asset.asset_id === 'string' && asset.asset_id !== ref) {
      return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: [`asset identity mismatch: requested=${ref}, hydrated=${asset.asset_id}`] };
    }
    for (const path of requiredSourceFields(input.obligation, input.outcome)) {
      if (!meaningful(readPath(asset, path))) missing.push(`${ref}:${path}`);
    }
    products.push({
      productId: ref,
      name: assetName(asset, ref),
      payload: asset,
      // membership/selection and patient applicability are separate axes.
      qualification: index === 0 ? 'PRIMARY_SELECTED' : 'SOURCE_ALTERNATIVE',
      clinicalApplicability: applicability,
    });
  }
  if (missing.length > 0) return { ok: false, code: 'MISSING_REQUIRED_FIELDS', details: missing };

  return {
    ok: true,
    sourceRefs: refs,
    clinicalApplicability: applicability,
    sourceBundle: {
      sourceId: refs.length === 1 ? refs[0] : `runtime-assets:${refs.join('+')}`,
      products,
      sourceFacts: {
        kind: 'RUNTIME_CATALOG_SOURCE_BOUND',
        assetRefs: refs,
        memberCount: products.length,
        membershipCompleteness: 'COMPLETE_FOR_ADOPTED_ASSETS',
        contentHashes: Object.fromEntries(products.flatMap((product) => {
          const hash = product.payload.content_hash;
          return typeof hash === 'string' && hash.trim() ? [[product.productId, hash]] : [];
        })),
      },
    },
    // Keep source-owned execution facts exclusively inside sourceBundle.payload. The reasoning
    // statement remains in Workspace for clinical rationale but is not a competing product truth.
    product: {
      outcome: input.outcome,
      form: input.decision.form,
      clinicalApplicability: applicability,
      sourceBindingRefs: refs,
      sourceEvidenceRefs: [...input.decision.sourceEvidenceRefs],
    },
  };
}
