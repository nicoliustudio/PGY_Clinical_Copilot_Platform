import { ToolLoopAgent, isStepCount, type ToolSet } from 'ai';
import { llmModel } from '../../model/adapter.js';
import { extractJson } from '../../util/json.js';
import { agentResultSchema, type AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { PrimaryAgentOutput, PrimaryAgentPort } from '../../contracts/ports.js';
import { addToolCall } from '../../trace.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS, type AiSdkToolBindings } from './tool-bindings.js';

function buildTools(context: RuntimeContext, bindings: AiSdkToolBindings): ToolSet {
  const tools: ToolSet = {};
  for (const [id, factory] of Object.entries(bindings)) tools[id] = factory(context);
  return tools;
}

function activeToolIds(context: RuntimeContext, bindings: AiSdkToolBindings, mode: 'harness' | 'classic'): string[] {
  const allowed = new Set(context.tools.map((t) => t.id));
  if (mode === 'harness') {
    allowed.add('capability.search');
    allowed.add('capability.activate');
  }
  return [...allowed].filter((id) => Boolean(bindings[id]));
}

function dynamicInstructions(base: string, context: RuntimeContext): string {
  const skills = context.skills.map((s) => `### Skill: ${s.id}\n${s.instruction}`).join('\n\n');
  return `${base}\n\n## Active Harness Skills\n${skills || '（无）'}\n\nActive scopes: ${context.knowledgeScopes.join(', ')}`;
}

function buildContextPrompt(context: RuntimeContext, mode: 'harness' | 'classic'): string {
  const skills = context.skills.map((skill) => `### Skill: ${skill.id}\n${skill.instruction}`).join('\n\n');
  return [
    `本次 Run 初始交互模式：${context.understanding.interaction.mode}`,
    '',
    '初始共享语义工作记忆（seed，不是固定流水线结论；可在检索/工具调用后修正）：',
    JSON.stringify(context.understanding, null, 2),
    '',
    mode === 'harness' ? 'Harness active skills:' : 'Classic pre-routed skills:', skills || '（无）',
    '',
    mode === 'harness'
      ? '你拥有 capability.search / capability.activate。需要业务扩展时先发现再激活；激活结果会返回新增 Skill 指令和 scope，并立即影响后续工具调用。'
      : 'Classic A/B：Capability 已由 legacy resolver 预装配；不要调用 Harness capability controls。',
    mode === 'harness'
      ? 'RAG 是 reasoning loop 中的工具：允许 search → inspect source → re-search → compare，不要把首次 Top-K 当最终答案。'
      : '按已装配工具完成检索与 Proposal。',
    '',
    `医生输入：\n${context.input}`,
  ].join('\n');
}

export interface AiSdkPrimaryAgentOptions {
  instructions: string;
  maxSteps?: number;
  totalTimeoutMs?: number;
  toolBindings?: AiSdkToolBindings;
  mode?: 'harness' | 'classic';
}

export class AiSdkPrimaryAgent implements PrimaryAgentPort {
  constructor(private readonly options: AiSdkPrimaryAgentOptions) {}

  async run(context: RuntimeContext): Promise<PrimaryAgentOutput> {
    const bindings = this.options.toolBindings ?? DEFAULT_AI_SDK_TOOL_BINDINGS;
    const mode = this.options.mode ?? 'harness';
    const agent = new ToolLoopAgent({
      model: llmModel,
      tools: buildTools(context, bindings),
      instructions: dynamicInstructions(this.options.instructions, context),
      prepareStep: async () => ({
        activeTools: activeToolIds(context, bindings, mode),
        instructions: dynamicInstructions(this.options.instructions, context),
      }),
      stopWhen: isStepCount(this.options.maxSteps ?? 16),
      onToolExecutionEnd: ({ toolCall, toolOutput, toolExecutionMs }) => {
        addToolCall(context.runId, { toolName: toolCall.toolName, input: toolCall.input, output: toolOutput, ms: toolExecutionMs });
      },
    });

    const response = await agent.generate({
      prompt: buildContextPrompt(context, mode),
      timeout: { totalMs: this.options.totalTimeoutMs ?? 360_000 },
    });
    const proposal: AgentResult = extractJson(response.text, agentResultSchema);
    return {
      proposal,
      usage: response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : undefined,
    };
  }
}
