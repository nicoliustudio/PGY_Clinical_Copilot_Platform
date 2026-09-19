import type { CapabilityDescriptor, ResolvedCapability } from './capability.js';

export interface HarnessCapabilityView {
  id: string;
  description: string;
  semanticDescription: string;
  positiveExamples: string[];
  negativeExamples: string[];
}

export interface HarnessActivationResult {
  capability: ResolvedCapability;
  addedKnowledgeScopes: string[];
  addedSkills: { id: string; instruction: string }[];
  addedToolIds: string[];
  /** H10：本次激活是否复用了已激活的 capability（幂等返回已有状态）。 */
  reused: boolean;
}

/**
 * HarnessControlPort is the only mutable control surface exposed to the agent loop.
 * The model may discover/activate capabilities; it cannot commit authority.
 */
export interface HarnessControlPort {
  listCapabilities(): HarnessCapabilityView[];
  activateCapability(id: string, reason: string): HarnessActivationResult;
  isCapabilityActive(id: string): boolean;
}

export function toCapabilityView(item: CapabilityDescriptor): HarnessCapabilityView {
  return {
    id: item.id,
    description: item.description,
    semanticDescription: item.semanticDescription,
    positiveExamples: item.positiveExamples,
    negativeExamples: item.negativeExamples,
  };
}
