import type { ClinicalWorkspace, WorkspaceEvent } from '../../contracts/workspace.js';

export class ClinicalWorkspaceStore {
  private readonly events: WorkspaceEvent[] = [];

  constructor(
    private readonly workspace: ClinicalWorkspace,
    private readonly runId: string,
  ) {}

  get state(): ClinicalWorkspace {
    return this.workspace;
  }

  append(type: WorkspaceEvent['type'], payload: Record<string, unknown>): WorkspaceEvent {
    const event: WorkspaceEvent = {
      runId: this.runId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    this.apply(event);
    return event;
  }

  trace(): WorkspaceEvent[] {
    return [...this.events];
  }

  private apply(event: WorkspaceEvent) {
    if (event.type === 'evidence.added' && typeof event.payload.id === 'string') {
      this.workspace.evidenceRefs.push({
        id: event.payload.id,
        sourceId: typeof event.payload.sourceId === 'string' ? event.payload.sourceId : undefined,
      });
    }
    if (event.type === 'candidate.selected' && typeof event.payload.id === 'string') {
      this.workspace.candidates.push({
        id: event.payload.id,
        kind: 'formula',
      });
    }
  }
}
