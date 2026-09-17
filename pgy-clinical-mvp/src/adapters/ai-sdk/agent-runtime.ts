import { ToolLoopAgent, tool, isStepCount, type ToolSet } from 'ai';
import { z } from 'zod';
import { llmModel } from '../../model/adapter.js';
import { search } from '../../knowledge/search.js';
import { searchNormative, validateFormula } from '../../clinical/formula.js';
import { extractJson } from '../../util/json.js';
import { agentResultSchema, type AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { PrimaryAgentOutput, PrimaryAgentPort } from '../../contracts/ports.js';
import { addToolCall } from '../../trace.js';

/**
 * AI SDK 适配层：Clinical Primary Agent 的宿主实现。
 * 「from 'ai'」只允许出现在本目录，不进入 platform / clinical / knowledge。
 *
 * Primary Agent 只做四件事：reason → retrieve → use tool → propose。
 * 它不负责安全、方剂权威、持久化或临床 commit。
 */

/** 工具 id → 该工具在此 RuntimeContext 下的实现（scopes 等由 Context 决定） */
type ToolFactory = (context: RuntimeContext) => ToolSet[string];

const toolFactories: Record<string, ToolFactory> = {
  'knowledge.search': (context) =>
    tool({
      description:
        '检索病、证、治法相关证据，返回结构化 Top-K（含 source_id/authority/excerpt/score/provenance）。scope 由 Runtime 给定。',
      inputSchema: z.object({
        query: z.string(),
        topK: z.number().optional(),
      }),
      execute: async ({ query, topK }) =>
        search(query, topK ?? 10, context.knowledgeScopes),
    }),
  'formula.search_normative': () =>
    tool({
      description:
        '在病例问题/治法方向下检索知识库已存在的 P1 规范方，返回 formula_id/source_id/composition',
      inputSchema: z.object({
        query: z.string(),
        topK: z.number().optional(),
      }),
      execute: async ({ query, topK }) => searchNormative(query, topK ?? 10),
    }),
  'formula.validate': () =>
    tool({
      description: '验证方剂组成是否真实存在于知识库且未被篡改',
      inputSchema: z.object({ composition: z.string() }),
      execute: async ({ composition }) => validateFormula(composition),
    }),
};

function buildTools(context: RuntimeContext): ToolSet {
  const tools: ToolSet = {};
  for (const descriptor of context.tools) {
    const factory = toolFactories[descriptor.id];
    if (!factory) {
      throw new Error(`No AI SDK binding for tool id: ${descriptor.id}`);
    }
    tools[descriptor.id] = factory(context);
  }
  return tools;
}

/** 把 RuntimeContext 投影成 Agent 可读的上下文段落（Skill JIT 在此生效）。 */
function buildContextPrompt(context: RuntimeContext): string {
  const skills =
    context.skills.length > 0
      ? context.skills
          .map((skill) => `### Skill: ${skill.id}\n${skill.instruction}`)
          .join('\n\n')
      : '（本次未激活额外 Skill）';

  return [
    `本次 Run 交互模式：${context.understanding.interaction.mode}`,
    `可用知识 scope：${context.knowledgeScopes.join(', ')}`,
    `可用工具：${context.tools.map((t) => t.id).join(', ') || '（无）'}`,
    '',
    '统一语义理解结果（已由 Runtime 产出，请直接消费）：',
    JSON.stringify(context.understanding, null, 2),
    '',
    '已激活的推理指引：',
    skills,
    '',
    `医生输入：\n${context.input}`,
  ].join('\n');
}

export interface AiSdkPrimaryAgentOptions {
  /** System instructions（由 composition root 从外置 Prompt 资产加载） */
  instructions: string;
  /** 单次 Run 最大步数 */
  maxSteps?: number;
  /** 单次 Run 超时（毫秒） */
  totalTimeoutMs?: number;
}

export class AiSdkPrimaryAgent implements PrimaryAgentPort {
  constructor(private readonly options: AiSdkPrimaryAgentOptions) {}

  async run(context: RuntimeContext): Promise<PrimaryAgentOutput> {
    const agent = new ToolLoopAgent({
      model: llmModel,
      tools: buildTools(context),
      instructions: this.options.instructions,
      stopWhen: isStepCount(this.options.maxSteps ?? 12),
      onToolExecutionEnd: ({ toolCall, toolOutput, toolExecutionMs }) => {
        addToolCall({
          toolName: toolCall.toolName,
          input: toolCall.input,
          output: toolOutput,
          ms: toolExecutionMs,
        });
      },
    });

    const response = await agent.generate({
      prompt: buildContextPrompt(context),
      timeout: { totalMs: this.options.totalTimeoutMs ?? 360_000 },
    });

    const proposal: AgentResult = extractJson(response.text, agentResultSchema);

    return {
      proposal,
      usage: response.usage
        ? {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          }
        : undefined,
    };
  }
}
