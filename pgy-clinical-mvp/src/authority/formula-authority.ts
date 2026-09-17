import { validateNormativeFormula } from '../clinical/formula.js';
import type { FormulaAuthorityPort } from '../contracts/ports.js';
import type { FormulaAuthorityInput, FormulaAuthorityOutput } from '../contracts/proposal.js';

export class DeterministicFormulaAuthority implements FormulaAuthorityPort {
  async apply(input: FormulaAuthorityInput): Promise<FormulaAuthorityOutput> {
    if (input.authority !== 'NORMATIVE') return { authority: input.authority };
    if (!input.sourceId) return { authority: 'BLOCKED', reason: 'MISSING_NORMATIVE_SOURCE' };
    if (!input.formulaId) return { authority: 'BLOCKED', reason: 'MISSING_NORMATIVE_FORMULA_ID' };

    const validation = await validateNormativeFormula({
      sourceId: input.sourceId,
      formulaId: input.formulaId,
      composition: input.composition.join(''),
    });
    if (!validation.valid) return { authority: 'BLOCKED', reason: 'FORMULA_SOURCE_BINDING_MISMATCH' };
    return { authority: 'NORMATIVE' };
  }
}
