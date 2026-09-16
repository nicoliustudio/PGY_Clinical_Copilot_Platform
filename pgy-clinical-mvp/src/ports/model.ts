import type { z } from 'zod';

/**
 * ModelPort —— 结构化生成的抽象端口。
 * Clinical / Knowledge 层只依赖本接口，不依赖任何具体 Runtime（AI SDK / 其他）。
 */
export interface StructuredRequest<T> {
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
}

export interface ModelPort {
  generateStructured<T>(request: StructuredRequest<T>): Promise<T>;
}
