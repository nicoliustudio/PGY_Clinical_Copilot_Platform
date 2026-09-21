import type { ClinicalWorkspace, ProposalDraft, TreatmentFormDecision } from '../../contracts/workspace.js';
import { getRuntimeAsset } from '../../knowledge/runtime-catalog.js';

/**
 * 从已检索的 GF 资产确定性补齐膏方组成 / 制法 / 用法（CASE-DERIVED ADVISORY）。
 * 这三个字段承载的是 GF 医案的原始数据，不应依赖模型复述；Runtime 只做确定性回填。
 */
function hydrateGaofangAdvisory(decision: TreatmentFormDecision, scopes: string[]): TreatmentFormDecision {
  if (scopes.length === 0) return decision;
  const gfRefs = decision.sourceEvidenceRefs.filter((r) => r.startsWith('GF-'));
  if (gfRefs.length === 0) return decision;
  for (const ref of gfRefs) {
    const asset = getRuntimeAsset(ref, scopes) as Record<string, unknown> | null;
    if (!asset) continue;
    const comp = asset.composition as { raw?: string } | undefined;
    const preparation = typeof asset.preparation_process === 'string' ? asset.preparation_process : undefined;
    const usage = typeof asset.usage === 'string' ? asset.usage : undefined;
    if (comp?.raw || preparation || usage) {
      return {
        ...decision,
        advisoryComposition: comp?.raw ? [comp.raw] : decision.advisoryComposition,
        preparation: preparation ?? decision.preparation,
        usage: usage ?? decision.usage,
      };
    }
  }
  return decision;
}

function renderTreatmentFormDecision(decision?: TreatmentFormDecision): string {
  if (!decision) return '';
  const parts = [
    `治疗形式（${decision.form}）: ${decision.disposition}`,
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
export function buildProposalDraft(workspace: ClinicalWorkspace, scopes: string[] = []): ProposalDraft {
  const spine = workspace.clinicalDecisionSpine;
  const hypotheses = workspace.hypothesisState?.hypotheses ?? [];
  const leading = hypotheses.find((h) => h.status === 'active') ?? hypotheses[0];
  const syndrome = workspace.patternAssessment?.primary?.statement ?? leading?.label;

  const plan = spine.treatmentPlan;
  const effectivePlan = plan?.treatmentFormDecision
    ? { ...plan, treatmentFormDecision: hydrateGaofangAdvisory(plan.treatmentFormDecision, scopes) }
    : plan;
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
