import type { z } from 'zod';

/**
 * 从 LLM 文本输出中提取 JSON 并用 zod schema 校验。
 * 不依赖 provider 的 response_format: json_object，跨 provider 更稳。
 */
export function extractJson<T>(text: string, schema: z.ZodType<T>): T {
  let t = text.trim();
  // 去掉可能的 markdown 代码块包裹
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`无法从输出中提取 JSON：${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(t.slice(start, end + 1));
  return schema.parse(parsed);
}
