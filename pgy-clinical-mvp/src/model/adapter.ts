import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from '../config.js';

const provider = createOpenAICompatible({
  name: 'token-plan',
  baseURL: config.llm.baseURL,
  apiKey: config.llm.apiKey,
});

// AI SDK LanguageModel，供 ToolLoopAgent / generateText 使用
export const llmModel = provider(config.llm.deepModel);

// fast 模型：供 Clinical Planner 等轻量结构化调用使用，降低策划延迟与 token 开销
export const fastModel = provider(config.llm.fastModel);

/**
 * 批量向量化。返回与输入等长的向量数组（每项维度 = EMBEDDING_DIMENSIONS）。
 * 直接调用阿里云 OpenAI 兼容 embedding 端点，不依赖 AI SDK 的 provider。
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  const B = config.embedding.batchSize;
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B);
    const res = await fetch(`${config.embedding.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.embedding.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.embedding.model,
        input: batch,
        dimensions: config.embedding.dimensions,
      }),
    });
    if (!res.ok) {
      throw new Error(`embedding 失败 HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    for (const item of sorted) out.push(item.embedding);
  }
  return out;
}

/**
 * 重排序。返回按相关性降序的 {index, score}。
 */
export async function rerank(
  query: string,
  documents: string[],
  topN = 20,
): Promise<{ index: number; score: number }[]> {
  const res = await fetch(config.rerank.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.rerank.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.rerank.model,
      query,
      documents,
      top_n: Math.min(topN, documents.length),
    }),
  });
  if (!res.ok) {
    throw new Error(`rerank 失败 HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    results: { index: number; relevance_score: number }[];
  };
  return data.results
    .map((r) => ({ index: r.index, score: r.relevance_score }))
    .sort((a, b) => b.score - a.score);
}

/** 余弦相似度 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
