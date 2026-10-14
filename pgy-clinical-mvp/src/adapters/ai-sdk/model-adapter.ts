import { generateText, type LanguageModel } from 'ai';
import { resolveLanguageModel } from '../../model/model-registry.js';
import { config } from '../../config.js';
import { extractJson } from '../../util/json.js';
import { pushLlmProbeRecord } from '../../util/llm-probe.js';
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

/** 纯观测：结构化输出校验失败时记录错误原文（LLM_PROBE=1 时才记录），用于离线归因格式修复重试的根因。 */
function pushParseErrorProbe(operation: string | undefined, attempt: number, output: string, error: unknown): void {
  try {
    pushLlmProbeRecord({
      kind: 'parse_error',
      ts: Date.now(),
      operation,
      attempt,
      error: errorSummary(error).slice(0, 800),
      outputLen: output.length,
      outputHead: output.slice(0, 400),
    });
  } catch {
    // observation must never affect execution
  }
}

export async function generateStructuredWithRetry<T>(
  request: StructuredRequest<T>,
  generate: (args: { system?: string; prompt: string; attempt: number }) => Promise<string>,
): Promise<T> {
  const firstText = await generate({ system: request.system, prompt: request.prompt, attempt: 1 });
  try {
    return extractJson(firstText, request.schema);
  } catch (firstError) {
    pushParseErrorProbe(request.operation, 1, firstText, firstError);
    const secondText = await generate({
      system: request.system,
      prompt: buildStructuredRepairPrompt(request.prompt, firstText, errorSummary(firstError)),
      attempt: 2,
    });
    try {
      return extractJson(secondText, request.schema);
    } catch (secondError) {
      pushParseErrorProbe(request.operation, 2, secondText, secondError);
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
export function createAiSdkModelPort(resolveModel: () => LanguageModel): ModelPort {
  return {
    async generateStructured<T>(request: StructuredRequest<T>) {
      return generateStructuredWithRetry(request, async ({ system, prompt, attempt }) => {
        const startedAt = Date.now();
        const result = await generateText({
          // 每次调用按当前活动模型解析：前端切换模型后下一次调用即生效，无需重启。
          model: resolveModel(),
          temperature: config.llm.temperature,
          system,
          prompt,
          timeout: { totalMs: 180_000 },
        });
        // 纯观测：控制面单次 LLM 请求耗时 / usage / 缓存命中（LLM_PROBE=1 时才记录）。
        try {
          pushLlmProbeRecord({
            kind: 'control',
            ts: Date.now(),
            responseTimeMs: Date.now() - startedAt,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens,
            cacheReadTokens: result.usage?.inputTokenDetails?.cacheReadTokens,
            operation: request.operation,
            attempt,
          });
        } catch {
          // observation must never affect execution
        }
        return result.text;
      });
    },
  };
}

/** Legacy/global port. Production run composition uses run-scoped role-specific ports. */
export const aiSdkModelPort: ModelPort = createAiSdkModelPort(resolveLanguageModel);
/** Legacy/global fast port. Production run composition pins control vs clinical roles separately. */
export const aiSdkFastModelPort: ModelPort = createAiSdkModelPort(resolveLanguageModel);
