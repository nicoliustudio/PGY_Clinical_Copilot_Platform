import type { CapabilityDescriptor, ResolvedCapability } from '../../contracts/capability.js';
import type { ClinicalUnderstanding } from '../../contracts/understanding.js';

/** Legacy A/B resolver only. Never use this exact-key matcher in the H1 Harness path. */
export class ClassicSemanticNeedResolver {
  async resolve(
    understanding: ClinicalUnderstanding,
    candidates: CapabilityDescriptor[],
  ): Promise<ResolvedCapability[]> {
    const needs = new Set(understanding.capabilityNeeds.map((need) => need.capability));
    return candidates
      .map((candidate): ResolvedCapability | undefined => {
        const matched = candidate.provides.filter((key) => needs.has(key));
        if (!matched.length) return undefined;
        return {
          id: candidate.id,
          confidence: 0.7,
          reason: `legacy exact-key match: ${matched.join(', ')}`,
          provides: [...candidate.provides],
          treatmentSpecific: candidate.treatmentSpecific,
          knowledgeScopes: [...candidate.knowledgeScopes],
          evidenceObligations: candidate.evidenceObligations,
          deliveryObligations: candidate.deliveryObligations,
        };
      })
      .filter((value): value is ResolvedCapability => value !== undefined);
  }
}
