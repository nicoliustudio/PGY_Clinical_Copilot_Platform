import type { ClinicalUnderstanding } from './understanding.js';
import type { CapabilityDescriptor, ResolvedCapability } from './capability.js';
import type { RuntimeContext, SafetyDecision } from './runtime.js';
import type { AgentResult } from './result.js';
import type { FormulaAuthorityInput, FormulaAuthorityOutput } from './proposal.js';

export interface ClinicalUnderstandingPort {
  understand(input: string): Promise<ClinicalUnderstanding>;
}

export interface CapabilityResolverPort {
  resolve(
    understanding: ClinicalUnderstanding,
    candidates: CapabilityDescriptor[],
  ): Promise<ResolvedCapability[]>;
}

export interface SafetyPort {
  evaluate(understanding: ClinicalUnderstanding): Promise<SafetyDecision>;
}

export interface PrimaryAgentOutput {
  proposal: AgentResult;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface PrimaryAgentPort {
  run(context: RuntimeContext): Promise<PrimaryAgentOutput>;
}

export interface FormulaAuthorityPort {
  apply(input: FormulaAuthorityInput): Promise<FormulaAuthorityOutput>;
}
