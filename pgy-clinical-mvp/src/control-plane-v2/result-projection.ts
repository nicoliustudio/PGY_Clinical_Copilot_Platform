import type { FormulaCardinality } from './types.js';
import type { SourceFormulaSet } from '../contracts/workspace.js';

export type ProjectedPresence = 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN';
export interface ProjectedFact<T> {
  presence: ProjectedPresence;
  value?: T;
  provenanceRefs?: readonly string[];
}

export interface ProjectedFormulaFacts {
  composition: ProjectedFact<string>;
  preparation: ProjectedFact<string>;
  usage: ProjectedFact<string>;
  modifications: {
    formulaLocal: ProjectedFact<string[]>;
    sourceShared: ProjectedFact<string[]>;
    patientSpecific: ProjectedFact<Array<{
      statement?: string;
      patientEvidenceRefs?: string[];
      /** 触发该加减的临床判断 artifact；与患者证据分列。 */
      assessmentRefs?: string[];
      sourceEvidenceRefs?: string[];
    }>>;
  };
}

export interface ProjectedFormula {
  formulaRef: string;
  formulaId: string;
  name: string;
  composition: string;
  sourceRef: string;
  sourceModifications: string[];
  sourceLevelModifications: string[];
  modificationStatus: SourceFormulaSet['formulas'][number]['modificationStatus'];
  usage?: string;
  /** Product-local authored stage semantics. */
  stageGuidance?: SourceFormulaSet['formulas'][number]['stageGuidance'];
  conditionalGuidance?: SourceFormulaSet['formulas'][number]['conditionalGuidance'];
  sequence?: SourceFormulaSet['formulas'][number]['sequence'];
  /** Parent/source-level authored stage semantics. Kept distinct from product-local facts. */
  sourceStageGuidance?: SourceFormulaSet['stageGuidance'];
  sourceConditionalGuidance?: SourceFormulaSet['conditionalGuidance'];
  sourceSequence?: SourceFormulaSet['sequence'];
  /** First-truth source membership / patient qualification. */
  membership: 'SOURCE_MEMBER';
  clinicalQualification: SourceFormulaSet['formulas'][number]['clinicalQualification'];
  exclusionReason?: string;
  exclusionEvidenceRefs?: string[];
  sequenceRelation?: SourceFormulaSet['formulas'][number]['sequenceRelation'];
  /** @deprecated compatibility projection only; never use as selection authority. */
  relation: 'PRIMARY_SELECTED' | 'SOURCE_ALTERNATIVE' | 'CLINICALLY_EXCLUDED' | 'UNASSESSED';
  applicableModifications: SourceFormulaSet['formulas'][number]['applicableModifications'];
  caseContext?: SourceFormulaSet['formulas'][number]['caseContext'];
  /** Lossless product facts. Legacy flat fields above remain compatibility helpers only. */
  facts?: ProjectedFormulaFacts;
}

/**
 * Deterministic formula projection. The model does not get a second chance to silently drop
 * source alternatives or copy generic conditional modifications into patient-specific advice.
 */
export function projectFormulaSet(
  set: SourceFormulaSet | undefined,
  cardinality: FormulaCardinality,
): ProjectedFormula[] {
  if (!set) return [];
  // SOURCE_SIBLING_COMPLETENESS: once a canonical source parent is adopted, every ACTIVE
  // sibling formula is a deliverable. `formulaCardinality` remains a request/completion constraint;
  // it must never be used as a projection filter that silently drops source siblings.
  // PRIMARY_ONLY therefore means one reasoning anchor, not one visible source product.
  void cardinality;
  // SOURCE COMPLETENESS: clinical exclusion changes qualification, never source membership.
  return set.formulas.map((f) => ({
    formulaRef: f.formulaRef,
    formulaId: f.formulaId,
    name: f.formulaName,
    composition: f.composition,
    sourceRef: set.parentRecordRef,
    sourceModifications: [...f.sourceModifications],
    sourceLevelModifications: [...set.sourceLevelModifications],
    modificationStatus: f.modificationStatus,
    usage: f.usage,
    membership: 'SOURCE_MEMBER',
    clinicalQualification: f.clinicalQualification,
    ...(f.exclusionReason ? { exclusionReason: f.exclusionReason } : {}),
    ...(f.exclusionEvidenceRefs && f.exclusionEvidenceRefs.length > 0 ? { exclusionEvidenceRefs: [...f.exclusionEvidenceRefs] } : {}),
    ...(f.stageGuidance !== undefined ? { stageGuidance: [...f.stageGuidance] } : {}),
    ...(f.conditionalGuidance !== undefined ? { conditionalGuidance: [...f.conditionalGuidance] } : {}),
    ...(f.sequence !== undefined ? { sequence: f.sequence.map((step) => ({ ...step })) } : {}),
    ...(set.stageGuidance !== undefined ? { sourceStageGuidance: [...set.stageGuidance] } : {}),
    ...(set.conditionalGuidance !== undefined ? { sourceConditionalGuidance: [...set.conditionalGuidance] } : {}),
    ...(set.sequence !== undefined ? { sourceSequence: set.sequence.map((step) => ({ ...step })) } : {}),
    ...(f.sequenceRelation ? { sequenceRelation: f.sequenceRelation } : {}),
    relation: f.relation,
    applicableModifications: f.applicableModifications,
    ...(f.caseContext ? { caseContext: { ...f.caseContext } } : {}),
    facts: {
      composition: {
        presence: f.compositionPresence ?? (f.composition.trim() ? 'PRESENT' : 'UNKNOWN'),
        ...(f.composition.trim() ? { value: f.composition } : {}),
        provenanceRefs: [set.parentRecordRef],
      },
      preparation: {
        presence: f.preparationPresence ?? (f.preparation === undefined ? 'UNKNOWN' : f.preparation.trim() ? 'PRESENT' : 'KNOWN_EMPTY'),
        ...(f.preparation ? { value: f.preparation } : {}),
        provenanceRefs: [set.parentRecordRef],
      },
      usage: {
        presence: f.usagePresence ?? (f.usage === undefined ? 'UNKNOWN' : f.usage.trim() ? 'PRESENT' : 'KNOWN_EMPTY'),
        ...(f.usage ? { value: f.usage } : {}),
        provenanceRefs: [set.parentRecordRef],
      },
      modifications: {
        formulaLocal: {
          presence: f.formulaLocalModificationPresence ?? (f.sourceModifications.length ? 'PRESENT' : 'UNKNOWN'),
          ...(f.sourceModifications.length ? { value: [...f.sourceModifications] } : {}),
          provenanceRefs: [f.formulaRef],
        },
        sourceShared: {
          presence: set.sourceLevelModificationPresence ?? (set.sourceLevelModifications.length ? 'PRESENT' : 'UNKNOWN'),
          ...(set.sourceLevelModifications.length ? { value: [...set.sourceLevelModifications] } : {}),
          provenanceRefs: [set.parentRecordRef],
        },
        patientSpecific: { presence: 'UNKNOWN', provenanceRefs: [] },
      },
    },
  }));
}
