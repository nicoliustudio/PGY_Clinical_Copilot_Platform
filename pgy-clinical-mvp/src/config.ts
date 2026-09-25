import 'dotenv/config';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

const kbReleaseDir = path.resolve(req('KB_RELEASE_DIR'));

export const config = {
  runtime: { mode: (process.env.CLINICAL_RUNTIME_MODE ?? 'harness') as 'harness' | 'classic' },
  llm: {
    /** 官方 DeepSeek 通道（兼容既有 LLM_BASE_URL / LLM_API_KEY 语义）。 */
    baseURL: req('LLM_BASE_URL'),
    apiKey: req('LLM_API_KEY'),
    /** 初始活动模型的 API model 名（前端可热切换，见 model/model-registry.ts）。 */
    deepModel: req('LLM_DEEP_MODEL'),
    /** 初始活动模型的目录 id（优先级高于 LLM_DEEP_MODEL；留空则按模型名匹配）。 */
    modelId: process.env.LLM_MODEL_ID ?? '',
    /**
     * 控制面固定模型。用于 Understanding / Request Compiler / Planner。
     * 留空时默认使用 official:deepseek-chat，避免“切临床模型”同时改写控制栈语义，
     * 从而污染模型 A/B。若该通道不可用，Runtime 会确定性回退到本次 run 的 clinical 模型。
     */
    controlModelId: process.env.LLM_CONTROL_MODEL_ID ?? 'official:deepseek-chat',
    /** 阿里云百炼 token-plan 通道；未配置 key 时该通道模型在前端置灰（不产生死按钮）。 */
    aliyun: {
      baseURL: process.env.LLM_ALIYUN_BASE_URL ?? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: process.env.LLM_ALIYUN_API_KEY ?? '',
    },
  },
  embedding: {
    baseURL: req('EMBEDDING_BASE_URL'),
    apiKey: req('EMBEDDING_API_KEY'),
    model: req('EMBEDDING_MODEL'),
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 2560),
    batchSize: Number(process.env.EMBEDDING_BATCH_SIZE ?? 20),
  },
  rerank: {
    apiKey: req('RERANK_API_KEY'),
    model: req('RERANK_MODEL'),
    endpoint: req('RERANK_ENDPOINT'),
  },
  kb: {
    releaseDir: kbReleaseDir,
    cacheDir: path.resolve('.kb-cache'),
    /** 轻量 Runtime Catalog（cards + indexes + detail data），默认位于 releaseDir 的 knowledge 根下（releases 同级）。 */
    runtimeCatalogDir: path.resolve(
      process.env.KB_RUNTIME_CATALOG_DIR ?? path.join(kbReleaseDir, '..', '..', 'runtime-catalog'),
    ),
    /** Runtime Catalog 单次检索返回给 Agent 的卡片数上限（可配置，非医学 Top-N）。 */
    runtimeCardLimit: Number(process.env.KB_RUNTIME_CARD_LIMIT ?? 8),
  },
  /** 实验开关（A/B）：Diagnostic Pattern Set + Disease Crosswalk + Existing Standards Runtime + Diagnostic Release + H13 Pattern Assessment。不影响 Safety/Authority/Retrieval ranking。 */
  experiment: {
    diagnosticPatternSet: process.env.TCM_DIAGNOSTIC_PATTERN_SET === 'on',
    diseaseCrosswalk: process.env.TCM_DISEASE_CROSSWALK === 'on',
    standardRuntime: process.env.TCM_STANDARD_RUNTIME === 'on',
    diagnosticRelease: process.env.TCM_DIAGNOSTIC_RELEASE === 'on',
    patternAssessment: process.env.TCM_PATTERN_ASSESSMENT === 'on',
    /** H14 Treatment Decision Causality（skill epistemic guidance；telemetry 始终记录）。 */
    h14: process.env.TCM_H14 === 'on',
  },
  // ASR 为可选能力：未配置时语音输入回退到禁用态，不影响文字对话。
  asr: {
    enabled: process.env.ASR_ENABLED === 'true',
    model: process.env.ASR_MODEL ?? 'qwen-audio-3.0-asr-flash-streaming',
    wsUrl: process.env.ASR_WS_URL ?? '',
    apiKey: process.env.ASR_API_KEY ?? '',
    sampleRate: Number(process.env.ASR_SAMPLE_RATE ?? 16000),
    timeoutSeconds: Number(process.env.ASR_TIMEOUT_SECONDS ?? 60),
  },
};
