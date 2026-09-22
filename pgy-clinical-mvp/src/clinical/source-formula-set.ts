import type { KnowledgeDoc } from '../knowledge/types.js';
import type {
  FormulaAdoptionState,
  SourceFormulaEntry,
  SourceFormulaSet,
} from '../contracts/workspace.js';

/**
 * H15.6 Source Formula Set —— 确定性同源多方水合。
 *
 * 关键不变式（不变量 1 + 二）：
 * - 一旦 Runtime 采用了一个具有处方权威的 P1 / normative 病-证 parent record，
 *   该 parent 下原知识库所有 ACTIVE 方必须被确定性水合出来。
 * - 禁止再经过 semantic search / topK / rerank / LLM 自主决定 / candidate frontier 截断。
 * - 主选方只有一个 PRIMARY_SELECTED；其余 ACTIVE 方是 SOURCE_ALTERNATIVE，
 *   只有存在明确临床排除依据时才标 CLINICALLY_EXCLUDED。
 * - `not selected` ≠ `clinically rejected`。
 *
 * 本模块是纯函数，不依赖模型、不读磁盘（docs 由调用方传入）。
 */

/** INACTIVE 之外的实体状态都视为可交付（fail-open 仅限「未声明/ACTIVE」）。 */
function isActiveFormula(entityStatus: string | undefined): boolean {
  return entityStatus !== 'INACTIVE';
}

export interface HydrateSourceFormulaSetOptions {
  /** 明确临床排除的公式引用集合 + 排除原因（可选）。缺省时所有非主选方均为 SOURCE_ALTERNATIVE。 */
  exclusions?: Record<string, { reason: string; evidenceRefs?: string[] }>;
}

/**
 * 由 selectedCandidateRef（`${sourceId}::${formulaId}`）确定性水合 parent 下的全部 ACTIVE 方。
 *
 * @param docs 已索引的知识文档（P1 normative docs）。
 * @param selectedCandidateRef 主选方引用（PRIMARY_SELECTED）。
 * @returns SourceFormulaSet；找不到 parent 或主选方不在 parent 内时返回 null（fail-closed）。
 */
export function hydrateSourceFormulaSet(
  docs: KnowledgeDoc[],
  selectedCandidateRef: string,
  options: HydrateSourceFormulaSetOptions = {},
): SourceFormulaSet | null {
  const [sourceId, selectedFormulaId] = selectedCandidateRef.split('::');
  if (!sourceId || !selectedFormulaId) return null;

  const parent = docs.find((d) => d.id === sourceId && d.sourceTier === 'P1');
  if (!parent) return null;

  const activeFormulas = parent.formulas.filter((f) => isActiveFormula(f.entityStatus) && f.composition.trim() !== '');
  if (activeFormulas.length === 0) return null;

  const selectedExists = activeFormulas.some((f) => f.id === selectedFormulaId);
  if (!selectedExists) return null;

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
    return {
      formulaRef,
      formulaId: f.id,
      formulaName: f.name,
      composition: f.composition,
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
    formulas,
  };
}

/** 主选方数量不变式：恰好 0 或 1 个 PRIMARY_SELECTED。 */
export function countPrimarySelected(set: SourceFormulaSet): number {
  return set.formulas.filter((f) => f.relation === 'PRIMARY_SELECTED').length;
}

/** 是否存在被误标成 CLINICALLY_EXCLUDED 的 ACTIVE 方（应为 SOURCE_ALTERNATIVE）。 */
export function assertSinglePrimary(set: SourceFormulaSet): void {
  const primaries = countPrimarySelected(set);
  if (primaries !== 1) {
    throw new Error(`invariant violated: expected exactly 1 PRIMARY_SELECTED, got ${primaries}`);
  }
}
