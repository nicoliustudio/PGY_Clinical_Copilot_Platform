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
    baseURL: req('LLM_BASE_URL'),
    apiKey: req('LLM_API_KEY'),
    fastModel: req('LLM_FAST_MODEL'),
    deepModel: req('LLM_DEEP_MODEL'),
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
