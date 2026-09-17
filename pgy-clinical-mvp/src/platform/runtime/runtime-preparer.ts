import { randomUUID } from 'node:crypto';
import type {
  CapabilityResolverPort,
  ClinicalUnderstandingPort,
  SafetyPort,
} from '../../contracts/ports.js';
import type { ModelProfile, RuntimeContext } from '../../contracts/runtime.js';
import type { ResolvedSkill } from '../../contracts/skill.js';
import { CapabilityRegistry } from '../registry/capability-registry.js';
import { SkillRegistry } from '../registry/skill-registry.js';
import { ToolRegistry } from '../registry/tool-registry.js';

export interface RuntimePreparerDependencies {
  understanding: ClinicalUnderstandingPort;
  capabilityResolver: CapabilityResolverPort;
  safety: SafetyPort;
  capabilities: CapabilityRegistry;
  skills: SkillRegistry;
  tools: ToolRegistry;
  model: ModelProfile;
  /** 平台级基线工具（始终允许），业务 Capability 只能在此之上追加 */
  baselineToolIds: string[];
  /** 平台级基线知识 scope（始终可检索），业务 Capability 只能在此之上追加 */
  baselineKnowledgeScopes: string[];
}

/**
 * RuntimePreparer —— 一次 Run 只装配一次运行环境。
 * Primary Agent 不再负责组装自己的世界：它拿到的就是已准备好的 RuntimeContext。
 */
export class RuntimePreparer {
  constructor(private readonly deps: RuntimePreparerDependencies) {}

  async prepare(input: string, runId: string = randomUUID()): Promise<RuntimeContext> {
    // 1. 共享语义理解（Understand once, consume everywhere）
    const understanding = await this.deps.understanding.understand(input);

    // 2. 语义能力解析（不读原文、不命关键词）
    const capabilities = await this.deps.capabilityResolver.resolve(
      understanding,
      this.deps.capabilities.enabled(),
    );
    const descriptors = capabilities.map(({ id }) =>
      this.deps.capabilities.require(id),
    );

    // 3. Skill JIT：只加载被激活 Capability 引用的 Skill
    const activatedBySkill = new Map<string, string[]>();
    for (const descriptor of descriptors) {
      for (const skillId of descriptor.skillIds) {
        const owners = activatedBySkill.get(skillId) ?? [];
        owners.push(descriptor.id);
        activatedBySkill.set(skillId, owners);
      }
    }
    const skills: ResolvedSkill[] = [...activatedBySkill.entries()].map(
      ([skillId, activatedBy]) => ({
        ...this.deps.skills.require(skillId),
        activatedBy,
      }),
    );

    // 4. 知识 scope / 工具暴露 = 平台基线 ∪ Capability 需求
    const knowledgeScopes = unique([
      ...this.deps.baselineKnowledgeScopes,
      ...descriptors.flatMap((c) => c.knowledgeScopes),
    ]);
    const toolIds = unique([
      ...this.deps.baselineToolIds,
      ...descriptors.flatMap((c) => c.toolIds),
    ]);
    const tools = toolIds.map((id) => this.deps.tools.require(id));

    // 5. 确定性安全决策
    const safety = await this.deps.safety.evaluate(understanding);

    return {
      runId,
      input,
      understanding,
      capabilities,
      skills,
      knowledgeScopes,
      tools,
      safety,
      model: this.deps.model,
      trace: { runId, startedAt: new Date().toISOString() },
    };
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
