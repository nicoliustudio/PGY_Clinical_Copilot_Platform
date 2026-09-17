import type {
  CapabilityDescriptor,
  ResolvedCapability,
} from '../../contracts/capability.js';
import type { CapabilityResolverPort } from '../../contracts/ports.js';
import type { ClinicalUnderstanding } from '../../contracts/understanding.js';

/** 语义需求未携带置信度时的中性先验 */
const NEUTRAL_CONFIDENCE = 0.7;

/**
 * Capability Resolver —— 消费统一 Understanding 的 capabilityNeeds（语义需求键），
 * 与 Capability Descriptor 的 provides（该能力可满足的语义需求）做数据驱动匹配。
 *
 * 它不读取用户原文、不命中业务关键词、不写业务分支。
 * 若未来能力数量变大，可在保持本 Port 契约不变的前提下替换为
 * embedding shortlist + LLM 语境选择实现。
 */
export class SemanticNeedCapabilityResolver implements CapabilityResolverPort {
  async resolve(
    understanding: ClinicalUnderstanding,
    candidates: CapabilityDescriptor[],
  ): Promise<ResolvedCapability[]> {
    const needs = new Set(
      understanding.capabilityNeeds.map((need) => need.capability),
    );

    return candidates
      .map((candidate) => {
        const matched = candidate.provides.filter((key) => needs.has(key));
        if (matched.length === 0) return undefined;
        return {
          id: candidate.id,
          confidence: NEUTRAL_CONFIDENCE,
          reason: `Matched semantic capability need(s): ${matched.join(', ')}`,
        } satisfies ResolvedCapability;
      })
      .filter((value): value is ResolvedCapability => value !== undefined);
  }
}
