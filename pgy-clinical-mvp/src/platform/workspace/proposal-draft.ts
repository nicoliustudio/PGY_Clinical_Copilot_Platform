import type { ProposalSubmitInput } from '../../contracts/result.js';
import type { ClinicalWorkspace, ProposalDraft, TreatmentFormDecision } from '../../contracts/workspace.js';

function renderTreatmentFormDecision(decision?: TreatmentFormDecision): string {
  if (!decision) return '';
  const parts = [
    `治疗形式（${decision.form}）: ${decision.disposition}`,
    decision.statement,
  ];
  if (decision.advisoryComposition?.length) parts.push(`治疗形式参考组成（CASE-DERIVED ADVISORY）: ${decision.advisoryComposition.join('；')}`);
  if (decision.preparation) parts.push(`制法参考: ${decision.preparation}`);
  if (decision.usage) parts.push(`用法参考: ${decision.usage}`);
  if (decision.sourceEvidenceRefs.length) parts.push(`治疗形式证据: ${decision.sourceEvidenceRefs.join(', ')}`);
  return parts.join('\n');
}

/**
 * ProposalDraft —— 只读投影 Workspace 中已经形成的临床判断。
 * Runtime 只序列化，不在候选之间自行选择。
 */
export function buildProposalDraft(workspace: ClinicalWorkspace, scopes: string[] = []): ProposalDraft {
  const spine = workspace.clinicalDecisionSpine;
  const hypotheses = workspace.hypothesisState?.hypotheses ?? [];
  const leading = hypotheses.find((h) => h.status === 'active') ?? hypotheses[0];
  const syndrome = workspace.patternAssessment?.primary?.statement ?? leading?.label;

  const plan = spine.treatmentPlan;
  const effectivePlan = plan;
  const treatment = effectivePlan
    ? [
        effectivePlan.primaryPrinciple,
        effectivePlan.treatmentTarget ? `治疗目标: ${effectivePlan.treatmentTarget}` : '',
        effectivePlan.priority ? `主次: ${effectivePlan.priority}` : '',
        effectivePlan.rationale ? `依据: ${effectivePlan.rationale}` : '',
        renderTreatmentFormDecision(effectivePlan.treatmentFormDecision),
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


function uniqRefs(refs: Array<string | undefined>): string[] {
  return [...new Set(refs.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))];
}

/**
 * Durable state 已 ready 后的 deterministic submit projection。
 *
 * 这里不做任何临床推理：只把 Workspace 已存在的 disease / primary pattern /
 * treatment / selected candidate / uncertainty 投影成 proposal.submit 的最小输入。
 * 若 ready-state 与可序列化 state 不一致，返回 null，让 Runtime fail closed 暴露 invariant bug。
 */
export function buildDeterministicClinicalSubmit(
  workspace: ClinicalWorkspace,
  scopes: string[] = [],
): ProposalSubmitInput | null {
  const spine = workspace.clinicalDecisionSpine;
  const disease = spine.diseaseAssessment;
  const primary = workspace.patternAssessment?.primary;
  const plan = spine.treatmentPlan;
  if (!disease?.statement || !primary?.statement || !plan) return null;

  const draft = buildProposalDraft(workspace, scopes);
  if (!draft.treatment) return null;

  const uncertainty = uniqRefs([
    ...(workspace.uncertainties ?? []),
    ...(disease.uncertainty ?? []),
    ...(workspace.patternAssessment?.uncertainty ?? []),
  ]);

  return {
    mode: 'clinical',
    disease: {
      name: disease.statement,
      evidence_refs: uniqRefs([...(disease.diseaseRefs ?? []), ...disease.evidenceRefs]),
    },
    syndrome: {
      name: primary.statement,
      evidence_refs: uniqRefs([...(primary.supportingEvidenceRefs ?? [])]),
    },
    treatment: {
      text: draft.treatment,
      evidence_refs: uniqRefs([
        ...plan.evidenceRefs,
        ...(plan.treatmentFormDecision?.sourceEvidenceRefs ?? []),
      ]),
    },
    ...(draft.selectedCandidateRef ? { candidate_ref: draft.selectedCandidateRef } : {}),
    ...(uncertainty.length ? { uncertainty } : {}),
  };
}
