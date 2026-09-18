import { understand } from '../clinical/understanding.js';
import { aiSdkModelPort } from '../adapters/ai-sdk/model-adapter.js';
import { AiSdkPrimaryAgent } from '../adapters/ai-sdk/agent-runtime.js';
import { DeterministicFormulaAuthority } from '../authority/formula-authority.js';
import { config } from '../config.js';
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
  BASELINE_TOOL_IDS,
  CLASSIC_BASELINE_TOOL_IDS,
  PLATFORM_TOOLS,
} from './platform-assets.js';

export type ClinicalRuntimeMode = 'harness' | 'classic';

/** Composition root: runtime mode is an A/B infrastructure switch, never a clinical branch. */
export async function createClinicalRuntime(
  mode: ClinicalRuntimeMode = config.runtime.mode,
): Promise<ClinicalRuntime> {
  const manifests = await discoverCapabilityManifests();
  const capabilities = new CapabilityRegistry(manifests);
  const skills = new SkillRegistry(await loadSkills(manifests.flatMap((m) => m.skillIds)));
  const tools = new ToolRegistry(PLATFORM_TOOLS);
  const safety = new RiskHypothesisSafetyPort();
  const understanding = { understand: (input: string) => understand(input, aiSdkModelPort) };
  const model = { id: `clinical-primary:${mode}`, model: config.llm.deepModel };

  const preparer = mode === 'harness'
    ? new RuntimePreparer({
        understanding,
        safety,
        capabilities,
        skills,
        tools,
        model,
        baselineToolIds: BASELINE_TOOL_IDS,
        baselineSkillIds: ['general-clinical-reasoning'],
        baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
      })
    : new ClassicRuntimePreparer({
        understanding,
        safety,
        capabilities,
        skills,
        tools,
        model,
        baselineToolIds: CLASSIC_BASELINE_TOOL_IDS,
        baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
      });

  const prompt = await loadPromptProfile(
    mode === 'harness' ? 'clinical-primary' : 'clinical-primary-classic',
  );
  const authority = new AuthorityPipeline([
    new SafetyInvariantStage(),
    new FormulaAuthorityStage(new DeterministicFormulaAuthority()),
  ]);

  return new ClinicalRuntime(
    preparer,
    new AiSdkPrimaryAgent({ instructions: prompt.instructions, mode }),
    authority,
    prompt.hash,
  );
}

const runtimeCache = new Map<ClinicalRuntimeMode, ClinicalRuntime>();

export async function getClinicalRuntime(
  mode: ClinicalRuntimeMode = config.runtime.mode,
): Promise<ClinicalRuntime> {
  const cached = runtimeCache.get(mode);
  if (cached) return cached;
  const runtime = await createClinicalRuntime(mode);
  runtimeCache.set(mode, runtime);
  return runtime;
}

export interface ClinicalRunResult { result: AgentResult; trace: RunTrace; workspace: ClinicalWorkspace; authority: AuthorityResult; }

export async function runCase(
  input: string,
  options: { mode?: ClinicalRuntimeMode; onEvent?: (event: AgentStreamEvent) => void } = {},
): Promise<ClinicalRunResult> {
  const mode = options.mode ?? config.runtime.mode;
  const runtime = await getClinicalRuntime(mode);
  const trace = newTrace(input);
  try {
    const { authority, usage, snapshot, workspace, workspaceEvents, evidenceEvents, candidateComparison, hypothesisEvents, hypothesisComparison, promotionCoverage, candidateAssessments, deliberationCoverage, agentLoop } = await runtime.run(input, trace.runId, options.onEvent);
    const result = authority.proposal;
    if (result.mode === 'clinical') result.run_id = trace.runId;
    finishTrace(trace.runId, { finalResult: result, usage, snapshot, workspaceEvents, evidenceEvents, candidateComparison, hypothesisEvents, hypothesisComparison, promotionCoverage, candidateAssessments, deliberationCoverage, agentLoop });
    return { result, trace, workspace, authority };
  } catch (e) {
    finishTrace(trace.runId, { error: e instanceof Error ? e.message : String(e) });
    const err = e instanceof Error ? e : new Error(String(e));
    (err as Error & { runId?: string }).runId = trace.runId;
    throw err;
  }
}
