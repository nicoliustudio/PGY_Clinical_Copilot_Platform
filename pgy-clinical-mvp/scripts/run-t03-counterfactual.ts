import { runCase } from '../src/composition/runtime.js';

/**
 * B2 — T03 术后病例 counterfactual sensitivity 检查。
 * 观察「真正 decision-changing 当前证据」变化时，主证是否相应变化，
 * 而非粘住初始 hypothesis（confirmation bias）。
 *
 * A 原病例
 * B 去掉历史血块/剧痛，保留当前舌暗脉涩
 * C 保留历史瘀象，去掉/减弱当前瘀象
 * D 加强当前肝郁脾虚的真正鉴别证据
 */

interface CaseSpec {
  id: string;
  input: string;
}

const CASES: CaseSpec[] = [
  {
    id: 'A',
    input: '甄某某，女，32岁。主诉：子宫肿块海扶术治疗后一月，要求配合中医治疗。既往因进行性经行下腹疼痛2+年诊断子宫肌瘤、子宫腺肌瘤并行HIFU。上次月经量多、色黯、有较多血块且腹痛剧烈。现患者无明显腹痛，但觉腹胀，无法集中精力，疲乏困顿，无烦躁，无胸闷气促，食欲可，寐安，二便尚正常。舌偏暗，苔白，脉弦细涩。',
  },
  {
    id: 'B',
    input: '甄某某，女，32岁。主诉：子宫肿块海扶术治疗后一月，要求配合中医治疗。既往因进行性经行下腹疼痛2+年诊断子宫肌瘤、子宫腺肌瘤并行HIFU。现患者无明显腹痛，但觉腹胀，无法集中精力，疲乏困顿，无烦躁，无胸闷气促，食欲可，寐安，二便尚正常。舌偏暗，苔白，脉弦细涩。',
  },
  {
    id: 'C',
    input: '甄某某，女，32岁。主诉：子宫肿块海扶术治疗后一月，要求配合中医治疗。既往因进行性经行下腹疼痛2+年诊断子宫肌瘤、子宫腺肌瘤并行HIFU。上次月经量多、色黯、有较多血块且腹痛剧烈。现患者无明显腹痛，但觉腹胀，无法集中精力，疲乏困顿，无烦躁，无胸闷气促，食欲可，寐安，二便尚正常。舌淡红，苔白，脉弦。',
  },
  {
    id: 'D',
    input: '甄某某，女，32岁。主诉：子宫肿块海扶术治疗后一月，要求配合中医治疗。既往因进行性经行下腹疼痛2+年诊断子宫肌瘤、子宫腺肌瘤并行HIFU。上次月经量多、色黯、有较多血块且腹痛剧烈。现患者无明显腹痛，但觉腹胀，情绪抑郁，善太息，两胁胀满，无法集中精力，疲乏困顿，纳差，大便溏，无烦躁，无胸闷气促，寐安。舌淡红，苔白，脉弦细。',
  },
];

// A 跑 3 次，B/C/D 各跑 2 次。
const RUNS: Record<string, number> = { A: 3, B: 2, C: 2, D: 2 };

function summarize(id: string, r: Awaited<ReturnType<typeof runCase>>): void {
  const ws = r.workspace as {
    patternAssessment?: { primary?: { statement?: string; hypothesisRef?: string } };
    hypothesisState?: { hypotheses?: Array<{ id: string; label: string; status: string }> };
    clinicalDecisionSpine?: {
      diseaseAssessment?: { statement?: string };
      treatmentPlan?: { primaryPrinciple?: string };
    };
  };
  const spine = ws.clinicalDecisionSpine ?? {};
  const leading = (ws.hypothesisState?.hypotheses ?? []).find((h) => h.status === 'active')
    ?? (ws.hypothesisState?.hypotheses ?? [])[0];
  const term = r.trace.agentLoop?.terminationReason ?? '?';
  const formulaName = r.result.mode === 'clinical' ? (r.result.formula?.name ?? '无') : '-';

  console.log(
    `[${id}] mode=${r.result.mode} term=${term}\n` +
    `  disease=${spine.diseaseAssessment?.statement ?? '-'}\n` +
    `  primary=${ws.patternAssessment?.primary?.statement ?? '-'}\n` +
    `  leadingHyp=${leading?.label ?? '-'}(${leading?.status ?? '-'})\n` +
    `  principle=${spine.treatmentPlan?.primaryPrinciple ?? '-'}\n` +
    `  formula=${formulaName}`,
  );
}

const results: string[] = [];

for (const c of CASES) {
  const n = RUNS[c.id] ?? 1;
  for (let i = 1; i <= n; i++) {
    const started = Date.now();
    try {
      const r = await runCase(c.input);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const ws = r.workspace as { patternAssessment?: { primary?: { statement?: string } } };
      const term = r.trace.agentLoop?.terminationReason ?? '?';
      results.push(
        `[${c.id}#${i}] mode=${r.result.mode} term=${term} primary=${ws.patternAssessment?.primary?.statement ?? '-'} ` +
        `formula=${r.result.mode === 'clinical' ? (r.result.formula?.name ?? '无') : '-'} ${elapsed}s`,
      );
      summarize(`${c.id}#${i}`, r);
    } catch (e) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      results.push(`[${c.id}#${i}] ERROR ${e instanceof Error ? e.message : e} ${elapsed}s`);
      console.log(`[${c.id}#${i}] ERROR ${elapsed}s: ${e instanceof Error ? e.message : e}`);
    }
  }
}

console.log('\n========== T03 counterfactual 汇总 ==========');
for (const line of results) console.log(line);
