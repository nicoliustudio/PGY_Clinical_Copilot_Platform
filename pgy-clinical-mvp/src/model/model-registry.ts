import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { config } from '../config.js';
import type { ModelProfile } from '../contracts/runtime.js';

/**
 * 模型目录与活动选择（唯一真源）。
 *
 * 为什么需要这一层：模型此前由 `.env` 在进程启动时固化（`llmModel` 是 import 期常量），
 * 无法热切换。这里把「选哪个模型」收敛成一个显式注册表 + 一个进程级活动选择，
 * 语言模型在**每次调用时**按当前选择解析，因此切换后无需重启即可生效。
 *
 * 边界：
 * - 本模块只决定「用哪个模型 / 是否发送 enable_thinking」这一事实，不做任何临床判断；
 * - 目录内每个模型的 thinking 语义都来自实测（见 thinking 字段注释），不靠文档推断，
 *   避免出现「点了没反应」或「发送参数直接 400」的死开关。
 */

export type ModelChannel = 'official' | 'aliyun';

/**
 * 推理开关的实际可用性（实测三态，决定前端开关是否可点、以及是否发送 enable_thinking）：
 * - `toggle`：可通过 `enable_thinking` 开关。部分模型默认开（可关），部分默认关（可开）。
 * - `always`：总是思考，前端开关置灰。**绝不发送该参数**——其中 glm-5.3 / MiniMax-M2.5 实测
 *   发送 `enable_thinking:false` 会直接返回 HTTP 400。
 * - `none`：非推理模型，本就不产生 reasoning，前端开关置灰。
 */
export type ThinkingMode = 'toggle' | 'always' | 'none';

/**
 * 思考预算档位：限制模型「思考过程」的最大 token 数，超过即截断并立即开始生成答案。
 * `off` 表示不发送该参数（思考长度完全由模型决定），与既有行为一致。
 */
export type ThinkingBudgetLevel = 'off' | 'low' | 'mid' | 'high';

/** 档位 → token 上限。仅对 `budget === 'verified'` 的模型有意义。 */
export const BUDGET_TOKENS: Record<Exclude<ThinkingBudgetLevel, 'off'>, number> = {
  low: 256,
  mid: 512,
  high: 1024,
};

/**
 * `thinking_budget` 的实际可用性（实测，非文档推断）：
 * - `verified`：实测 reasoning_tokens 会随 budget 变化并被截断（前端开放该档位）。
 * - `ignored`：实测该参数被**静默忽略**（HTTP 200 但不生效，思考长度不变甚至更长）。
 *   前端置灰并说明原因，避免做出「点得动但没反应」的假旋钮。
 */
export type BudgetSupport = 'verified' | 'ignored';

export interface ModelOption {
  /** 目录内稳定 id（前端 value）。 */
  id: string;
  label: string;
  channel: ModelChannel;
  channelLabel: string;
  /** 发给 API 的 model 名。 */
  modelId: string;
  thinking: ThinkingMode;
  /** 该模型在「未显式指定」时的推理默认值；`toggle` 之外的取值无实际作用。 */
  defaultThinking: boolean;
  /** 实测备注（小任务中位延迟 / 推理占比），用于前端悬浮提示，不做医学含义。 */
  measured?: string;
  /** `thinking_budget` 实测可用性，决定前端预算档位是否开放。 */
  budget: BudgetSupport;
}

const CHANNEL_LABEL: Record<ModelChannel, string> = {
  official: 'DeepSeek 官方',
  aliyun: '阿里云百炼',
};

type ModelOptionSeed = Omit<ModelOption, 'channelLabel'>;

const CATALOG: ModelOption[] = ([
  // ---- DeepSeek 官方 ----
  // 官方通道实测忽略 enable_thinking，自然也不会应用 thinking_budget。
  { id: 'official:deepseek-chat', label: 'deepseek-chat', channel: 'official', modelId: 'deepseek-chat', thinking: 'none', defaultThinking: false, budget: 'ignored', measured: '实测 107ms · 非推理，全局最快基线' },
  { id: 'official:deepseek-flash', label: 'deepseek-flash', channel: 'official', modelId: 'deepseek-flash', thinking: 'always', defaultThinking: true, budget: 'ignored', measured: '思考型；官方忽略开关，无法关闭' },
  { id: 'official:deepseek-v4-pro', label: 'deepseek-v4-pro', channel: 'official', modelId: 'deepseek-v4-pro', thinking: 'always', defaultThinking: true, budget: 'ignored', measured: '思考型；官方忽略开关，无法关闭' },

  // ---- 阿里云百炼 · 千问（实测支持思考预算） ----
  { id: 'aliyun:qwen3.8-max', label: 'qwen3.8-max', channel: 'aliyun', modelId: 'qwen3.8-max', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 206s（思考 7258 tok）→ 预算256 降至 37.8s' },
  { id: 'aliyun:qwen3.8-flash', label: 'qwen3.8-flash', channel: 'aliyun', modelId: 'qwen3.8-flash', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 89s（思考 5880 tok）→ 预算256 降至 18.5s' },
  { id: 'aliyun:qwen3.7-plus', label: 'qwen3.7-plus', channel: 'aliyun', modelId: 'qwen3.7-plus', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 40.9s（思考 2732 tok）→ 预算256 降至 13.1s' },
  { id: 'aliyun:qwen3.7-max', label: 'qwen3.7-max', channel: 'aliyun', modelId: 'qwen3.7-max', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 70s（思考 5095 tok）→ 预算256 降至 10.2s' },
  { id: 'aliyun:qwen3.6-plus', label: 'qwen3.6-plus', channel: 'aliyun', modelId: 'qwen3.6-plus', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 80s（思考 4110 tok）→ 预算256 降至 14.0s' },
  { id: 'aliyun:qwen3.6-flash', label: 'qwen3.6-flash', channel: 'aliyun', modelId: 'qwen3.6-flash', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '默认知 7.7s / 关推理 ~0.3s；预算256 实测 4.7s→1.7s' },

  // ---- 阿里云百炼 · DeepSeek ----
  // v4.1-flash / v4-pro-0813 实测静默忽略该参数（思考反而更长），故不开放预算档位。
  { id: 'aliyun:deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', channel: 'aliyun', modelId: 'deepseek-v4.1-flash', thinking: 'toggle', defaultThinking: true, budget: 'ignored', measured: '默认知 2.1s / 关推理 ~1.2s；实测忽略思考预算' },
  { id: 'aliyun:deepseek-v4-pro-0813', label: 'deepseek-v4-pro-0813', channel: 'aliyun', modelId: 'deepseek-v4-pro-0813', thinking: 'toggle', defaultThinking: true, budget: 'ignored', measured: '默认知 2.2s / 关推理 ~1.4s；实测忽略思考预算' },
  { id: 'aliyun:deepseek-v4-pro', label: 'deepseek-v4-pro', channel: 'aliyun', modelId: 'deepseek-v4-pro', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '默认知 3.0s / 关推理 ~1.4s；预算实测生效' },
  { id: 'aliyun:deepseek-v4-flash', label: 'deepseek-v4-flash', channel: 'aliyun', modelId: 'deepseek-v4-flash', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '默认知 1.5s / 关推理 ~0.8s；预算实测生效' },
  { id: 'aliyun:deepseek-v4-flash-0731', label: 'deepseek-v4-flash-0731', channel: 'aliyun', modelId: 'deepseek-v4-flash-0731', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '默认知 1.8s / 关推理 ~1.5s；预算实测生效' },
  { id: 'aliyun:deepseek-v3.2', label: 'deepseek-v3.2', channel: 'aliyun', modelId: 'deepseek-v3.2', thinking: 'toggle', defaultThinking: false, budget: 'verified', measured: '默认非推理 1.0s；可开启思考；预算实测生效' },

  // ---- 阿里云百炼 · 月之暗面 ----
  { id: 'aliyun:kimi-k2.5', label: 'kimi-k2.5', channel: 'aliyun', modelId: 'kimi-k2.5', thinking: 'toggle', defaultThinking: false, budget: 'verified', measured: '默认非推理 0.7s；可开启思考；预算实测生效' },
  { id: 'aliyun:kimi-k2.6', label: 'kimi-k2.6', channel: 'aliyun', modelId: 'kimi-k2.6', thinking: 'toggle', defaultThinking: false, budget: 'verified', measured: '默认非推理 1.0s；可开启思考；预算实测生效' },
  { id: 'aliyun:kimi-k2.7-code', label: 'kimi-k2.7-code', channel: 'aliyun', modelId: 'kimi-k2.7-code', thinking: 'always', defaultThinking: true, budget: 'verified', measured: '实测开关无效；但思考预算实测生效' },

  // ---- 阿里云百炼 · 智谱 ----
  // 全系实测静默忽略该参数，故不开放预算档位。
  { id: 'aliyun:glm-5.3', label: 'glm-5.3', channel: 'aliyun', modelId: 'glm-5.3', thinking: 'always', defaultThinking: true, budget: 'ignored', measured: '发送关推理参数会返回 400，故不发送；实测忽略思考预算' },
  { id: 'aliyun:glm-5.2', label: 'glm-5.2', channel: 'aliyun', modelId: 'glm-5.2', thinking: 'toggle', defaultThinking: true, budget: 'ignored', measured: '默认知 7.4s / 关推理 ~7.0s；实测忽略思考预算' },
  { id: 'aliyun:glm-5', label: 'glm-5', channel: 'aliyun', modelId: 'glm-5', thinking: 'toggle', defaultThinking: true, budget: 'ignored', measured: '默认知 10.9s / 关推理 ~9.1s；实测忽略思考预算' },
  { id: 'aliyun:glm-5.1', label: 'glm-5.1', channel: 'aliyun', modelId: 'glm-5.1', thinking: 'toggle', defaultThinking: true, budget: 'ignored', measured: '默认知 6.8s / 关推理 ~6.4s；实测忽略思考预算' },

  // ---- 阿里云百炼 · MiniMax ----
  { id: 'aliyun:MiniMax-M2.5', label: 'MiniMax-M2.5', channel: 'aliyun', modelId: 'MiniMax-M2.5', thinking: 'always', defaultThinking: true, budget: 'verified', measured: '发送关推理参数会返回 400，故不发送；预算实测生效' },
] satisfies ModelOptionSeed[]).map((option) => ({ ...option, channelLabel: CHANNEL_LABEL[option.channel] }));

const DEFAULT_OPTION_ID = 'official:deepseek-chat';

export interface ModelSelection {
  optionId: string;
  thinking: boolean;
  /** 思考预算档位。对 `budget==='ignored'` 的模型恒为 `off`。 */
  budget: ThinkingBudgetLevel;
}

/**
 * Run-scoped immutable model selection. Unlike the mutable UI selection above, this value is
 * captured once at run start and is safe to retain for the whole request lifecycle.
 */
export interface FrozenModelSelection extends Readonly<ModelSelection> {}

export interface ModelExecutionReceipt {
  /** Clinical reasoning role: Primary Agent only. */
  clinical: FrozenModelSelection;
  /** Control role: Understanding / Request Compiler / Planner. */
  control: FrozenModelSelection;
  /** What the caller explicitly requested for this run (or the UI-active option at run start). */
  requestedClinicalOptionId: string;
  /** Configured control role before availability fallback. */
  requestedControlOptionId: string;
  /** Present only when the configured control role was unavailable and this run fell back to clinical. */
  controlFallbackReason?: 'UNKNOWN_MODEL' | 'CHANNEL_NOT_CONFIGURED';
  clinicalProfile: ModelProfile;
  controlProfile: ModelProfile;
  /** Stable cache / trace key. */
  key: string;
}

/** 目录 id → 选项。 */
function optionById(id: string): ModelOption | undefined {
  return CATALOG.find((option) => option.id === id);
}

/** 通道凭据是否就绪（缺 key 的通道模型在前端置灰，而不是变成死按钮）。 */
function channelReady(channel: ModelChannel): boolean {
  return channel === 'official' ? config.llm.apiKey.trim().length > 0 : config.llm.aliyun.apiKey.trim().length > 0;
}

/** 规范化预算档位：实测忽略该参数的模型一律落到 `off`，不保留一个不会生效的档位。 */
function normalizeBudget(option: ModelOption, budget: ThinkingBudgetLevel | undefined): ThinkingBudgetLevel {
  if (option.budget !== 'verified') return 'off';
  return budget ?? 'off';
}

/**
 * 当前选择下**实际**要发送的思考上限。目录展示与请求注入共用这一个判定，
 * 因此界面上显示的档位与真的发给 API 的参数永远一致（不会出现假旋钮）。
 * 未开启推理时不发送：没有思考过程，限制长度没有意义。
 */
function effectiveBudgetTokens(option: ModelOption, sel: ModelSelection): number | undefined {
  if (option.budget !== 'verified') return undefined;
  if (!sel.thinking) return undefined;
  if (sel.budget === 'off') return undefined;
  return BUDGET_TOKENS[sel.budget];
}

/**
 * 初始选择解析顺序：
 * 1. `LLM_MODEL_ID`（目录 id，显式指定）；
 * 2. `LLM_DEEP_MODEL`（API model 名，优先官方通道，保持既有 .env 语义）；
 * 3. `official:deepseek-chat`。
 */
function resolveInitialOption(): ModelOption {
  const explicit = config.llm.modelId.trim();
  const byId = explicit ? optionById(explicit) : undefined;
  if (byId) return byId;

  const byModelId = CATALOG.filter((option) => option.modelId === config.llm.deepModel);
  const official = byModelId.find((option) => option.channel === 'official' && channelReady('official'));
  const ready = byModelId.find((option) => channelReady(option.channel));
  return official ?? ready ?? byModelId[0] ?? optionById(DEFAULT_OPTION_ID)!;
}

const selection: ModelSelection = (() => {
  const option = resolveInitialOption();
  return {
    optionId: option.id,
    thinking: option.thinking === 'toggle' ? option.defaultThinking : option.thinking === 'always',
    budget: 'off',
  };
})();

/** 预算档位（前端渲染下拉框用；`off` 表示不限制）。 */
export const BUDGET_LEVELS: Array<{ value: ThinkingBudgetLevel; label: string; tokens: number | null }> = [
  { value: 'off', label: '不限制', tokens: null },
  { value: 'low', label: '低 (256)', tokens: BUDGET_TOKENS.low },
  { value: 'mid', label: '中 (512)', tokens: BUDGET_TOKENS.mid },
  { value: 'high', label: '高 (1024)', tokens: BUDGET_TOKENS.high },
];

export interface CatalogView {
  options: Array<ModelOption & { available: boolean; defaultOption: boolean }>;
  active: ModelSelection & {
    label: string;
    channelLabel: string;
    modelId: string;
    thinkingMode: ThinkingMode;
    available: boolean;
    /** 该模型是否支持思考预算（前端据此决定档位是否可点）。 */
    budgetSupported: boolean;
    /** 当前选择下**真实生效**的思考上限；`null` 表示这一次不发送该参数。 */
    effectiveBudgetTokens: number | null;
    measured?: string;
  };
  budgetLevels: typeof BUDGET_LEVELS;
  defaultOptionId: string;
}

export function getModelCatalog(): CatalogView {
  const option = optionById(selection.optionId)!;
  return {
    options: CATALOG.map((item) => ({ ...item, available: channelReady(item.channel), defaultOption: item.id === DEFAULT_OPTION_ID })),
    active: {
      ...selection,
      label: option.label,
      channelLabel: option.channelLabel,
      modelId: option.modelId,
      thinkingMode: option.thinking,
      available: channelReady(option.channel),
      budgetSupported: option.budget === 'verified',
      effectiveBudgetTokens: effectiveBudgetTokens(option, selection) ?? null,
      ...(option.measured ? { measured: option.measured } : {}),
    },
    budgetLevels: BUDGET_LEVELS,
    defaultOptionId: DEFAULT_OPTION_ID,
  };
}

export type ApplySelectionResult =
  | { ok: true; active: CatalogView['active'] }
  | { ok: false; code: 'UNKNOWN_MODEL' | 'CHANNEL_NOT_CONFIGURED'; message: string };

/**
 * 应用模型选择。`thinking` / `budget` 只在模型真实支持时生效，不支持的会被规范化到真实值，
 * 因此返回的 active 始终等于实际会发送给 API 的语义（不会出现 UI 与请求不一致的假切换）。
 */
export function applyModelSelection(
  optionId: string,
  thinking?: boolean,
  budget?: ThinkingBudgetLevel,
): ApplySelectionResult {
  const option = optionById(optionId);
  if (!option) return { ok: false, code: 'UNKNOWN_MODEL', message: `未知模型：${optionId}` };
  if (!channelReady(option.channel)) {
    return { ok: false, code: 'CHANNEL_NOT_CONFIGURED', message: `${option.channelLabel}通道未配置 API Key，该模型不可用` };
  }
  selection.optionId = option.id;
  if (option.thinking === 'toggle') {
    selection.thinking = typeof thinking === 'boolean' ? thinking : option.defaultThinking;
  } else {
    selection.thinking = option.thinking === 'always';
  }
  selection.budget = normalizeBudget(option, budget);
  return { ok: true, active: getModelCatalog().active };
}

export function getActiveOption(): ModelOption {
  return optionById(selection.optionId)!;
}

export function getActiveSelection(): ModelSelection {
  return { ...selection };
}

export function normalizeSelectionForOption(option: ModelOption, input?: Partial<ModelSelection>): FrozenModelSelection {
  const thinking = option.thinking === 'toggle'
    ? (typeof input?.thinking === 'boolean' ? input.thinking : option.defaultThinking)
    : option.thinking === 'always';
  return Object.freeze({
    optionId: option.id,
    thinking,
    budget: normalizeBudget(option, input?.budget),
  });
}

/** Resolve a directory id to an immutable selection without mutating the UI-active model. */
export function freezeSelection(optionId: string, fallback?: FrozenModelSelection): FrozenModelSelection {
  const option = optionById(optionId);
  if (!option || !channelReady(option.channel)) {
    if (fallback) return fallback;
    const active = getActiveOption();
    return normalizeSelectionForOption(active, selection);
  }
  return normalizeSelectionForOption(option);
}

export interface RunModelRequest {
  optionId: string;
  thinking?: boolean;
  budget?: ThinkingBudgetLevel;
}

function requestedClinicalSelection(request?: RunModelRequest): FrozenModelSelection {
  if (!request) {
    const active = getActiveOption();
    return normalizeSelectionForOption(active, selection);
  }
  const option = optionById(request.optionId);
  if (!option) throw new Error(`requested clinical model is unknown: ${request.optionId}`);
  if (!channelReady(option.channel)) throw new Error(`requested clinical model channel is unavailable: ${request.optionId}`);
  return normalizeSelectionForOption(option, {
    optionId: option.id,
    thinking: request.thinking,
    budget: request.budget,
  });
}

function controlSelection(clinical: FrozenModelSelection): {
  selection: FrozenModelSelection;
  fallbackReason?: ModelExecutionReceipt['controlFallbackReason'];
} {
  const requested = config.llm.controlModelId.trim();
  const option = optionById(requested);
  if (!option) return { selection: clinical, fallbackReason: 'UNKNOWN_MODEL' };
  if (!channelReady(option.channel)) return { selection: clinical, fallbackReason: 'CHANNEL_NOT_CONFIGURED' };
  return { selection: normalizeSelectionForOption(option) };
}

/**
 * Capture the complete model execution truth for one run.
 *
 * Invariant: the caller may pass the exact clinical selection in the run request. After this receipt
 * exists, process-global UI changes cannot affect any call in the run. Control and clinical roles are
 * deliberately separate so a clinical-model A/B does not silently replace Understanding / Compiler /
 * Planner at the same time.
 */
export function snapshotModelExecution(request?: RunModelRequest): ModelExecutionReceipt {
  const clinical = requestedClinicalSelection(request);
  const controlResolved = controlSelection(clinical);
  const control = controlResolved.selection;
  return Object.freeze({
    clinical,
    control,
    requestedClinicalOptionId: request?.optionId ?? clinical.optionId,
    requestedControlOptionId: config.llm.controlModelId.trim(),
    ...(controlResolved.fallbackReason ? { controlFallbackReason: controlResolved.fallbackReason } : {}),
    clinicalProfile: modelProfileForSelection('clinical', clinical),
    controlProfile: modelProfileForSelection('control', control),
    key: `clinical=${clinical.optionId}:${clinical.thinking ? '1' : '0'}:${clinical.budget}|control=${control.optionId}:${control.thinking ? '1' : '0'}:${control.budget}`,
  });
}

export function modelProfileForSelection(prefix: string, frozen: FrozenModelSelection): ModelProfile {
  const option = optionById(frozen.optionId);
  if (!option) throw new Error(`unknown frozen model option: ${frozen.optionId}`);
  return { id: `${prefix}:${option.id}`, provider: option.channel, model: option.modelId };
}

/** Trace 快照用的模型身份。`model` 字段是真实发给 API 的 model 名。 */
export function getActiveModelProfile(prefix: string): ModelProfile {
  const option = getActiveOption();
  return { id: `${prefix}:${option.id}`, provider: option.channel, model: option.modelId };
}

/** 活动模型的展示名（SSE meta / 健康探针）。 */
export function describeActiveModel(): string {
  const option = getActiveOption();
  const thinkingSuffix = option.thinking === 'toggle' ? `｜推理${selection.thinking ? '开' : '关'}` : '';
  const tokens = effectiveBudgetTokens(option, selection);
  const budgetSuffix = tokens === undefined ? '' : `｜预算${tokens}`;
  return `${option.channelLabel}/${option.modelId}${thinkingSuffix}${budgetSuffix}`;
}

const modelCache = new Map<string, LanguageModel>();

/**
 * Resolve one frozen model selection. New run execution must pass an immutable run receipt;
 * process-global UI selection is only a convenience default for the *next* run.
 *
 * 参数注入（两者都是阿里云百炼的非 OpenAI 标准参数，经 `transformRequestBody` 透传）：
 * - `enable_thinking` 只在 `thinking==='toggle'` 时注入：`always`/`none` 发送无意义，
 *   其中 glm-5.3 / MiniMax-M2.5 实测发送 `false` 会直接 400。
 * - `thinking_budget` 只在**实测生效**（`budget==='verified'`）且推理已开启且档位非 `off` 时注入；
 *   实测被忽略的模型（DeepSeek 官方、glm 系、deepseek-v4.1-flash 等）一律不发送，
 *   避免出现「档位可调但请求里根本没有这个参数」的假开关。
 */
export function resolveLanguageModelFor(frozen: FrozenModelSelection): LanguageModel {
  const option = optionById(frozen.optionId);
  if (!option) throw new Error(`unknown frozen model option: ${frozen.optionId}`);
  const sendsThinking = option.thinking === 'toggle';
  const budgetTokens = effectiveBudgetTokens(option, frozen);
  const cacheKey = `${option.channel}|${option.modelId}|${sendsThinking ? (frozen.thinking ? 'on' : 'off') : 'na'}|${budgetTokens ?? 'na'}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  const credentials = option.channel === 'official'
    ? { baseURL: config.llm.baseURL, apiKey: config.llm.apiKey }
    : { baseURL: config.llm.aliyun.baseURL, apiKey: config.llm.aliyun.apiKey };

  const needsBodyTransform = sendsThinking || budgetTokens !== undefined;
  const provider = createOpenAICompatible({
    name: option.channel,
    baseURL: credentials.baseURL,
    apiKey: credentials.apiKey,
    ...(needsBodyTransform
      ? {
          transformRequestBody: (body: Record<string, unknown>) => {
            const next: Record<string, unknown> = { ...body };
            if (sendsThinking) next.enable_thinking = frozen.thinking;
            if (budgetTokens !== undefined) next.thinking_budget = budgetTokens;
            return next;
          },
        }
      : {}),
  });
  const model = provider(option.modelId);
  modelCache.set(cacheKey, model);
  return model;
}

/** UI/legacy helper. New run execution should snapshot first and call resolveLanguageModelFor(). */
export function resolveLanguageModel(): LanguageModel {
  return resolveLanguageModelFor(snapshotModelExecution().clinical);
}
