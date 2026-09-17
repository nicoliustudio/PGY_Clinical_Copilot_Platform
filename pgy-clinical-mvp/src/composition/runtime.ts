import { understand } from '../clinical/understanding.js';
import { aiSdkModelPort } from '../adapters/ai-sdk/model-adapter.js';
import { AiSdkPrimaryAgent } from '../adapters/ai-sdk/agent-runtime.js';
import { DeterministicFormulaAuthority } from '../authority/formula-authority.js';
import { config } from '../config.js';
import type { AgentResult } from '../contracts/result.js';
import { ClinicalRuntime } from '../platform/agent/clinical-runtime.js';
import { FormulaAuthorityStage } from '../platform/authority/formula-stage.js';
import { AuthorityPipeline } from '../platform/authority/pipeline.js';
import { RiskHypothesisSafetyPort } from '../platform/authority/risk-safety-port.js';
import { SafetyInvariantStage } from '../platform/authority/safety-stage.js';
import { CapabilityRegistry } from '../platform/registry/capability-registry.js';
import { SkillRegistry } from '../platform/registry/skill-registry.js';
import { ToolRegistry } from '../platform/registry/tool-registry.js';
import { RuntimePreparer } from '../platform/runtime/runtime-preparer.js';
import { SemanticNeedCapabilityResolver } from '../platform/runtime/semantic-need-resolver.js';
import { finishTrace, newTrace, type RunTrace } from '../trace.js';
import { discoverCapabilityManifests, loadSkills } from './load-assets.js';
import { loadPromptProfile } from './load-prompt.js';
import {
  BASELINE_KNOWLEDGE_SCOPES,
  BASELINE_TOOL_IDS,
  PLATFORM_TOOLS,
} from './platform-assets.js';

/**
 * Composition Root —— 唯一知道「具体实现是谁」的地方。
 * 业务能力经数据注册进入 Registries；Core Runtime 保持 0 业务分支。
 */
export async function createClinicalRuntime(): Promise<ClinicalRuntime> {
  const manifests = await discoverCapabilityManifests();
  const capabilities = new CapabilityRegistry(manifests);
  const skills = new SkillRegistry(
    await loadSkills(manifests.flatMap((m) => m.skillIds)),
  );
  const tools = new ToolRegistry(PLATFORM_TOOLS);
  const prompt = await loadPromptProfile('clinical-primary');

  const preparer = new RuntimePreparer({
    understanding: { understand: (input) => understand(input, aiSdkModelPort) },
    capabilityResolver: new SemanticNeedCapabilityResolver(),
    safety: new RiskHypothesisSafetyPort(),
    capabilities,
    skills,
    tools,
    model: { id: 'clinical-primary', model: config.llm.deepModel },
    baselineToolIds: BASELINE_TOOL_IDS,
    baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
  });

  const authority = new AuthorityPipeline([
    new SafetyInvariantStage(),
    new FormulaAuthorityStage(new DeterministicFormulaAuthority()),
  ]);

  return new ClinicalRuntime(
    preparer,
    new AiSdkPrimaryAgent({ instructions: prompt.instructions }),
    authority,
    prompt.hash,
  );
}

let cachedRuntime: ClinicalRuntime | null = null;

export async function getClinicalRuntime(): Promise<ClinicalRuntime> {
  cachedRuntime ??= await createClinicalRuntime();
  return cachedRuntime;
}

export interface ClinicalRunResult {
  result: AgentResult;
  trace: RunTrace;
}

/** 单病例入口：一条命令即可跑通「理解 → 装配 → 提案 → 权威」全链。 */
export async function runCase(input: string): Promise<ClinicalRunResult> {
  const runtime = await getClinicalRuntime();
  const trace = newTrace(input);

  try {
    const { authority, usage, snapshot } = await runtime.run(input, trace.runId);
    const result = authority.proposal;
    // run_id 由系统注入，不依赖 LLM 输出
    if (result.mode === 'clinical') result.run_id = trace.runId;

    finishTrace({ finalResult: result, usage, snapshot });
    return { result, trace };
  } catch (e) {
    finishTrace({ error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
