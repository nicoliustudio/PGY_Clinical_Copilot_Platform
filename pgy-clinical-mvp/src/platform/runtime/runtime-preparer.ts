import { randomUUID } from 'node:crypto';
import type { ClinicalUnderstandingPort, RuntimePreparationPort, SafetyPort } from '../../contracts/ports.js';
import type { ModelProfile, RuntimeContext } from '../../contracts/runtime.js';
import type { ResolvedSkill } from '../../contracts/skill.js';
import { CapabilityRegistry } from '../registry/capability-registry.js';
import { SkillRegistry } from '../registry/skill-registry.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import { HarnessSession } from './harness-session.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../workspace/clinical-workspace.js';

export interface RuntimePreparerDependencies {
  understanding: ClinicalUnderstandingPort;
  safety: SafetyPort;
  capabilities: CapabilityRegistry;
  skills: SkillRegistry;
  tools: ToolRegistry;
  model: ModelProfile;
  baselineToolIds: string[];
  baselineSkillIds: string[];
  baselineKnowledgeScopes: string[];
}

/**
 * H1 Harness bootstrap: seed semantic working memory and baseline platform assets only.
 * Business capabilities are NOT pre-routed. The agent discovers/activates them in-loop.
 */
export class RuntimePreparer implements RuntimePreparationPort {
  constructor(private readonly deps: RuntimePreparerDependencies) {}

  async prepare(input: string, runId: string = randomUUID()): Promise<RuntimeContext> {
    const understanding = await this.deps.understanding.understand(input);
    const safety = await this.deps.safety.evaluate(understanding);
    const skills: ResolvedSkill[] = this.deps.baselineSkillIds.map((id) => ({
      ...this.deps.skills.require(id),
      activatedBy: ['harness.baseline'],
    }));

    const workspace = createClinicalWorkspace();
    const workspaceStore = new ClinicalWorkspaceStore(workspace, runId);
    workspace.facts = [...understanding.facts];
    workspace.informationGaps = understanding.informationGaps.map((g) => g.question);
    workspace.uncertainties = understanding.uncertainties.map((u) => u.item);
    workspace.safetyDisposition =
      safety.status === 'BLOCK' ? 'urgent' : safety.status === 'CAUTION' ? 'uncertain' : 'routine';
    workspaceStore.append('workspace.seeded', { input });

    const context = {
      runId,
      input,
      understanding,
      capabilities: [],
      skills,
      knowledgeScopes: [...new Set(this.deps.baselineKnowledgeScopes)],
      tools: this.deps.baselineToolIds.map((id) => this.deps.tools.require(id)),
      safety,
      model: this.deps.model,
      trace: { runId, startedAt: new Date().toISOString() },
      harness: undefined as unknown as RuntimeContext['harness'],
      workspace,
      workspaceStore,
    } satisfies RuntimeContext;

    context.harness = new HarnessSession(
      context,
      this.deps.capabilities,
      this.deps.skills,
      this.deps.tools,
    );
    return context;
  }
}
