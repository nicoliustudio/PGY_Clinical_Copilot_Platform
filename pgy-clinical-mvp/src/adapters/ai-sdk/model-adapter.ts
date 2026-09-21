import { generateText } from 'ai';
import { llmModel, fastModel } from '../../model/adapter.js';
import { extractJson } from '../../util/json.js';
import type { ModelPort, StructuredRequest } from '../../ports/model.js';

/**
 * Structured output reliability policy:
 * - first attempt: normal structured prompt
 * - parse/schema failure: exactly one format-repair retry
 * - second failure: fail closed with a stable infrastructure error
 *
 * The retry is format-only. It must not become best-of-N clinical reasoning.
 */
function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1200);
  return String(error).slice(0, 1200);
}

export function buildStructuredRepairPrompt(
  originalPrompt: string,
  previousOutput: string,
  validationError: string,
): string {
  return [
    originalPrompt,
    '',
    '---',
    'STRUCTURED OUTPUT FORMAT REPAIR',
    'Your previous answer could not be parsed or did not match the required schema.',
    'Do not change the substantive clinical/planning content unless required to satisfy the declared schema.',
    'Return exactly one valid JSON object, with no markdown fence and no explanatory text.',
    `Validation error: ${validationError}`,
    'Previous output:',
    previousOutput.slice(0, 12000),
  ].join('\n');
}

export async function generateStructuredWithRetry<T>(
  request: StructuredRequest<T>,
  generate: (args: { system?: string; prompt: string }) => Promise<string>,
): Promise<T> {
  const firstText = await generate({ system: request.system, prompt: request.prompt });
  try {
    return extractJson(firstText, request.schema);
  } catch (firstError) {
    const secondText = await generate({
      system: request.system,
      prompt: buildStructuredRepairPrompt(request.prompt, firstText, errorSummary(firstError)),
    });
    try {
      return extractJson(secondText, request.schema);
    } catch (secondError) {
      const op = request.operation ?? 'structured_generation';
      throw new Error(
        `STRUCTURED_OUTPUT_FAILED[${op}]: ${errorSummary(secondError)} | first_error=${errorSummary(firstError)}`,
      );
    }
  }
}

/**
 * AI SDK 对 ModelPort 的实现。
 * 「from 'ai'」只允许出现在这里（以及 Agent Runtime 宿主），不进入 clinical/knowledge。
 */
function createModelPort(model: typeof llmModel): ModelPort {
  return {
    async generateStructured<T>(request: StructuredRequest<T>) {
      return generateStructuredWithRetry(request, async ({ system, prompt }) => {
        const result = await generateText({
          model,
          system,
          prompt,
          timeout: { totalMs: 180_000 },
        });
        return result.text;
      });
    },
  };
}

/** deep 模型端口：Primary Agent / Understanding 使用。 */
export const aiSdkModelPort: ModelPort = createModelPort(llmModel);
/** fast 模型端口：Clinical Planner 使用。 */
export const aiSdkFastModelPort: ModelPort = createModelPort(fastModel);
