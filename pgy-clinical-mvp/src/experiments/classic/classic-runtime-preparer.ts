import { randomUUID } from 'node:crypto';
import type { ClinicalUnderstandingPort, RuntimePreparationPort, SafetyPort } from '../../contracts/ports.js';
import type { ModelProfile, RuntimeContext } from '../../contracts/runtime.js';
import { CapabilityRegistry } from '../../platform/registry/capability-registry.js';
import { SkillRegistry } from '../../platform/registry/skill-registry.js';
import { ToolRegistry } from '../../platform/registry/tool-registry.js';
import { HarnessSession } from '../../platform/runtime/harness-session.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../../platform/workspace/clinical-workspace.js';
import { ClassicSemanticNeedResolver } from './semantic-need-resolver.js';
import { emptyClinicalStrategy } from '../../contracts/clinical-strategy.js';
import { CommitLedger } from '../../platform/commit/commit-ledger.js';

export interface ClassicRuntimePreparerDependencies {
  understanding: ClinicalUnderstandingPort;
  safety: SafetyPort;
  capabilities: CapabilityRegistry;
  skills: SkillRegistry;
  tools: ToolRegistry;
  model: ModelProfile;
  baselineToolIds: string[];
  baselineKnowledgeScopes: string[];
}

/** Legacy pre-routing path retained only for A/B regression. */
export class ClassicRuntimePreparer implements RuntimePreparationPort {
  private readonly resolver = new ClassicSemanticNeedResolver();
  constructor(private readonly deps: ClassicRuntimePreparerDependencies) {}

  async prepare(input: string, runId: string = randomUUID()): Promise<RuntimeContext> {
    const understanding = await this.deps.understanding.understand(input);
    const safety = await this.deps.safety.evaluate(understanding);

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
      strategy: emptyClinicalStrategy(),
      capabilities: [],
      skills: [],
      knowledgeScopes: [...new Set(this.deps.baselineKnowledgeScopes)],
      tools: this.deps.baselineToolIds.map((id) => this.deps.tools.require(id)),
      safety,
      model: this.deps.model,
      trace: { runId, startedAt: new Date().toISOString() },
      harness: undefined as unknown as RuntimeContext['harness'],
      workspace,
      workspaceStore,
      commitLedger: new CommitLedger(),
    } satisfies RuntimeContext;
    const harness = new HarnessSession(context, this.deps.capabilities, this.deps.skills, this.deps.tools);
    context.harness = harness;
    const resolved = await this.resolver.resolve(understanding, this.deps.capabilities.enabled());
    for (const cap of resolved) harness.activateCapability(cap.id, cap.reason);
    return context;
  }
}
