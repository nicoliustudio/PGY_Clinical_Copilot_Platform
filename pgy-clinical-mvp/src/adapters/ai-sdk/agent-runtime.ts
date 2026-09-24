import { ToolLoopAgent, isStepCount, generateText, type ToolSet, type ModelMessage } from 'ai';
import { llmModel } from '../../model/adapter.js';
import { config } from '../../config.js';
import { extractJson } from '../../util/json.js';
import { agentResultSchema, type AgentResult, type ProposalSubmitInput } from '../../contracts/result.js';
import type { RuntimeContext } from '../../contracts/runtime.js';
import type { PrimaryAgentOutput, PrimaryAgentPort } from '../../contracts/ports.js';
import type { AgentStreamEvent, LifecycleStage } from '../../contracts/stream.js';
import type { AgentLoopTrace, CommitReliabilityMetrics, TerminationReason, ContextMetrics, PromptComponents, ControlPlaneTraceV21 } from '../../contracts/agent-loop.js';
import { addToolCall, addActionReceipt, setRunMetrics, addH14TreatmentRetrieval } from '../../trace.js';
import { executionProtocolVersion, type ActionReceipt, type DecisionImpact, type ExecutionRole, type ExecutionRoleCost, type RunExecutionMetrics, type RecentRetrievalFeedback, type H14TreatmentRetrieval } from '../../contracts/execution.js';
import { DEFAULT_AI_SDK_TOOL_BINDINGS, type AiSdkToolBindings } from './tool-bindings.js';
import { applyToolExecutionResult, type ToolExecutionEnvelope } from './workspace-events.js';
import { ToolCallLedger } from './tool-call-ledger.js';
import { RetrievalDisciplineTracker, isRetrievalTool } from './retrieval-discipline.js';
import { computeExecutionNecessity } from './execution-necessity.js';
import { ProjectionCache } from './projection-cache.js';
import { canonicalizeProposalSubmit } from './proposal-canonicalizer.js';
import { buildDeterministicClinicalSubmit, buildProposalDraft, countProposalDraftFields } from '../../platform/workspace/proposal-draft.js';
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
import { evaluateProposalReadiness } from '../../platform/workspace/proposal-readiness.js';
import {
  applyEvidenceNeedBlocker,
  blockedObligationsV21,
  openObligationsV21,
  outcomeCoverage,
  refreshControlPlaneV21,
  runnableObligations,
  unmetObligationsV21,
  v21ToolSurface,
} from '../../platform/control-plane/control-plane-v21-session.js';
import type { EffectTerm } from '../../control-plane-v21/types.js';
import { formulaFrontierPending } from '../../platform/control-plane/artifact-bridge.js';
import { evidenceRetrievalProgress } from '../../clinical/capability-evidence.js';
import { renderActiveSkills } from '../../platform/skills/render-skills.js';
import { buildClinicalWorkingView, renderClinicalWorkingView, estimateTokens, type RecentAction } from '../../platform/context/clinical-working-view.js';
import type { ClinicalWorkspace, DecisionState, WorkspaceBatchResult, WorkspaceEvent } from '../../contracts/workspace.js';
import { getFormulaHydrationStats, resetFormulaHydrationStats } from '../../clinical/formula.js';
import { requiredDeliveryFields } from '../../clinical/capability-delivery.js';

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

/** Tools whose result/validity depends on mutable Runtime/Workspace state. */
function isStatefulLedgerTool(id: string): boolean {
  return id === 'capability.activate'
    || id === 'knowledge.search'
    || id === 'knowledge.search_cards'
    || id === 'formula.search_normative'
    || id === 'formula.search_candidates'
    || id === 'formula.get_modification_evidence'
    || id === 'proposal.submit'
    || id === 'delivery.commit'
    || id.startsWith('workspace.');
}

function scopeStateKey(context: RuntimeContext): string {
  return `scopes:${[...context.knowledgeScopes].sort().join(',')}`;
}

function runtimeStateKey(context: RuntimeContext): string {
  return `workspace:${context.workspaceStore.version}|${scopeStateKey(context)}`;
}

function ledgerStateKeyFor(id: string, context: RuntimeContext): string | undefined {
  if (id === 'capability.discover') return capabilityStateKey(context);
  if (id === 'knowledge.get_source' || id === 'knowledge.get_asset') return scopeStateKey(context);
  if (isStatefulLedgerTool(id)) return runtimeStateKey(context);
  return undefined;
}

function buildTools(context: RuntimeContext, bindings: AiSdkToolBindings, ledger: ToolCallLedger): ToolSet {
  const tools: ToolSet = {};
  for (const [id, factory] of Object.entries(bindings)) {
    const stateKey = () => ledgerStateKeyFor(id, context) ?? '';
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

/**
 * Control Plane V2.1 action surface 投影（Phase 6 —— 调度主权）。
 *
 * - 只有声明了 `effectPatternsV21` 的工具受 V2.1 管辖；proposal.submit / capability.* 等控制类工具不受影响。
 * - 工具可见 ⟺ 它的某个 effect pattern 与**当前 runnable obligation** 的 admissible effect 结构匹配。
 * - 检索是否开放因此由 unmet obligation 决定，而不是「搜索 N 次」的阈值。
 * - Request IR 未能建立（compileStatus=FAILED）时不接管（避免用不完整的闭世界契约阻断临床工作）。
 */
export function projectControlPlaneV21Surface(context: RuntimeContext, internalToolIds: string[]): string[] {
  const state = context.controlPlaneV21;
  if (!state || state.compileStatus !== 'COMPILED') return internalToolIds;
  refreshControlPlaneV21(context);
  const patternsFor = (id: string): EffectTerm[] | undefined =>
    context.tools.find((t) => t.id === id)?.effectPatternsV21 as EffectTerm[] | undefined;
  const { closed } = v21ToolSurface(state, internalToolIds, patternsFor);
  const closedSet = new Set(closed);
  // V2.1.1: provider selection is already deterministic in the graph and RuntimePreparer activates
  // those providers. Keeping discover/activate exposed would reintroduce a second orchestration loop.
  closedSet.add('capability.discover');
  closedSet.add('capability.activate');

  // V2.1.1 evidence lifecycle refinement: discovery and hydration are different execution states
  // even though they serve the same generic obligation. A retrieval tool stays legal only while it
  // can still advance **some** runnable evidence obligation; otherwise every call is a guaranteed
  // no-op (search→search / hydrate→hydrate loops). The progress is derived from declared
  // evidenceObligations + receipts, so no modality-specific branch is involved.
  const evidenceNodes = runnableObligations(state)
    .filter((node) => node.target.type === 'artifact:treatment-evidence' && node.target.producerCapabilityId);
  if (evidenceNodes.length > 0) {
    const progress = evidenceRetrievalProgress(
      context.capabilities,
      context.workspace.capabilityEvidenceReceipts,
      evidenceNodes.map((node) => node.target.producerCapabilityId as string),
    );
    const open = new Set<string>();
    const declared = new Set<string>();
    for (const p of progress) {
      const obligation = context.capabilities
        .find((c) => c.id === p.capabilityId)
        ?.evidenceObligations?.find((o) => o.id === p.obligationId);
      for (const toolId of obligation?.discoveryToolIds ?? []) {
        declared.add(toolId);
        if (p.requiresDiscovery) open.add(toolId);
      }
      for (const toolId of obligation?.hydrationToolIds ?? []) {
        declared.add(toolId);
        if (p.requiresHydration) open.add(toolId);
      }
    }
    for (const toolId of declared) if (!open.has(toolId)) closedSet.add(toolId);
  }

  // Formula evidence follows the same progress rule: discovery is useful only until concrete
  // candidates exist. Once they do, the only state-advancing retrieval is candidate hydration.
  const currentFormulaEvidence = runnableObligations(state)
    .find((node) => node.target.type === 'artifact:formula-evidence');
  if (currentFormulaEvidence) {
    const formulaCandidates = context.workspace.candidates.filter((candidate) => candidate.kind === 'formula');
    if (formulaCandidates.length === 0) {
      closedSet.add('formula.get_evidence');
      closedSet.add('formula.validate');
    } else {
      closedSet.add('formula.search_candidates');
      closedSet.add('formula.search_normative');
    }
  }

  // P0-3 No-progress terminal: when required obligations are BLOCKED and none remain OPEN, no
  // legal effect can change satisfaction state. proposal.submit must leave the legal surface —
  // otherwise the model re-submits the same not-ready proposal indefinitely (false completion loop).
  const blockedRequired = state.graph.nodes.filter((n) => n.required && n.status === 'BLOCKED');
  const openRequired = state.graph.nodes.filter((n) => n.required && n.status === 'OPEN');
  if (blockedRequired.length > 0 && openRequired.length === 0) {
    closedSet.add('proposal.submit');
  }

  return internalToolIds.filter((id) => !closedSet.has(id));
}

function projectActiveToolSurface(
  context: RuntimeContext,
  bindings: AiSdkToolBindings,
  mode: 'harness' | 'classic',
): string[] {
  const allInternal = activeToolIds(context, bindings, mode).map(fromApiToolName);
  // Phase 6：工具合法性**只**由 V2.1 obligation 投影决定，不存在第二种调度权威。
  // 未建立 Request IR（编译器失败）时不再回退到 phase/action-class 调度器 —— 保留完整工具面，
  // 由 readiness / Authority 继续做提交闸门（fail-closed 在 commit，而不是靠 legacy 调度猜测）。
  return projectControlPlaneV21Surface(context, allInternal).map(toApiToolName);
}

/**
 * Phase 5：合成义务已可执行、但模型仍无法完成时，才由 Runtime 施加 NEED_EVIDENCE blocker，
 * 重新打开**定向**检索。这是重新打开检索的唯一通道（不使用搜索次数阈值）。
 */
function maybeApplyEvidenceNeedBlocker(context: RuntimeContext): void {
  const state = context.controlPlaneV21;
  if (!state || state.compileStatus !== 'COMPILED') return;
  refreshControlPlaneV21(context);
  const runnable = runnableObligations(state);
  // 已有可执行的取证义务 → 模型应直接执行，不需要 blocker。
  if (runnable.some((n) => n.allowedEffects.some((e) => e.op === 'retrieve'))) return;
  const target = runnable.find((n) => n.allowedEffects.some((e) => e.op === 'commit'));
  if (!target) return;
  applyEvidenceNeedBlocker(
    state,
    context.workspace,
    target.id,
    `synthesis obligation ${target.target.type} reported insufficient evidence`,
  );
}

/** Control Plane V2.1 遥测快照。 */
export function controlPlaneTraceV21(
  context: RuntimeContext,
  steps: ControlPlaneTraceV21['steps'],
): ControlPlaneTraceV21 | undefined {
  const state = context.controlPlaneV21;
  if (!state) return undefined;
  refreshControlPlaneV21(context);
  const required = state.graph.nodes.filter((n) => n.required);
  const readiness = evaluateProposalReadiness(context);
  return {
    requestCompileStatus: state.compileStatus,
    ...(state.compileError ? { requestCompileError: state.compileError } : {}),
    requiredOutcomes: [...state.requestIR.outcomes.required],
    preferredOutcomes: [...state.requestIR.outcomes.preferred],
    allowedOutcomes: [...(state.requestIR.outcomes.allowed ?? [])],
    excludedOutcomes: [...state.requestIR.outcomes.excluded],
    unresolvedOutcomes: [...(state.requestIR.outcomes.unresolved ?? [])],
    preferredShortfalls: [...(state.requestIR.outcomes.unresolvedPreferred ?? [])],
    mentionOutcomes: (state.requestIR.outcomes.mentions ?? []).map((mention) => ({ ...mention })),
    ...(state.semanticValidation ? { semanticValidation: state.semanticValidation } : {}),
    exclusive: state.requestIR.outcomes.exclusive,
    formulaCardinality: state.requestIR.outputPolicy.formulaCardinality.mode,
    knowledgeSourcePolicy: state.requestIR.generationPolicy.knowledgeSource,
    planningIssues: state.graph.issues.map((issue) => ({ type: issue.type, message: issue.message })),
    requiredObligationCount: required.length,
    satisfiedObligationCount: required.filter((n) => n.status === 'SATISFIED').length,
    openObligations: openObligationsV21(state).map((n) => n.id),
    blockedObligations: blockedObligationsV21(state).map((n) => n.id),
    notDeliverableObligations: required.filter((n) => n.status === 'NOT_DELIVERABLE').map((n) => n.id),
    graphComplete: unmetObligationsV21(state).length === 0,
    unmetObligations: unmetObligationsV21(state).map((n) => n.id),
    obligations: state.graph.nodes.map((n) => ({
      id: n.id,
      type: n.target.type,
      ...(typeof n.target.qualifiers.outcome === 'string' ? { outcome: n.target.qualifiers.outcome } : {}),
      ...(n.provider ? { provider: `${n.provider.capabilityId}/${n.provider.ruleId}` } : {}),
      source: n.source,
      status: n.status,
      required: n.required,
      rootOutcomes: [...n.rootOutcomes],
      dependsOn: [...n.dependsOn],
      ...(n.blocker ? { blocker: n.blocker.type } : {}),
    })),
    outcomeCoverage: outcomeCoverage(state).map((o) => ({ outcome: o.outcome, status: o.status })),
    appliedBlockers: state.appliedBlockers.map((b) => ({
      obligationId: b.obligationId,
      type: b.blocker.type,
      question: b.blocker.question,
    })),
    steps,
    readiness: {
      ready: readiness.ready,
      blockerCodes: readiness.blockers.map((b) => b.code),
      missingArtifacts: [...readiness.missingArtifacts],
    },
  };
}

function closureAwareActiveToolIds(
  context: RuntimeContext,
  bindings: AiSdkToolBindings,
  mode: 'harness' | 'classic',
): string[] {
  return projectActiveToolSurface(context, bindings, mode);
}

/** H15.5.3：Natural stop 后的恢复阶段。submit = 仅提交；completion = 补齐缺失产物。 */
type RecoveryState = { kind: 'submit' } | { kind: 'completion'; missing: string[] };

/** H15.5.3：Completion Contract —— planner 预判 + 能力输出义务 + Agent 显式义务的并集。 */
export function completionContractFor(context: RuntimeContext): { requiredArtifacts: string[]; missingArtifacts: string[]; ok: boolean } {
  const readiness = evaluateProposalReadiness(context);
  const missing = [...readiness.missingArtifacts];
  // unresolved hypothesis 不是“缺少 formalHypotheses”，但 recovery 需要一个现有 artifact key
  // 来选择 hypothesis-resolution 工具面；对外 readiness 仍保留独立 blocker 语义。
  if (readiness.unresolvedHypotheses.length > 0 && !missing.includes('formalHypotheses')) missing.push('formalHypotheses');
  for (const core of readiness.coreMissing) {
    if (core !== 'clinicalQuestion' && !missing.includes(core)) missing.push(core);
  }
  return { requiredArtifacts: readiness.requiredArtifacts, missingArtifacts: missing, ok: readiness.ready };
}

/**
 * H15.5.3：Recovery active tools。与主 loop 共用同一 phase-driven action-surface 投影
 * （missing 参数冗余，phase 从 workspace 重新推导，保证主/recovery 口径一致）。
 */
export function recoveryActiveToolIds(
  context: RuntimeContext,
  bindings: AiSdkToolBindings,
  mode: 'harness' | 'classic',
  _missing: string[],
): string[] {
  return projectActiveToolSurface(context, bindings, mode);
}

/** H15.5.3：Recovery 复用原始剩余预算（不重新给一套 maxSteps）。 */
export function recoveryRemainingSteps(resourceSteps: number, usedSteps: number): number {
  return Math.max(1, resourceSteps - usedSteps);
}

/** H15.5.3：Recovery 通用执行指令（不写病例特定医疗内容）。 */
const RECOVERY_INSTRUCTION = 'Your previous response did not complete the structured clinical task. Do not end in free text. Complete the missing durable clinical decisions using the available tools, then call proposal.submit.';

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
- When existing evidence supports the required product draft, stop broad retrieval. If delivery.commit is available, commit the exact required outcome before proposal.submit.
- Reuse before retrieving. Before another retrieval, name the unresolved decision it could change (disease framing / syndrome judgment / treatment method / formula selection / safety disposition). If the workspace already has sufficient evidence for that decision, reuse existing evidence instead of retrieving again.
- Do not retrieve merely to increase confidence or completeness. Do not continue broad retrieval after a viable canonical candidate exists unless new evidence could materially change the decision.
- Commit workspace cognition atomically: when one clinical decision includes candidate focus, candidate assessment, hypothesis update, and uncertainty resolution, commit them together in one workspace.record_deliberation. Do not split one cognitive decision into multiple workspace writes unless later information genuinely changes the decision. Do not repeat workspace mutations that are already persisted.
- Choose the clinical action you need. Do not manually fabricate canonical identity/source binding. The Kernel performs deterministic hydration and validation when you call delivery.commit.
- Reuse already activated capabilities, validated candidates, and existing deterministic results when still valid. Do not repeat execution chores that do not change the business objective.
- When the clinical decision is sufficiently complete, commit every runnable required delivery with delivery.commit; only then submit the proposal. Do not repeat deterministic Kernel work.
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

/**
 * Control Plane V2.1：把本次 run 的 required outcome 暴露给模型。
 * 这是一个 durable artifact 必须显式声明 outcome 的闭环前提（多治疗形式并存时不可含糊）。
 *
 * 「哪些 outcome 需要交付」由图本身给出（required 且未 terminal 的 treatment-delivery 义务），
 * 不由 Core 认识任何具体治疗形式 —— 新增 modality 只改 manifest，这里不需要改。
 */
function controlPlaneOutcomeGuidance(context: RuntimeContext): string {
  const state = context.controlPlaneV21;
  if (!state || state.compileStatus !== 'COMPILED') return '';
  const required = state.requestIR.outcomes.required;
  if (required.length === 0) return '';
  const pending = [...new Set(state.graph.nodes
    .filter((node) => node.required
      && node.status === 'OPEN'
      && node.target.type === 'artifact:treatment-delivery'
      && typeof node.target.qualifiers.outcome === 'string')
    .map((node) => node.target.qualifiers.outcome as string))].sort();
  const lines = ['', '## Active Request Outcomes', ...required.map((o) => `- ${o}`)];
  if (pending.length > 0) {
    lines.push(
      '',
      `Treatment-form deliveries still unrecorded: ${pending.join(', ')}`,
      'Record each one with workspace.record_deliberation → treatmentPlan.treatmentDeliveries[]. `outcome` must be copied exactly '
      + 'from the list above; one delivery closes only its own outcome obligation. '
      + 'Use treatmentPlan.treatmentFormDecision only when exactly one delivery exists.',
      'A delivery must implement the very treatment form its `outcome` names. Never let a neighbouring or auxiliary technique '
      + 'stand in for the requested form. Product completeness is manifest-driven: a delivery remains OPEN until every required '
      + 'field declared by its capability is present.',
    );
    for (const outcome of pending) {
      const capability = context.capabilities.find((c) => c.provides?.includes(outcome));
      const obligation = capability?.deliveryObligations?.[0];
      if (!obligation) continue;
      const fields = requiredDeliveryFields(obligation, outcome);
      if (fields.length > 0) lines.push(`- ${outcome} required delivery fields: ${fields.join(', ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * V2.1.1：把「可执行但尚未执行的下一步」显式告诉模型。
 * 这些 hint 全部由 durable state + obligation graph 派生，不含任何业务 modality 知识；
 * 它们不改变 closure 语义，只避免模型在无法推进的动作上空转。
 */
function pendingObligationHints(context: RuntimeContext): string {
  const state = context.controlPlaneV21;
  if (!state || state.compileStatus !== 'COMPILED') return '';
  const hints: string[] = [];
  if (formulaFrontierPending(context.workspace)) {
    hints.push(
      'Formula evidence has been hydrated but the deliberation frontier is empty, so the formula-evidence '
      + 'obligation cannot close. Call workspace.focus_candidates with the candidates you actually consider, '
      + 'then continue with selection.',
    );
  }
  return hints.length > 0 ? `\n\n## Pending Obligation Hints\n${hints.map((h) => `- ${h}`).join('\n')}\n` : '';
}

export function dynamicInstructions(base: string, context: RuntimeContext, ledger?: ToolCallLedger, retrievalFeedback?: RecentRetrievalFeedback, decisionState?: DecisionState): string {
  const skills = renderActiveSkills(context.skills);
  const view = buildClinicalWorkingView(
    context.workspace, context.strategy, buildRecentActions(ledger), retrievalFeedback, decisionState,
    completionContractFor(context).requiredArtifacts,
  );
  const workingView = renderClinicalWorkingView(view);
  const patternPrinciple = config.experiment.diagnosticPatternSet ? `\n\n${DIAGNOSTIC_PATTERN_PRINCIPLE}` : '';
  return `${base}\n\n${ACTION_PRINCIPLE}${patternPrinciple}${controlPlaneOutcomeGuidance(context)}${pendingObligationHints(context)}\n\n## Active Harness Skills\n${skills || '（无）'}\n\nActive scopes: ${context.knowledgeScopes.join(', ')}\n\n## Clinical Working View\n${workingView}`;
}

/** 度量「目标驱动工作上下文」相对「全量投影」的收缩程度（估算）。 */
function computeContextMetrics(context: RuntimeContext, ledger: ToolCallLedger, retrievalFeedback?: RecentRetrievalFeedback): ContextMetrics {
  const workingView = renderClinicalWorkingView(buildClinicalWorkingView(
    context.workspace, context.strategy, buildRecentActions(ledger), retrievalFeedback, undefined,
    completionContractFor(context).requiredArtifacts,
  ));
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
  const workingViewTokens = estimateTokens(renderClinicalWorkingView(buildClinicalWorkingView(
    context.workspace, context.strategy, buildRecentActions(ledger), retrievalFeedback, undefined,
    completionContractFor(context).requiredArtifacts,
  )));
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
  if (toolName === 'delivery.commit') return 'COMMIT';
  if (toolName === 'proposal.submit') return 'OTHER';
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
  // Skill 正文已经通过 dynamicInstructions 进入 system instructions。
  // 这里仅保留激活 id，避免同一 Skill 在 system + user prompt 中重复一整份，
  // 降低 token 与“重复强调导致行为过拟合/漂移”的风险。
  const skillIds = context.skills.map((skill) => skill.id).join(', ');
  return [
    `本次 Run 初始交互模式：${context.understanding.interaction.mode}`,
    '',
    `初始安全处置：${context.workspace.safetyDisposition}`,
    '临床总策划（ClinicalStrategy）与当前工作上下文见 system 指令中的 Clinical Working View。',
    '',
    mode === 'harness' ? 'Harness active skill ids:' : 'Classic pre-routed skill ids:', skillIds || '（无）',
    '',
    mode === 'harness'
      ? context.controlPlaneV21?.compileStatus === 'COMPILED'
        ? 'Control Plane 已确定性解析并激活 required providers；不要重新 discover/activate。先完成 PREPARED reasoning/draft；当 delivery.commit 出现在合法工具面时，必须提交对应 exact outcome。所有 required delivery 均已 commit 后再调用 proposal.submit。'
        : '你拥有 capability.discover / capability.activate / proposal.submit。需要业务扩展时先发现再激活；探索充分后调用 proposal.submit 提交最终 Proposal。'
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
      runtimeReadyStateCommitCount: 0,
      runtimeReadyStateCommitSuccessCount: 0,
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
    let stepOffset = 0;
    let recovery: RecoveryState | null = null;
    // V2.1.1 Actuation telemetry：每步的 runnable obligation 与 legal effect surface（仅观测）。
    const controlPlaneSteps: ControlPlaneTraceV21['steps'] = [];

    const buildLoopAgent = (maxSteps: number, rec: RecoveryState | null) => new ToolLoopAgent({
      model: llmModel,
      tools: buildTools(context, bindings, ledger),
      instructions: dynamicInstructions(this.options.instructions, context, ledger, tracker.feedback()),
      toolChoice: rec ? 'required' : undefined,
      prepareStep: async ({ initialMessages, steps }) => {
        currentStep = stepOffset + steps.length + 1;
        metrics.workspaceProjectionCount += 1;
        metrics.decisionStateProjectionCount += 1;
        const version = context.workspaceStore.version;
        cachedDecisionState = projectionCache.getDecisionState(version, context.workspace, context.strategy).decisionState;
        const activeTools = rec
          ? recoveryActiveToolIds(context, bindings, mode, rec.kind === 'completion' ? rec.missing : [])
          : closureAwareActiveToolIds(context, bindings, mode);
        if (context.controlPlaneV21?.compileStatus === 'COMPILED') {
          controlPlaneSteps.push({
            step: currentStep,
            runnable: runnableObligations(context.controlPlaneV21).map((n) => n.id),
            surface: activeTools.map(fromApiToolName),
          });
        }
        const baseInstructions = dynamicInstructions(this.options.instructions, context, ledger, tracker.feedback(), cachedDecisionState);
        let instructions = baseInstructions;
        if (rec) {
          const recoverHeader = rec.kind === 'submit'
            ? 'Your structured clinical task now has all required durable artifacts. Call proposal.submit immediately to submit the final proposal. Do not end in free text.'
            : `${RECOVERY_INSTRUCTION}\n\nMissing durable artifacts: ${rec.missing.join(', ')}.\nUse workspace.record_deliberation to write the missing clinical decisions or prepared delivery draft. When delivery.commit becomes available, commit each required exact outcome. Only after all required delivery commits are terminal should you call proposal.submit.`;
          instructions = `${recoverHeader}\n\n${baseInstructions}`;
        }
        return {
          activeTools,
          toolChoice: rec ? 'required' : undefined,
          instructions,
          messages: compactAgentMessages(initialMessages, steps),
        };
      },
      stopWhen: mode === 'harness'
        ? [proposalSubmitReadyStep(), isStepCount(maxSteps)]
        : [isStepCount(maxSteps)],
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
            // Phase 5：合成已可执行但仍无法完成 → 由 Runtime 施加 NEED_EVIDENCE，重新打开定向检索。
            maybeApplyEvidenceNeedBlocker(context);
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
      const response = await buildLoopAgent(resourceSteps, null).generate({
        prompt: buildContextPrompt(context, mode),
        timeout: { totalMs: this.options.totalTimeoutMs ?? 360_000 },
      });
      proposal = extractJson(response.text, agentResultSchema);
      usage = response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : usage;
      emit('completed');
      return { proposal, usage };
    }

    // Harness production path：不依赖 response.text 提取 JSON。
    // H15.5.3：natural stop ≠ completion。recovery 循环驱动，直到 submit 或预算耗尽。
    let finalContract: ReturnType<typeof completionContractFor> | null = null;

    while (true) {
      const maxSteps = Math.max(1, resourceSteps - stepCount);
      const agent = buildLoopAgent(maxSteps, recovery);
      const response = await agent.generate({
        prompt: buildContextPrompt(context, mode),
        timeout: { totalMs: this.options.totalTimeoutMs ?? 360_000 },
      });
      stepCount += response.steps.length;
      stepOffset = stepCount;
      finishReason = response.finishReason;
      finalStepHadToolCalls = response.finalStep.toolCalls.length > 0;
      usage = response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : usage;

      if (submittedProposal !== undefined) break;

      finalContract = completionContractFor(context);
      if (resourceSteps - stepCount <= 0) break;
      recovery = finalContract.ok ? { kind: 'submit' } : { kind: 'completion', missing: finalContract.missingArtifacts };
    }

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
    } else if (finalContract?.ok) {
      // durable state 已完整：临床判断已经结束。最后一步是 closed-world serialization，
      // 不再让 LLM 重写 JSON / 重新“按 submit 按钮”，避免把机械动作变成随机源。
      emit('finalizing');
      commitReliability.runtimeReadyStateCommitCount = 1;
      const deterministicSubmit = buildDeterministicClinicalSubmit(context.workspace, context.knowledgeScopes);
      if (!deterministicSubmit) {
        terminationReason = 'execution_incomplete';
        forcedFinalization = false;
        proposalSubmitted = false;
        commitReliability.finalProposalCommittedCount = 1;
        proposal = {
          mode: 'conversation',
          message: 'EXECUTION_INCOMPLETE: readiness=true but deterministic proposal projection is unavailable',
        };
      } else {
        proposal = await canonicalizeProposalSubmit(deterministicSubmit, context);
        commitReliability.runtimeReadyStateCommitSuccessCount = 1;
        commitReliability.finalProposalCommittedCount = 1;
        commitReliability.timeFromFinalDecisionToCommitMs = Date.now() - finalDecisionAtMs;
        commitReliability.proposalSerializationLatencyMs = Date.now() - finalDecisionAtMs;
        forcedFinalization = false;
        proposalSubmitted = false;
        terminationReason = 'runtime_committed_ready_state';
      }
    } else {
      // H15.5.3：budget 耗尽且 contract 不完整 → EXECUTION_INCOMPLETE，不伪装成 clarification。
      terminationReason = 'execution_incomplete';
      forcedFinalization = true;
      proposalSubmitted = false;
      commitReliability.finalProposalCommittedCount = 1;
      const missing = finalContract?.missingArtifacts ?? [];
      // V2.1.1：fail-closed 必须可解释。typed blocker（unsupported / ambiguous / cycle / NEED_EVIDENCE）
      // 是「为什么闭世界下无法交付」的真源，不能让用户只看到 EXECUTION_INCOMPLETE。
      const typedBlockers = (context.controlPlaneV21?.graph.nodes ?? [])
        .filter((node) => node.required && (node.status === 'BLOCKED' || node.blocker !== undefined))
        .map((node) => node.blocker?.question ?? `${node.target.type} is not deliverable`);
      const blockerNote = typedBlockers.length > 0
        ? `; blocked: ${[...new Set(typedBlockers)].join(' | ')}`
        : '';
      proposal = {
        mode: 'conversation',
        message: `EXECUTION_INCOMPLETE: missing artifacts [${missing.join(', ')}]${blockerNote}`,
      };
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
      controlPlane: controlPlaneTraceV21(context, controlPlaneSteps),
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
    metrics.completionMissingArtifactsAtEnd = completionContractFor(context).missingArtifacts;
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
    const draft = buildProposalDraft(context.workspace, context.knowledgeScopes);
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
