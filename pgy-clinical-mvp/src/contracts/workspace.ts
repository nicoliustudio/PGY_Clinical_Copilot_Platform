export interface EvidenceReference {
  id: string;
  sourceId?: string;
  summary?: string;
}

export interface CandidateReference {
  id: string;
  kind: 'formula' | 'syndrome' | 'hypothesis';
  confidence?: number;
}

export interface ClinicalWorkspace {
  facts: unknown[];
  hypotheses: unknown[];
  evidenceRefs: EvidenceReference[];
  candidates: CandidateReference[];
  informationGaps: string[];
  uncertainties: string[];
  activeCapabilities: string[];
  activeSkills: string[];
  safetyDisposition: 'routine' | 'urgent' | 'uncertain';
}

export type WorkspaceEventType =
  | 'workspace.seeded'
  | 'evidence.added'
  | 'candidate.selected'
  | 'capability.activated'
  | 'safety.updated';

export interface WorkspaceEvent {
  runId: string;
  type: WorkspaceEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}
