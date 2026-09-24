import type { AgentResult, ClinicalResult, ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { getCanonicalFormula } from '../../clinical/formula.js';
import { getP2CaseFormulaComposition } from '../../clinical/formula-evidence.js';
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
  // Kernel Commit Boundary：canonical hydrate 失败不得降级为空的 GENERATED_DRAFT 产品。
  // 只有当 candidate_ref 能解析到 canonical source/product（NORMATIVE）或 P2 case-derived 时才产出 formula。
  let formula: ClinicalResult['formula'];

  // Authority Cutover: under V2.1 a proposal candidate_ref is only a reasoning hint. It must not
  // hydrate/materialize a product or create a second product authority path. Product materialization
  // happens only inside Kernel delivery.commit from durable selection state.
  if (ref && context.controlPlaneV21?.compileStatus !== 'COMPILED') {
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
      } else if (candidate.sourceAuthority === 'P2_CASE_DERIVED') {
        // H15.2.6/H15.2.7：P2 case-derived fallback —— 不升级 authority，保留 provenance（name + composition + case/visit/evidence）。
        // composition 从源病例方药单元确定性读取（不塞回病例全文，不补药/改剂量）。
        const p2 = await getP2CaseFormulaComposition(candidate.sourceId ?? '', docs);
        formula = {
          authority: 'GENERATED_DRAFT',
          formula_id: candidate.formulaId,
          name: p2?.formulaName ?? candidate.name ?? '',
          composition: p2 ? [p2.composition] : candidate.composition ?? [],
          source_id: candidate.sourceId,
          evidence_refs: candidate.sourceCaseRef ? [candidate.sourceCaseRef] : [],
          candidate_ref: ref,
          source_authority: 'P2_CASE_DERIVED',
          source_case_ref: candidate.sourceCaseRef,
          visit_ref: candidate.visitRef,
          source_evidence_ref: candidate.sourceEvidenceRef,
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
