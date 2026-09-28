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

function legacyQualification(clinicalQualification: SourceFormulaSet['formulas'][number]['clinicalQualification']): CommittedSourceProduct['qualification'] {
  if (clinicalQualification === 'CURRENTLY_SELECTED') return 'PRIMARY_SELECTED';
  if (clinicalQualification === 'CLINICALLY_EXCLUDED') return 'CLINICALLY_EXCLUDED';
  return 'UNASSESSED';
}

export function sourceBundleFromSet(context: RuntimeContext, set: SourceFormulaSet): CommittedSourceBundle {
  const patientPlan = context.workspace.clinicalDecisionSpine.modificationPlan;
  const patientItems = patientPlan?.items ?? [];
  const selectedProducts = set.formulas.filter((formula) => formula.clinicalQualification === 'CURRENTLY_SELECTED');

  // Patient-specific modifications are product-scoped execution facts. Until the adoption contract carries
  // an explicit target product, a durable patient-specific plan is legal only when exactly one product has
  // been explicitly qualified CURRENTLY_SELECTED. Never attach it to products[0], and never silently drop it.
  if (patientItems.length > 0 && selectedProducts.length !== 1) {
    throw new Error(`patient-specific modification plan requires exactly one explicitly selected product; got ${selectedProducts.length}`);
  }
  const patientTargetRef = selectedProducts[0]?.formulaRef;

  const products: CommittedSourceProduct[] = set.formulas.map((formula) => {
    const isPatientTarget = patientTargetRef === formula.formulaRef;
    const compositionPresence = formula.compositionPresence ?? (formula.composition.trim() ? 'PRESENT' : 'UNKNOWN');
    const localPresence = formula.formulaLocalModificationPresence
      ?? (formula.sourceModifications.length > 0 ? 'PRESENT' : 'UNKNOWN');
    const sharedPresence = set.sourceLevelModificationPresence
      ?? (set.sourceLevelModifications.length > 0 ? 'PRESENT' : 'UNKNOWN');
    const preparationPresence = formula.preparationPresence
      ?? (formula.preparation === undefined ? 'UNKNOWN' : formula.preparation.trim() ? 'PRESENT' : 'KNOWN_EMPTY');
    const usagePresence = formula.usagePresence
      ?? (formula.usage === undefined ? 'UNKNOWN' : formula.usage.trim() ? 'PRESENT' : 'KNOWN_EMPTY');
    const patientPresence: FieldPresence = !isPatientTarget
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
        ...(formula.stageGuidance !== undefined ? { stageGuidance: [...formula.stageGuidance] } : {}),
        ...(formula.conditionalGuidance !== undefined ? { conditionalGuidance: [...formula.conditionalGuidance] } : {}),
        ...(formula.sequence !== undefined ? { sequence: formula.sequence.map((step) => ({ ...step })) } : {}),
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
                  ...(item.assessmentRefs && item.assessmentRefs.length > 0 ? { assessmentRefs: [...item.assessmentRefs] } : {}),
                  sourceEvidenceRefs: [...(item.sourceEvidenceRefs ?? [])],
                }))
              : undefined,
            patientPresence === 'PRESENT'
              ? patientItems.flatMap((item) => [
                  ...item.patientEvidenceRefs,
                  ...(item.assessmentRefs ?? []),
                  ...(item.sourceEvidenceRefs ?? []),
                ])
              : [],
          ),
        },
      },
      membership: 'SOURCE_MEMBER',
      clinicalQualification: formula.clinicalQualification,
      ...(formula.sequenceRelation ? { sequenceRelation: formula.sequenceRelation } : {}),
      // Compatibility projection only. Downstream authority must read clinicalQualification.
      qualification: legacyQualification(formula.clinicalQualification),
      ...(formula.exclusionReason ? { exclusionReason: formula.exclusionReason } : {}),
      ...(formula.exclusionEvidenceRefs && formula.exclusionEvidenceRefs.length > 0
        ? { exclusionEvidenceRefs: [...formula.exclusionEvidenceRefs] }
        : {}),
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
      ...(set.stageGuidance !== undefined ? { stageGuidance: [...set.stageGuidance] } : {}),
      ...(set.conditionalGuidance !== undefined ? { conditionalGuidance: [...set.conditionalGuidance] } : {}),
      ...(set.sequence !== undefined ? { sequence: set.sequence.map((step) => ({ ...step })) } : {}),
      ...(set.sourceCaseRef ? { sourceCaseRef: set.sourceCaseRef } : {}),
    },
  };
}

/**
 * Convert durable SourceFormulaSet truth into the canonical selection unit used at commit.
 *
 * Source selection and product selection are orthogonal:
 * - one explicit CURRENTLY_SELECTED product -> product-level canonical truth;
 * - zero selected products on a complete P1 source -> source-bundle truth;
 * - multiple selected products -> fail closed.
 *
 * P2 case-visit hydration already carries one explicit selected visit, so it normally uses product truth.
 */
export function canonicalSelectionTruthFromSourceFormulaSet(set: SourceFormulaSet): CandidateTruth | undefined {
  if (set.completeness !== 'COMPLETE') return undefined;
  const selected = set.formulas.filter((formula) => formula.clinicalQualification === 'CURRENTLY_SELECTED');
  if (selected.length > 1) return undefined;

  const product = selected[0];
  if (product) {
    if (product.compositionPresence !== 'PRESENT' || !product.composition.trim()) return undefined;
    const sourceId = set.sourceAuthority === 'P2_CASE_DERIVED'
      ? product.caseContext?.sourceRef
      : set.parentRecordRef;
    if (!sourceId) return undefined;
    return {
      kind: 'formula',
      canonicalKey: `${sourceId}::${product.formulaId}`,
      sourceId,
      productId: product.formulaId,
      composition: product.composition,
      provenanceKind: set.sourceAuthority === 'P2_CASE_DERIVED' ? 'CASE_DERIVED' : 'CANONICAL_SOURCE',
    };
  }

  if (set.sourceAuthority === 'P2_CASE_DERIVED') return undefined;
  return {
    kind: 'source-bundle',
    canonicalKey: set.parentRecordRef,
    sourceId: set.parentRecordRef,
    provenanceKind: 'CANONICAL_SOURCE',
  };
}

/** @deprecated compatibility alias. Use canonicalSelectionTruthFromSourceFormulaSet. */
export function canonicalCandidateTruthFromSourceFormulaSet(set: SourceFormulaSet): CandidateTruth | undefined {
  return canonicalSelectionTruthFromSourceFormulaSet(set);
}

function sameCanonicalMembership(a: SourceFormulaSet, b: SourceFormulaSet): boolean {
  const refs = (set: SourceFormulaSet) => set.formulas.map((formula) => formula.formulaRef).sort();
  return JSON.stringify(refs(a)) === JSON.stringify(refs(b));
}

/**
 * Rehydrate source-owned facts at commit, then overlay only durable patient decision state.
 * The Workspace may own qualification/exclusion, but it never becomes a second owner of composition,
 * source modifications, usage, preparation, disease/syndrome/treatment, or membership.
 */
function canonicalSetWithDecisionState(canonical: SourceFormulaSet, decided: SourceFormulaSet): SourceFormulaSet | undefined {
  if (!sameCanonicalMembership(canonical, decided)) return undefined;
  const decisions = new Map(decided.formulas.map((formula) => [formula.formulaRef, formula]));
  return {
    ...canonical,
    formulas: canonical.formulas.map((formula) => {
      const decision = decisions.get(formula.formulaRef);
      if (!decision) return formula;
      return {
        ...formula,
        clinicalQualification: decision.clinicalQualification,
        relation: legacyQualification(decision.clinicalQualification),
        ...(decision.sequenceRelation ? { sequenceRelation: decision.sequenceRelation } : {}),
        ...(decision.exclusionReason ? { exclusionReason: decision.exclusionReason } : {}),
        ...(decision.exclusionEvidenceRefs ? { exclusionEvidenceRefs: [...decision.exclusionEvidenceRefs] } : {}),
      };
    }),
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
      const provider = uniqueProvider(context, outcome);
      if (!provider) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };

      if (truth.kind === 'source-bundle') {
        const sourceId = truth.sourceId ?? truth.canonicalKey;
        const selectedSet = context.workspace.sourceFormulaSet;
        if (!sourceId || !selectedSet || selectedSet.parentRecordRef !== sourceId || selectedSet.completeness !== 'COMPLETE') {
          return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
        }
        if (selectedSet.sourceAuthority === 'P2_CASE_DERIVED') return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };

        let canonicalSet: SourceFormulaSet | null = null;
        try {
          const index = await loadIndex();
          canonicalSet = hydrateSourceFormulaSet(index.docs, `source-node:${sourceId}`);
        } catch {
          return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
        }
        if (!canonicalSet || canonicalSet.completeness !== 'COMPLETE') {
          return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
        }
        const commitSet = canonicalSetWithDecisionState(canonicalSet, selectedSet);
        if (!commitSet) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };

        try {
          const sourceBundle = sourceBundleFromSet(context, commitSet);
          return {
            ok: true,
            providerId: provider.id,
            product: {
              selectionUnit: 'SOURCE_NODE',
              selectedSourceRef: sourceId,
              sourceMemberCount: sourceBundle.products.length,
            },
            sourceBundle,
            sourceRefs: [sourceId],
          };
        } catch {
          return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
        }
      }

      const sep = truth.canonicalKey.indexOf('::');
      if (sep <= 0) return { ok: false, code: 'SOURCE_BINDING_MISMATCH' };
      const sourceId = truth.canonicalKey.slice(0, sep);
      const formulaId = truth.canonicalKey.slice(sep + 2);

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
              .filter((formula) => formula.clinicalQualification === 'CLINICALLY_EXCLUDED')
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
      try {
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
      } catch {
        return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
      }
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
    // The canonical delivery unit remains the complete SourceBundle, while a P1 SOURCE_NODE needs
    // an explicit product decision before herbal-formula delivery is allowed to close.
    const selection = context.workspace.clinicalDecisionSpine.formulaSelection;
    const set = context.workspace.sourceFormulaSet;
    if (!selection?.selectedCandidateRef || !set || set.completeness !== 'COMPLETE') {
      return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };
    }
    // A P1 SOURCE_NODE is source truth, not yet formula authority. Herbal delivery cannot be
    // committed until the product-decision transaction has produced one explicit primaryFormulaRef.
    // This prevents direct callers from bypassing the control-plane formulaSelection invariant.
    if (selection.selectedCandidateRef.startsWith('source-node:') && !selection.primaryFormulaRef) {
      return { ok: false, code: 'CANONICAL_HYDRATION_FAILED', details: ['selected P1 source has no explicit product decision'] };
    }
    const truth = canonicalSelectionTruthFromSourceFormulaSet(set);
    if (!truth) return { ok: false, code: 'CANONICAL_HYDRATION_FAILED' };

    const registry = new CandidateHandleRegistry();
    const handle = registry.issue(truth);
    const canonicalCoordinator = new CommitCoordinator(registry, context.commitLedger);
    return canonicalCoordinator.commit({ outcome, candidateHandle: handle }, env);
  }

  return coordinator.commit({ outcome, reasoningArtifactRef: `delivery:${outcome}` }, env);
}
