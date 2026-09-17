import type { RuntimeRunResult } from '../../contracts/authority.js';
import type { PrimaryAgentPort, RuntimePreparationPort } from '../../contracts/ports.js';
import { AuthorityPipeline } from '../authority/pipeline.js';

/**
 * 稳定的 Runtime 外壳：prepare → reason/propose → authority。
 * 业务能力应通过注册数据接入，而不是在此处新增分支。
 */
export class ClinicalRuntime {
  constructor(
    private readonly preparer: RuntimePreparationPort,
    private readonly primaryAgent: PrimaryAgentPort,
    private readonly authority: AuthorityPipeline,
    /** 本次装配所用的 Prompt 内容 hash（用于 Run 快照溯源） */
    private readonly promptHash?: string,
  ) {}

  async run(input: string, runId?: string): Promise<RuntimeRunResult> {
    const context = await this.preparer.prepare(input, runId);
    const output = await this.primaryAgent.run(context);
    const authority = await this.authority.resolve(output.proposal, context);
    return {
      authority,
      usage: output.usage,
      snapshot: {
        modelProfileId: context.model.id,
        promptHash: this.promptHash,
        capabilities: context.capabilities.map((c) => c.id),
        skills: context.skills.map((s) => s.id),
        knowledgeScopes: context.knowledgeScopes,
      },
    };
  }
}
