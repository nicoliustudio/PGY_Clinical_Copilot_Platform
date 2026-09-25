import { understand } from '../clinical/understanding.js';
import { createAiSdkModelPort } from '../adapters/ai-sdk/model-adapter.js';
import { AiSdkPrimaryAgent } from '../adapters/ai-sdk/agent-runtime.js';
import { StructuredClinicalPlanner } from '../platform/planning/clinical-planner.js';
import { DeterministicFormulaAuthority } from '../authority/formula-authority.js';
import { config } from '../config.js';
import {
  modelProfileForSelection,
  resolveLanguageModelFor,
  snapshotModelExecution,
  type ModelExecutionReceipt,
  type RunModelRequest,
} from '../model/model-registry.js';
import type { AuthorityResult } from '../contracts/authority.js';
import type { AgentResult } from '../contracts/result.js';
import type { AgentStreamEvent } from '../contracts/stream.js';
import type { ClinicalWorkspace } from '../contracts/workspace.js';
import { ClinicalRuntime } from '../platform/agent/clinical-runtime.js';
import { FormulaAuthorityStage } from '../platform/authority/formula-stage.js';
import { AuthorityPipeline } from '../platform/authority/pipeline.js';
import { RiskHypothesisSafetyPort } from '../platform/authority/risk-safety-port.js';
import { SafetyInvariantStage } from '../platform/authority/safety-stage.js';
import { CapabilityRegistry } from '../platform/registry/capability-registry.js';
import { SkillRegistry } from '../platform/registry/skill-registry.js';
import { ToolRegistry } from '../platform/registry/tool-registry.js';
import { RuntimePreparer } from '../platform/runtime/runtime-preparer.js';
import { ClassicRuntimePreparer } from '../experiments/classic/classic-runtime-preparer.js';
import { finishTrace, newTrace, type RunTrace } from '../trace.js';
import { discoverCapabilityManifests, loadSkills } from './load-assets.js';
import { loadPromptProfile } from './load-prompt.js';
import {
  BASELINE_KNOWLEDGE_SCOPES,
  BASELINE_SKILL_IDS,
  BASELINE_TOOL_IDS,
  CLASSIC_BASELINE_TOOL_IDS,
  PLATFORM_TOOLS,
} from './platform-assets.js';
import { CONTROL_PLANE_V21_POLICY } from './control-plane-v21-policy.js';

export type ClinicalRuntimeMode = 'harness' | 'classic';

/** Composition root: runtime mode is an A/B infrastructure switch, never a clinical branch. */
export async function createClinicalRuntime(
  mode: ClinicalRuntimeMode = config.runtime.mode,
  modelExecution: ModelExecutionReceipt = snapshotModelExecution(),
): Promise<ClinicalRuntime> {
  const manifests = await discoverCapabilityManifests();
  const capabilities = new CapabilityRegistry(manifests);
  const skills = new SkillRegistry(await loadSkills([...manifests.flatMap((m) => m.skillIds), ...BASELINE_SKILL_IDS]));
  const tools = new ToolRegistry(PLATFORM_TOOLS);
  const safety = new RiskHypothesisSafetyPort();
  const controlPort = createAiSdkModelPort(() => resolveLanguageModelFor(modelExecution.control));
  const clinicalResolver = () => resolveLanguageModelFor(modelExecution.clinical);
  const understanding = { understand: (input: string) => understand(input, controlPort) };
  const model = modelProfileForSelection(`clinical-primary:${mode}`, modelExecution.clinical);

  const preparer = mode === 'harness'
    ? new RuntimePreparer({
        understanding,
        safety,
        planner: new StructuredClinicalPlanner(controlPort),
        capabilities,
        skills,
        tools,
        model,
        baselineToolIds: BASELINE_TOOL_IDS,
        baselineSkillIds: BASELINE_SKILL_IDS,
        baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
        // Phase 2/6：Request IR 编译 + 参数化生产规则调度（V2.1 是 harness 的唯一调度主权）。
        controlPlane: { compiler: controlPort, policy: CONTROL_PLANE_V21_POLICY },
        modelExecution,
      })
    : new ClassicRuntimePreparer({
        understanding,
        safety,
        capabilities,
        skills,
        tools,
        model,
        modelExecution,
        baselineToolIds: CLASSIC_BASELINE_TOOL_IDS,
        baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
      });

  const prompt = await loadPromptProfile(
    mode === 'harness' ? 'clinical-primary' : 'clinical-primary-classic',
  );
  // Kernel Commit Boundary：formula source/product binding 校验已移至 CommitCoordinator（commit 阶段 fail-closed）。
  // FormulaAuthorityStage 保留为只读/审计占位关卡，不再依据 proposal.formula.authority 放行。
  const authority = new AuthorityPipeline([
    new SafetyInvariantStage(),
    new FormulaAuthorityStage(),
  ]);

  return new ClinicalRuntime(
    preparer,
    new AiSdkPrimaryAgent({ instructions: prompt.instructions, mode, resolveModel: clinicalResolver }),
    authority,
    prompt.hash,
  );
}

const runtimeCache = new Map<string, ClinicalRuntime>();

/**
 * Clear assembled Runtime cache. Each cached Runtime is already keyed by an immutable run model
 * receipt; clearing is therefore an operational/UI concern, not required for in-flight correctness.
 */
export function resetClinicalRuntimeCache(): void {
  runtimeCache.clear();
}

export async function getClinicalRuntime(
  mode: ClinicalRuntimeMode = config.runtime.mode,
  modelExecution: ModelExecutionReceipt = snapshotModelExecution(),
): Promise<ClinicalRuntime> {
  const key = `${mode}|${modelExecution.key}`;
  const cached = runtimeCache.get(key);
  if (cached) return cached;
  const runtime = await createClinicalRuntime(mode, modelExecution);
  runtimeCache.set(key, runtime);
  return runtime;
}

export interface ClinicalRunResult { result: AgentResult; trace: RunTrace; workspace: ClinicalWorkspace; authority: AuthorityResult; }

export async function runCase(
  input: string,
  options: { mode?: ClinicalRuntimeMode; onEvent?: (event: AgentStreamEvent) => void; model?: RunModelRequest; modelExecution?: ModelExecutionReceipt } = {},
): Promise<ClinicalRunResult> {
  const mode = options.mode ?? config.runtime.mode;
  // Freeze model truth before Runtime construction. UI changes after this line affect the next run only.
  const modelExecution = options.modelExecution ?? snapshotModelExecution(options.model);
  const runtime = await getClinicalRuntime(mode, modelExecution);
  const trace = newTrace(input);
  try {
    const { authority, usage, snapshot, workspace, workspaceEvents, evidenceEvents, candidateComparison, hypothesisEvents, hypothesisComparison, promotionCoverage, candidateAssessments, deliberationCoverage, agentLoop, strategy, contextMetrics, commits } = await runtime.run(input, trace.runId, options.onEvent);
    const result = authority.proposal;
    if (result.mode === 'clinical') result.run_id = trace.runId;
    finishTrace(trace.runId, { finalResult: result, usage, snapshot, workspaceEvents, evidenceEvents, candidateComparison, hypothesisEvents, hypothesisComparison, promotionCoverage, candidateAssessments, deliberationCoverage, agentLoop, clinicalStrategy: strategy, contextMetrics, commits });
    return { result, trace, workspace, authority };
  } catch (e) {
    finishTrace(trace.runId, { error: e instanceof Error ? e.message : String(e) });
    const err = e instanceof Error ? e : new Error(String(e));
    (err as Error & { runId?: string }).runId = trace.runId;
    throw err;
  }
}
