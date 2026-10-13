import { createHash } from 'node:crypto';
import { config } from '../config.js';

/**
 * 语言模型（chat/agent）不自在此处创建：它们由 `model/model-registry.ts` 按当前活动选择
 * 在每次调用时解析，从而支持前端热切换。本模块只负责与模型选择无关的向量化 / 重排序。
 */

/**
 * Query 级向量 / 重排序缓存（进程内，有界 LRU）。
 *
 * 只缓存「同一输入 → 同一输出」的纯远程调用结果：embedding 与 rerank 对同一 (model, 输入)
 * 都是确定性的，所以命中缓存不改变任何检索语义、不改变任何排序结果，只是省掉重复的网络往返。
 * 典型命中：formula.search_candidates 的 4 条 recall lane 中，两条共享 patientQuery、
 * 两条共享 hypothesis query，串行实现会对同一 query 重复向量化。
 *
 * 文档向量不走这里（已随 KB 索引落盘），因此缓存规模只与 query 数量相关。
 */
const EMBED_CACHE_LIMIT = 512;
const RERANK_CACHE_LIMIT = 64;

const embedCache = new Map<string, number[]>();
const rerankCache = new Map<string, { index: number; score: number }[]>();
const cacheStats = { embedHit: 0, embedMiss: 0, rerankHit: 0, rerankMiss: 0 };

function lruGet<T>(cache: Map<string, T>, key: string): T | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 清空缓存并归零计数：供测试隔离与 A/B 度量使用。 */
export function resetVectorCache(): void {
  embedCache.clear();
  rerankCache.clear();
  cacheStats.embedHit = 0;
  cacheStats.embedMiss = 0;
  cacheStats.rerankHit = 0;
  cacheStats.rerankMiss = 0;
}

/** 缓存命中/未命中计数（仅观测，不设阈值）。 */
export function vectorCacheStats(): typeof cacheStats {
  return { ...cacheStats };
}

function embedKey(text: string): string {
  return `${config.embedding.model}|${config.embedding.dimensions}|${text}`;
}

function rerankKey(query: string, documents: string[], topN: number): string {
  const payload = [config.rerank.model, config.rerank.endpoint, String(topN), query, ...documents].join('\u0001');
  return createHash('sha1').update(payload).digest('hex');
}

/**
 * 批量向量化。返回与输入等长的向量数组（每项维度 = EMBEDDING_DIMENSIONS）。
 * 直接调用阿里云 OpenAI 兼容 embedding 端点，不依赖 AI SDK 的 provider。
 */
async function embedRemote(texts: string[]): Promise<number[][]> {
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

export async function embed(texts: string[]): Promise<number[][]> {
  const out: (number[] | undefined)[] = new Array(texts.length);
  const missTextByKey = new Map<string, string>();
  const missIndexByKey = new Map<string, number[]>();
  texts.forEach((text, i) => {
    const key = embedKey(text);
    const hit = lruGet(embedCache, key);
    if (hit !== undefined) {
      out[i] = hit;
      cacheStats.embedHit += 1;
      return;
    }
    if (!missTextByKey.has(key)) missTextByKey.set(key, text);
    const bucket = missIndexByKey.get(key);
    if (bucket) bucket.push(i);
    else missIndexByKey.set(key, [i]);
  });
  const missKeys = [...missTextByKey.keys()];
  if (missKeys.length > 0) {
    const vectors = await embedRemote(missKeys.map((k) => missTextByKey.get(k) as string));
    missKeys.forEach((key, k) => {
      const vector = vectors[k];
      lruSet(embedCache, key, vector, EMBED_CACHE_LIMIT);
      for (const i of missIndexByKey.get(key) as number[]) out[i] = vector;
      cacheStats.embedMiss += 1;
    });
  }
  return out as number[][];
}

/**
 * 重排序。返回按相关性降序的 {index, score}。
 */
export async function rerank(
  query: string,
  documents: string[],
  topN = 20,
): Promise<{ index: number; score: number }[]> {
  const key = rerankKey(query, documents, topN);
  const hit = lruGet(rerankCache, key);
  if (hit !== undefined) {
    cacheStats.rerankHit += 1;
    // 返回浅拷贝：缓存结果不得被调用方就地修改。
    return hit.map((r) => ({ ...r }));
  }
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
  const ranked = data.results
    .map((r) => ({ index: r.index, score: r.relevance_score }))
    .sort((a, b) => b.score - a.score);
  lruSet(rerankCache, key, ranked, RERANK_CACHE_LIMIT);
  cacheStats.rerankMiss += 1;
  return ranked.map((r) => ({ ...r }));
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
