import type { ProposalSubmitInput } from '../../contracts/result.js';
import { proposalSubmitInputSchema } from '../../contracts/result.js';
import type { DecisionState, ProposalDraft } from '../../contracts/workspace.js';
import type { RuntimeContext } from '../../contracts/runtime.js';

/**
 * H11 Minimal Finalization —— 把「已经形成的判断」序列化为最小 proposal 结构。
 * 不重新解决病例，不重新检索，不生成新的 formula identity。
 */

export type ProposalParseResult =
  | { ok: true; value: ProposalSubmitInput }
  | { ok: false; stage: 'parse' | 'schema'; error: string; rawPayload: string; cleanedPayload: string };

/**
 * Deterministic syntax cleanup + parse + schema validation。
 * 允许：去 markdown code fence、trim 前后包装、提取唯一明确 JSON object。
 * 禁止：猜缺失字段、修正 clinical 内容。raw 与 cleaned 均保留以便 Trace 溯源。
 */
export function tryParseProposalSubmit(text: string): ProposalParseResult {
  const rawPayload = text;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return {
      ok: false,
      stage: 'parse',
      error: '无法从输出中提取 JSON object',
      rawPayload,
      cleanedPayload: cleaned,
    };
  }
  cleaned = cleaned.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return {
      ok: false,
      stage: 'parse',
      error: e instanceof Error ? e.message : String(e),
      rawPayload,
      cleanedPayload: cleaned,
    };
  }

  const validated = proposalSubmitInputSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      stage: 'schema',
      error: validated.error.message,
      rawPayload,
      cleanedPayload: cleaned,
    };
  }
  return { ok: true, value: validated.data };
}

/** 最小 finalization 上下文：只含已形成的判断，不含完整 Trace / tool history / retrieval results / skills / 全部 candidates。 */
export function buildMinimalFinalizationPrompt(
  context: RuntimeContext,
  draft: ProposalDraft,
  decisionState: DecisionState,
): string {
  const focusedCandidateRefs = decisionState.currentFrontier;
  const criticalEvidenceRefs = decisionState.currentEvidenceRefs;
  const preservedUncertainty = decisionState.decisionChangingUnknowns;

  return [
    '你的临床探索已结束（或达到资源上限）。现在只做一件事：把下面已经形成的判断序列化为一个合法的 proposal 结构。',
    '不要重新检索、不要重新辨证、不要生成新的方剂 identity（sourceId/formulaId/composition 由 Runtime 填充）。',
    '',
    '## ProposalDraft（已形成的最终判断）',
    JSON.stringify({
      disease: draft.disease ?? null,
      syndrome: draft.syndrome ?? null,
      treatment: draft.treatment ?? null,
      selectedCandidateRef: draft.selectedCandidateRef ?? null,
      uncertainty: draft.uncertainty ?? [],
    }, null, 2),
    '',
    '## 当前决策焦点',
    JSON.stringify({
      question: decisionState.question,
      leading: decisionState.leadingExplanations,
      focusedCandidateRefs,
      criticalEvidenceRefs,
      preservedUncertainty,
    }, null, 2),
    '',
    '## 输出要求',
    '只输出一个 JSON 对象。mode ∈ {conversation, clarification, urgent, clinical}。',
    'clinical 模式需要 disease.name / syndrome.name / treatment.text，可选 candidate_ref（优先用上述 selectedCandidateRef）/ uncertainty。',
    '若信息不足以形成方药 proposal，选择 clarification（questions）。',
    '不要 markdown 代码块、不要解释文字。',
  ].join('\n');
}

/** 第二次（bounded retry）输入：仅 ProposalDraft + 上次错误摘要，不再加入完整病例或历史。 */
export function buildRetryPrompt(draft: ProposalDraft, errorSummary: string): string {
  return [
    '上一次输出无法解析。请仅根据以下已形成的判断，重新输出一个合法 JSON 对象。',
    '',
    '## ProposalDraft',
    JSON.stringify({
      disease: draft.disease ?? null,
      syndrome: draft.syndrome ?? null,
      treatment: draft.treatment ?? null,
      selectedCandidateRef: draft.selectedCandidateRef ?? null,
      uncertainty: draft.uncertainty ?? [],
    }, null, 2),
    '',
    '## 上次错误',
    errorSummary,
    '',
    '只输出 JSON。不要 markdown、不要解释。mode 必须合法；clinical 需 disease.name / syndrome.name / treatment.text。',
  ].join('\n');
}

/** 最小 finalization 上下文「条目数」，用于 finalizationContextItemCount telemetry。 */
export function countFinalizationContextItems(draft: ProposalDraft, decisionState: DecisionState): number {
  let n = 0;
  if (draft.disease) n += 1;
  if (draft.syndrome) n += 1;
  if (draft.treatment) n += 1;
  if (draft.selectedCandidateRef) n += 1;
  if (draft.uncertainty && draft.uncertainty.length > 0) n += 1;
  n += decisionState.currentFrontier.length;
  n += decisionState.currentEvidenceRefs.length;
  n += decisionState.decisionChangingUnknowns.length;
  return n;
}
