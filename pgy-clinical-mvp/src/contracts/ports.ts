import type { ClinicalUnderstanding } from './understanding.js';
import type { RuntimeContext, SafetyDecision } from './runtime.js';
import type { AgentResult } from './result.js';
import type { FormulaAuthorityInput, FormulaAuthorityOutput } from './proposal.js';
import type { AgentStreamEvent } from './stream.js';
import type { AgentLoopTrace, ContextMetrics } from './agent-loop.js';
import type { ClinicalStrategy } from './clinical-strategy.js';

export interface ClinicalUnderstandingPort {
  understand(input: string): Promise<ClinicalUnderstanding>;
}

export interface ClinicalPlannerInput {
  input: string;
  understanding: ClinicalUnderstanding;
  safety: SafetyDecision;
  availableCapabilities: { id: string; semanticDescription: string }[];
}

/** 临床总策划层：一次结构化生成 ClinicalStrategy，不做临床结论。 */
export interface ClinicalPlannerPort {
  plan(input: ClinicalPlannerInput): Promise<ClinicalStrategy>;
}

export interface RuntimePreparationPort {
  prepare(input: string, runId?: string): Promise<RuntimeContext>;
}

export interface SafetyPort {
  evaluate(understanding: ClinicalUnderstanding): Promise<SafetyDecision>;
}

export interface PrimaryAgentOutput {
  proposal: AgentResult;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Harness 级收敛/终结可观测状态（平台状态，非临床枚举）。 */
  agentLoop?: AgentLoopTrace;
  /** H3 Context 压缩指标（估算）。 */
  contextMetrics?: ContextMetrics;
}

export interface PrimaryAgentPort {
  run(context: RuntimeContext, onEvent?: (event: AgentStreamEvent) => void): Promise<PrimaryAgentOutput>;
}

export interface FormulaAuthorityPort {
  apply(input: FormulaAuthorityInput): Promise<FormulaAuthorityOutput>;
}
