import { mkdirSync, writeFileSync } from 'node:fs';
import { runCase } from '../src/composition/runtime.js';

/**
 * Control Plane V2.1 E2E 验证。
 *
 * 覆盖 TRAE_EXECUTION.md 要求的语义矩阵：
 * 只针灸 / 针灸+膏方 / 多个方 / KB 不足允许模型生成 / 全新 modality（拔罐，未安装 provider）。
 *
 * 输出：Request IR、obligation graph 终态、typed blocker、shadow action-surface 分歧、最终交付状态。
 */

const CASE = '女，42岁。经期腹痛剧烈，经量多夹血块，平素畏寒肢冷，腰膝酸软，面色少华，舌淡暗有瘀点，脉沉细涩。';

interface Scenario {
  id: string;
  goal: string;
  input: string;
}

/** 重复调用检测：同名工具累计调用次数 > 1 即视为一次重复（仅观测，不改变行为）。 */
function duplicateCalls(toolNames: string[]): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

const SCENARIOS: Scenario[] = [
  { id: 'acupuncture-only', goal: '只针灸（exclusive，不要汤药）', input: `只做针灸，不要开汤药。${CASE}` },
  { id: 'acupuncture-gaofang', goal: '针灸 + 膏方', input: `既要针灸，也想开一料膏方长期调理。${CASE}` },
  { id: 'multi-formula', goal: '多个方（至少三个合适方）', input: `请辨证后给我至少三个合适的方子备选。${CASE}` },
  { id: 'kb-insufficient-model-allowed', goal: 'KB 不足时允许模型给思路', input: `如果知识库里没有特别合适的方子，你可以自己给一个拟方思路。${CASE}` },
  { id: 'unknown-modality', goal: '全新 modality：拔罐（未安装 provider）', input: `在针灸基础上再加拔罐方案。${CASE}` },
];

async function main(): Promise<void> {
  const only = process.argv[2];
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`unknown scenario: ${only}`);

  const report: Record<string, unknown>[] = [];
  for (const scenario of scenarios) {
    const started = Date.now();
    try {
      const { result, trace, authority, workspace } = await runCase(scenario.input, { mode: 'harness' });
      const cp = trace.agentLoop?.controlPlane;
      const ws = trace.workspaceEvents ?? [];
      report.push({
        scenario: scenario.id,
        goal: scenario.goal,
        elapsedMs: Date.now() - started,
        resultMode: result.mode,
        authority: authority.status,
        termination: trace.agentLoop?.terminationReason,
        steps: trace.agentLoop?.stepCount,
        forcedFinalization: trace.agentLoop?.forcedFinalization,
        finalizationContextFields: trace.agentLoop?.commitReliability?.proposalDraftFieldCount,
        retrievalCalls: (trace.toolCalls ?? [])
          .filter((t) => t.toolName.startsWith('knowledge.') || t.toolName.startsWith('formula.'))
          .map((t) => `${t.toolName} ${JSON.stringify(t.input ?? {}).slice(0, 120)}`),
        toolCalls: (trace.toolCalls ?? []).map((t) => t.toolName),
        workspaceEventTypes: ws.map((e) => e.type),
        treatmentPlans: ws.filter((e) => e.type === 'treatment.plan.recorded').map((e) => Object.keys(e.payload)),
        completionRequired: trace.runMetrics?.completionRequiredArtifacts,
        completionMissingAtEnd: trace.runMetrics?.completionMissingArtifactsAtEnd,
        selectedCandidateRef: trace.runMetrics?.selectedCandidateRef,
        controlPlane: cp
          ? {
              compileStatus: cp.requestCompileStatus,
              compileError: cp.requestCompileError,
              // Request IR
              requestIR: {
                required: cp.requiredOutcomes,
                preferred: cp.preferredOutcomes,
                excluded: cp.excludedOutcomes,
                unresolved: cp.unresolvedOutcomes,
                exclusive: cp.exclusive,
                formulaCardinality: cp.formulaCardinality,
                knowledgeSourcePolicy: cp.knowledgeSourcePolicy,
              },
              graphComplete: cp.graphComplete,
              unmet: cp.unmetObligations,
              blocked: cp.blockedObligations,
              notDeliverable: cp.notDeliverableObligations,
              issues: cp.planningIssues,
              blockers: cp.appliedBlockers,
              coverage: cp.outcomeCoverage,
              // obligation DAG（含 resolved provider）
              obligations: cp.obligations,
              // 调度遥测：每步 runnable obligation + legal effect surface
              steps: cp.steps,
              // 与 runtime 同一真源的 readiness
              readiness: cp.readiness,
              graphCompleteButNotReady: cp.graphComplete && !cp.readiness.ready,
            }
          : null,
        // 重复 search / 重复 activate 观测
        repeatedRetrieval: duplicateCalls(
          (trace.toolCalls ?? [])
            .map((t) => t.toolName)
            .filter((n) => n.startsWith('knowledge.') || n.startsWith('formula.')),
        ),
        repeatedControl: duplicateCalls(
          (trace.toolCalls ?? []).map((t) => t.toolName).filter((n) => n.startsWith('capability.')),
        ),
        // 证据/交付闭环真源（确定性；用于核对 retrieval 推进与 closure）
        evidenceReceipts: workspace.capabilityEvidenceReceipts,
        evidenceClosures: workspace.capabilityEvidenceClosures,
        deliveryClosures: workspace.capabilityDeliveryClosures,
        // formula-evidence closure 的两个输入（frontier × hydrated candidates）
        deliberationFrontier: workspace.deliberationState.frontier,
        hydratedCandidateRefs: workspace.evidenceState.evidenceItems
          .flatMap((e) => e.relatedCandidates),
        treatmentDeliveries: workspace.clinicalDecisionSpine.treatmentPlan?.treatmentDeliveries
          ?? (workspace.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision
            ? [workspace.clinicalDecisionSpine.treatmentPlan.treatmentFormDecision]
            : undefined),
        unresolvedHypotheses: trace.hypothesisComparison
          ?.filter((h) => h.status === 'alternative')
          .map((h) => h.label),
        // 模型实际提交的提交类 payload（用于区分「模型没写」与「写了但被拒绝」）
        deliberationInputs: (trace.toolCalls ?? [])
          .filter((t) => t.toolName === 'workspace.record_deliberation')
          .map((t) => {
            const plan = (t.input as Record<string, unknown> | undefined)?.treatmentPlan as Record<string, unknown> | undefined;
            return {
              keys: Object.keys((t.input as Record<string, unknown>) ?? {}),
              treatmentPlanKeys: plan ? Object.keys(plan) : [],
              deliveries: Array.isArray(plan?.treatmentDeliveries) ? plan.treatmentDeliveries.length : 0,
              hasLegacyForm: Boolean(plan?.treatmentFormDecision),
              formulaSelection: Boolean((t.input as Record<string, unknown>)?.formulaSelection),
            };
          }),
        // 最终用户结果（确定性投影）
        finalResult:
          result.mode === 'clinical'
            ? {
                mode: result.mode,
                formula: (result as Record<string, unknown>).formula,
                formula_set: (result as Record<string, unknown>).formula_set,
                treatment_deliveries: (result as Record<string, unknown>).treatment_deliveries,
                missing_information: result.missing_information,
              }
            : { mode: result.mode, message: (result as Record<string, unknown>).message },
        missing_information: result.mode === 'clinical' ? result.missing_information : undefined,
      });
    } catch (error) {
      report.push({
        scenario: scenario.id,
        goal: scenario.goal,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  mkdirSync('reports', { recursive: true });
  const out = `reports/control-plane-v21-e2e-v21${only ? `-${only}` : ''}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  for (const item of report) {
    const cp = item.controlPlane as Record<string, unknown> | null;
    const readiness = cp?.readiness as { ready: boolean; blockerCodes: string[] } | undefined;
    console.log(
      `[e2e] ${item.scenario} mode=${item.resultMode} term=${item.termination} steps=${item.steps}`
      + ` compile=${cp?.compileStatus} complete=${cp?.graphComplete} ready=${readiness?.ready}`
      + ` ir=${JSON.stringify((cp?.requestIR as Record<string, unknown> | undefined)?.required)}`
      + ` unresolved=${JSON.stringify((cp?.requestIR as Record<string, unknown> | undefined)?.unresolved)}`
      + ` unmet=${(cp?.unmet as unknown[] | undefined)?.length ?? 0}`
      + ` issues=${JSON.stringify(cp?.issues)}`
      + ` coverage=${JSON.stringify(cp?.coverage)}`
      + ` dupRetrieval=${JSON.stringify(item.repeatedRetrieval)} dupControl=${JSON.stringify(item.repeatedControl)}`
      + ` graphCompleteButNotReady=${cp?.graphCompleteButNotReady}`,
    );
  }
  console.log(`[e2e] report -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
