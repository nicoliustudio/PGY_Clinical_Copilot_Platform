import 'dotenv/config';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

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
    releaseDir: path.resolve(req('KB_RELEASE_DIR')),
    cacheDir: path.resolve('.kb-cache'),
  },
};
