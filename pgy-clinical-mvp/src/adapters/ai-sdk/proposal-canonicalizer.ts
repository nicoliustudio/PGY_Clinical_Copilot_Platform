import type { AgentResult, ClinicalResult, ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { getCanonicalFormula } from '../../clinical/formula.js';
import type { KnowledgeDoc } from '../../knowledge/types.js';

/**
 * H11 Runtime canonicalization —— 将 proposal.submit 的「最小化输入」序列化为完整 AgentResult。
 *
 * - candidate_ref 是 canonical formula identity 的唯一来源；模型 raw formula 字段不参与。
 * - formula.authority 由 Runtime 判定：candidate_ref 可 canonical hydrate → NORMATIVE，否则 GENERATED_DRAFT。
 * - safety.status 由 Runtime 后续（ClinicalRuntime）以 canonical safety 覆盖，这里先占位 PASS。
 * - disease / syndrome / treatment 是模型的开放世界选择，缺失 confidence/evidence_refs 时补默认值。
 */
export async function canonicalizeProposalSubmit(
  input: ProposalSubmitInput,
  context: RuntimeContext,
  docs?: KnowledgeDoc[],
): Promise<AgentResult> {
  if (input.mode === 'conversation') return { mode: 'conversation', message: input.message };
  if (input.mode === 'clarification') return { mode: 'clarification', questions: input.questions };
  if (input.mode === 'urgent') {
    return { mode: 'urgent', message: input.message, risks: input.risks };
  }

  const ref = input.candidate_ref;
  let formula: ClinicalResult['formula'] = {
    authority: 'GENERATED_DRAFT',
    formula_id: '',
    name: '',
    composition: [],
    source_id: '',
    evidence_refs: [],
    candidate_ref: ref,
  };

  if (ref) {
    const candidate = context.workspace.candidates.find((c) => c.id === ref && c.kind === 'formula');
    if (candidate?.formulaId && candidate?.sourceId) {
      const canonical = await getCanonicalFormula(candidate.sourceId, candidate.formulaId, context.runId, docs);
      if (canonical) {
        formula = {
          authority: 'NORMATIVE',
          formula_id: canonical.formulaId,
          name: canonical.name,
          composition: [canonical.composition],
          source_id: canonical.sourceId,
          evidence_refs: [canonical.sourceId],
          candidate_ref: ref,
        };
      }
    }
  }

  return {
    mode: 'clinical',
    status: 'COMPLETED',
    disease: {
      name: input.disease.name,
      confidence: input.disease.confidence ?? 0,
      evidence_refs: input.disease.evidence_refs ?? [],
    },
    syndrome: {
      name: input.syndrome.name,
      confidence: input.syndrome.confidence ?? 0,
      evidence_refs: input.syndrome.evidence_refs ?? [],
    },
    treatment: {
      text: input.treatment.text,
      evidence_refs: input.treatment.evidence_refs ?? [],
    },
    formula,
    missing_information: input.uncertainty ?? [],
    safety: { status: 'PASS' },
  };
}
