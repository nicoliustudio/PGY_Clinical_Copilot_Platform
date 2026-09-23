import type { CapabilityDescriptor } from '../contracts/capability.js';
import type { ControlRuleV21, OutcomeProviderResolutionV21 } from './types.js';

export function rulesOf(capability: CapabilityDescriptor): ControlRuleV21[] {
  return (capability.controlPlaneV21?.rules ?? []) as ControlRuleV21[];
}

export function resolveOutcomeProvider(
  outcome: string,
  capabilities: CapabilityDescriptor[],
): OutcomeProviderResolutionV21 {
  const candidates = capabilities
    .filter((c) => c.enabled !== false && c.provides.includes(outcome))
    .flatMap((capability) => rulesOf(capability)
      .filter((rule) => rule.forOutcomes?.includes(outcome))
      .map((rule) => ({ outcome, capabilityId: capability.id, ruleId: rule.id })))
    .sort((a, b) => `${a.capabilityId}/${a.ruleId}`.localeCompare(`${b.capabilityId}/${b.ruleId}`));
  return {
    outcome,
    candidates,
    status: candidates.length === 0 ? 'UNSUPPORTED' : candidates.length === 1 ? 'RESOLVED' : 'AMBIGUOUS',
  };
}
