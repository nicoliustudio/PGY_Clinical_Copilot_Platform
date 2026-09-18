import { runCase } from '../src/composition/runtime.js';
import { StructuredClinicalPlanner } from '../src/platform/planning/clinical-planner.js';
import { aiSdkFastModelPort } from '../src/adapters/ai-sdk/model-adapter.js';

const CASE = '子宫肌瘤确诊。月经于7月28日初潮，来潮后，经量过多如注，夹有血块，导致严重贫血，曾经输血并服用激素妇宁片治疗。第一妇幼保健院B型超声波检查提示为粘膜下小型子宫肌瘤。胸闷作满，面色少华，经后带下绵绵，苔薄，舌边红，脉弦细。';

async function measurePlannerLatency(): Promise<number> {
  const planner = new StructuredClinicalPlanner(aiSdkFastModelPort);
  const started = Date.now();
  await planner.plan({
    input: CASE,
    understanding: {
      interaction: { mode: 'clinical' },
      facts: [],
      intents: [],
      risks: [],
      informationGaps: [],
      capabilityNeeds: [],
      uncertainties: [],
    },
    safety: { status: 'PASS', reasons: [], blockNormativeCommit: false },
    availableCapabilities: [],
  });
  return Date.now() - started;
}

async function main(): Promise<void> {
  console.log('[acceptance] 测量 Planner 延迟（fast model）...');
  const plannerLatency = await measurePlannerLatency();
  console.log(`[acceptance] Planner latency = ${plannerLatency}ms\n`);

  console.log('[acceptance] 运行子宫肌瘤病例（H3 Phase 2 / deepseek）...');
  const started = Date.now();
  const { result, trace, authority } = await runCase(CASE, { mode: 'harness' });
  const elapsed = Date.now() - started;

  const toolCalls = trace.toolCalls ?? [];
  const count = (name: string) => toolCalls.filter((t) => t.toolName === name).length;
  const workspaceWrites = toolCalls.filter((t) => t.toolName.startsWith('workspace.')).length;
  const loop = trace.agentLoop;
  const cm = trace.contextMetrics;

  const report = {
    plannerLatencyMs: plannerLatency,
    elapsedMs: elapsed,
    resultMode: result.mode,
    authorityReached: authority.status,
    formulaAuthority: result.mode === 'clinical' ? result.formula.authority : undefined,
    strategy: trace.clinicalStrategy
      ? { goal: trace.clinicalStrategy.goal, primaryQuestion: trace.clinicalStrategy.primaryQuestion }
      : null,
    agentLoop: loop
      ? {
          stepCount: loop.stepCount,
          terminationReason: loop.terminationReason,
          forcedFinalization: loop.forcedFinalization,
          proposalSubmitted: loop.proposalSubmitted,
        }
      : null,
    usage: trace.usage,
    contextMetrics: cm,
    toolCalls: {
      total: toolCalls.length,
      knowledgeSearch: count('knowledge.search'),
      formulaSearch: count('formula.search_normative'),
      getSource: count('knowledge.get_source'),
      formulaValidate: count('formula.validate'),
      capabilityActivate: count('capability.activate'),
      proposalSubmit: count('proposal.submit'),
      workspaceWrites,
    },
    workspaceEvents: trace.workspaceEvents?.length,
    toolTrace: toolCalls.map((t) => ({ tool: t.toolName, ms: t.ms })),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
