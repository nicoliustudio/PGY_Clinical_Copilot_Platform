import { mkdirSync, writeFileSync } from 'node:fs';
import { runCase } from '../src/composition/runtime.js';

/**
 * Control Plane V2.1.2 Closure —— 最小真实 E2E（3 例 × 1 次，不重复稳定性测试）。
 *
 * T02 子宫肌瘤：验证 formula frontier 是否自然闭合（candidate → evidence → assessment → selection）。
 * T08 失眠仅辨证：验证 Request IR 排除开方 → clinical-core 完成即正确停止，不被强迫进入 formula selection。
 * T17 产后腰痛：验证多 modality 语义解析、unsupported modality 不得静默吸附、不得强制方剂。
 */

interface Scenario {
  id: string;
  goal: string;
  input: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'T02-uterine-fibroid',
    goal: '常规辨证开方（formula frontier 自然闭合）',
    input: '患者于1978年经上海市第二军医大学妇科检查发现子宫肌瘤。月经超前量多四年余，经后带下绵绵，并有腥味，大便秘结。于1981年10月31日B型超声波检查报告：子宫前位，大小4.3cm×6.1cm×7.8cm。子宫左后壁向外突出，呈一实质性暗区，大小约2.4cm×3.0cm，与宫壁间无明显分界，提示为小型子宫肌瘤。',
  },
  {
    id: 'T08-insomnia-pattern-only',
    goal: '只辨证不开方（不得强迫选方）',
    input: '陈某，女，45岁，更年期综合征，失眠3年，近期加重。入睡困难、多梦易醒，每晚睡2～3小时；伴心烦心悸、口干咽燥、手足心热、盗汗、舌尖溃疡；舌红少苔、舌尖红赤，脉细数。甲状腺功能正常。本次只需要辨证和治法，不需要开方。',
  },
  {
    id: 'T17-postpartum-lowback',
    goal: '针灸为主 + 艾灸/拔罐，不要汤药（多 modality 语义解析）',
    input: '产后腰腹空痛，足跟疼痛，恶露量少，头晕耳鸣，两眼干涩。苔薄，脉细。希望以针灸为主，可以考虑艾灸或拔罐，请不要开汤药。',
  },
];

function duplicateCalls(toolNames: string[]): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

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
      report.push({
        scenario: scenario.id,
        goal: scenario.goal,
        elapsedMs: Date.now() - started,
        resultMode: result.mode,
        authority: authority.status,
        termination: trace.agentLoop?.terminationReason,
        steps: trace.agentLoop?.stepCount,
        toolCalls: (trace.toolCalls ?? []).map((t) => t.toolName),
        repeatedRetrieval: duplicateCalls(
          (trace.toolCalls ?? []).map((t) => t.toolName)
            .filter((n) => n.startsWith('knowledge.') || n.startsWith('formula.')),
        ),
        requestIR: cp ? {
          required: cp.requiredOutcomes,
          preferred: cp.preferredOutcomes,
          excluded: cp.excludedOutcomes,
          mentions: cp.mentionOutcomes,
          unresolved: cp.unresolvedOutcomes,
          preferredShortfalls: cp.preferredShortfalls,
          exclusive: cp.exclusive,
          formulaCardinality: cp.formulaCardinality,
          knowledgeSourcePolicy: cp.knowledgeSourcePolicy,
        } : undefined,
        semanticValidation: cp?.semanticValidation,
        issues: cp?.planningIssues,
        graphComplete: cp?.graphComplete,
        readiness: cp?.readiness,
        graphCompleteButNotReady: cp ? cp.graphComplete && !cp.readiness.ready : undefined,
        obligations: cp?.obligations,
        outcomeCoverage: cp?.outcomeCoverage,
        deliveries: workspace.clinicalDecisionSpine.treatmentPlan?.treatmentDeliveries
          ?? (workspace.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision
            ? [workspace.clinicalDecisionSpine.treatmentPlan.treatmentFormDecision]
            : undefined),
        selectedCandidateRef: workspace.clinicalDecisionSpine.formulaSelection?.selectedCandidateRef,
        patternPrimary: workspace.patternAssessment?.primary?.statement,
        finalResult: result.mode === 'clinical'
          ? {
              formula: (result as Record<string, unknown>).formula,
              formula_set: (result as Record<string, unknown>).formula_set,
              treatment_deliveries: (result as Record<string, unknown>).treatment_deliveries,
              missing_information: result.missing_information,
            }
          : { message: (result as Record<string, unknown>).message },
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
  const out = `reports/control-plane-v212-e2e${only ? `-${only}` : ''}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  for (const item of report) {
    const readiness = item.readiness as { ready: boolean; missingArtifacts: string[] } | undefined;
    const ir = item.requestIR as Record<string, unknown> | undefined;
    console.log(
      `[v212] ${item.scenario} mode=${item.resultMode} term=${item.termination} steps=${item.steps}`
      + ` complete=${item.graphComplete} ready=${readiness?.ready}`
      + ` required=${JSON.stringify((ir?.required as string[] | undefined) ?? [])}`
      + ` mentions=${JSON.stringify(ir?.mentions ?? [])}`
      + ` unresolved=${JSON.stringify((ir?.unresolved as string[] | undefined) ?? [])}`
      + ` shortfall=${JSON.stringify((ir?.preferredShortfalls as string[] | undefined) ?? [])}`
      + ` coverage=${JSON.stringify(item.outcomeCoverage)}`
      + ` miss=${JSON.stringify(readiness?.missingArtifacts ?? [])}`
      + ` dup=${JSON.stringify(item.repeatedRetrieval)}`,
    );
  }
  console.log(`[v212] report -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
