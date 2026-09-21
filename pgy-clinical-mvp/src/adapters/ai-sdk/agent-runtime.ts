import { ToolLoopAgent, isStepCount, generateText, type ToolSet, type ModelMessage } from 'ai';
import { llmModel } from '../../model/adapter.js';
import { config } from '../../config.js';
import { extractJson } from '../../util/json.js';
import { agentResultSchema, type AgentResult, type ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { PrimaryAgentOutput, PrimaryAgentPort } from '../../contracts/ports.js';
import type { AgentStreamEvent, LifecycleStage } from '../../contracts/stream.js';
import type { AgentLoopTrace, CommitReliabilityMetrics, TerminationReason, ContextMetrics, PromptComponents } from '../../contracts/agent-loop.js';
import { addToolCall, addActionReceipt, setRunMetrics, addH14TreatmentRetrieval } from '../../trace.js';
import { executionProtocolVersion, type ActionReceipt, type DecisionImpact, type ExecutionRole, type ExecutionRoleCost, type RunExecutionMetrics, type RecentRetrievalFeedback, type H14TreatmentRetrieval } from '../../contracts/execution.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS, type AiSdkToolBindings } from './tool-bindings.js';
import { applyToolExecutionResult, type ToolExecutionEnvelope } from './workspace-events.js';
import { ToolCallLedger } from './tool-call-ledger.js';
import { RetrievalDisciplineTracker, isRetrievalTool } from './retrieval-discipline.js';
import { computeExecutionNecessity } from './execution-necessity.js';
import { ProjectionCache } from './projection-cache.js';
import { canonicalizeProposalSubmit } from './proposal-canonicalizer.js';
import { buildProposalDraft, countProposalDraftFields } from '../../platform/workspace/proposal-draft.js';
import {
  buildMinimalFinalizationPrompt,
  buildRetryPrompt,
  tryParseProposalSubmit,
  countFinalizationContextItems,
} from './minimal-finalization.js';
import { buildEvidenceProjection } from '../../platform/workspace/evidence-projection.js';
import { buildHypothesisProjection } from '../../platform/workspace/hypothesis-projection.js';
import { buildComparisonMatrix } from '../../platform/workspace/deliberation-projection.js';
import { buildDecisionState } from '../../platform/workspace/decision-state-projection.js';
import { checkClinicalCompletion } from '../../platform/workspace/clinical-workspace.js';
import { renderActiveSkills } from '../../platform/skills/render-skills.js';
import { buildClinicalWorkingView, renderClinicalWorkingView, estimateTokens, type RecentAction } from '../../platform/context/clinical-working-view.js';
import type { ClinicalWorkspace, DecisionState, WorkspaceBatchResult, WorkspaceEvent } from '../../contracts/workspace.js';
import { getFormulaHydrationStats, resetFormulaHydrationStats } from '../../clinical/formula.js';

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

function wrapToolWithLedger(id: string, t: ToolSet[string], ledger: ToolCallLedger, stateKey?: () => string): ToolSet[string] {
  const original = t.execute as unknown as ((input: unknown, options: unknown) => unknown) | undefined;
  if (!original) return t;
  return {
    ...t,
    execute: async (input: unknown, options: unknown) => {
      const key = stateKey ? stateKey() : undefined;
      const cached = ledger.reuse(id, input, key);
      if (cached) return cached.output;
      const output = await original(input, options);
      ledger.record(id, input, output, key);
      return output;
    },
  } as ToolSet[string];
}

/** H10：capability.discover 是 stateful 工具，其结果随 active capabilities 变化，dedupe key 需纳入 active 状态。 */
function capabilityStateKey(context: RuntimeContext): string {
  return `caps:${[...context.capabilities.map((c) => c.id)].sort().join(',')}`;
}

function buildTools(context: RuntimeContext, bindings: AiSdkToolBindings, ledger: ToolCallLedger): ToolSet {
  const tools: ToolSet = {};
  for (const [id, factory] of Object.entries(bindings)) {
    const stateKey = id === 'capability.discover' ? () => capabilityStateKey(context) : undefined;
    tools[toApiToolName(id)] = wrapToolWithLedger(id, factory(context), ledger, stateKey);
  }
  return tools;
}

/**
 * H12：proposal.submit 只有在覆盖检查通过（返回真实 proposal，而非 notReady 修正回执）时才终止 loop。
 * 若存在 unresolved formal hypothesis，proposal.submit 返回 { notReady: true }，loop 应继续让 Agent 完成 deliberation。
 */
function proposalSubmitReadyStep() {
  return ({ steps }: { steps: unknown[] }): boolean => {
    const last = steps[steps.length - 1] as
      | { toolCalls?: Array<{ toolName?: string }>; toolResults?: Array<unknown> }
      | undefined;
    if (!last?.toolCalls) return false;
    const target = toApiToolName('proposal.submit');
    return last.toolCalls.some((tc, i) => {
      if (tc.toolName !== target) return false;
      const result = last.toolResults?.[i] as { output?: unknown } | undefined;
      const output = result?.output;
      return !(typeof output === 'object' && output !== null && (output as Record<string, unknown>).notReady === true);
    });
  };
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
- Use the shortest defensible path to a clinical proposal.
- Before another tool call, determine whether the result is likely to materially change: disease framing, syndrome judgment, treatment method, or formula selection.
- If it will not materially change any of these, do not call the tool.
- Do not resolve every uncertainty.
- When existing evidence already supports a defensible source-grounded proposal, call proposal.submit.
- Reuse before retrieving. Before another retrieval, name the unresolved decision it could change (disease framing / syndrome judgment / treatment method / formula selection / safety disposition). If the workspace already has sufficient evidence for that decision, reuse existing evidence instead of retrieving again.
- Do not retrieve merely to increase confidence or completeness. Do not continue broad retrieval after a viable canonical candidate exists unless new evidence could materially change the decision.
- Commit workspace cognition atomically: when one clinical decision includes candidate focus, candidate assessment, hypothesis update, and uncertainty resolution, commit them together in one workspace.record_deliberation. Do not split one cognitive decision into multiple workspace writes unless later information genuinely changes the decision. Do not repeat workspace mutations that are already persisted.
- Choose the clinical action you need. Do not manually perform deterministic preparation (canonical hydrate, formula validation, source binding) that the Harness completes automatically before submit.
- Reuse already activated capabilities, validated candidates, and existing deterministic results when still valid. Do not repeat execution chores that do not change the business objective.
- When the clinical decision is sufficiently complete, submit the proposal instead of continuing exploration. Do not repeat deterministic preparation already handled by the Harness.
- Establish patient hypotheses explicitly with workspace.consider_hypotheses (leading or alternative). Once established, every alternative must be resolved before submit: selected, rejected with basis, or preserved as uncertainty.`;

/** Diagnostic Pattern Set Spike：domain-general epistemic rules（仅开关 ON 时注入）。 */
const DIAGNOSTIC_PATTERN_PRINCIPLE = `## Diagnostic Pattern Evidence
- For diseases with structured diagnostic-pattern knowledge, you may inspect the normative pattern set (knowledge.get_diagnostic_patterns) before committing to a patient-level syndrome.
- Normative pattern definitions are diagnostic evidence, not the patient's diagnosis.
- Before choosing a patient syndrome, distinguish: findings explicitly present, findings explicitly absent, findings not reported or unknown. Absence of mention is not negative evidence.
- Do not select a syndrome by symptom-count matching.
- Consider whether multiple mechanisms may coexist. A manifestation such as blood stasis may be a component of the case without necessarily being the primary pattern.
- Use discriminating evidence, current clinical context, treatment history, tongue/pulse, and contradictions.
- Establish the patient-level pattern assessment before using formula evidence as the main basis for treatment selection.
- Formula evidence must not be used to create the syndrome that the formula is intended to treat.`;

export function dynamicInstructions(base: string, context: RuntimeContext, ledger?: ToolCallLedger, retrievalFeedback?: RecentRetrievalFeedback, decisionState?: DecisionState): string {
  const skills = renderActiveSkills(context.skills);
  const view = buildClinicalWorkingView(context.workspace, context.strategy, buildRecentActions(ledger), retrievalFeedback, decisionState);
  const workingView = renderClinicalWorkingView(view);
  const patternPrinciple = config.experiment.diagnosticPatternSet ? `\n\n${DIAGNOSTIC_PATTERN_PRINCIPLE}` : '';
  return `${base}\n\n${ACTION_PRINCIPLE}${patternPrinciple}\n\n## Active Harness Skills\n${skills || '（无）'}\n\nActive scopes: ${context.knowledgeScopes.join(', ')}\n\n## Clinical Working View\n${workingView}`;
}

/** 度量「目标驱动工作上下文」相对「全量投影」的收缩程度（估算）。 */
function computeContextMetrics(context: RuntimeContext, ledger: ToolCallLedger, retrievalFeedback?: RecentRetrievalFeedback): ContextMetrics {
  const workingView = renderClinicalWorkingView(buildClinicalWorkingView(context.workspace, context.strategy, buildRecentActions(ledger), retrievalFeedback));
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

/** H4 Prompt Telemetry：估算每一步 prompt 各组成部分 token（仅观测，不设阈值）。 */
function computePromptComponents(context: RuntimeContext, ledger: ToolCallLedger, retrievalFeedback?: RecentRetrievalFeedback): PromptComponents {
  const basePromptTokens = estimateTokens(`${context.input}\n${ACTION_PRINCIPLE}\nActive scopes: ${context.knowledgeScopes.join(', ')}`);
  const strategyTokens = estimateTokens(JSON.stringify(context.strategy));
  const decisionStateTokens = estimateTokens(JSON.stringify(buildDecisionState(context.workspace, context.strategy)));
  const workingViewTokens = estimateTokens(renderClinicalWorkingView(buildClinicalWorkingView(context.workspace, context.strategy, buildRecentActions(ledger), retrievalFeedback)));
  const skillTokens = estimateTokens(renderActiveSkills(context.skills));
  const toolSchemaTokens = estimateTokens(context.tools.map((t) => `${t.id}:${t.description}`).join('\n'));
  const recentMessageTokens = estimateTokens(buildSearchHistory(ledger));
  return {
    basePromptTokens,
    strategyTokens,
    decisionStateTokens,
    workingViewTokens,
    skillTokens,
    toolSchemaTokens,
    recentMessageTokens,
    totalPromptTokens:
      basePromptTokens + strategyTokens + decisionStateTokens + workingViewTokens + skillTokens + toolSchemaTokens + recentMessageTokens,
    activeToolCount: context.tools.length,
    availableCapabilityCount: context.capabilities.length,
  };
}

/** H5 Decision Impact：基于 Workspace state delta 判定（非模型声明）。 */
export function computeDecisionImpact(delta: WorkspaceEvent[], errored: boolean): DecisionImpact {
  if (errored) return 'unresolved';
  const types = new Set(delta.map((e) => e.type));
  if (
    types.has('candidate.presented') ||
    types.has('candidate.focused') ||
    types.has('candidate.selected') ||
    types.has('hypothesis.presented') ||
    types.has('hypothesis.selected') ||
    types.has('hypothesis.rejected')
  ) {
    return 'changed';
  }
  if (types.has('evidence.added') || types.has('hypothesis.supported')) {
    return 'reinforced';
  }
  return 'none';
}

/** H9 工具执行角色分类（不改变行为，只用于可观测）。 */
export function classifyExecutionRole(toolName: string): ExecutionRole {
  if (isRetrievalTool(toolName)) return 'RETRIEVAL';
  if (
    toolName === 'workspace.focus_candidates' ||
    toolName === 'workspace.record_candidate_assessment' ||
    toolName === 'workspace.record_candidate_exclusion' ||
    toolName === 'workspace.record_deliberation'
  ) {
    return 'COGNITIVE_MUTATION';
  }
  if (toolName === 'formula.validate') return 'VALIDATION';
  if (toolName === 'proposal.submit') return 'COMMIT';
  if (toolName === 'capability.discover' || toolName === 'capability.activate') return 'CAPABILITY';
  return 'OTHER';
}

/**
 * H14：是否「治疗知识检索」。由 metadata 驱动，Core 不判断业务语义。
 * - 工具自身标记 treatmentSpecific（formula.search_normative）。
 * - Runtime Catalog 工具（knowledge.search_cards / get_asset）继承激活 capability 的 treatmentSpecific。
 */
function isTreatmentRetrieval(internalName: string, context: RuntimeContext): boolean {
  const tool = context.tools.find((t) => t.id === internalName);
  if (tool?.treatmentSpecific) return true;
  if (internalName === 'knowledge.search_cards' || internalName === 'knowledge.get_asset') {
    return context.capabilities.some((c) => c.treatmentSpecific === true);
  }
  return false;
}

function cardsReturnedFor(rawOutput: unknown): number {
  return Array.isArray(rawOutput) ? rawOutput.length : 0;
}

function emptyExecutionRoleCosts(): Record<ExecutionRole, ExecutionRoleCost> {
  return {
    RETRIEVAL: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
    COGNITIVE_MUTATION: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
    VALIDATION: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
    COMMIT: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
    CAPABILITY: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
    OTHER: { toolCalls: 0, nonDecisionChangingCalls: 0, latencyMs: 0, resultTokens: 0 },
  };
}

function emptyRoleCounts(): Record<ExecutionRole, number> {
  return { RETRIEVAL: 0, COGNITIVE_MUTATION: 0, VALIDATION: 0, COMMIT: 0, CAPABILITY: 0, OTHER: 0 };
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
    resetFormulaHydrationStats(context.runId);
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
    let actionCounter = 0;
    let currentStep = 0;
    const tracker = new RetrievalDisciplineTracker();
    // Diagnostic Pattern Set Spike：时序追踪局部状态（run 内）。
    let firstKnowledgeQuery: string | undefined;
    let formulaSearchTimingRecorded = false;
    let patternSetUsed = false;
    let standardEvidenceUsed = false;
    // H13 Pattern Assessment 时序追踪局部状态。
    let patternAssessmentRecorded = false;
    let patternAssessmentTimingRecorded = false;
    let leadingAtFirstPatternAssessment: string | undefined;
    // H14 Treatment Decision Causality 时序追踪局部状态。
    let firstTreatmentRetrievalStep: number | undefined;
    let treatmentRetrievalCount = 0;
    let specializedTreatmentRetrievalCount = 0;
    let formulaRetrievalCount = 0;
    let treatmentRetrievalBeforePatternAssessmentCount = 0;
    let treatmentRetrievalBeforeTreatmentTargetCount = 0;
    let hypothesisTransitionsAfterTreatmentRetrieval = 0;
    let hasHadTreatmentRetrieval = false;
    let patternAssessmentAtFirstTreatmentRetrieval = false;
    let treatmentTargetAtFirstTreatmentRetrieval = false;
    let openQuestionAtFirstTreatmentRetrieval = false;
    // H15 Clinical Decision Spine 时序追踪局部状态。
    let diseaseAssessmentAtFirstTreatmentRetrieval = false;
    let formalHypothesisAtFirstTreatmentRetrieval = false;
    let treatmentPlanAtFirstTreatmentRetrieval = false;
    let formulaRetrievalRejectedForMissingContext = 0;
    // H15.1 局部状态：Completion Obligation / Formula Decision Quality。
    let formulaCandidateRetrievalCount = 0;
    let formulaEvidenceRetrievalCount = 0;
    let falseCompletionAttemptCount = 0;
    // H15.2.3 no-progress correction 追踪（仅观测，不设 hard gate）。
    let lastCorrectionCode: string | undefined;
    let workspaceVersionAtLastCorrection = -1;
    let repeatedNoProgressCorrectionCount = 0;
    let repeatedUnresolvedHypothesisCorrectionCount = 0;
    let repeatedTreatmentContextCorrectionCount = 0;
    const recordCorrection = (code: string) => {
      const v = context.workspaceStore.version;
      if (code === lastCorrectionCode && v === workspaceVersionAtLastCorrection) {
        repeatedNoProgressCorrectionCount += 1;
        if (code === 'UNRESOLVED_HYPOTHESES') repeatedUnresolvedHypothesisCorrectionCount += 1;
        else if (code === 'TREATMENT_CONTEXT_INCOMPLETE') repeatedTreatmentContextCorrectionCount += 1;
      }
      lastCorrectionCode = code;
      workspaceVersionAtLastCorrection = v;
    };
    const metrics: RunExecutionMetrics = {
      totalToolCalls: 0, decisionChangingToolCalls: 0, reinforcingToolCalls: 0, nonDecisionChangingToolCalls: 0, unresolvedToolCalls: 0,
      redundantSearchCount: 0, deduplicatedCallCount: 0, cacheHitCount: 0, parallelGroupCount: 0, parallelToolCallCount: 0,
      knowledgeSearchCount: 0, getSourceCount: 0, formulaSearchCount: 0, formulaValidationCalls: 0,
      toolLatencyMsTotal: 0, resultTokensProduced: 0,
      uniqueCandidatesDiscovered: 0, uniqueCandidatesPromoted: 0, uniqueCandidatesHydrated: 0, uniqueCandidatesValidated: 0,
      formulaHydrationCalls: 0, formulaHydrationCacheHitCount: 0, formulaCandidateVisibleTokens: 0, formulaHydratedVisibleTokens: 0,
      cognitiveMutationCalls: 0, effectiveMutationCalls: 0, noopMutationCalls: 0,
      workspaceEventsWritten: 0, workspaceEventBatches: 0,
      workspaceProjectionCount: 0, decisionStateProjectionCount: 0,
      deliberationCommitCount: 0,
      retrievalsBeforeFirstViableCandidate: 0, retrievalsAfterFirstViableCandidate: 0,
      nonDecisionChangingRetrievalsBeforeViable: 0, nonDecisionChangingRetrievalsAfterViable: 0,
      getSourceReuseCount: 0, formulaSearchReuseCount: 0, evidenceReuseCount: 0,
      toolCallsByExecutionRole: emptyExecutionRoleCosts(),
      nonDecisionChangingCallsByExecutionRole: emptyRoleCounts(),
      latencyMsByExecutionRole: emptyRoleCounts(),
      resultTokensByExecutionRole: emptyRoleCounts(),
      requiredNonDecisionChangingCalls: 0,
      avoidableNonDecisionChangingCalls: 0,
      capabilityActivationCount: 0,
      capabilityReuseCount: 0,
      duplicateCapabilityActivationCount: 0,
      validationCallCount: 0,
      validationReuseCount: 0,
      duplicateValidationCount: 0,
      projectionWithStateChange: 0,
      projectionWithoutStateChange: 0,
      projectionReuseCount: 0,
      diagnosticPatternSetUsed: false,
      diagnosticPatternSetFirstClinicalRetrieval: false,
      returnedPatternRefs: [],
      formalHypothesisRefsAfterPatternSet: [],
      formulaSearchBeforeFormalHypothesis: false,
      diagnosticPatternQueryDisease: undefined,
      resolvedDiseaseConcepts: [],
      diagnosticSyndromesReturned: [],
      diseaseStandardUsed: false,
      syndromeStandardUsed: false,
      syndromeConceptsReturned: [],
      formalHypothesesAfterStandardEvidence: [],
      diagnosticReleaseUsed: false,
      diagnosticReleaseSourcesUsed: [],
      diseaseStandardSourceIds: [],
      diagnosticPatternSourceIds: [],
      patternAssessmentRecorded: false,
      primaryPatternRef: undefined,
      secondaryPatternRefs: [],
      sharedMechanismCount: 0,
      rootBranchRecorded: false,
      currentDominantMechanismRecorded: false,
      treatmentTargetRecorded: false,
      patternAssessmentBeforeFormulaSearch: false,
      primaryPatternChangedAfterAssessment: undefined,
      h14Enabled: config.experiment.h14,
      firstTreatmentRetrievalStep: undefined,
      patternAssessmentBeforeFirstTreatmentRetrieval: undefined,
      treatmentTargetBeforeFirstTreatmentRetrieval: undefined,
      openQuestionPresentBeforeTreatmentRetrieval: undefined,
      treatmentRetrievalCount: 0,
      specializedTreatmentRetrievalCount: 0,
      formulaRetrievalCount: 0,
      treatmentRetrievalBeforePatternAssessmentCount: 0,
      treatmentRetrievalBeforeTreatmentTargetCount: 0,
      hypothesisTransitionsAfterTreatmentRetrieval: 0,
      diseaseAssessmentBeforeTreatmentRetrieval: undefined,
      formalHypothesisBeforeTreatmentRetrieval: undefined,
      treatmentPlanBeforeTreatmentRetrieval: undefined,
      formulaRetrievalRejectedForMissingContext: 0,
      formulaReviewRecorded: false,
      modificationItemsWithPatientEvidence: 0,
      clinicalCompletionObligationCreated: false,
      completionRequestedOutcome: undefined,
      completionRequiredArtifacts: [],
      completionMissingArtifactsAtEnd: [],
      falseCompletionAttemptCount: 0,
      formulaCandidateRetrievalCount: 0,
      formulaEvidenceRetrievalCount: 0,
      formulaSelectionFromEvidence: undefined,
      selectedCandidateRef: undefined,
      retrievalSuggestedHypothesisCount: 0,
    };

    const commitReliability: CommitReliabilityMetrics = {
      agentProposalSubmitCount: 0,
      agentProposalSubmitSuccessCount: 0,
      runtimeForcedFinalizationCount: 0,
      runtimeForcedFinalizationSuccessCount: 0,
      finalProposalCommittedCount: 0,
      proposalParseFailureCount: 0,
      proposalSchemaFailureCount: 0,
      proposalRetryCount: 0,
      proposalRetrySuccessCount: 0,
      finalizationInputTokens: 0,
      finalizationOutputTokens: 0,
      finalizationContextItemCount: 0,
      proposalDraftFieldCount: 0,
    };

    const emit = (stage: LifecycleStage) => onEvent?.({ type: 'lifecycle', stage });

    const projectionCache = new ProjectionCache();
    let cachedDecisionState: DecisionState | undefined;

    const agent = new ToolLoopAgent({
      model: llmModel,
      tools: buildTools(context, bindings, ledger),
      instructions: dynamicInstructions(this.options.instructions, context, ledger, tracker.feedback()),
      prepareStep: async ({ initialMessages, steps }) => {
        currentStep = steps.length + 1;
        metrics.workspaceProjectionCount += 1;
        metrics.decisionStateProjectionCount += 1;
        const version = context.workspaceStore.version;
        cachedDecisionState = projectionCache.getDecisionState(version, context.workspace, context.strategy).decisionState;
        return {
          activeTools: activeToolIds(context, bindings, mode),
          instructions: dynamicInstructions(this.options.instructions, context, ledger, tracker.feedback(), cachedDecisionState),
          messages: compactAgentMessages(initialMessages, steps),
        };
      },
      stopWhen: mode === 'harness'
        ? [proposalSubmitReadyStep(), isStepCount(resourceSteps)]
        : [isStepCount(resourceSteps)],
      onToolExecutionEnd: ({ toolCall, toolOutput, toolExecutionMs }) => {
        const internalName = fromApiToolName(toolCall.toolName);
        const stateKey = internalName === 'capability.discover' ? capabilityStateKey(context) : undefined;
        const reused = ledger.isReused(internalName, toolCall.input, stateKey);
        const executionRole = classifyExecutionRole(internalName);
        const actionId = `A_${String(++actionCounter).padStart(4, '0')}`;
        const nowMs = Date.now();

        // H8：复用判定需要「本次调用前」的 workspace 身份快照。
        const candidateIdsBefore = new Set(context.workspace.candidates.map((c) => c.id));
        const evidenceIdsBefore = new Set<string>();
        for (const e of context.workspace.evidenceState.evidenceItems) {
          evidenceIdsBefore.add(e.id);
          evidenceIdsBefore.add(e.sourceRef);
        }
        for (const r of context.workspace.evidenceRefs) {
          evidenceIdsBefore.add(r.id);
          if (r.sourceId) evidenceIdsBefore.add(r.sourceId);
        }

        let rawOutput: unknown;
        let error: unknown;
        let batchResult: WorkspaceBatchResult | undefined;
        if (reused) {
          rawOutput = toolOutput.type === 'tool-result' ? toolOutput.output : undefined;
          error = toolOutput.type === 'tool-error' ? toolOutput.error : undefined;
        } else {
          const applied = applyToolExecutionResult(internalName, toolCall.input, toolOutput as ToolExecutionEnvelope, context.workspaceStore);
          rawOutput = applied.rawOutput;
          error = applied.error;
          batchResult = applied.batchResult;
        }

        if (internalName === 'proposal.submit' && toolOutput.type === 'tool-result') {
          const submitOutput = rawOutput;
          const isNotReady = typeof submitOutput === 'object' && submitOutput !== null && (submitOutput as Record<string, unknown>).notReady === true;
          if (isNotReady) {
            // H15.1：不把「未完成的 submit 尝试」当作最终 proposal。
            const submitCode = (submitOutput as Record<string, unknown>).code;
            recordCorrection(typeof submitCode === 'string' ? submitCode : 'UNRESOLVED_HYPOTHESES');
            if (submitCode === 'CLINICAL_DECISION_INCOMPLETE') falseCompletionAttemptCount += 1;
          } else {
            submittedProposal = toolCall.input;
          }
          tracker.recordSubmit(currentStep, nowMs);
        }

        // H5：计算 workspace state delta 与 decision impact，生成 ActionReceipt。
        const all = context.workspaceStore.trace();
        const delta = reused ? [] : all.slice(workspaceEventCursor);

        // Diagnostic Pattern Set Spike telemetry（Debug/Eval，不进入 clinical decision）。
        const isKnowledgeQuery =
          internalName === 'knowledge.search' ||
          internalName === 'knowledge.get_source' ||
          internalName === 'formula.search_normative' ||
          internalName === 'knowledge.get_diagnostic_patterns';
        if (isKnowledgeQuery && firstKnowledgeQuery === undefined) firstKnowledgeQuery = internalName;
        if (internalName === 'knowledge.get_diagnostic_patterns') {
          patternSetUsed = true;
          metrics.diagnosticPatternSetUsed = true;
          const qd = (toolCall.input as Record<string, unknown>)?.disease;
          if (typeof qd === 'string') metrics.diagnosticPatternQueryDisease = qd;
          if (Array.isArray(rawOutput)) {
            for (const rec of rawOutput) {
              const r = (rec && typeof rec === 'object' ? rec : {}) as Record<string, unknown>;
              const ref = r.patternRef;
              if (typeof ref === 'string' && !metrics.returnedPatternRefs!.includes(ref)) metrics.returnedPatternRefs!.push(ref);
              const rr = r.retrievalRelation as Record<string, unknown> | undefined;
              const matched = rr?.matchedDisease;
              if (typeof matched === 'string' && !metrics.resolvedDiseaseConcepts!.includes(matched)) metrics.resolvedDiseaseConcepts!.push(matched);
              const syn = r.syndrome;
              if (typeof syn === 'string' && !metrics.diagnosticSyndromesReturned!.includes(syn)) metrics.diagnosticSyndromesReturned!.push(syn);
            }
          }
        }
        if (internalName === 'formula.search_normative' && !formulaSearchTimingRecorded) {
          formulaSearchTimingRecorded = true;
          const hasFormalHypothesis = context.workspace.hypothesisState.hypotheses.some((h) => h.origin !== 'retrieval_suggested');
          metrics.formulaSearchBeforeFormalHypothesis = !hasFormalHypothesis;
        }
        if (patternSetUsed) {
          for (const e of delta) {
            if (e.type === 'hypothesis.presented' && typeof e.payload.id === 'string' && !metrics.formalHypothesisRefsAfterPatternSet!.includes(e.payload.id)) {
              metrics.formalHypothesisRefsAfterPatternSet!.push(e.payload.id);
            }
          }
        }

        // Existing Standards Runtime telemetry（Debug/Eval）。
        if (internalName === 'knowledge.get_disease_standard') {
          standardEvidenceUsed = true;
          metrics.diseaseStandardUsed = true;
        }
        if (internalName === 'knowledge.get_syndrome_standard') {
          standardEvidenceUsed = true;
          metrics.syndromeStandardUsed = true;
          const cn = (rawOutput as Record<string, unknown>)?.canonicalName;
          if (typeof cn === 'string' && !metrics.syndromeConceptsReturned!.includes(cn)) metrics.syndromeConceptsReturned!.push(cn);
        }
        if (standardEvidenceUsed) {
          for (const e of delta) {
            if (e.type === 'hypothesis.presented' && typeof e.payload.id === 'string' && !metrics.formalHypothesesAfterStandardEvidence!.includes(e.payload.id)) {
              metrics.formalHypothesesAfterStandardEvidence!.push(e.payload.id);
            }
          }
        }

        // Diagnostic Release telemetry：区分 2024 标准 / GB/T ontology / ZY/T 3.1-2025 / T/GDACM 0117-2022。
        const isReleaseSourceId = (sid: string) => sid.startsWith('ZY_T_3_1') || sid.startsWith('T_GDACM') || sid.startsWith('DKP_');
        if (internalName === 'knowledge.get_disease_standard' && Array.isArray(rawOutput)) {
          for (const rec of rawOutput) {
            const src = (rec as Record<string, unknown>)?.source as Record<string, unknown> | undefined;
            const sid = src?.sourceId;
            if (typeof sid === 'string') {
              if (!metrics.diseaseStandardSourceIds!.includes(sid)) metrics.diseaseStandardSourceIds!.push(sid);
              if (isReleaseSourceId(sid)) {
                metrics.diagnosticReleaseUsed = true;
                if (!metrics.diagnosticReleaseSourcesUsed!.includes(sid)) metrics.diagnosticReleaseSourcesUsed!.push(sid);
              }
            }
          }
        }
        if (internalName === 'knowledge.get_diagnostic_patterns' && Array.isArray(rawOutput)) {
          for (const rec of rawOutput) {
            const sid = (rec as Record<string, unknown>)?.sourceId;
            if (typeof sid === 'string' && isReleaseSourceId(sid)) {
              metrics.diagnosticReleaseUsed = true;
              if (!metrics.diagnosticPatternSourceIds!.includes(sid)) metrics.diagnosticPatternSourceIds!.push(sid);
              if (!metrics.diagnosticReleaseSourcesUsed!.includes(sid)) metrics.diagnosticReleaseSourcesUsed!.push(sid);
            }
          }
        }

        // H13 Pattern Assessment telemetry：从本次 workspace delta 检测 pattern.assessment.recorded。
        if (delta.some((e) => e.type === 'pattern.assessment.recorded')) {
          patternAssessmentRecorded = true;
          metrics.patternAssessmentRecorded = true;
          if (!patternAssessmentTimingRecorded) {
            patternAssessmentTimingRecorded = true;
            metrics.patternAssessmentBeforeFormulaSearch = !formulaSearchTimingRecorded;
            leadingAtFirstPatternAssessment = context.workspace.hypothesisState.hypotheses.find((h) => h.status === 'active')?.id;
          }
        }

        // H14 Treatment Decision Causality：只观察，不做临床裁决。
        if (isTreatmentRetrieval(internalName, context)) {
          const isGateRejection = typeof rawOutput === 'object' && rawOutput !== null && (rawOutput as Record<string, unknown>).code === 'TREATMENT_CONTEXT_INCOMPLETE';
          if (isGateRejection) {
            // H15：被门禁拒绝的尝试不算「真实治疗检索」，只计 rejection。
            recordCorrection('TREATMENT_CONTEXT_INCOMPLETE');
            formulaRetrievalRejectedForMissingContext += 1;
          } else {
            const pa = context.workspace.patternAssessment;
            const paPresent = pa !== null && pa !== undefined;
            const ttPresent = typeof pa?.treatmentTarget === 'string' && pa.treatmentTarget.trim() !== '';
            const openQuestions = context.workspace.uncertainties ?? [];
            const openQuestionPresent = openQuestions.length > 0;
            const spine = context.workspace.clinicalDecisionSpine;
            const diseasePresent = spine.diseaseAssessment !== undefined;
            const hypothesisPresent = spine.patternHypothesisRefs.length > 0;
            const treatmentPlanPresent = spine.treatmentPlan !== undefined;

            treatmentRetrievalCount += 1;
            if (internalName === 'formula.search_normative') formulaRetrievalCount += 1;
            else if (internalName === 'knowledge.search_cards' || internalName === 'knowledge.get_asset') specializedTreatmentRetrievalCount += 1;
            if (internalName === 'formula.search_candidates') formulaCandidateRetrievalCount += 1;
            if (internalName === 'formula.get_evidence') formulaEvidenceRetrievalCount += 1;

            if (firstTreatmentRetrievalStep === undefined) {
              firstTreatmentRetrievalStep = currentStep;
              patternAssessmentAtFirstTreatmentRetrieval = paPresent;
              treatmentTargetAtFirstTreatmentRetrieval = ttPresent;
              openQuestionAtFirstTreatmentRetrieval = openQuestionPresent;
              diseaseAssessmentAtFirstTreatmentRetrieval = diseasePresent;
              formalHypothesisAtFirstTreatmentRetrieval = hypothesisPresent;
              treatmentPlanAtFirstTreatmentRetrieval = treatmentPlanPresent;
            }
            if (!paPresent) treatmentRetrievalBeforePatternAssessmentCount += 1;
            if (!ttPresent) treatmentRetrievalBeforeTreatmentTargetCount += 1;

            const activeCapability = context.capabilities.find((c) => c.treatmentSpecific === true)?.id ?? '';
            const activeScope = context.knowledgeScopes
              .filter((s) => context.capabilities.some((c) => c.id === s && c.treatmentSpecific === true))
              .join(',');
            const assetIdsFetched = internalName === 'knowledge.get_asset' && rawOutput !== null && rawOutput !== undefined ? 1 : 0;

            const h14Event: H14TreatmentRetrieval = {
              tool: internalName,
              step: currentStep,
              activeCapability,
              activeScope,
              patternAssessmentPresent: paPresent,
              treatmentTargetPresent: ttPresent,
              openQuestionsSnapshot: openQuestions,
              cardsReturned: cardsReturnedFor(rawOutput),
              assetIdsFetched,
              workspaceStateVersion: context.workspaceStore.version,
            };
            addH14TreatmentRetrieval(context.runId, h14Event);
            hasHadTreatmentRetrieval = true;
          }
        }

        // H14：治疗检索后、无新证据时的 hypothesis 转变（只记录，不拦截）。
        if (hasHadTreatmentRetrieval) {
          const hypChange = delta.some((e) =>
            e.type === 'hypothesis.presented' ||
            e.type === 'hypothesis.selected' ||
            e.type === 'hypothesis.rejected' ||
            e.type === 'hypothesis.preserved_as_uncertainty',
          );
          const hasNewEvidence = delta.some((e) => e.type === 'evidence.added');
          if (hypChange && !hasNewEvidence) hypothesisTransitionsAfterTreatmentRetrieval += 1;
        }

        const decisionImpact = computeDecisionImpact(delta, error !== undefined);
        const newEvidenceCount = delta.filter((e) => e.type === 'evidence.added').length;
        const status = error !== undefined ? 'error' : reused ? 'deduplicated' : 'success';
        const resultTokenEstimate = rawOutput === undefined ? 0 : estimateTokens(JSON.stringify(rawOutput));

        // H10：executionNecessity 由 Harness 确定性判定（非模型填写）。
        const batchWritten = batchResult?.written ?? 0;
        const capabilityAlreadyActive =
          internalName === 'capability.activate' &&
          typeof rawOutput === 'object' && rawOutput !== null &&
          (rawOutput as Record<string, unknown>).reused === true;
        const executionNecessity = computeExecutionNecessity({
          toolName: internalName,
          executionRole,
          reused,
          decisionImpact,
          batchWritten,
          capabilityAlreadyActive,
        });

        tracker.recordToolExecution({
          toolName: internalName,
          reused,
          decisionImpact,
          rawOutput,
          candidateIdsBefore,
          evidenceIdsBefore,
          newCandidateCount: reused ? 0 : context.workspace.candidates.filter((c) => !candidateIdsBefore.has(c.id)).length,
          newEvidenceCount,
        });
        tracker.recordViableCandidateIfAbsent(context.workspace, currentStep, nowMs);

        const receipt: ActionReceipt = {
          executionProtocolVersion,
          actionId,
          runId: context.runId,
          toolName: internalName,
          status,
          executionRole,
          sourceRefs: [],
          evidenceRefs: delta.filter((e) => e.type === 'evidence.added').map((e) => typeof e.payload.id === 'string' ? e.payload.id : '').filter(Boolean),
          stateDeltaRefs: delta.map((e) => `${e.type}:${typeof e.payload.id === 'string' ? e.payload.id : ''}`),
          newEvidenceCount,
          reusedEvidenceCount: reused ? 1 : 0,
          stateDeltaCount: delta.length,
          decisionImpact,
          executionNecessity,
          latencyMs: toolExecutionMs ?? 0,
          resultTokenEstimate,
          errorCode: error !== undefined ? 'TOOL_ERROR' : undefined,
        };
        addActionReceipt(context.runId, receipt);

        // 累计运行指标。
        metrics.totalToolCalls += 1;
        metrics.toolLatencyMsTotal += toolExecutionMs ?? 0;
        metrics.resultTokensProduced += resultTokenEstimate;
        if (decisionImpact === 'changed') metrics.decisionChangingToolCalls += 1;
        else if (decisionImpact === 'reinforced') metrics.reinforcingToolCalls += 1;
        else if (decisionImpact === 'none') metrics.nonDecisionChangingToolCalls += 1;
        else metrics.unresolvedToolCalls += 1;
        if (reused) { metrics.deduplicatedCallCount += 1; metrics.cacheHitCount += 1; }
        if (batchResult) {
          metrics.workspaceEventsWritten += batchResult.written;
          metrics.workspaceEventBatches += 1;
        }
        if (executionRole === 'COGNITIVE_MUTATION') {
          metrics.cognitiveMutationCalls += 1;
          if (internalName === 'workspace.record_deliberation') metrics.deliberationCommitCount += 1;
          const effective = !reused && batchResult !== undefined && batchResult.written > 0;
          if (effective) metrics.effectiveMutationCalls += 1;
          else metrics.noopMutationCalls += 1;
        }
        if ((internalName === 'knowledge.search' || internalName === 'formula.search_normative') && decisionImpact === 'none' && newEvidenceCount === 0) {
          metrics.redundantSearchCount += 1;
        }
        if (internalName === 'knowledge.search') metrics.knowledgeSearchCount += 1;
        else if (internalName === 'knowledge.get_source') metrics.getSourceCount += 1;
        else if (internalName === 'formula.search_normative') metrics.formulaSearchCount += 1;
        else if (internalName === 'formula.validate') metrics.formulaValidationCalls += 1;

        // H10：execution role cost breakdown + execution necessity 分层。
        const roleCost = metrics.toolCallsByExecutionRole[executionRole];
        roleCost.toolCalls += 1;
        roleCost.latencyMs += toolExecutionMs ?? 0;
        roleCost.resultTokens += resultTokenEstimate;
        metrics.latencyMsByExecutionRole[executionRole] += toolExecutionMs ?? 0;
        metrics.resultTokensByExecutionRole[executionRole] += resultTokenEstimate;
        if (decisionImpact === 'none') {
          roleCost.nonDecisionChangingCalls += 1;
          metrics.nonDecisionChangingCallsByExecutionRole[executionRole] += 1;
          if (executionNecessity === 'required') metrics.requiredNonDecisionChangingCalls += 1;
          else if (executionNecessity === 'avoidable') metrics.avoidableNonDecisionChangingCalls += 1;
        }
        if (internalName === 'capability.activate') {
          metrics.capabilityActivationCount += 1;
          if (capabilityAlreadyActive || reused) {
            metrics.capabilityReuseCount += 1;
            metrics.duplicateCapabilityActivationCount += 1;
          }
        }

        const toolCallTrace = { toolName: internalName, input: toolCall.input, output: rawOutput, error, ms: toolExecutionMs, reused };
        addToolCall(context.runId, toolCallTrace);
        onEvent?.({ type: 'tool-call', toolCall: toolCallTrace });

        if (!reused && delta.length > 0) {
          workspaceEventCursor = all.length;
          onEvent?.({ type: 'workspace', events: delta });
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
    const finalDecisionAtMs = Date.now();

    if (submittedProposal !== undefined) {
      // 主动 submit：canonical candidate 身份由 Runtime ownership，模型只提交选择。
      commitReliability.agentProposalSubmitCount = 1;
      proposal = await canonicalizeProposalSubmit(submittedProposal as ProposalSubmitInput, context);
      commitReliability.agentProposalSubmitSuccessCount = 1;
      commitReliability.finalProposalCommittedCount = 1;
      commitReliability.timeFromFinalDecisionToCommitMs = Date.now() - finalDecisionAtMs;
      proposalSubmitted = true;
      forcedFinalization = false;
      terminationReason = 'agent_submitted';
    } else {
      // Minimal Finalization：只 serialize 已形成的判断，不重新解决病例、不重新检索。
      emit('finalizing');
      commitReliability.runtimeForcedFinalizationCount = 1;
      const finalize = await this.minimalFinalization(context, commitReliability);
      proposal = finalize.proposal;
      if (finalize.usage) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + (finalize.usage.inputTokens ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (finalize.usage.outputTokens ?? 0),
        };
      }
      commitReliability.runtimeForcedFinalizationSuccessCount = 1;
      commitReliability.finalProposalCommittedCount = 1;
      commitReliability.timeFromFinalDecisionToCommitMs = Date.now() - finalDecisionAtMs;
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
      promptComponents: computePromptComponents(context, ledger, tracker.feedback()),
      commitReliability,
    };

    const contextMetrics = computeContextMetrics(context, ledger, tracker.feedback());
    const hydrationStats = getFormulaHydrationStats(context.runId);
    const retrievalMetrics = tracker.metrics();
    metrics.uniqueCandidatesDiscovered = context.workspace.candidates.length;
    metrics.uniqueCandidatesPromoted = context.workspace.deliberationState.frontier.length;
    metrics.uniqueCandidatesValidated = hydrationStats.uniqueCandidatesValidated;
    metrics.uniqueCandidatesHydrated = hydrationStats.uniqueCandidatesHydrated;
    metrics.formulaHydrationCalls = hydrationStats.formulaHydrationCalls;
    metrics.formulaHydrationCacheHitCount = hydrationStats.formulaHydrationCacheHitCount;
    metrics.formulaValidationCalls = hydrationStats.formulaValidationCalls;
    metrics.validationCallCount = hydrationStats.formulaValidationCalls;
    metrics.validationReuseCount = hydrationStats.validationReuseCount;
    metrics.duplicateValidationCount = hydrationStats.duplicateValidationCount;
    const projectionMetrics = projectionCache.metrics();
    metrics.projectionWithStateChange = projectionMetrics.projectionWithStateChange;
    metrics.projectionWithoutStateChange = projectionMetrics.projectionWithoutStateChange;
    metrics.projectionReuseCount = projectionMetrics.projectionReuseCount;
    Object.assign(metrics, retrievalMetrics);
    metrics.diagnosticPatternSetFirstClinicalRetrieval = firstKnowledgeQuery === 'knowledge.get_diagnostic_patterns';

    // H13：从最终 workspace.patternAssessment 派生结构指标 + consistency（仅记录，不纠正）。
    const pa = context.workspace.patternAssessment;
    if (pa) {
      metrics.primaryPatternRef = pa.primary?.hypothesisRef;
      metrics.secondaryPatternRefs = (pa.secondary ?? [])
        .map((s) => s.hypothesisRef)
        .filter((x): x is string => typeof x === 'string');
      metrics.sharedMechanismCount = (pa.sharedMechanisms ?? []).length;
      metrics.rootBranchRecorded = pa.rootBranch !== undefined;
      metrics.currentDominantMechanismRecorded = pa.currentDominantMechanism !== undefined;
      metrics.treatmentTargetRecorded = typeof pa.treatmentTarget === 'string' && pa.treatmentTarget.trim() !== '';
      if (pa.primary?.hypothesisRef && leadingAtFirstPatternAssessment) {
        metrics.primaryPatternChangedAfterAssessment = pa.primary.hypothesisRef !== leadingAtFirstPatternAssessment;
      }
    }

    // H14：固化治疗检索时序指标（仅观察，不做临床裁决）。
    metrics.firstTreatmentRetrievalStep = firstTreatmentRetrievalStep;
    metrics.patternAssessmentBeforeFirstTreatmentRetrieval = firstTreatmentRetrievalStep === undefined ? undefined : patternAssessmentAtFirstTreatmentRetrieval;
    metrics.treatmentTargetBeforeFirstTreatmentRetrieval = firstTreatmentRetrievalStep === undefined ? undefined : treatmentTargetAtFirstTreatmentRetrieval;
    metrics.openQuestionPresentBeforeTreatmentRetrieval = firstTreatmentRetrievalStep === undefined ? undefined : openQuestionAtFirstTreatmentRetrieval;
    metrics.treatmentRetrievalCount = treatmentRetrievalCount;
    metrics.specializedTreatmentRetrievalCount = specializedTreatmentRetrievalCount;
    metrics.formulaRetrievalCount = formulaRetrievalCount;
    metrics.treatmentRetrievalBeforePatternAssessmentCount = treatmentRetrievalBeforePatternAssessmentCount;
    metrics.treatmentRetrievalBeforeTreatmentTargetCount = treatmentRetrievalBeforeTreatmentTargetCount;
    metrics.hypothesisTransitionsAfterTreatmentRetrieval = hypothesisTransitionsAfterTreatmentRetrieval;

    // H15：固化 Clinical Decision Spine 时序指标 + 门禁观测（只观察）。
    metrics.diseaseAssessmentBeforeTreatmentRetrieval = firstTreatmentRetrievalStep === undefined ? undefined : diseaseAssessmentAtFirstTreatmentRetrieval;
    metrics.formalHypothesisBeforeTreatmentRetrieval = firstTreatmentRetrievalStep === undefined ? undefined : formalHypothesisAtFirstTreatmentRetrieval;
    metrics.treatmentPlanBeforeTreatmentRetrieval = firstTreatmentRetrievalStep === undefined ? undefined : treatmentPlanAtFirstTreatmentRetrieval;
    metrics.formulaRetrievalRejectedForMissingContext = formulaRetrievalRejectedForMissingContext;
    metrics.formulaReviewRecorded = context.workspace.clinicalDecisionSpine.formulaReview !== undefined;
    metrics.modificationItemsWithPatientEvidence = (context.workspace.clinicalDecisionSpine.modificationPlan?.items ?? []).filter((it) => it.patientEvidenceRefs.length > 0).length;

    // H15.1：固化 Completion Obligation & Formula Decision Quality 指标（只观察）。
    const obligation = context.workspace.clinicalDecisionSpine.completionObligation;
    metrics.clinicalCompletionObligationCreated = obligation !== undefined;
    metrics.completionRequestedOutcome = obligation?.requestedOutcome;
    metrics.completionRequiredArtifacts = obligation?.requiredArtifacts ?? [];
    metrics.completionMissingArtifactsAtEnd = checkClinicalCompletion(context.workspace).missingArtifacts;
    metrics.falseCompletionAttemptCount = falseCompletionAttemptCount;
    metrics.formulaCandidateRetrievalCount = formulaCandidateRetrievalCount;
    metrics.formulaEvidenceRetrievalCount = formulaEvidenceRetrievalCount;
    const selectedRef = context.workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef;
    metrics.selectedCandidateRef = selectedRef;
    metrics.formulaSelectionFromEvidence = selectedRef === undefined
      ? undefined
      : context.workspace.candidates.some((c) => c.id === selectedRef);
    metrics.retrievalSuggestedHypothesisCount = context.workspace.hypothesisState.hypotheses.filter((h) => h.origin === 'retrieval_suggested').length;
    metrics.repeatedNoProgressCorrectionCount = repeatedNoProgressCorrectionCount;
    metrics.repeatedUnresolvedHypothesisCorrectionCount = repeatedUnresolvedHypothesisCorrectionCount;
    metrics.repeatedTreatmentContextCorrectionCount = repeatedTreatmentContextCorrectionCount;

    setRunMetrics(context.runId, metrics);

    return { proposal, usage, agentLoop, contextMetrics };
  }

  /**
   * H11 Minimal Finalization —— 只把 Workspace 中已形成的判断序列化为最小 proposal 结构。
   * 不重新解决病例、不重新检索、不生成新的 formula identity；模型输出经 parse → schema → canonical fill。
   * 第一次 parse/schema 失败时，最多做一次 bounded structured retry；再失败则 FAIL CLOSED。
   */
  private async minimalFinalization(
    context: RuntimeContext,
    commitReliability: CommitReliabilityMetrics,
  ): Promise<{ proposal: AgentResult; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const draft = buildProposalDraft(context.workspace);
    commitReliability.proposalDraftFieldCount = countProposalDraftFields(draft);
    const decisionState = buildDecisionState(context.workspace, context.strategy);
    commitReliability.finalizationContextItemCount = countFinalizationContextItems(draft, decisionState);

    const serializationStartedAtMs = Date.now();
    const prompt = buildMinimalFinalizationPrompt(context, draft, decisionState);

    let result = await generateText({
      model: llmModel,
      system: this.options.instructions,
      prompt,
      timeout: { totalMs: 120_000 },
    });
    let finInput = result.usage.inputTokens ?? 0;
    let finOutput = result.usage.outputTokens ?? 0;

    let parsed = tryParseProposalSubmit(result.text);
    if (parsed.ok) {
      commitReliability.finalizationInputTokens = finInput;
      commitReliability.finalizationOutputTokens = finOutput;
      commitReliability.proposalSerializationLatencyMs = Date.now() - serializationStartedAtMs;
      const proposal = await canonicalizeProposalSubmit(parsed.value, context);
      return { proposal, usage: { inputTokens: finInput, outputTokens: finOutput } };
    }

    // 记录 parse/schema 失败并保留 raw payload 进 Trace。
    if (parsed.stage === 'parse') commitReliability.proposalParseFailureCount += 1;
    else commitReliability.proposalSchemaFailureCount += 1;
    addToolCall(context.runId, {
      toolName: 'finalization',
      input: { attempt: 1 },
      output: parsed.rawPayload,
      error: parsed.error,
      ms: 0,
    });

    // bounded retry：仅一次，最小上下文 + 错误摘要。
    commitReliability.proposalRetryCount += 1;
    const retryResult = await generateText({
      model: llmModel,
      system: this.options.instructions,
      prompt: buildRetryPrompt(draft, parsed.error),
      timeout: { totalMs: 120_000 },
    });
    finInput += retryResult.usage.inputTokens ?? 0;
    finOutput += retryResult.usage.outputTokens ?? 0;

    const retryParsed = tryParseProposalSubmit(retryResult.text);
    if (retryParsed.ok) {
      commitReliability.proposalRetrySuccessCount += 1;
      commitReliability.finalizationInputTokens = finInput;
      commitReliability.finalizationOutputTokens = finOutput;
      commitReliability.proposalSerializationLatencyMs = Date.now() - serializationStartedAtMs;
      const proposal = await canonicalizeProposalSubmit(retryParsed.value, context);
      return { proposal, usage: { inputTokens: finInput, outputTokens: finOutput } };
    }

    if (retryParsed.stage === 'parse') commitReliability.proposalParseFailureCount += 1;
    else commitReliability.proposalSchemaFailureCount += 1;
    addToolCall(context.runId, {
      toolName: 'finalization.retry',
      input: { attempt: 2 },
      output: retryParsed.rawPayload,
      error: retryParsed.error,
      ms: 0,
    });

    // FAIL CLOSED：不伪造 proposal、不猜测缺失临床字段。
    throw new Error(
      `Proposal finalization failed (${retryParsed.stage}): ${retryParsed.error} | raw: ${retryParsed.rawPayload.slice(0, 200)}`,
    );
  }
}
