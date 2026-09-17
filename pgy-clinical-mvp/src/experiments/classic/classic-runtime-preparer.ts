import { randomUUID } from 'node:crypto';
import type { ClinicalUnderstandingPort, RuntimePreparationPort, SafetyPort } from '../../contracts/ports.js';
import type { ModelProfile, RuntimeContext } from '../../contracts/runtime.js';
import { CapabilityRegistry } from '../../platform/registry/capability-registry.js';
import { SkillRegistry } from '../../platform/registry/skill-registry.js';
import { ToolRegistry } from '../../platform/registry/tool-registry.js';
import { HarnessSession } from '../../platform/runtime/harness-session.js';
import { ClassicSemanticNeedResolver } from './semantic-need-resolver.js';

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
    const context = {
      runId,
      input,
      understanding,
      capabilities: [],
      skills: [],
      knowledgeScopes: [...new Set(this.deps.baselineKnowledgeScopes)],
      tools: this.deps.baselineToolIds.map((id) => this.deps.tools.require(id)),
      safety: await this.deps.safety.evaluate(understanding),
      model: this.deps.model,
      trace: { runId, startedAt: new Date().toISOString() },
      harness: undefined as unknown as RuntimeContext['harness'],
    } satisfies RuntimeContext;
    const harness = new HarnessSession(context, this.deps.capabilities, this.deps.skills, this.deps.tools);
    context.harness = harness;
    const resolved = await this.resolver.resolve(understanding, this.deps.capabilities.enabled());
    for (const cap of resolved) harness.activateCapability(cap.id, cap.reason);
    return context;
  }
}
