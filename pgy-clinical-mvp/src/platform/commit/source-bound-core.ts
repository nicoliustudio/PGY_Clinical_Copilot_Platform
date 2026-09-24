import type { CapabilityDeliveryObligation } from '../../contracts/capability.js';
import type { CommittedSourceBundle, CommittedSourceProduct } from '../../contracts/commit.js';
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

export type SourceBoundCoreResult =
  | {
      ok: true;
      product: Readonly<Record<string, unknown>>;
      sourceBundle: CommittedSourceBundle;
      sourceRefs: readonly string[];
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
  hydratedRefs: ReadonlySet<string>;
  resolveAsset: (ref: string) => Record<string, unknown> | null;
}): SourceBoundCoreResult {
  const requiredDraft = [...new Set([
    ...(input.obligation.requiredFields ?? []),
    ...(input.obligation.requiredFieldsByOutcome?.[input.outcome] ?? []),
  ])];
  const missingDraft = requiredDraft.filter((path) => !meaningful(readPath(input.decision, path)));
  if (missingDraft.length > 0) return { ok: false, code: 'MISSING_REQUIRED_FIELDS', details: missingDraft };

  const refs = [...new Set((input.decision.sourceAssetRefs ?? []).filter(Boolean))];
  // Retrieval/hydration and citation are evidence, not adoption. SOURCE_BOUND always requires an
  // explicit selection written to sourceAssetRefs; sourceEvidenceRefs can never silently promote
  // a merely-seen asset into product truth.
  if (refs.length === 0) {
    return {
      ok: false,
      code: 'SOURCE_BINDING_MISMATCH',
      details: ['SOURCE_BOUND delivery requires explicit sourceAssetRefs selection'],
    };
  }

  const products: CommittedSourceProduct[] = [];
  const missing: string[] = [];
  for (const [index, ref] of refs.entries()) {
    if (!input.hydratedRefs.has(ref)) return { ok: false, code: 'SOURCE_BINDING_MISMATCH', details: [`unhydrated source asset: ${ref}`] };
    const resolved = input.resolveAsset(ref);
    if (!resolved) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED', details: [`asset unavailable: ${ref}`] };
    // Commit owns an immutable snapshot, never the Runtime Catalog/cache object itself. CommitLedger
    // deep-freezes records; cloning here prevents that freeze from mutating shared catalog state.
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
      qualification: input.decision.disposition === 'CURRENTLY_NOT_SUITABLE'
        ? 'CLINICALLY_EXCLUDED'
        : (index === 0 ? 'PRIMARY_SELECTED' : 'SOURCE_ALTERNATIVE'),
      ...(input.decision.disposition === 'CURRENTLY_NOT_SUITABLE' ? { exclusionReason: input.decision.statement } : {}),
    });
  }
  if (missing.length > 0) return { ok: false, code: 'MISSING_REQUIRED_FIELDS', details: missing };

  return {
    ok: true,
    sourceRefs: refs,
    sourceBundle: {
      sourceId: refs.length === 1 ? refs[0] : `runtime-assets:${refs.join('+')}`,
      products,
      sourceFacts: {
        kind: 'RUNTIME_CATALOG_SOURCE_BOUND',
        assetRefs: refs,
        memberCount: products.length,
        // These are exact immutable snapshots for the explicitly adopted atomic assets. Do not
        // over-claim that a Runtime Catalog asset id represents every possible sibling in some
        // broader bibliographic collection; sibling completeness must be declared by that resolver.
        membershipCompleteness: 'COMPLETE_FOR_ADOPTED_ASSETS',
        contentHashes: Object.fromEntries(products.flatMap((product) => {
          const hash = product.payload.content_hash;
          return typeof hash === 'string' && hash.trim() ? [[product.productId, hash]] : [];
        })),
      },
    },
    product: {
      outcome: input.outcome,
      form: input.decision.form,
      disposition: input.decision.disposition,
      statement: input.decision.statement,
      sourceAssetRefs: refs,
      sourceEvidenceRefs: [...input.decision.sourceEvidenceRefs],
    },
  };
}
