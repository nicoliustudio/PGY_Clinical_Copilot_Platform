import type { KnowledgeDoc } from '../knowledge/types.js';
import type {
  FormulaAdoptionState,
  SourceFieldPresence,
  SourceFormulaEntry,
  SourceFormulaSet,
} from '../contracts/workspace.js';

/**
 * Source Formula Set —— canonical source membership projection.
 *
 * Membership and product completeness are deliberately independent:
 * - every ACTIVE source product remains a member, even when a product field is UNKNOWN;
 * - clinical qualification changes recommendation state, never source existence;
 * - source-local/shared modification facts preserve PRESENT / KNOWN_EMPTY / UNKNOWN.
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

export function hydrateSourceFormulaSet(
  docs: KnowledgeDoc[],
  selectedCandidateRef: string,
  options: HydrateSourceFormulaSetOptions = {},
): SourceFormulaSet | null {
  const [sourceId, selectedFormulaId] = selectedCandidateRef.split('::');
  if (!sourceId || !selectedFormulaId) return null;

  const parent = docs.find((d) => d.id === sourceId && d.sourceTier === 'P1');
  if (!parent) return null;

  // SOURCE MEMBERSHIP: composition completeness must never decide whether an ACTIVE product exists.
  const activeFormulas = parent.formulas.filter((f) => isActiveFormula(f.entityStatus));
  if (activeFormulas.length === 0) return null;
  if (!activeFormulas.some((f) => f.id === selectedFormulaId)) return null;

  const shared = normalizeTextList(parent.sourceModifications);
  const formulas: SourceFormulaEntry[] = activeFormulas.map((f) => {
    const formulaRef = `${sourceId}::${f.id}`;
    let relation: FormulaAdoptionState = 'SOURCE_ALTERNATIVE';
    let exclusionReason: string | undefined;
    let exclusionEvidenceRefs: string[] | undefined;
    if (f.id === selectedFormulaId) {
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
    // Legacy compatibility only: when a single product source has shared rules, expose them locally too.
    // Authoritative product facts still keep formula-local and source-shared scopes separate.
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
      compositionPresence: f.composition.trim().length > 0 ? 'PRESENT' : 'UNKNOWN',
      sourceModifications: legacyLocal,
      formulaLocalModificationPresence: local.presence,
      modificationStatus: legacyStatus,
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
    disease: parent.disease,
    syndrome: parent.syndrome,
    treatmentMethod: parent.treatment,
    completeness: 'COMPLETE',
    sourceLevelModifications: shared.values,
    sourceLevelModificationPresence: shared.presence,
    formulas,
  };
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
