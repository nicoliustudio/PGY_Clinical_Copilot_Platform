import type { ProductQualification } from '../contracts/workspace.js';

/**
 * Source / Product semantics —— 三个正交轴：
 *   1. Source membership（MEMBER）：hydration 建立，表示「该产品属于这个来源」，永不因顺序改变。
 *   2. Source selection：选择某个 source-node / case-visit，与产品选择无关。
 *   3. Product clinical qualification（UNASSESSED / CURRENTLY_SELECTED / CLINICALLY_EXCLUDED）：
 *      只有显式 product decision 才产生，绝不从 products[] 数组顺序隐式推导。
 *
 * 这是纯类型 + 纯函数层，不读磁盘、不读 workspace，用于 Kernel 校验与测试。
 */

/** 一个显式产品决定（source selection 与 product qualification 分离后的产物）。 */
export interface ProductDecision {
  /** 引用 SourceFormulaEntry.formulaRef（`${sourceId}::${formulaId}`）。 */
  formulaRef: string;
  disposition: 'SELECT' | 'EXCLUDE' | 'LEAVE_UNASSESSED';
  rationale?: string;
  supportingFactRefs?: string[];
  contradictingFactRefs?: string[];
}

interface QualifiableProduct {
  formulaRef: string;
  clinicalQualification?: ProductQualification;
  exclusionReason?: string;
}

/**
 * 把显式 product decisions 施加到一个已水合的 source membership 上。
 * 未决定的产品一律 UNASSESSED；决定的产品才有 CURRENTLY_SELECTED / CLINICALLY_EXCLUDED。
 * 决策指向不存在的产品时 fail-closed（闭世界身份）。
 */
export function applyProductDecisions<T extends QualifiableProduct>(
  products: readonly T[],
  decisions: readonly ProductDecision[] = [],
): T[] {
  const byRef = new Map(decisions.map((d) => [d.formulaRef, d]));
  for (const decision of decisions) {
    if (!products.some((p) => p.formulaRef === decision.formulaRef)) {
      throw new Error(`product decision outside selected source: ${decision.formulaRef}`);
    }
  }
  return products.map((product) => {
    const decision = byRef.get(product.formulaRef);
    if (!decision || decision.disposition === 'LEAVE_UNASSESSED') {
      return { ...product, clinicalQualification: 'UNASSESSED' as const, exclusionReason: undefined };
    }
    if (decision.disposition === 'EXCLUDE') {
      return {
        ...product,
        clinicalQualification: 'CLINICALLY_EXCLUDED' as const,
        exclusionReason: decision.rationale,
      };
    }
    return { ...product, clinicalQualification: 'CURRENTLY_SELECTED' as const, exclusionReason: undefined };
  });
}

export function selectedProducts<T extends { clinicalQualification?: ProductQualification }>(
  products: readonly T[],
): T[] {
  return products.filter((p) => p.clinicalQualification === 'CURRENTLY_SELECTED');
}

/** Legacy single-formula projection 仅在 clinical selection 真正唯一时合法。 */
export function uniqueSelectedProduct<T extends { clinicalQualification?: ProductQualification }>(
  products: readonly T[],
): T | undefined {
  const selected = selectedProducts(products);
  return selected.length === 1 ? selected[0] : undefined;
}

/**
 * SOURCE_NODE candidate 顶层不得存在有临床 authority 的单方 identity。
 * 该断言是静态 invariant 的一部分：source-level candidate 不能被 products[0] 代表。
 */
export function assertNoFormulaAuthorityAtSourceCandidate(candidate: unknown): void {
  const record = candidate as Record<string, unknown>;
  if ('formulaId' in record || 'formulaName' in record) {
    throw new Error('SOURCE_NODE candidate must not expose top-level formulaId/formulaName authority');
  }
}
