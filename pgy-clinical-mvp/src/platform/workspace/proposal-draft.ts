import type { ClinicalWorkspace, ProposalDraft, TreatmentFormDecision } from '../../contracts/workspace.js';

function renderTreatmentFormDecision(decision?: TreatmentFormDecision): string {
  if (!decision) return '';
  const parts = [
    `治疗形式（膏方）: ${decision.disposition}`,
    decision.statement,
  ];
  if (decision.advisoryComposition?.length) parts.push(`膏方医案参考组成（CASE-DERIVED ADVISORY）: ${decision.advisoryComposition.join('；')}`);
  if (decision.preparation) parts.push(`制法参考: ${decision.preparation}`);
  if (decision.usage) parts.push(`用法参考: ${decision.usage}`);
  if (decision.sourceEvidenceRefs.length) parts.push(`膏方证据: ${decision.sourceEvidenceRefs.join(', ')}`);
  return parts.join('\n');
}

/**
 * ProposalDraft —— 只读投影 Workspace 中已经形成的临床判断。
 * Runtime 只序列化，不在候选之间自行选择。
 */
export function buildProposalDraft(workspace: ClinicalWorkspace): ProposalDraft {
  const spine = workspace.clinicalDecisionSpine;
  const hypotheses = workspace.hypothesisState?.hypotheses ?? [];
  const leading = hypotheses.find((h) => h.status === 'active') ?? hypotheses[0];
  const syndrome = workspace.patternAssessment?.primary?.statement ?? leading?.label;

  const plan = spine.treatmentPlan;
  const treatment = plan
    ? [
        plan.primaryPrinciple,
        plan.treatmentTarget ? `治疗目标: ${plan.treatmentTarget}` : '',
        plan.priority ? `主次: ${plan.priority}` : '',
        plan.rationale ? `依据: ${plan.rationale}` : '',
        renderTreatmentFormDecision(plan.treatmentFormDecision),
      ].filter(Boolean).join('\n')
    : undefined;

  const frontier = workspace.deliberationState?.frontier ?? [];
  const selectedCandidateRef = spine.formulaSelection?.selectedCandidateRef
    ?? (frontier.length === 1 ? frontier[0] : undefined);

  return {
    disease: spine.diseaseAssessment?.statement,
    syndrome,
    treatment,
    selectedCandidateRef,
    uncertainty: (workspace.uncertainties ?? []).slice(),
  };
}

/** 非空字段计数，用于 proposalDraftFieldCount telemetry。 */
export function countProposalDraftFields(draft: ProposalDraft): number {
  let n = 0;
  if (draft.disease !== undefined && draft.disease !== '') n += 1;
  if (draft.syndrome !== undefined && draft.syndrome !== '') n += 1;
  if (draft.treatment !== undefined && draft.treatment !== '') n += 1;
  if (draft.selectedCandidateRef !== undefined && draft.selectedCandidateRef !== '') n += 1;
  if (draft.uncertainty !== undefined && draft.uncertainty.length > 0) n += 1;
  return n;
}
