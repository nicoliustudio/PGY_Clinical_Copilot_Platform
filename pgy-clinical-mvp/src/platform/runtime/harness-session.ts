import type { HarnessActivationResult, HarnessControlPort } from '../../contracts/harness.js';
import { toCapabilityView } from '../../contracts/harness.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import { CapabilityRegistry } from '../registry/capability-registry.js';
import { SkillRegistry } from '../registry/skill-registry.js';
import { ToolRegistry } from '../registry/tool-registry.js';

export class HarnessSession implements HarnessControlPort {
  constructor(
    private readonly context: RuntimeContext,
    private readonly capabilities: CapabilityRegistry,
    private readonly skills: SkillRegistry,
    private readonly tools: ToolRegistry,
  ) {}

  listCapabilities() {
    return this.capabilities.enabled().map(toCapabilityView);
  }

  isCapabilityActive(id: string): boolean {
    return this.context.capabilities.some((c) => c.id === id);
  }

  activateCapability(id: string, reason: string): HarnessActivationResult {
    const descriptor = this.capabilities.require(id);
    if (descriptor.enabled === false) throw new Error(`Capability disabled: ${id}`);

    let resolved = this.context.capabilities.find((c) => c.id === id);
    const reused = resolved !== undefined;
    if (!resolved) {
      resolved = { id, confidence: 1, reason, treatmentSpecific: descriptor.treatmentSpecific };
      this.context.capabilities.push(resolved);
    }

    const addedKnowledgeScopes: string[] = [];
    for (const scope of descriptor.knowledgeScopes) {
      if (!this.context.knowledgeScopes.includes(scope)) {
        this.context.knowledgeScopes.push(scope);
        addedKnowledgeScopes.push(scope);
      }
    }

    const addedSkills: { id: string; instruction: string }[] = [];
    for (const skillId of descriptor.skillIds) {
      const existing = this.context.skills.find((s) => s.id === skillId);
      if (existing) {
        if (!existing.activatedBy.includes(id)) existing.activatedBy.push(id);
        continue;
      }
      const skill = this.skills.require(skillId);
      const resolvedSkill = { ...skill, activatedBy: [id] };
      this.context.skills.push(resolvedSkill);
      addedSkills.push({ id: skill.id, instruction: skill.instruction });
    }

    const addedToolIds: string[] = [];
    for (const toolId of descriptor.toolIds) {
      if (!this.context.tools.some((t) => t.id === toolId)) {
        this.context.tools.push(this.tools.require(toolId));
        addedToolIds.push(toolId);
      }
    }

    return { capability: resolved, addedKnowledgeScopes, addedSkills, addedToolIds, reused };
  }
}
