import { ToolLoopAgent, isStepCount, hasToolCall, generateText, type ToolSet, type ModelMessage } from 'ai';
import { llmModel } from '../../model/adapter.js';
import { extractJson } from '../../util/json.js';
import { agentResultSchema, type AgentResult } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { PrimaryAgentOutput, PrimaryAgentPort } from '../../contracts/ports.js';
import type { AgentStreamEvent, LifecycleStage } from '../../contracts/stream.js';
import type { AgentLoopTrace, TerminationReason, ContextMetrics } from '../../contracts/agent-loop.js';
import { addToolCall } from '../../trace.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS, type AiSdkToolBindings } from './tool-bindings.js';
import { applyToolExecutionResult, type ToolExecutionEnvelope } from './workspace-events.js';
import { ToolCallLedger } from './tool-call-ledger.js';
import { buildEvidenceProjection } from '../../platform/workspace/evidence-projection.js';
import { buildHypothesisProjection } from '../../platform/workspace/hypothesis-projection.js';
import { buildComparisonMatrix } from '../../platform/workspace/deliberation-projection.js';
import { renderActiveSkills } from '../../platform/skills/render-skills.js';
import { buildClinicalWorkingView, renderClinicalWorkingView, estimateTokens, type RecentAction } from '../../platform/context/clinical-working-view.js';
import type { ClinicalWorkspace } from '../../contracts/workspace.js';

/**
 * H2.5D：promotion gap 只作为 Agent projection / diagnostics / trace，不再自动扩大 reasoning loop。
 * 无论 workspace 里有多少 unresolved gap，reasoning 都只跑一轮，避免额外自由 pass 扰动已正确的选择。
 */
export function reasoningPassCount(_workspace: ClinicalWorkspace): number {
  return 1;
}

/**
 * DeepSeek 官方 API 的 function.name 只允许 [a-zA-Z0-9_-]，不接受点号。
 * 这里把内部工具名（如 capability.discover）映射为 API 名（capability-discover）；
 * 连字符在内部工具名中不存在，因此反向映射无歧义。
 */
function toApiToolName(id: string): string {
  return id.replace(/\./g, '-');
}

function fromApiToolName(name: string): string {
  return name.replace(/-/g, '.');
}

function wrapToolWithLedger(id: string, t: ToolSet[string], ledger: ToolCallLedger): ToolSet[string] {
  const original = t.execute as unknown as ((input: unknown, options: unknown) => unknown) | undefined;
  if (!original) return t;
  return {
    ...t,
    execute: async (input: unknown, options: unknown) => {
      const cached = ledger.reuse(id, input);
      if (cached) return cached.output;
      const output = await original(input, options);
      ledger.record(id, input, output);
      return output;
    },
  } as ToolSet[string];
}

function buildTools(context: RuntimeContext, bindings: AiSdkToolBindings, ledger: ToolCallLedger): ToolSet {
  const tools: ToolSet = {};
  for (const [id, factory] of Object.entries(bindings)) {
    tools[toApiToolName(id)] = wrapToolWithLedger(id, factory(context), ledger);
  }
  return tools;
}

function activeToolIds(context: RuntimeContext, bindings: AiSdkToolBindings, mode: 'harness' | 'classic'): string[] {
  const allowed = new Set(context.tools.map((t) => t.id));
  if (mode === 'harness') {
    allowed.add('capability.discover');
    allowed.add('capability.activate');
    allowed.add('proposal.submit');
  }
  return [...allowed].filter((id) => Boolean(bindings[id])).map((id) => toApiToolName(id));
}

function buildSearchHistory(ledger: ToolCallLedger): string {
  const rows = ledger.entries()
    .filter((e) => e.toolName === 'knowledge.search' || e.toolName === 'formula.search_normative')
    .map((e) => `- ${e.toolName} ${e.normalizedInput.slice(0, 160)}${e.reused ? ' [reused]' : ''}`);
  return rows.join('\n');
}

function buildRecentActions(ledger?: ToolCallLedger): RecentAction[] {
  if (!ledger) return [];
  const useful = new Set([
    'knowledge.search',
    'knowledge.get_source',
    'formula.search_normative',
    'workspace.focus_candidates',
    'workspace.record_deliberation',
    'workspace.record_candidate_assessment',
    'workspace.record_candidate_exclusion',
  ]);
  return ledger.entries()
    .filter((e) => useful.has(e.toolName))
    .slice(-6)
    .map((e) => ({ toolName: e.toolName, summary: e.normalizedInput.slice(0, 120) }));
}

const ACTION_PRINCIPLE = `## Action Principle
- 再次调用工具前，先判断：该动作是否会实质性减少当前 ClinicalStrategy 中某个开放问题或不确定性？
- 若已有证据足以支撑可辩护 Proposal，优先调用 proposal.submit。
- 不要因为「可能还有更多信息」就继续搜索。
- 保留显式不确定性，而不是追求穷尽式确定。`;

export function dynamicInstructions(base: string, context: RuntimeContext, ledger?: ToolCallLedger): string {
  const skills = renderActiveSkills(context.skills);
  const view = buildClinicalWorkingView(context.workspace, context.strategy, buildRecentActions(ledger));
  const workingView = renderClinicalWorkingView(view);
  return `${base}\n\n${ACTION_PRINCIPLE}\n\n## Active Harness Skills\n${skills || '（无）'}\n\nActive scopes: ${context.knowledgeScopes.join(', ')}\n\n## Clinical Working View\n${workingView}`;
}

/** 度量「目标驱动工作上下文」相对「全量投影」的收缩程度（估算）。 */
function computeContextMetrics(context: RuntimeContext, ledger: ToolCallLedger): ContextMetrics {
  const workingView = renderClinicalWorkingView(buildClinicalWorkingView(context.workspace, context.strategy, buildRecentActions(ledger)));
  const raw = [
    JSON.stringify(buildHypothesisProjection(context.workspace), null, 2),
    JSON.stringify(buildEvidenceProjection(context.workspace), null, 2),
    JSON.stringify(buildComparisonMatrix(context.workspace), null, 2),
    buildSearchHistory(ledger),
  ].join('\n\n');
  const workingViewTokenEstimate = estimateTokens(workingView);
  const rawContextTokenEstimate = estimateTokens(raw);
  const compressionRatio = workingViewTokenEstimate === 0 ? 0 : rawContextTokenEstimate / workingViewTokenEstimate;
  return { workingViewTokenEstimate, rawContextTokenEstimate, compressionRatio };
}

function buildContextPrompt(context: RuntimeContext, mode: 'harness' | 'classic'): string {
  const skills = context.skills.map((skill) => `### Skill: ${skill.id}\n${skill.instruction}`).join('\n\n');
  return [
    `本次 Run 初始交互模式：${context.understanding.interaction.mode}`,
    '',
    `初始安全处置：${context.workspace.safetyDisposition}`,
    '临床总策划（ClinicalStrategy）与当前工作上下文见 system 指令中的 Clinical Working View。',
    '',
    mode === 'harness' ? 'Harness active skills:' : 'Classic pre-routed skills:', skills || '（无）',
    '',
    mode === 'harness'
      ? '你拥有 capability.discover / capability.activate / proposal.submit。需要业务扩展时先发现再激活；探索充分后调用 proposal.submit 提交最终 Proposal。'
      : 'Classic A/B：Capability 已由 legacy resolver 预装配；不要调用 Harness capability controls。',
    mode === 'harness'
      ? 'RAG 是 reasoning loop 中的工具：允许 search → inspect source → re-search → compare。但仅在预计会改变当前临床判断时才再次检索；已有证据足以支撑可辩护 Proposal 时直接提交。'
      : '按已装配工具完成检索与 Proposal。',
    '',
    `医生输入：\n${context.input}`,
  ].join('\n');
}

function buildFinalizePrompt(context: RuntimeContext): string {
  const evidence = JSON.stringify(buildEvidenceProjection(context.workspace), null, 2);
  const hypotheses = JSON.stringify(buildHypothesisProjection(context.workspace), null, 2);
  const deliberation = JSON.stringify(buildComparisonMatrix(context.workspace), null, 2);
  return [
    '你的临床探索已完成（或达到资源上限）。现在必须基于已积累的工作台信息提交最终 Proposal，禁止继续检索或调用任何探索工具。',
    '',
    `本次交互模式：${context.understanding.interaction.mode}`,
    `原始病例：\n${context.input}`,
    '',
    `当前安全处置：${context.workspace.safetyDisposition}`,
    `不确定点：${JSON.stringify(context.workspace.uncertainties)}`,
    `信息缺口：${JSON.stringify(context.workspace.informationGaps)}`,
    '',
    '## Evidence Projection',
    evidence,
    '',
    '## Hypothesis Coverage',
    hypotheses,
    '',
    '## Candidate Comparison Matrix (Frontier)',
    deliberation,
    '',
    '只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。按 system 指令中的四种结构（conversation / clarification / urgent / clinical）选择其一。保留不确定性、允许 clarification / missing_information，不要为了完整度编造。',
  ].join('\n');
}

export interface AiSdkPrimaryAgentOptions {
  instructions: string;
  maxSteps?: number;
  totalTimeoutMs?: number;
  toolBindings?: AiSdkToolBindings;
  mode?: 'harness' | 'classic';
}

/**
 * 压缩下一 step 的 model-visible messages：只保留初始用户消息 + 最近一步的 tool call/result。
 * 历史 raw tool result 不再自动回灌；完整信息保留在 Workspace / Trace / ToolCallLedger，
 * 模型通过 ClinicalWorkingView（instructions）获取当前注意力的压缩状态与 recent action receipt。
 */
export function compactAgentMessages(
  initialMessages: ModelMessage[],
  steps: { response: { messages: ModelMessage[] } }[],
): ModelMessage[] {
  if (steps.length === 0) return [...initialMessages];
  const lastStep = steps[steps.length - 1];
  return [...initialMessages, ...lastStep.response.messages];
}

export class AiSdkPrimaryAgent implements PrimaryAgentPort {
  constructor(private readonly options: AiSdkPrimaryAgentOptions) {}

  async run(context: RuntimeContext, onEvent?: (event: AgentStreamEvent) => void): Promise<PrimaryAgentOutput> {
    const bindings = this.options.toolBindings ?? DEFAULT_AI_SDK_TOOL_BINDINGS;
    const mode = this.options.mode ?? 'harness';
    const ledger = new ToolCallLedger();
    const resourceSteps = this.options.maxSteps ?? 16;
    let proposal: AgentResult | undefined;
    let usage: PrimaryAgentOutput['usage'];
    let workspaceEventCursor = context.workspaceStore.trace().length;

    let submittedProposal: unknown = undefined;
    let stepCount = 0;
    let finishReason: string | undefined;
    let finalStepHadToolCalls = false;
    let terminationReason: TerminationReason = 'agent_submitted';
    let proposalSubmitted = false;
    let forcedFinalization = false;

    const emit = (stage: LifecycleStage) => onEvent?.({ type: 'lifecycle', stage });

    const agent = new ToolLoopAgent({
      model: llmModel,
      tools: buildTools(context, bindings, ledger),
      instructions: dynamicInstructions(this.options.instructions, context, ledger),
      prepareStep: async ({ initialMessages, steps }) => ({
        activeTools: activeToolIds(context, bindings, mode),
        instructions: dynamicInstructions(this.options.instructions, context, ledger),
        messages: compactAgentMessages(initialMessages, steps),
      }),
      stopWhen: mode === 'harness'
        ? [hasToolCall(toApiToolName('proposal.submit')), isStepCount(resourceSteps)]
        : [isStepCount(resourceSteps)],
      onToolExecutionEnd: ({ toolCall, toolOutput, toolExecutionMs }) => {
        const internalName = fromApiToolName(toolCall.toolName);
        const reused = ledger.isReused(internalName, toolCall.input);

        let rawOutput: unknown;
        let error: unknown;
        if (reused) {
          rawOutput = toolOutput.type === 'tool-result' ? toolOutput.output : undefined;
          error = toolOutput.type === 'tool-error' ? toolOutput.error : undefined;
        } else {
          const applied = applyToolExecutionResult(internalName, toolCall.input, toolOutput as ToolExecutionEnvelope, context.workspaceStore);
          rawOutput = applied.rawOutput;
          error = applied.error;
        }

        if (internalName === 'proposal.submit' && toolOutput.type === 'tool-result') {
          submittedProposal = toolCall.input;
        }

        const toolCallTrace = { toolName: internalName, input: toolCall.input, output: rawOutput, error, ms: toolExecutionMs, reused };
        addToolCall(context.runId, toolCallTrace);
        onEvent?.({ type: 'tool-call', toolCall: toolCallTrace });

        if (!reused) {
          const all = context.workspaceStore.trace();
          if (all.length > workspaceEventCursor) {
            const delta = all.slice(workspaceEventCursor);
            workspaceEventCursor = all.length;
            onEvent?.({ type: 'workspace', events: delta });
          }
        }
      },
    });

    emit('exploring');

    if (mode === 'classic') {
      const response = await agent.generate({
        prompt: buildContextPrompt(context, mode),
        timeout: { totalMs: this.options.totalTimeoutMs ?? 360_000 },
      });
      proposal = extractJson(response.text, agentResultSchema);
      usage = response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : usage;
      emit('completed');
      return { proposal, usage };
    }

    // Harness production path：不依赖 response.text 提取 JSON。
    const response = await agent.generate({
      prompt: buildContextPrompt(context, mode),
      timeout: { totalMs: this.options.totalTimeoutMs ?? 360_000 },
    });

    stepCount = response.steps.length;
    finishReason = response.finishReason;
    finalStepHadToolCalls = response.finalStep.toolCalls.length > 0;
    usage = response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : usage;

    if (submittedProposal !== undefined) {
      proposal = agentResultSchema.parse(submittedProposal);
      proposalSubmitted = true;
      forcedFinalization = false;
      terminationReason = 'agent_submitted';
    } else {
      // Forced Finalization：不进入第二轮临床探索，只基于已有工作台交卷。
      emit('finalizing');
      const finalize = await this.forcedFinalization(context);
      proposal = finalize.proposal;
      if (finalize.usage) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + (finalize.usage.inputTokens ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (finalize.usage.outputTokens ?? 0),
        };
      }
      forcedFinalization = true;
      proposalSubmitted = false;
      terminationReason = finalStepHadToolCalls ? 'resource_limit_fallback' : 'agent_stopped_without_submit';
    }

    emit('completed');

    const agentLoop: AgentLoopTrace = {
      stepCount,
      finishReason,
      terminationReason,
      proposalSubmitted,
      forcedFinalization,
      usage,
      finalStepHadToolCalls,
      toolCallLedger: ledger.entries(),
    };

    const contextMetrics = computeContextMetrics(context, ledger);

    return { proposal, usage, agentLoop, contextMetrics };
  }

  /**
   * Forced Finalization：单独一次模型调用，不开放任何 exploration tool。
   * 这不是第二轮临床探索，禁止继续 search；只是「根据已有工作台交卷」。
   *
   * 实现说明：thinking 模式的 provider 不支持强制 tool_choice，且模型工具调用 JSON 在
   * 兜底场景下不可靠，因此这里采用「无工具 + 文本 JSON」的确定性收尾，等价于 classic 的
   * extractJson 路径，但输入是已积累的 workspace 投影（非新探索）。
   */
  private async forcedFinalization(context: RuntimeContext): Promise<{ proposal: AgentResult; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const result = await generateText({
      model: llmModel,
      system: this.options.instructions,
      prompt: buildFinalizePrompt(context),
      timeout: { totalMs: 120_000 },
    });
    const proposal = extractJson(result.text, agentResultSchema);
    return {
      proposal,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    };
  }
}
