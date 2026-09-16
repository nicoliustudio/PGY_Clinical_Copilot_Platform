import { validateFormula } from '../clinical/formula.js';

/**
 * Formula Authority Pipeline —— Agent 边界之外的确定性关卡。
 * 无论 Agent 是否自觉调用过 formula.validate，Runtime 都在最终输出后
 * 无条件再执行一次组成/权威校验。不依赖 Agent 的自觉。
 */

export type FormulaAuthority = 'NORMATIVE' | 'GENERATED_DRAFT' | 'BLOCKED';

export interface FormulaAuthorityInput {
  authority: string;
  composition: string[];
  sourceId: string;
}

export interface FormulaAuthorityOutput {
  authority: FormulaAuthority;
  /** 校验未通过的原因 */
  reason?: string;
}

export async function applyFormulaAuthority(
  input: FormulaAuthorityInput,
): Promise<FormulaAuthorityOutput> {
  if (input.authority !== 'NORMATIVE') {
    return { authority: input.authority as FormulaAuthority };
  }

  // NORMATIVE 必须无条件通过「组成未被篡改」校验
  const composition = input.composition.join('');
  const validation = await validateFormula(composition);

  if (!validation.valid) {
    return { authority: 'BLOCKED', reason: 'FORMULA_MUTATION' };
  }

  return { authority: 'NORMATIVE' };
}
