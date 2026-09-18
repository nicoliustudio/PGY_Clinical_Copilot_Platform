import type { CapabilityDescriptor } from '../src/contracts/capability.js';
import type { AgentResult } from '../src/contracts/result.js';
import type { ClinicalUnderstanding } from '../src/contracts/understanding.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { ClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import { ClinicalRuntime } from '../src/platform/agent/clinical-runtime.js';
import { FormulaAuthorityStage } from '../src/platform/authority/formula-stage.js';
import { AuthorityPipeline } from '../src/platform/authority/pipeline.js';
import { RiskHypothesisSafetyPort } from '../src/platform/authority/risk-safety-port.js';
import { SafetyInvariantStage } from '../src/platform/authority/safety-stage.js';
import { CapabilityRegistry } from '../src/platform/registry/capability-registry.js';
import { SkillRegistry } from '../src/platform/registry/skill-registry.js';
import { ToolRegistry } from '../src/platform/registry/tool-registry.js';
import { RuntimePreparer } from '../src/platform/runtime/runtime-preparer.js';
import {
  BASELINE_KNOWLEDGE_SCOPES,
  BASELINE_SKILL_IDS,
  BASELINE_TOOL_IDS,
  PLATFORM_TOOLS,
} from '../src/composition/platform-assets.js';
import {
  discoverCapabilityManifests,
  loadSkills,
} from '../src/composition/load-assets.js';

/** 测试用统一 Understanding 基座 */
export function baseUnderstanding(
  mode: ClinicalUnderstanding['interaction']['mode'],
): ClinicalUnderstanding {
  return {
    interaction: { mode },
    facts: [],
    intents: [],
    risks: [],
    informationGaps: [],
    capabilityNeeds: [],
    uncertainties: [],
  };
}

export interface TestRuntimeOptions {
  understand(input: string): ClinicalUnderstanding;
  propose(context: RuntimeContext): AgentResult;
  /** 返回 false 表示组成被篡改（用于验证 Formula Authority 关卡不可绕过） */
  validateFormula?(sourceId: string): boolean;
  extraCapabilities?: CapabilityDescriptor[];
  /** 可选 Planner 替身，默认返回空策略。 */
  plan?(): ClinicalStrategy;
}

/**
 * 组装一个不依赖模型/网络的 Runtime，用于验证 Runtime 骨架本身的结构性行为。
 * 装配路径与生产 composition root 完全同构，只是把 Ports 换成可观察的替身。
 */
export async function buildTestRuntime(
  options: TestRuntimeOptions,
): Promise<ClinicalRuntime> {
  const manifests = [
    ...(await discoverCapabilityManifests()),
    ...(options.extraCapabilities ?? []),
  ];

  const capabilities = new CapabilityRegistry(manifests);
  const skills = new SkillRegistry(
    await loadSkills([...manifests.flatMap((m) => m.skillIds), ...BASELINE_SKILL_IDS]),
  );
  const tools = new ToolRegistry(PLATFORM_TOOLS);

  const preparer = new RuntimePreparer({
    understanding: { understand: async (input) => options.understand(input) },
    safety: new RiskHypothesisSafetyPort(),
    planner: { plan: async () => (options.plan ? options.plan() : emptyClinicalStrategy()) },
    capabilities,
    skills,
    tools,
    model: { id: 'test-model' },
    baselineToolIds: BASELINE_TOOL_IDS,
    baselineSkillIds: BASELINE_SKILL_IDS,
    baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
  });

  const authority = new AuthorityPipeline([
    new SafetyInvariantStage(),
    new FormulaAuthorityStage({
      apply: async (input) => {
        const valid =
          input.sourceId.length > 0 &&
          (options.validateFormula?.(input.sourceId) ?? true);
        return valid
          ? { authority: 'NORMATIVE' as const }
          : { authority: 'BLOCKED' as const, reason: 'TEST_FORMULA_MUTATION' };
      },
    }),
  ]);

  return new ClinicalRuntime(
    preparer,
    { run: async (context) => ({ proposal: options.propose(context) }) },
    authority,
  );
}

/** 测试用临床提案 */
export function clinicalProposal(
  overrides: { sourceId?: string; authority?: 'NORMATIVE' | 'GENERATED_DRAFT' } = {},
): AgentResult {
  return {
    mode: 'clinical',
    status: 'COMPLETED',
    disease: { name: 'demo-disease', confidence: 0.8, evidence_refs: ['P1:demo'] },
    syndrome: { name: 'demo-syndrome', confidence: 0.7, evidence_refs: ['P1:demo'] },
    treatment: { text: 'demo-treatment', evidence_refs: ['P1:demo'] },
    formula: {
      authority: overrides.authority ?? 'NORMATIVE',
      formula_id: 'demo-formula',
      name: 'demo-formula',
      composition: ['demo-herb'],
      source_id: overrides.sourceId ?? 'P1:demo',
      evidence_refs: ['P1:demo'],
    },
    missing_information: [],
    safety: { status: 'PASS' },
  };
}
