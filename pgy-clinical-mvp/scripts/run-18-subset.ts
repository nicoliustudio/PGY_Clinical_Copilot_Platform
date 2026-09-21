import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runCase } from '../src/composition/runtime.js';

/**
 * 18 例测试集子集（T01/T03/T07/T11/T13/T15）全链路数据采集。
 * 进程内直接调 runCase（等价于 /api/run/stream 的 harness assembly），
 * 落盘完整 ClinicalRunResult，供后续渲染为参考格式 md。
 */

interface CaseSpec {
  id: string;
  title: string;
  input: string;
}

const CASES: CaseSpec[] = [
  {
    id: 'T01',
    title: '基础方｜妇科·月经后期',
    input: '经行后期，量少色淡清稀。下腹隐痛，喜用热敷，腰痠肢软，纳少便溏。苔薄，舌淡，脉沉细。',
  },
  {
    id: 'T03',
    title: '基础方｜妇科·子宫肌瘤术后',
    input: '甄某某，女，32岁。主诉：子宫肿块海扶术治疗后一月，要求配合中医治疗。既往因进行性经行下腹疼痛2+年诊断子宫肌瘤、子宫腺肌瘤并行HIFU。上次月经量多、色黯、有较多血块且腹痛剧烈。现患者无明显腹痛，但觉腹胀，无法集中精力，疲乏困顿，无烦躁，无胸闷气促，食欲可，寐安，二便尚正常。舌偏暗，苔白，脉弦细涩。',
  },
  {
    id: 'T07',
    title: '基础方｜内科·便秘',
    input: '患者，男，72岁。大便干结难解1年，每3~4天排便1次，排便时费力，伴口干咽燥，手足心热，心烦失眠，舌质红、少苔，脉细数。既往无肠道器质性疾病病史。',
  },
  {
    id: 'T11',
    title: '膏方｜妇科·月经失调膏方',
    input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。患者希望冬令长期调理，明确要求以膏代煎药，请按膏方思路给方案，不想每天煎汤药。',
  },
  {
    id: 'T13',
    title: '膏方｜内科·肺结核后调养膏方',
    input: '宋某，男，42岁。肺结核1年，已规律接受抗痨治疗。现干咳少痰，偶带血丝，午后潮热，夜间盗汗，神疲乏力，腰膝酸软，面色㿠白，体重下降。胸部CT示双肺上叶结核病灶部分纤维化；舌红少苔，脉细数无力。在继续规范抗痨治疗的前提下，希望用膏方长期调养，明确不要把膏方当作替代抗痨治疗。',
  },
  {
    id: 'T15',
    title: '针灸｜妇科·痛经针灸',
    input: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。',
  },
];

const outDir = path.resolve('reports', 'raw-18-subset');
mkdirSync(outDir, { recursive: true });

for (const c of CASES) {
  const started = Date.now();
  console.log(`\n[run] ${c.id} 开始：${c.title}`);
  try {
    const { result, trace, workspace, authority } = await runCase(c.input);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const summary = {
      id: c.id,
      title: c.title,
      input: c.input,
      runId: trace.runId,
      startedAt: trace.startedAt,
      finishedAt: trace.finishedAt,
      totalMs: trace.totalMs,
      result,
      trace,
      workspace,
      authority,
    };
    const file = path.join(outDir, `${c.id}.json`);
    writeFileSync(file, JSON.stringify(summary, null, 2));
    console.log(
      `[done] ${c.id}  ${elapsed}s  runId=${trace.runId}  mode=${result.mode}  ` +
        `${result.mode === 'conversation' ? result.message : result.mode === 'clarification' ? `questions=${result.questions?.length ?? 0}` : 'clinical'}`,
    );
  } catch (e) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.error(`[error] ${c.id}  ${elapsed}s  ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n[all] 输出目录：${outDir}`);
