import { randomUUID } from 'node:crypto';
import type { ClinicalPlannerPort, ClinicalUnderstandingPort, RuntimePreparationPort, SafetyPort } from '../../contracts/ports.js';
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
  planner: ClinicalPlannerPort;
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
    const strategy = await this.deps.planner.plan({
      input,
      understanding,
      safety,
      availableCapabilities: this.deps.capabilities.enabled().map((c) => ({
        id: c.id,
        semanticDescription: c.semanticDescription,
      })),
    });
    const skills: ResolvedSkill[] = this.deps.baselineSkillIds.map((id) => ({
      ...this.deps.skills.require(id),
      activatedBy: ['harness.baseline'],
    }));

    const workspace = createClinicalWorkspace();
    const workspaceStore = new ClinicalWorkspaceStore(workspace, runId);
    workspace.facts = [...understanding.facts];
    workspace.caseFacts = understanding.facts.map((f, i) => ({
      id: `CF_${String(i + 1).padStart(3, '0')}`,
      kind: f.kind,
      value: f.value,
      source: f.source,
      evidenceKind: 'patient',
      temporalRole: f.temporalRole,
      polarity: f.polarity,
    }));
    workspace.informationGaps = understanding.informationGaps.map((g) => g.question);
    workspace.uncertainties = understanding.uncertainties.map((u) => u.item);
    workspace.safetyDisposition =
      safety.status === 'BLOCK' ? 'urgent' : safety.status === 'CAUTION' ? 'uncertain' : 'routine';
    // H15：Clinical Decision Spine 的 clinical question 从规划层初始化为当前临床判断。
    workspace.clinicalDecisionSpine.clinicalQuestion = { statement: strategy.decisionQuestion ?? '', version: 0 };
    workspaceStore.append('workspace.seeded', { input });

    const context = {
      runId,
      input,
      understanding,
      strategy,
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
