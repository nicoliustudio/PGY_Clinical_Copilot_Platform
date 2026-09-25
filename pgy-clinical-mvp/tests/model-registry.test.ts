import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyModelSelection,
  describeActiveModel,
  getActiveModelProfile,
  getModelCatalog,
  resolveLanguageModel,
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
  assert.ok(catalog.options.length >= 20, `目录应包含全部候选模型，实际 ${catalog.options.length}`);
});

test('model catalog: thinking 三态与开关可用性一致，且 always 不依赖默认开关值', () => {
  for (const option of getModelCatalog().options) {
    assert.ok(['toggle', 'always', 'none'].includes(option.thinking), `${option.id} thinking 非法`);
    if (option.thinking === 'toggle') continue;
    // always / none 模型没有「可开关」语义，默认值只作为展示兜底。
    assert.equal(typeof option.defaultThinking, 'boolean');
  }
  assert.equal(optionById('official:deepseek-chat')?.thinking, 'none');
  assert.equal(optionById('aliyun:glm-5.3')?.thinking, 'always');
  assert.equal(optionById('aliyun:MiniMax-M2.5')?.thinking, 'always');
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
  const ready = optionById('aliyun:glm-5.3')?.available;
  if (!ready) {
    assert.equal(applyModelSelection('official:deepseek-flash', false).ok, true);
    assert.equal(getModelCatalog().active.thinking, true, 'always 模型不得被关掉');
    return;
  }
  assert.equal(applyModelSelection('aliyun:glm-5.3', false).ok, true);
  const catalog = getModelCatalog();
  assert.equal(catalog.active.thinkingMode, 'always');
  assert.equal(catalog.active.thinking, true, '请求关推理时不得假装关掉');
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
