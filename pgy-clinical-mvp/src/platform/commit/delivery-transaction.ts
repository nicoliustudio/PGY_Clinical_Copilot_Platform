import type { CapabilityDeliveryObligation } from '../../contracts/capability.js';
import type {
  CommitResult,
  CommittedSourceBundle,
  CommittedSourceProduct,
  FieldPresence,
  FactField,
} from '../../contracts/commit.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { SourceFormulaSet } from '../../contracts/workspace.js';
import { treatmentDeliveryArtifacts, treatmentDeliveryCompleteness } from '../../clinical/capability-delivery.js';
import { getCanonicalFormula, validateNormativeFormula } from '../../clinical/formula.js';
import { hydrateSourceFormulaSet } from '../../clinical/source-formula-set.js';
import { loadIndex } from '../../knowledge/build.js';
import { CandidateHandleRegistry, type CandidateTruth } from './candidate-handle-registry.js';
import { CommitCoordinator, type CommitEnvironment } from './commit-coordinator.js';
import { materializeSourceBoundProduct } from './source-bound-materializer.js';

function fact<T>(presence: FieldPresence, value: T | undefined, provenanceRefs: readonly string[]): FactField<T> {
  if (presence === 'PRESENT' && value !== undefined) return { presence, value, provenanceRefs };
  if (presence === 'KNOWN_EMPTY') return { presence, provenanceRefs };
  return { presence: 'UNKNOWN', provenanceRefs };
}

function sourceBundleFromSet(context: RuntimeContext, set: SourceFormulaSet): CommittedSourceBundle {
  const patientPlan = context.workspace.clinicalDecisionSpine.modificationPlan;
  const patientItems = patientPlan?.items ?? [];
  const products: CommittedSourceProduct[] = set.formulas.map((formula) => {
    const isPrimary = formula.relation === 'PRIMARY_SELECTED';
    const compositionPresence = formula.compositionPresence ?? (formula.composition.trim() ? 'PRESENT' : 'UNKNOWN');
    const localPresence = formula.formulaLocalModificationPresence
      ?? (formula.sourceModifications.length > 0 ? 'PRESENT' : 'UNKNOWN');
    const sharedPresence = set.sourceLevelModificationPresence
      ?? (set.sourceLevelModifications.length > 0 ? 'PRESENT' : 'UNKNOWN');
    const preparationPresence = formula.preparationPresence
      ?? (formula.preparation === undefined ? 'UNKNOWN' : formula.preparation.trim() ? 'PRESENT' : 'KNOWN_EMPTY');
    const usagePresence = formula.usagePresence
      ?? (formula.usage === undefined ? 'UNKNOWN' : formula.usage.trim() ? 'PRESENT' : 'KNOWN_EMPTY');
    const patientPresence: FieldPresence = !isPrimary
      ? 'UNKNOWN'
      : (patientPlan === undefined ? 'UNKNOWN' : (patientItems.length > 0 ? 'PRESENT' : 'KNOWN_EMPTY'));

    return {
      productId: formula.formulaId,
      name: formula.formulaName,
      payload: {
        formulaRef: formula.formulaRef,
        composition: fact(compositionPresence, compositionPresence === 'PRESENT' ? formula.composition : undefined, [set.parentRecordRef]),
        preparation: fact(preparationPresence, preparationPresence === 'PRESENT' ? formula.preparation : undefined, [set.parentRecordRef]),
        usage: fact(usagePresence, usagePresence === 'PRESENT' ? formula.usage : undefined, [set.parentRecordRef]),
        ...(formula.caseContext ? { caseContext: Object.freeze({ ...formula.caseContext }) } : {}),
        modifications: {
          formulaLocal: fact(localPresence, localPresence === 'PRESENT' ? formula.sourceModifications : undefined, [formula.formulaRef]),
          sourceShared: fact(sharedPresence, sharedPresence === 'PRESENT' ? set.sourceLevelModifications : undefined, [set.parentRecordRef]),
          patientSpecific: fact(
            patientPresence,
            patientPresence === 'PRESENT'
              ? patientItems.map((item) => ({
                  statement: item.statement,
                  patientEvidenceRefs: [...item.patientEvidenceRefs],
                  sourceEvidenceRefs: [...(item.sourceEvidenceRefs ?? [])],
                }))
              : undefined,
            patientPresence === 'PRESENT'
              ? patientItems.flatMap((item) => [...item.patientEvidenceRefs, ...(item.sourceEvidenceRefs ?? [])])
              : [],
          ),
        },
      },
      qualification: formula.relation,
      ...(formula.exclusionReason ? { exclusionReason: formula.exclusionReason } : {}),
    };
  });

  return {
    sourceId: set.parentRecordRef,
    products,
    sourceFacts: {
      disease: set.disease,
      syndrome: set.syndrome,
      treatmentMethod: set.treatmentMethod,
      membershipCompleteness: set.completeness,
      sourceKind: set.sourceKind ?? 'P1_NORMATIVE_SOURCE',
      sourceAuthority: set.sourceAuthority ?? 'P1',
      ...(set.sourceCaseRef ? { sourceCaseRef: set.sourceCaseRef } : {}),
    },
  };
}

/**
 * Convert durable SourceFormulaSet truth into the exact canonical product identity used at commit.
 *
 * Retrieval/selection candidate identities are intentionally NOT parsed here. A SOURCE_NODE candidate
 * and a formula product are different identities; only the Kernel-materialized SourceFormulaSet may
 * choose the primary product that crosses the commit boundary.
 */
export function canonicalCandidateTruthFromSourceFormulaSet(set: SourceFormulaSet): CandidateTruth | undefined {
  if (set.completeness !== 'COMPLETE') return undefined;
  const primary = set.formulas.find((formula) => formula.relation === 'PRIMARY_SELECTED');
  if (!primary || primary.compositionPresence !== 'PRESENT' || !primary.composition.trim()) return undefined;
  const sourceId = set.sourceAuthority === 'P2_CASE_DERIVED'
    ? primary.caseContext?.sourceRef
    : set.parentRecordRef;
  if (!sourceId) return undefined;

  return {
    kind: 'formula',
    canonicalKey: `${sourceId}::${primary.formulaId}`,
    sourceId,
    productId: primary.formulaId,
    composition: primary.composition,
    provenanceKind: set.sourceAuthority === 'P2_CASE_DERIVED' ? 'CASE_DERIVED' : 'CANONICAL_SOURCE',
  };
}

function uniqueProvider(context: RuntimeContext, outcome: string) {
  const providers = context.capabilities.filter((capability) => capability.provides?.includes(outcome));
  return providers.length === 1 ? providers[0] : undefined;
}

function deliveryObligation(context: RuntimeContext, outcome: string): { capabilityId: string; obligation: CapabilityDeliveryObligation } | undefined {
  const provider = uniqueProvider(context, outcome);
  if (!provider) return undefined;
  const obligations = provider.deliveryObligations ?? [];
  if (obligations.length !== 1) return undefined;
  return { capabilityId: provider.id, obligation: obligations[0] };
}

function buildCommitEnvironment(context: RuntimeContext): CommitEnvironment {
  return {
    safety: {
      status: context.safety.status,
      reviewRequired: context.safety.reviewRequired,
      reasons: context.safety.reasons,
    },
    readReasoningProduct: (ref) => {
      const prefix = 'delivery:';
      if (!ref.startsWith(prefix)) return undefined;
      const outcome = ref.slice(prefix.length);
      return treatmentDeliveryArtifacts(context.workspace)
        .find((delivery) => delivery.outcome === outcome) as unknown as Readonly<Record<string, unknown>> | undefined;
    },
    validateDelivery: (outcome, product) => {
      const completeness = treatmentDeliveryCompleteness(context.capabilities, product);
      if (!completeness.complete) {
        return { ok: false, code: 'MISSING_REQUIRED_FIELDS', missing: completeness.missingFields };
      }
      if (!completeness.capabilityId) return { ok: false, code: 'NO_PROVIDER' };
      const provider = uniqueProvider(context, outcome);
      if (!provider || provider.id !== completeness.capabilityId) return { ok: false, code: 'NO_PROVIDER' };
      return { ok: true, providerId: completeness.capabilityId };
    },
    hydrateSourceBoundProduct: (outcome) => {
      const owner = deliveryObligation(context, outcome);
      if (!owner) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      const capability = context.capabilities.find((item) => item.id === owner.capabilityId);
      if (!capability) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      return materializeSourceBoundProduct(context, capability, owner.obligation, outcome);
    },
    hydrateCanonicalCandidate: async (truth, outcome) => {
      const sep = truth.canonicalKey.indexOf('::');
      if (sep <= 0) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
      const sourceId = truth.canonicalKey.slice(0, sep);
      const formulaId = truth.canonicalKey.slice(sep + 2);
      const provider = uniqueProvider(context, outcome);
      if (!provider) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };

      const canonical = await getCanonicalFormula(sourceId, formulaId, context.runId);
      if (!canonical) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      if (typeof truth.composition === 'string' && truth.composition.trim().length > 0) {
        if (canonical.sourceAuthority === 'P1') {
          const validation = await validateNormativeFormula({ sourceId, formulaId: canonical.formulaId, composition: truth.composition });
          if (!validation.valid) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
        } else {
          const normalize = (value: string) => value.replace(/[\s，。、,.;；:：()（）\[\]【】{}《》<>'"“”‘’\-_]/g, '');
          if (normalize(truth.composition) !== normalize(canonical.composition)) {
            return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
          }
        }
      }

      let set: SourceFormulaSet | null = null;
      try {
        const index = await loadIndex();
        const prior = context.workspace.sourceFormulaSet;
        const exclusions = prior?.parentRecordRef === sourceId
          ? Object.fromEntries(prior.formulas
              .filter((formula) => formula.relation === 'CLINICALLY_EXCLUDED')
              .map((formula) => [formula.formulaRef, {
                reason: formula.exclusionReason ?? 'clinically excluded',
                evidenceRefs: formula.exclusionEvidenceRefs,
              }]))
          : undefined;
        set = hydrateSourceFormulaSet(index.docs, `${sourceId}::${formulaId}`, exclusions ? { exclusions } : undefined);
      } catch {
        return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      }
      if (!set || set.completeness !== 'COMPLETE') return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      const selected = set.formulas.find((formula) => formula.formulaId === formulaId);
      if (!selected || selected.compositionPresence !== 'PRESENT' || !selected.composition.trim()) {
        return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      }
      const sourceBundle = sourceBundleFromSet(context, set);
      const selectedProduct = sourceBundle.products.find((product) => product.productId === formulaId);
      if (!selectedProduct) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      return {
        ok: true,
        providerId: provider.id,
        product: selectedProduct.payload,
        sourceBundle,
        sourceRefs: set.sourceAuthority === 'P2_CASE_DERIVED'
          ? [...new Set([set.parentRecordRef, ...set.formulas.map((formula) => formula.formulaRef.split('::')[0] ?? '')].filter(Boolean))]
          : [sourceId],
      };
    },
  };
}

/**
 * Kernel transaction for one exact outcome. No disease/modality branch exists here:
 * materialization comes from the provider manifest.
 */
export async function commitDeliveryOutcome(context: RuntimeContext, outcome: string): Promise<CommitResult> {
  const owner = deliveryObligation(context, outcome);
  if (!owner) {
    const providers = context.capabilities.filter((capability) => capability.provides?.includes(outcome));
    return { ok: false, code: providers.length > 1 ? 'AMBIGUOUS_PROVIDER' : 'NO_PROVIDER' };
  }

  const coordinator = new CommitCoordinator(new CandidateHandleRegistry(), context.commitLedger);
  const env = buildCommitEnvironment(context);
  if (owner.obligation.materialization === 'SOURCE_BOUND') {
    return coordinator.commit({ outcome, sourceBound: true }, env);
  }

  if (owner.obligation.materialization === 'CANONICAL_CANDIDATE') {
    // Commit from durable selection/source truth, not from retrieval-card display metadata.
    // A P1 source-node candidate may carry a representative formula only for display; the authoritative
    // primary product is the one materialized in SourceFormulaSet by the Kernel selection transaction.
    const selection = context.workspace.clinicalDecisionSpine.formulaSelection;
    const set = context.workspace.sourceFormulaSet;
    if (!selection?.selectedCandidateRef || !set || set.completeness !== 'COMPLETE') {
      return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
    }
    const truth = canonicalCandidateTruthFromSourceFormulaSet(set);
    if (!truth) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };

    const registry = new CandidateHandleRegistry();
    const handle = registry.issue(truth);
    const canonicalCoordinator = new CommitCoordinator(registry, context.commitLedger);
    return canonicalCoordinator.commit({ outcome, candidateHandle: handle }, env);
  }

  return coordinator.commit({ outcome, reasoningArtifactRef: `delivery:${outcome}` }, env);
}
