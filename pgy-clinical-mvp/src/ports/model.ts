import type { z } from 'zod';

/**
 * ModelPort —— 结构化生成的抽象端口。
 * Clinical / Knowledge 层只依赖本接口，不依赖任何具体 Runtime（AI SDK / 其他）。
 */
export interface StructuredRequest<T> {
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  /** 仅用于错误定位/trace，不改变生成语义。 */
  operation?: string;
}

export interface ModelPort {
  generateStructured<T>(request: StructuredRequest<T>): Promise<T>;
}
