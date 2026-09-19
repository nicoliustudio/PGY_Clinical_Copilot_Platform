import type { ClinicalWorkspace, ProposalDraft } from '../../contracts/workspace.js';

/**
 * H11 ProposalDraft —— 从 Workspace 只读投影「已经明确形成的最终判断」。
 *
 * 严格 serialization，不创造临床判断：
 * - syndrome 来自 leading hypothesis（active > first），不推断新证型。
 * - selectedCandidateRef 仅在 frontier 恰好一个 candidate 时给出，不在多候选间自行选择。
 * - uncertainty 直接复用 workspace.uncertainties。
 * - disease / treatment 当前 Workspace 未持久化，故保持 undefined（不编造）。
 */
export function buildProposalDraft(workspace: ClinicalWorkspace): ProposalDraft {
  const hypotheses = workspace.hypothesisState?.hypotheses ?? [];
  const leading = hypotheses.find((h) => h.status === 'active') ?? hypotheses[0];

  const frontier = workspace.deliberationState?.frontier ?? [];
  const selectedCandidateRef = frontier.length === 1 ? frontier[0] : undefined;

  return {
    syndrome: leading?.label,
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
