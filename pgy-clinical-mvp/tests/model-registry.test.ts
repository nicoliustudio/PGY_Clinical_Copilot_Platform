import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyModelSelection,
  describeActiveModel,
  getActiveModelProfile,
  getModelCatalog,
  resolveLanguageModel,
  snapshotModelExecution,
  getOfficialCircuitBreakerStatus,
  recordOfficialChannelFailure,
  resetOfficialCircuitBreaker,
  tripOfficialCircuitBreaker,
  isChannelCrashError,
  wrapLanguageModelWithBreaker,
  setOfficialHangTimeoutMsForTests,
  ChannelHangTimeoutError,
  OFFICIAL_FALLBACK_OPTION_ID,
  BUDGET_LEVELS,
  BUDGET_TOKENS,
} from '../src/model/model-registry.js';

/**
 * 模型目录 / 推理开关契约测试（不联网，只验证确定性语义）。
 *
 * 这些不变量直接决定前端控件是不是「死按钮」或「假切换」：
 * - 目录 id 稳定且唯一（前端 value 依赖它）；
 * - `always` / `none` 模型的 thinking 必须被规范化，不能把 UI 的开关状态当成真实语义；
 * - 未知模型必须被拒绝，不能静默接受。
 *
 * 注意：真实的 `enable_thinking` 注入与 400 规避需要真实通道，不在单测中覆盖；
 * 目录里每个模型的 `thinking` 分类来自实测（见 model-registry.ts 注释）。
 */

/** 把全局选择恢复到官方基线，避免用例之间互相污染（选择是进程级单例）。 */
function resetToBaseline(): void {
  const applied = applyModelSelection('official:deepseek-chat');
  assert.equal(applied.ok, true);
}

function optionById(id: string) {
  return getModelCatalog().options.find((option) => option.id === id);
}

test('model catalog: id 唯一、分组为官方 + 阿里两通道、label 与 API model 名一致', () => {
  const catalog = getModelCatalog();
  const ids = catalog.options.map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  assert.deepEqual([...new Set(catalog.options.map((option) => option.channelLabel))], ['DeepSeek 官方', '阿里云百炼']);
  for (const option of catalog.options) {
    assert.equal(option.id, `${option.channel}:${option.modelId}`, `id 必须由 channel + modelId 组成：${option.id}`);
    assert.equal(option.label, option.modelId);
  }
  assert.equal(catalog.options.length, 9, `目录应严格只保留官方3+千问6共9个模型，实际 ${catalog.options.length}`);
});

test('model catalog: thinking 三态与开关可用性一致，且 always 不依赖默认开关值', () => {
  for (const option of getModelCatalog().options) {
    assert.ok(['toggle', 'always', 'none'].includes(option.thinking), `${option.id} thinking 非法`);
    if (option.thinking === 'toggle') continue;
    // always / none 模型没有「可开关」语义，默认值只作为展示兜底。
    assert.equal(typeof option.defaultThinking, 'boolean');
  }
  assert.equal(optionById('official:deepseek-chat')?.thinking, 'none');
  assert.equal(optionById('official:deepseek-flash')?.thinking, 'always');
  assert.equal(optionById('official:deepseek-v4-pro')?.thinking, 'always');
  assert.equal(optionById('aliyun:qwen3.8-max')?.thinking, 'toggle');
  assert.equal(optionById('aliyun:qwen3.8-flash')?.thinking, 'toggle');
  assert.equal(optionById('aliyun:qwen3.6-flash')?.thinking, 'toggle');
});

test('model selection: 未知模型被拒绝（不静默接受）', () => {
  const before = getModelCatalog().active.optionId;
  const applied = applyModelSelection('aliyun:not-a-real-model');
  assert.equal(applied.ok, false);
  if (!applied.ok) assert.equal(applied.code, 'UNKNOWN_MODEL');
  assert.equal(getModelCatalog().active.optionId, before, '失败的选择不得改变活动模型');
});

test('model selection: 非推理模型（none）忽略请求中的开关值', () => {
  const applied = applyModelSelection('official:deepseek-chat', true);
  assert.equal(applied.ok, true);
  const catalog = getModelCatalog();
  assert.equal(catalog.active.thinkingMode, 'none');
  assert.equal(catalog.active.thinking, false, '非推理模型不得被标记为「思考中」');
});

test('model selection: 可开关模型保留用户选择，未指定时采用模型默认值', () => {
  const aliyunReady = optionById('aliyun:qwen3.6-flash')?.available;
  const toggleOption = optionById('aliyun:qwen3.6-flash');
  if (!aliyunReady) {
    // 未配置阿里通道时不产生假阳性：跳过但显式断言官方路径仍可用。
    assert.equal(applyModelSelection('official:deepseek-chat').ok, true);
    return;
  }
  assert.equal(applyModelSelection('aliyun:qwen3.6-flash', false).ok, true);
  assert.equal(getModelCatalog().active.thinking, false);
  assert.equal(applyModelSelection('aliyun:qwen3.6-flash', true).ok, true);
  assert.equal(getModelCatalog().active.thinking, true);
  // 不传 thinking：采用该模型自身的默认值，而不是沿用上一个模型的状态。
  assert.equal(applyModelSelection('aliyun:qwen3.6-flash').ok, true);
  assert.equal(getModelCatalog().active.thinking, toggleOption?.defaultThinking);
});

test('model selection: 仅思考模型（always）的开关值被规范化为 true', () => {
  assert.equal(applyModelSelection('official:deepseek-flash', false).ok, true);
  const catalog = getModelCatalog();
  assert.equal(catalog.active.thinkingMode, 'always');
  assert.equal(catalog.active.thinking, true, 'always 模型不得被关掉');
  resetToBaseline();
});

test('model identity: modelProfile 使用真实 API model 名，描述区分推理状态', () => {
  resetToBaseline();
  const profile = getActiveModelProfile('clinical-primary:harness');
  assert.equal(profile.id, 'clinical-primary:harness:official:deepseek-chat');
  assert.equal(profile.provider, 'official');
  assert.equal(profile.model, 'deepseek-chat');
  assert.equal(describeActiveModel(), 'DeepSeek 官方/deepseek-chat', '非可开关模型不显示推理后缀');

  if (optionById('aliyun:qwen3.6-flash')?.available) {
    applyModelSelection('aliyun:qwen3.6-flash', false);
    assert.equal(describeActiveModel(), '阿里云百炼/qwen3.6-flash｜推理关');
    applyModelSelection('aliyun:qwen3.6-flash', true);
    assert.equal(describeActiveModel(), '阿里云百炼/qwen3.6-flash｜推理开');
  }
  resetToBaseline();
});

test('model resolution: 同一选择复用实例，切换后解析到不同实例', () => {
  resetToBaseline();
  const first = resolveLanguageModel();
  const again = resolveLanguageModel();
  assert.equal(first, again, '同一 (channel, model, thinking) 组合应复用实例');

  if (optionById('aliyun:qwen3.6-flash')?.available) {
    applyModelSelection('aliyun:qwen3.6-flash', false);
    assert.notEqual(resolveLanguageModel(), first, '切换模型后必须解析到新的模型实例');
  }
  resetToBaseline();
});

/* ---------- 思考预算（thinking_budget） ---------- */

test('budget: 档位定义完整且 token 上限单调递增', () => {
  assert.deepEqual(BUDGET_LEVELS.map((level) => level.value), ['off', 'low', 'mid', 'high']);
  assert.equal(BUDGET_LEVELS[0].tokens, null, 'off 不发送参数');
  assert.ok(BUDGET_TOKENS.low < BUDGET_TOKENS.mid && BUDGET_TOKENS.mid < BUDGET_TOKENS.high);
});

test('budget: 实测忽略该参数的模型一律规范化为 off（不保留无效档位）', () => {
  resetToBaseline();
  const ignored = getModelCatalog().options.find((option) => option.budget === 'ignored' && option.available);
  assert.ok(ignored, '目录应至少有一个实测忽略思考预算的可用模型');
  const applied = applyModelSelection(ignored!.id, undefined, 'high');
  assert.equal(applied.ok, true);
  const active = getModelCatalog().active;
  assert.equal(active.budgetSupported, false);
  assert.equal(active.budget, 'off', '不支持的模型不得保留一个不会生效的档位');
  assert.equal(active.effectiveBudgetTokens, null, '不支持的模型不得声称会发送预算');
  resetToBaseline();
});

test('budget: 推理关闭时不发送预算（避免无意义的截断）', () => {
  const option = getModelCatalog().options.find((o) => o.budget === 'verified' && o.thinking === 'toggle' && o.available);
  if (!option) return; // 未配置阿里通道时不产生假阳性
  assert.equal(applyModelSelection(option.id, false, 'low').ok, true);
  const active = getModelCatalog().active;
  assert.equal(active.budgetSupported, true);
  assert.equal(active.effectiveBudgetTokens, null, '没有思考过程时不得发送 thinking_budget');
  assert.equal(active.budget, 'low', '档位本身应被记住，开启推理后即可生效');
});

test('budget: 支持且推理开启时，展示的 tokens 等于真实会发送的值', () => {
  const option = getModelCatalog().options.find((o) => o.budget === 'verified' && o.thinking === 'toggle' && o.available);
  if (!option) return;
  for (const level of ['low', 'mid', 'high'] as const) {
    assert.equal(applyModelSelection(option.id, true, level).ok, true);
    const active = getModelCatalog().active;
    assert.equal(active.budget, level);
    assert.equal(active.effectiveBudgetTokens, BUDGET_TOKENS[level], `${level} 的生效值必须与档位定义一致`);
    assert.ok(describeActiveModel().endsWith(`｜预算${BUDGET_TOKENS[level]}`), '描述必须反映真实发送的预算');
  }
  // 回到 off：不发送该参数
  assert.equal(applyModelSelection(option.id, true, 'off').ok, true);
  assert.equal(getModelCatalog().active.effectiveBudgetTokens, null);
  resetToBaseline();
});

test('budget: 换模型不携带档位时重置为 off（不把上一个模型的预算带过去）', () => {
  const option = getModelCatalog().options.find((o) => o.budget === 'verified' && o.thinking === 'toggle' && o.available);
  if (!option) return;
  assert.equal(applyModelSelection(option.id, true, 'high').ok, true);
  assert.equal(getModelCatalog().active.effectiveBudgetTokens, BUDGET_TOKENS.high);
  assert.equal(applyModelSelection(option.id, true).ok, true);
  assert.equal(getModelCatalog().active.budget, 'off');
  resetToBaseline();
});

test('budget: 缓存键包含预算，改档位必须解析到新的模型实例', () => {
  const option = getModelCatalog().options.find((o) => o.budget === 'verified' && o.thinking === 'toggle' && o.available);
  if (!option) return;
  assert.equal(applyModelSelection(option.id, true, 'off').ok, true);
  const noBudget = resolveLanguageModel();
  assert.equal(applyModelSelection(option.id, true, 'low').ok, true);
  const lowBudget = resolveLanguageModel();
  assert.notEqual(lowBudget, noBudget, '预算变化必须产生新的 provider 实例，否则参数不会真正下发');
  assert.equal(applyModelSelection(option.id, true, 'low').ok, true);
  assert.equal(resolveLanguageModel(), lowBudget, '同一档位应复用实例');
  resetToBaseline();
});

/* ---------- 熔断机制与快速兜底 ---------- */

test('circuit breaker: 官方通道故障熔断后，快照自动快速降级为 qwen3.8-flash', () => {
  resetToBaseline();
  resetOfficialCircuitBreaker();
  assert.equal(getOfficialCircuitBreakerStatus().state, 'CLOSED');

  // 未熔断时，指定官方模型快照正常保持官方
  const normalReceipt = snapshotModelExecution({ optionId: 'official:deepseek-chat' });
  assert.equal(normalReceipt.clinical.optionId, 'official:deepseek-chat');
  assert.equal(normalReceipt.clinicalFallbackReason, undefined);

  // 模拟通道连续失败或主动熔断
  tripOfficialCircuitBreaker();
  assert.equal(getOfficialCircuitBreakerStatus().state, 'OPEN');

  // 熔断后，快照自动切为兜底模型 aliyun:qwen3.8-flash
  const fallbackReceipt = snapshotModelExecution({ optionId: 'official:deepseek-chat' });
  assert.equal(fallbackReceipt.clinical.optionId, OFFICIAL_FALLBACK_OPTION_ID);
  assert.equal(fallbackReceipt.clinicalFallbackReason, 'CIRCUIT_BREAKER_OPEN');
  assert.equal(fallbackReceipt.requestedClinicalOptionId, 'official:deepseek-chat');

  // 重置后恢复
  resetOfficialCircuitBreaker();
  assert.equal(getOfficialCircuitBreakerStatus().state, 'CLOSED');
  const restoredReceipt = snapshotModelExecution({ optionId: 'official:deepseek-chat' });
  assert.equal(restoredReceipt.clinical.optionId, 'official:deepseek-chat');
  assert.equal(restoredReceipt.clinicalFallbackReason, undefined);
  resetToBaseline();
});

test('circuit breaker: isChannelCrashError 能正确识别 5xx 与网络故障，排除用户主动取消', () => {
  assert.equal(isChannelCrashError(new Error('fetch failed')), true);
  assert.equal(isChannelCrashError({ statusCode: 503, message: 'Service Unavailable' }), true);
  assert.equal(isChannelCrashError({ code: 'ETIMEDOUT', message: 'connection timeout' }), true);
  assert.equal(isChannelCrashError({ code: 'ECONNRESET', message: 'socket hang up' }), true);

  // 正常客户端中断不判定为通道崩溃
  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';
  assert.equal(isChannelCrashError(abortErr), false);
  assert.equal(isChannelCrashError(new Error('aborted by user')), false);
  assert.equal(isChannelCrashError(new Error('Invalid JSON format in prompt')), false);
});

/* ---------- 官方通道「活挂」超时与运行时透明兜底 ---------- */

/** 测试替身转模型类型（避免与 SDK 的 LanguageModel 复杂签名纠缠）。 */
function toModel(obj: unknown): ReturnType<typeof wrapLanguageModelWithBreaker> {
  return obj as never;
}

test('hang timeout: doGenerate 活挂（200 后永不出内容）时超时转故障、记录熔断并透明兜底', async () => {
  resetOfficialCircuitBreaker();
  setOfficialHangTimeoutMsForTests(30);

  // 官方模型活挂：永不 settle（模拟 200 + keep-alive-only、无内容 token）
  let hungSignal: AbortSignal | undefined;
  const hungModel = {
    doGenerate: (options: { abortSignal?: AbortSignal } = {}) => {
      hungSignal = options.abortSignal;
      return new Promise(() => {});
    },
  };
  const fallbackResult = { from: 'fallback' };
  let fallbackCalls = 0;
  const fallbackModel = {
    doGenerate: () => {
      fallbackCalls += 1;
      return Promise.resolve(fallbackResult);
    },
  };
  const wrapped = wrapLanguageModelWithBreaker(toModel(hungModel), () => toModel(fallbackModel));
  const call = () => (wrapped as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();

  const startedAt = Date.now();
  const res = await call();
  assert.equal(res, fallbackResult, '活挂必须在超时时限内由兜底模型返回结果');
  assert.ok(Date.now() - startedAt < 5_000, '不能无限等待');
  assert.equal(fallbackCalls, 1);
  assert.ok(hungSignal?.aborted, '超时必须 abort 底层请求，避免连接永久悬挂');
  assert.equal(getOfficialCircuitBreakerStatus().failures, 1, '活挂必须记为通道失败');

  // 第二次活挂达到阈值，熔断 OPEN（此后快照期将直接快速降级为 qwen3.8-flash）
  await call();
  assert.equal(getOfficialCircuitBreakerStatus().state, 'OPEN');
  assert.equal(isChannelCrashError(new ChannelHangTimeoutError(1000)), true, '超时错误必须判定为通道级故障');

  setOfficialHangTimeoutMsForTests(30_000);
  resetOfficialCircuitBreaker();
});

test('hang timeout: doStream 活挂同样超时转故障并兜底', async () => {
  resetOfficialCircuitBreaker();
  setOfficialHangTimeoutMsForTests(30);
  const hungModel = { doStream: () => new Promise(() => {}) };
  const fallbackResult = { stream: 'ok' };
  const fallbackModel = { doStream: () => Promise.resolve(fallbackResult) };
  const wrapped = wrapLanguageModelWithBreaker(toModel(hungModel), () => toModel(fallbackModel));

  const res = await (wrapped as unknown as { doStream: () => Promise<unknown> }).doStream();
  assert.equal(res, fallbackResult);
  assert.equal(getOfficialCircuitBreakerStatus().failures, 1);

  setOfficialHangTimeoutMsForTests(30_000);
  resetOfficialCircuitBreaker();
});

test('hang timeout: 用户主动取消仍原样抛 AbortError，不记失败不兜底', async () => {
  resetOfficialCircuitBreaker();
  setOfficialHangTimeoutMsForTests(30);
  const userController = new AbortController();
  const pendingModel = {
    doGenerate: (options: { abortSignal?: AbortSignal } = {}) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  };
  let fallbackCalls = 0;
  const fallbackModel = {
    doGenerate: () => {
      fallbackCalls += 1;
      return Promise.resolve({});
    },
  };
  const wrapped = wrapLanguageModelWithBreaker(toModel(pendingModel), () => toModel(fallbackModel));

  const pending = (wrapped as unknown as { doGenerate: (o: unknown) => Promise<unknown> }).doGenerate({
    abortSignal: userController.signal,
  });
  userController.abort();
  await assert.rejects(pending, (err: unknown) => (err as Error).name === 'AbortError');
  assert.equal(fallbackCalls, 0, '用户取消不得触发兜底');
  assert.equal(getOfficialCircuitBreakerStatus().failures, 0, '用户取消不得记为通道失败');

  setOfficialHangTimeoutMsForTests(30_000);
  resetOfficialCircuitBreaker();
});

test('hang timeout: 正常完成的调用不受超时影响并记录成功', async () => {
  resetOfficialCircuitBreaker();
  setOfficialHangTimeoutMsForTests(50);
  const okResult = { ok: true };
  const okModel = { doGenerate: () => Promise.resolve(okResult) };
  const wrapped = wrapLanguageModelWithBreaker(toModel(okModel), () => {
    throw new Error('不应触发兜底');
  });

  const res = await (wrapped as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();
  assert.equal(res, okResult);
  assert.equal(getOfficialCircuitBreakerStatus().state, 'CLOSED');
  assert.equal(getOfficialCircuitBreakerStatus().failures, 0);

  setOfficialHangTimeoutMsForTests(30_000);
  resetOfficialCircuitBreaker();
});

test('hang timeout: 兜底通道同样活挂时，调用在超时窗口内抛错而非挂满上层总超时', async () => {
  resetOfficialCircuitBreaker();
  setOfficialHangTimeoutMsForTests(30);

  let hungFallbackSignal: AbortSignal | undefined;
  const hungModel = { doGenerate: () => new Promise(() => {}) };
  const hungFallback = {
    doGenerate: (options: { abortSignal?: AbortSignal } = {}) => {
      hungFallbackSignal = options.abortSignal;
      return new Promise(() => {});
    },
  };
  const wrapped = wrapLanguageModelWithBreaker(toModel(hungModel), () => toModel(hungFallback));

  const startedAt = Date.now();
  await assert.rejects(
    (wrapped as unknown as { doGenerate: () => Promise<unknown> }).doGenerate(),
    (err: unknown) => (err as Error).name === 'ChannelHangTimeoutError',
    '双通道同挂时必须抛出通道故障错误，不得无限悬挂',
  );
  assert.ok(Date.now() - startedAt < 5_000, '不得拖满上层 180s/360s 总超时');
  assert.ok(hungFallbackSignal?.aborted, '兜底超时必须 abort 底层请求，避免连接悬挂');
  assert.equal(getOfficialCircuitBreakerStatus().failures, 1, '官方活挂仍记为通道失败');

  setOfficialHangTimeoutMsForTests(30_000);
  resetOfficialCircuitBreaker();
});

test('circuit breaker: OPEN 期间 doGenerate 直接快速兜底，不再等待官方通道', async () => {
  resetOfficialCircuitBreaker();
  // 超时给足 10s：若误等官方（活挂替身永不返回），耗时断言会失败
  setOfficialHangTimeoutMsForTests(10_000);
  tripOfficialCircuitBreaker();

  let officialCalls = 0;
  const deadOfficial = {
    doGenerate: () => {
      officialCalls += 1;
      return new Promise(() => {});
    },
  };
  const fallbackResult = { fast: true };
  let fallbackCalls = 0;
  const fallbackModel = {
    doGenerate: () => {
      fallbackCalls += 1;
      return Promise.resolve(fallbackResult);
    },
  };
  const wrapped = wrapLanguageModelWithBreaker(toModel(deadOfficial), () => toModel(fallbackModel));

  const startedAt = Date.now();
  const res = await (wrapped as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();
  assert.equal(res, fallbackResult);
  assert.ok(Date.now() - startedAt < 1_000, 'OPEN 期间必须立即兜底，不得等待超时');
  assert.equal(officialCalls, 0, 'OPEN 期间不得再调用官方通道');
  assert.equal(fallbackCalls, 1);

  setOfficialHangTimeoutMsForTests(30_000);
  resetOfficialCircuitBreaker();
});

