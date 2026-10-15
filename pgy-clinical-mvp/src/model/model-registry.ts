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
 * 通道策略（2026-10 基准实测后收敛）：
 * - 默认走 DeepSeek 官方；目录只保留官方 + 阿里云百炼·千问系列（其余源实测明显更慢，剔除）；
 * - 官方通道熔断（5xx / 网络故障 / 超时等通道级失败）时，clinical/control 在 run 快照阶段
 *   自动切到 `aliyun:qwen3.8-flash`（全目录实测综合响应最快的兜底），冷却期后半开重试官方。
 *
 * 边界：
 * - 本模块只决定「用哪个模型 / 是否发送思考开关 / 通道是否熔断」这一事实，不做任何临床判断；
 * - 目录内每个模型的 thinking 语义都来自实测（见 thinking 字段注释），不靠文档推断，
 *   避免出现「点了没反应」或「发送参数直接 400」的死开关。
 */

export type ModelChannel = 'official' | 'aliyun';

/**
 * 推理开关的实际可用性（实测三态，决定前端开关是否可点、以及是否发送思考开关参数）：
 * - `toggle`：可开关思考。参数形态随通道方言（见 thinkingParamFor）：
 *   百炼用 `enable_thinking`，火山方舟 / DeepSeek 官方用 `thinking.type`。部分模型默认开（可关），部分默认关（可开）。
 * - `always`：总是思考，前端开关置灰。**绝不发送该参数**——部分模型实测发送关闭值会直接返回 HTTP 400。
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
  // ---- DeepSeek 官方（默认通道） ----
  // 官方通道实测忽略 enable_thinking，自然也不会应用 thinking_budget。
  { id: 'official:deepseek-chat', label: 'deepseek-chat', channel: 'official', modelId: 'deepseek-chat', thinking: 'none', defaultThinking: false, budget: 'ignored', measured: '实测 107ms · 非推理，全局最快基线' },
  { id: 'official:deepseek-flash', label: 'deepseek-flash', channel: 'official', modelId: 'deepseek-flash', thinking: 'always', defaultThinking: true, budget: 'ignored', measured: '思考型；官方忽略开关，无法关闭' },
  { id: 'official:deepseek-v4-pro', label: 'deepseek-v4-pro', channel: 'official', modelId: 'deepseek-v4-pro', thinking: 'always', defaultThinking: true, budget: 'ignored', measured: '思考型；官方忽略开关，无法关闭' },

  // ---- 阿里云百炼 · 千问（兜底通道，实测支持思考预算） ----
  { id: 'aliyun:qwen3.8-max', label: 'qwen3.8-max', channel: 'aliyun', modelId: 'qwen3.8-max', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 206s（思考 7258 tok）→ 预算256 降至 37.8s' },
  { id: 'aliyun:qwen3.8-flash', label: 'qwen3.8-flash', channel: 'aliyun', modelId: 'qwen3.8-flash', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '官方故障兜底模型；推理任务实测 89s（思考 5880 tok）→ 预算256 降至 18.5s' },
  { id: 'aliyun:qwen3.7-plus', label: 'qwen3.7-plus', channel: 'aliyun', modelId: 'qwen3.7-plus', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 40.9s（思考 2732 tok）→ 预算256 降至 13.1s' },
  { id: 'aliyun:qwen3.7-max', label: 'qwen3.7-max', channel: 'aliyun', modelId: 'qwen3.7-max', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 70s（思考 5095 tok）→ 预算256 降至 10.2s' },
  { id: 'aliyun:qwen3.6-plus', label: 'qwen3.6-plus', channel: 'aliyun', modelId: 'qwen3.6-plus', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '推理任务实测 80s（思考 4110 tok）→ 预算256 降至 14.0s' },
  { id: 'aliyun:qwen3.6-flash', label: 'qwen3.6-flash', channel: 'aliyun', modelId: 'qwen3.6-flash', thinking: 'toggle', defaultThinking: true, budget: 'verified', measured: '默认知 7.7s / 关推理 ~0.3s；预算256 实测 4.7s→1.7s' },
] satisfies ModelOptionSeed[]).map((option) => ({ ...option, channelLabel: CHANNEL_LABEL[option.channel] }));

const DEFAULT_OPTION_ID = 'official:deepseek-chat';
export const OFFICIAL_FALLBACK_OPTION_ID = 'aliyun:qwen3.8-flash';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerConfig {
  /** 触发熔断的连续失败次数阈值 */
  failureThreshold: number;
  /** 熔断后冷却时间 (毫秒)，冷却期后转为 HALF_OPEN 尝试探测 */
  cooldownMs: number;
}

const officialCircuitBreaker = {
  state: 'CLOSED' as CircuitBreakerState,
  failures: 0,
  lastFailureTime: 0,
  config: {
    failureThreshold: 2,
    cooldownMs: 30_000,
  },
};

/** 查询官方通道熔断器当前状态 */
export function getOfficialCircuitBreakerStatus(): {
  state: CircuitBreakerState;
  failures: number;
  lastFailureTime: number;
} {
  if (officialCircuitBreaker.state === 'OPEN') {
    const elapsed = Date.now() - officialCircuitBreaker.lastFailureTime;
    if (elapsed >= officialCircuitBreaker.config.cooldownMs) {
      officialCircuitBreaker.state = 'HALF_OPEN';
    }
  }
  return {
    state: officialCircuitBreaker.state,
    failures: officialCircuitBreaker.failures,
    lastFailureTime: officialCircuitBreaker.lastFailureTime,
  };
}

/** 记录官方通道调用失败，满足阈值时切为 OPEN */
export function recordOfficialChannelFailure(): void {
  officialCircuitBreaker.failures += 1;
  officialCircuitBreaker.lastFailureTime = Date.now();
  if (officialCircuitBreaker.failures >= officialCircuitBreaker.config.failureThreshold) {
    officialCircuitBreaker.state = 'OPEN';
  }
}

/** 记录官方通道调用成功，恢复 CLOSED */
export function recordOfficialChannelSuccess(): void {
  officialCircuitBreaker.state = 'CLOSED';
  officialCircuitBreaker.failures = 0;
  officialCircuitBreaker.lastFailureTime = 0;
}

/** 重置熔断器（供测试或管理） */
export function resetOfficialCircuitBreaker(): void {
  recordOfficialChannelSuccess();
}

/** 手动触发熔断（供测试或运维） */
export function tripOfficialCircuitBreaker(): void {
  officialCircuitBreaker.state = 'OPEN';
  officialCircuitBreaker.failures = officialCircuitBreaker.config.failureThreshold;
  officialCircuitBreaker.lastFailureTime = Date.now();
}

/**
 * 官方通道「活挂」超时保护。
 *
 * 官方接口的真实故障形态可能是：HTTP 200 秒回，但只发 SSE keep-alive 心跳、永不产出内容。
 * 此时 `doGenerate` 的 Promise 永不 settle、永不抛错 —— 错误驱动的熔断器永远等不到故障信号，
 * 兜底自然不触发（表现为请求无限卡住）。该超时把「活挂」转为 `ChannelHangTimeoutError`
 * （isChannelCrashError 判定为通道级故障），从而记录失败并透明切换到阿里兜底通道。
 *
 * 默认 60s：非流式 doGenerate 无法区分「服务器在思考」与「活挂」，race 的是整个调用时长；
 * 正常临床长调用可达 30-60s，取 30s 会误杀慢调用并把官方错误熔断。可经 LLM_OFFICIAL_TIMEOUT_MS 调整。
 */
let officialHangTimeoutMs = Number.parseInt(process.env.LLM_OFFICIAL_TIMEOUT_MS ?? '', 10) || 60_000;

/** 覆盖官方通道活挂超时（测试注入用）。 */
export function setOfficialHangTimeoutMsForTests(ms: number): void {
  officialHangTimeoutMs = ms;
}

/** 官方通道活挂超时错误：必须被 isChannelCrashError 判定为通道级故障（而非用户取消）。 */
export class ChannelHangTimeoutError extends Error {
  constructor(ms: number) {
    super(`channel hang timeout: official channel produced no result within ${ms}ms`);
    this.name = 'ChannelHangTimeoutError';
  }
}

/**
 * 给底层模型调用加活挂超时：
 * - 注入合并后的 AbortSignal（用户取消信号 + 超时信号），超时时同步 abort 底层请求，避免连接悬挂；
 * - 超时以 `ChannelHangTimeoutError` 拒绝（可触发熔断）；用户主动取消仍以原始 AbortError 形态抛出（不触发熔断）。
 */
async function callWithHangTimeout(
  orig: (...args: unknown[]) => Promise<unknown>,
  target: object,
  args: unknown[],
): Promise<unknown> {
  const options = { ...((args[0] as Record<string, unknown> | undefined) ?? {}) };
  const userSignal = options.abortSignal as AbortSignal | undefined;
  const controller = new AbortController();
  options.abortSignal = controller.signal;

  const forwardUserAbort = () => controller.abort(userSignal?.reason);
  if (userSignal?.aborted) forwardUserAbort();
  else userSignal?.addEventListener('abort', forwardUserAbort, { once: true });

  let rejectOnTimeout: ((err: ChannelHangTimeoutError) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectOnTimeout = reject;
  });
  const timer = setTimeout(() => {
    const err = new ChannelHangTimeoutError(officialHangTimeoutMs);
    controller.abort(err);
    rejectOnTimeout?.(err);
  }, officialHangTimeoutMs);

  try {
    return await Promise.race([orig.apply(target, [options]), timeoutPromise]);
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', forwardUserAbort);
  }
}

/** 判断错误是否属于通道级崩溃（网络故障、5xx、超时等），非用户主动取消或参数校验错误 */
export function isChannelCrashError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = (err as Error).message || '';
  const name = (err as Error).name || '';
  if (name === 'AbortError' || msg.includes('aborted')) return false;
  if (name === 'ChannelHangTimeoutError') return true;

  const status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 500) return true;

  const code = (err as { code?: string }).code;
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }
  if (/fetch failed|timeout|network|socket hang up|connection refused|gateway timeout|service unavailable/i.test(msg)) {
    return true;
  }
  return false;
}

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
  /** Present only when the requested clinical model fell back due to circuit breaker or unavailability. */
  clinicalFallbackReason?: 'CIRCUIT_BREAKER_OPEN' | 'CHANNEL_NOT_CONFIGURED';
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
  if (channel === 'official') return config.llm.apiKey.trim().length > 0;
  return config.llm.aliyun.apiKey.trim().length > 0;
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
  fallbackOptionId: string;
  circuitBreaker: ReturnType<typeof getOfficialCircuitBreakerStatus>;
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
    fallbackOptionId: OFFICIAL_FALLBACK_OPTION_ID,
    circuitBreaker: getOfficialCircuitBreakerStatus(),
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

function requestedClinicalSelection(request?: RunModelRequest): {
  selection: FrozenModelSelection;
  fallbackReason?: ModelExecutionReceipt['clinicalFallbackReason'];
} {
  const targetOptionId = request?.optionId ?? selection.optionId;
  const targetOption = optionById(targetOptionId);
  if (!targetOption) throw new Error(`requested clinical model is unknown: ${targetOptionId}`);

  const isOfficial = targetOption.channel === 'official';
  const breaker = getOfficialCircuitBreakerStatus();
  const isBreakerOpen = isOfficial && breaker.state === 'OPEN';
  const isChannelMissingKey = !channelReady(targetOption.channel);

  const reqThinking = request ? request.thinking : selection.thinking;
  const reqBudget = request ? request.budget : selection.budget;

  if (isBreakerOpen || (isOfficial && isChannelMissingKey)) {
    const fallbackOption = optionById(OFFICIAL_FALLBACK_OPTION_ID);
    if (fallbackOption && channelReady(fallbackOption.channel)) {
      return {
        selection: normalizeSelectionForOption(fallbackOption, {
          thinking: reqThinking,
          // 兜底的价值在「快速恢复可用」：不限预算的思考在大 prompt 下可超活挂超时，
          // 会被误杀导致双通道同时判死。官方请求的 budget 档位对其无意义（官方 budget=ignored）。
          budget: 'low',
        }),
        fallbackReason: isBreakerOpen ? 'CIRCUIT_BREAKER_OPEN' : 'CHANNEL_NOT_CONFIGURED',
      };
    }
  }

  if (isChannelMissingKey) throw new Error(`requested clinical model channel is unavailable: ${targetOptionId}`);

  return {
    selection: normalizeSelectionForOption(targetOption, {
      optionId: targetOption.id,
      thinking: reqThinking,
      budget: reqBudget,
    }),
  };
}

function controlSelection(clinical: FrozenModelSelection): {
  selection: FrozenModelSelection;
  fallbackReason?: ModelExecutionReceipt['controlFallbackReason'];
} {
  const requested = config.llm.controlModelId.trim();
  const option = optionById(requested);
  if (!option) return { selection: clinical, fallbackReason: 'UNKNOWN_MODEL' };
  if (!channelReady(option.channel)) return { selection: clinical, fallbackReason: 'CHANNEL_NOT_CONFIGURED' };

  if (option.channel === 'official' && getOfficialCircuitBreakerStatus().state === 'OPEN') {
    return { selection: clinical, fallbackReason: 'CHANNEL_NOT_CONFIGURED' };
  }

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
  const clinicalResolved = requestedClinicalSelection(request);
  const clinical = clinicalResolved.selection;
  const controlResolved = controlSelection(clinical);
  const control = controlResolved.selection;
  return Object.freeze({
    clinical,
    control,
    requestedClinicalOptionId: request?.optionId ?? getActiveOption().id,
    requestedControlOptionId: config.llm.controlModelId.trim(),
    ...(clinicalResolved.fallbackReason ? { clinicalFallbackReason: clinicalResolved.fallbackReason } : {}),
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
 * 思考开关的参数形态按通道方言区分（同一语义，字段不同，混用会 400）：
 * - 阿里云百炼：`enable_thinking: boolean`
 * - 火山方舟 / DeepSeek 官方：`thinking: { type: 'enabled' | 'disabled' }`
 * 仅在 `thinking==='toggle'` 时经 `transformRequestBody` 注入；`always`/`none` 一律不发送。
 */
function thinkingParamFor(channel: ModelChannel, thinking: boolean): Record<string, unknown> {
  return channel === 'aliyun'
    ? { enable_thinking: thinking }
    : { thinking: { type: thinking ? 'enabled' : 'disabled' } };
}

/**
 * 包装官方通道模型：活挂超时 + 熔断 + 透明兜底。
 * - 熔断 OPEN 期间不再等待故障通道（否则一次 run 内每次 LLM 调用都白等超时），直接快速兜底；
 *   冷却结束转 HALF_OPEN 后自动恢复对官方的探测。
 * - 运行时调用（doGenerate/doStream）一旦超时或通道崩溃，记录失败并改由 fallbackFactory 提供的
 *   兜底模型重试同一请求；用户主动取消（AbortError）原样抛出，不记失败不兜底。
 * - 注意：doStream 的超时只保护到响应建立（运行时全部走 generateText/doGenerate，
 *   不存在流式中途活挂路径）。
 */
export function wrapLanguageModelWithBreaker(baseModel: LanguageModel, fallbackFactory: () => LanguageModel): LanguageModel {
  const invokeFallback = (method: 'doGenerate' | 'doStream', args: unknown[]): Promise<unknown> => {
    const fallback = fallbackFactory() as Record<string, unknown>;
    const fn = fallback[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof fn !== 'function') throw new Error(`fallback model has no ${method}`);
    // 兜底通道同样可能活挂：不加保护时双通道同挂会把 run 拖满上层总超时（180s/360s）才报错。
    return callWithHangTimeout(fn, fallback, args);
  };
  return new Proxy(baseModel as object, {
    get(target, prop, receiver) {
      if (prop === 'doGenerate' || prop === 'doStream') {
        const orig = Reflect.get(target, prop, receiver) as ((...args: unknown[]) => Promise<unknown>) | undefined;
        if (typeof orig !== 'function') return orig;
        return async (...args: unknown[]) => {
          // 熔断 OPEN：通道已被判定崩溃，立即兜底，不再等官方（含活挂超时）
          if (getOfficialCircuitBreakerStatus().state === 'OPEN') {
            return await invokeFallback(prop, args);
          }
          try {
            const res = await callWithHangTimeout(orig, target, args);
            recordOfficialChannelSuccess();
            return res;
          } catch (err) {
            if (isChannelCrashError(err)) {
              recordOfficialChannelFailure();
              try {
                return await invokeFallback(prop, args);
              } catch {
                // 兜底若失败则抛出原错误
              }
            }
            throw err;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as LanguageModel;
}

/**
 * Resolve one frozen model selection. New run execution must pass an immutable run receipt;
 * process-global UI selection is only a convenience default for the *next* run.
 *
 * 参数注入（非 OpenAI 标准参数，经 `transformRequestBody` 透传；形态随通道方言，见 `thinkingParamFor`）：
 * - 思考开关只在 `thinking==='toggle'` 时注入：`always`/`none` 发送无意义，
 *   其中 glm-5.3 / MiniMax-M2.5 实测发送 `false` 会直接 400，故一律不发送。
 * - `thinking_budget`（仅阿里云）只在**实测生效**（`budget==='verified'`）且推理已开启且档位非 `off` 时注入；
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
            if (sendsThinking) Object.assign(next, thinkingParamFor(option.channel, frozen.thinking));
            if (budgetTokens !== undefined) next.thinking_budget = budgetTokens;
            return next;
          },
        }
      : {}),
  });
  const rawModel = provider(option.modelId);
  const model = option.channel === 'official' && channelReady('aliyun')
    ? wrapLanguageModelWithBreaker(rawModel, () => resolveLanguageModelFor(
        normalizeSelectionForOption(optionById(OFFICIAL_FALLBACK_OPTION_ID)!, { budget: 'low' }),
      ))
    : rawModel;
  modelCache.set(cacheKey, model);
  return model;
}

/** UI/legacy helper. New run execution should snapshot first and call resolveLanguageModelFor(). */
export function resolveLanguageModel(): LanguageModel {
  return resolveLanguageModelFor(snapshotModelExecution().clinical);
}
