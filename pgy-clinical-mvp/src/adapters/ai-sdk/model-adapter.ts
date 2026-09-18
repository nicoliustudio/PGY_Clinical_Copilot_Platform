import { generateText } from 'ai';
import { llmModel, fastModel } from '../../model/adapter.js';
import { extractJson } from '../../util/json.js';
import type { ModelPort, StructuredRequest } from '../../ports/model.js';

/**
 * AI SDK 对 ModelPort 的实现。
 * 「from 'ai'」只允许出现在这里（以及 Agent Runtime 宿主），不进入 clinical/knowledge。
 */
function createModelPort(model: typeof llmModel): ModelPort {
  return {
    async generateStructured<T>({
      schema,
      system,
      prompt,
    }: StructuredRequest<T>) {
      const result = await generateText({
        model,
        system,
        prompt,
        timeout: { totalMs: 180_000 },
      });
      return extractJson(result.text, schema);
    },
  };
}

/** deep 模型端口：Primary Agent / Understanding 使用。 */
export const aiSdkModelPort: ModelPort = createModelPort(llmModel);
/** fast 模型端口：Clinical Planner 使用。 */
export const aiSdkFastModelPort: ModelPort = createModelPort(fastModel);
