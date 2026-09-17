import { validateFormula } from '../clinical/formula.js';
import type { FormulaAuthorityPort } from '../contracts/ports.js';
import type {
  FormulaAuthorityInput,
  FormulaAuthorityOutput,
} from '../contracts/proposal.js';

/**
 * Formula Authority —— Agent 边界之外的确定性关卡。
 * 无论 Agent 是否自觉调用过 formula.validate，Runtime 都在最终输出后
 * 无条件再执行一次组成/权威校验。不依赖 Agent 的自觉。
 */
export class DeterministicFormulaAuthority implements FormulaAuthorityPort {
  async apply(input: FormulaAuthorityInput): Promise<FormulaAuthorityOutput> {
    if (input.authority !== 'NORMATIVE') {
      return { authority: input.authority };
    }

    // NORMATIVE 必须绑定真实 source_id，否则不得进入权威状态。
    // 这条不变量对「知识库命中」和「未来 fallback 生成」一视同仁：无真实来源一律阻断。
    if (!input.sourceId) {
      return { authority: 'BLOCKED', reason: 'MISSING_NORMATIVE_SOURCE' };
    }

    // NORMATIVE 必须无条件通过「组成未被篡改」校验
    const validation = await validateFormula(input.composition.join(''));

    if (!validation.valid) {
      return { authority: 'BLOCKED', reason: 'FORMULA_MUTATION' };
    }

    return { authority: 'NORMATIVE' };
  }
}
