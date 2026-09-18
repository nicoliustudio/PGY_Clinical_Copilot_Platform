import type {
  ClinicalWorkspace,
  EvidenceProjection,
  WorkspaceEventType,
} from '../../contracts/workspace.js';

export const EVIDENCE_EVENT_TYPES: WorkspaceEventType[] = [
  'knowledge.search.completed',
  'evidence.added',
  'candidate.presented',
  'candidate.selected',
  'candidate.rejected',
];

/**
 * Agent-facing evidence projection: only current evidence/candidate/uncertainty/gap state.
 * Never inject the full workspace, event log, or facts/hypotheses into the prompt.
 */
export function buildEvidenceProjection(workspace: ClinicalWorkspace): EvidenceProjection {
  return {
    evidence: workspace.evidenceState.evidenceItems.map((item) => ({
      id: item.id,
      sourceRef: item.sourceRef,
      sourceType: item.sourceType,
      title: item.title,
      summary: item.summary,
    })),
    candidates: workspace.evidenceState.candidateComparisons.map((c) => ({ ...c })),
    uncertainties: workspace.uncertainties,
    informationGaps: workspace.informationGaps,
  };
}
