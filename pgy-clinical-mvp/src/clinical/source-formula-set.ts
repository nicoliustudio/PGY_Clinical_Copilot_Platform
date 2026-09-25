import type { KnowledgeDoc } from '../knowledge/types.js';
import type {
  CandidateReference,
  FormulaAdoptionState,
  SourceFieldPresence,
  SourceFormulaEntry,
  SourceFormulaSet,
} from '../contracts/workspace.js';

/**
 * Source Formula Set —— source membership projection for both normative P1 sources and historical P2 cases.
 *
 * P1 semantics:
 *   one normative parent source -> every ACTIVE sibling formula.
 * P2 semantics:
 *   one historical case -> every structured case-formula encounter/visit in the same case lineage.
 *
 * P2 is never promoted to normative prescription authority. It is authoritative only for the historical fact
 * "this source case used this prescription at this visit". Delivery/execution clearance remains independent.
 */

function isActiveFormula(entityStatus: string | undefined): boolean {
  return entityStatus !== 'INACTIVE';
}

const EMPTY_MARKERS = new Set(['none', 'null', 'nil', '无', '无加减', '暂无', '无。', '-']);

function normalizeTextList(value: string[] | undefined): { values: string[]; presence: SourceFieldPresence } {
  if (value === undefined) return { values: [], presence: 'UNKNOWN' };
  const cleaned = value
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !EMPTY_MARKERS.has(item.toLowerCase()));
  if (cleaned.length === 0) return { values: [], presence: 'KNOWN_EMPTY' };
  return { values: cleaned, presence: 'PRESENT' };
}

function textPresence(value: string | undefined): SourceFieldPresence {
  if (value === undefined) return 'UNKNOWN';
  return value.trim().length > 0 ? 'PRESENT' : 'KNOWN_EMPTY';
}

export interface HydrateSourceFormulaSetOptions {
  exclusions?: Record<string, { reason: string; evidenceRefs?: string[] }>;
}

function hydrateP1(
  parent: KnowledgeDoc,
  selectedFormulaId: string | undefined,
  options: HydrateSourceFormulaSetOptions,
): SourceFormulaSet | null {
  const sourceId = parent.id;
  const activeFormulas = parent.formulas.filter((f) => isActiveFormula(f.entityStatus));
  if (activeFormulas.length === 0) return null;
  // Source-node selection (no explicit formula) defaults to the first active product.
  // An explicitly requested product that is absent from the parent is a fail-closed identity miss,
  // never a silent substitution — this keeps intent fidelity without re-parsing candidate syntax.
  let primaryFormulaId: string;
  if (selectedFormulaId === undefined) {
    primaryFormulaId = activeFormulas[0]!.id;
  } else if (activeFormulas.some((f) => f.id === selectedFormulaId)) {
    primaryFormulaId = selectedFormulaId;
  } else {
    return null;
  }

  const shared = normalizeTextList(parent.sourceModifications);
  const formulas: SourceFormulaEntry[] = activeFormulas.map((f) => {
    const formulaRef = `${sourceId}::${f.id}`;
    let relation: FormulaAdoptionState = 'SOURCE_ALTERNATIVE';
    let exclusionReason: string | undefined;
    let exclusionEvidenceRefs: string[] | undefined;
    if (f.id === primaryFormulaId) {
      relation = 'PRIMARY_SELECTED';
    } else {
      const exclusion = options.exclusions?.[formulaRef];
      if (exclusion) {
        relation = 'CLINICALLY_EXCLUDED';
        exclusionReason = exclusion.reason;
        exclusionEvidenceRefs = exclusion.evidenceRefs;
      }
    }

    const local = normalizeTextList(f.sourceModifications);
    const legacyLocal = local.presence === 'PRESENT'
      ? local.values
      : (activeFormulas.length === 1 && shared.presence === 'PRESENT' ? shared.values : []);
    const legacyStatus = legacyLocal.length > 0
      ? 'PRESENT' as const
      : (local.presence === 'UNKNOWN' ? 'UNKNOWN' as const
        : (shared.presence === 'PRESENT' && activeFormulas.length > 1
          ? 'UNATTRIBUTED_SOURCE_RULES' as const
          : 'KNOWN_EMPTY' as const));

    return {
      formulaRef,
      formulaId: f.id,
      formulaName: f.name,
      composition: f.composition ?? '',
      compositionPresence: f.compositionPresence ?? (f.composition.trim().length > 0 ? 'PRESENT' : 'UNKNOWN'),
      sourceModifications: legacyLocal,
      formulaLocalModificationPresence: local.presence,
      modificationStatus: legacyStatus,
      preparation: f.preparation,
      preparationPresence: textPresence(f.preparation),
      usage: f.usage,
      usagePresence: textPresence(f.usage),
      relation,
      exclusionReason,
      exclusionEvidenceRefs,
      applicableModifications: [],
    };
  });

  return {
    parentRecordRef: sourceId,
    sourceKind: 'P1_NORMATIVE_SOURCE',
    sourceAuthority: 'P1',
    disease: parent.disease,
    syndrome: parent.syndrome,
    treatmentMethod: parent.treatment,
    completeness: 'COMPLETE',
    sourceLevelModifications: shared.values,
    sourceLevelModificationPresence: shared.presence,
    formulas,
  };
}

function p2CaseRef(doc: KnowledgeDoc): string {
  return doc.caseId ? `P2:${doc.caseId}` : doc.id;
}

function p2VisitRef(doc: KnowledgeDoc): string {
  return doc.id.startsWith('P2:') ? doc.id.slice(3) : doc.id;
}

function p2FormulaId(doc: KnowledgeDoc): string {
  return `P2_CASE_FORMULA::${p2CaseRef(doc)}::${p2VisitRef(doc)}::1`;
}

function hydrateP2Case(
  docs: KnowledgeDoc[],
  selectedEncounter: KnowledgeDoc,
  options: HydrateSourceFormulaSetOptions,
): SourceFormulaSet | null {
  if (selectedEncounter.kind !== 'case-formula' || !selectedEncounter.composition?.trim()) return null;
  const caseRef = p2CaseRef(selectedEncounter);
  const caseId = selectedEncounter.caseId;
  const encounters = docs.filter((doc) =>
    doc.sourceTier === 'P2'
    && doc.kind === 'case-formula'
    && Boolean(doc.composition?.trim())
    && (caseId ? doc.caseId === caseId : doc.id === selectedEncounter.id),
  );
  if (encounters.length === 0) return null;

  // Preserve source order when possible; visit text is display metadata, not identity authority.
  const formulas: SourceFormulaEntry[] = encounters.map((doc) => {
    const formulaRef = `${doc.id}::formula`;
    let relation: FormulaAdoptionState = doc.id === selectedEncounter.id ? 'PRIMARY_SELECTED' : 'SOURCE_ALTERNATIVE';
    let exclusionReason: string | undefined;
    let exclusionEvidenceRefs: string[] | undefined;
    const exclusion = options.exclusions?.[formulaRef];
    if (relation !== 'PRIMARY_SELECTED' && exclusion) {
      relation = 'CLINICALLY_EXCLUDED';
      exclusionReason = exclusion.reason;
      exclusionEvidenceRefs = exclusion.evidenceRefs;
    }
    return {
      formulaRef,
      formulaId: p2FormulaId(doc),
      formulaName: doc.formulaName?.trim() || `病例方${doc.visit ? `（${doc.visit}）` : '（原案无正式方名）'}`,
      composition: doc.composition ?? '',
      compositionPresence: doc.composition?.trim() ? 'PRESENT' : 'UNKNOWN',
      sourceModifications: [],
      formulaLocalModificationPresence: 'UNKNOWN',
      modificationStatus: 'UNKNOWN',
      preparationPresence: 'UNKNOWN',
      usagePresence: 'UNKNOWN',
      relation,
      exclusionReason,
      exclusionEvidenceRefs,
      caseContext: {
        sourceRef: doc.id,
        visit: doc.visit,
        patient: doc.patient,
        symptoms: doc.symptoms,
        disease: doc.disease,
        syndrome: doc.syndrome,
        treatment: doc.treatment,
      },
      applicableModifications: [],
    };
  });

  return {
    parentRecordRef: caseRef,
    sourceKind: 'P2_CASE_SOURCE',
    sourceAuthority: 'P2_CASE_DERIVED',
    sourceCaseRef: caseRef,
    disease: selectedEncounter.disease,
    syndrome: selectedEncounter.syndrome,
    treatmentMethod: selectedEncounter.treatment,
    completeness: 'COMPLETE',
    sourceLevelModifications: [],
    sourceLevelModificationPresence: 'UNKNOWN',
    formulas,
  };
}

/**
 * Hydrate the complete membership set for the selected treatment source.
 * A selectable P2 case candidate therefore has a legal deterministic end state instead of becoming a dead candidate.
 */
export function hydrateSourceFormulaSetForCandidate(
  docs: KnowledgeDoc[],
  candidate: Pick<CandidateReference, 'id' | 'sourceId' | 'formulaId' | 'sourceKind' | 'sourceAuthority'>,
  options: HydrateSourceFormulaSetOptions = {},
): SourceFormulaSet | null {
  const sourceId = candidate.sourceId;
  if (!sourceId) return null;
  const source = docs.find((d) => d.id === sourceId);
  if (!source) return null;
  if (source.sourceTier === 'P1') return hydrateP1(source, candidate.formulaId, options);
  if (source.sourceTier === 'P2') return hydrateP2Case(docs, source, options);
  return null;
}

/** Migration compatibility for historical candidate refs. New selection code hydrates from CandidateReference. */
export function hydrateSourceFormulaSet(
  docs: KnowledgeDoc[],
  selectedCandidateRef: string,
  options: HydrateSourceFormulaSetOptions = {},
): SourceFormulaSet | null {
  let sourceId: string | undefined;
  let formulaId: string | undefined;
  if (selectedCandidateRef.startsWith('source-node:')) {
    sourceId = selectedCandidateRef.slice('source-node:'.length);
  } else if (selectedCandidateRef.startsWith('case-visit:')) {
    sourceId = selectedCandidateRef.slice('case-visit:'.length);
  } else {
    [sourceId, formulaId] = selectedCandidateRef.split('::');
  }
  if (!sourceId) return null;
  const source = docs.find((d) => d.id === sourceId);
  if (!source) return null;
  return hydrateSourceFormulaSetForCandidate(docs, {
    id: selectedCandidateRef,
    sourceId,
    formulaId,
    sourceKind: source.sourceTier === 'P1' ? 'P1_NORMATIVE_SOURCE' : 'P2_CASE_SOURCE',
    sourceAuthority: source.sourceTier === 'P1' ? 'P1' : 'P2_CASE_DERIVED',
  }, options);
}

export function countPrimarySelected(set: SourceFormulaSet): number {
  return set.formulas.filter((f) => f.relation === 'PRIMARY_SELECTED').length;
}

export function assertSinglePrimary(set: SourceFormulaSet): void {
  const primaries = countPrimarySelected(set);
  if (primaries !== 1) {
    throw new Error(`invariant violated: expected exactly 1 PRIMARY_SELECTED, got ${primaries}`);
  }
}
