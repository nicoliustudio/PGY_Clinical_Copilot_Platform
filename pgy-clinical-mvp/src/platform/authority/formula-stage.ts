import type { AuthorityStage, AuthorityStageDecision } from '../../contracts/authority.js';
import type { FormulaAuthorityPort } from '../../contracts/ports.js';
import type { AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';

/**
 * Formula Authority（无条件，位于 Agent 之外）。
 * 无论 Agent 是否自觉调用过 formula.validate，最终 NORMATIVE 都必须经此关卡。
 */
export class FormulaAuthorityStage implements AuthorityStage {
  readonly id = 'formula.authority';

  constructor(private readonly authority: FormulaAuthorityPort) {}

  async evaluate(
    proposal: AgentResult,
    _context: RuntimeContext,
  ): Promise<AuthorityStageDecision> {
    if (proposal.mode !== 'clinical') {
      return { stage: this.id, action: 'ALLOW', reasons: [] };
    }

    const formula = proposal.formula;
    if (formula.authority !== 'NORMATIVE') {
      return { stage: this.id, action: 'ALLOW', reasons: [] };
    }

    const result = await this.authority.apply({
      authority: formula.authority,
      composition: formula.composition,
      sourceId: formula.source_id,
      formulaId: formula.formula_id,
    });

    if (result.authority === 'BLOCKED') {
      return {
        stage: this.id,
        action: 'BLOCK',
        reasons: [result.reason ?? 'Formula authority rejected the proposal.'],
        proposal: {
          ...proposal,
          status: 'BLOCKED',
          formula: { ...formula, authority: 'BLOCKED' },
        },
      };
    }

    return { stage: this.id, action: 'ALLOW', reasons: [] };
  }
}
