import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * 18-case full coverage evaluation. EVALUATION ONLY.
 */

const modelId = config.llm.deepModel;
const CONCURRENCY = Number(process.env.H18_CONCURRENCY ?? 6);

type TaskIntent = 'formula' | 'pattern_only' | 'gaofang' | 'acupuncture' | 'preparation';

interface CaseDef { id: string; taskIntent: TaskIntent; input: string; ref: string; }

const CASES: CaseDef[] = [
  { id: 'T01', taskIntent: 'formula', ref: '月经后期-血寒-温经散寒养血-大营煎', input: '经行后期，量少色淡清稀。下腹隐痛，喜用热敷，腰痠肢软，纳少便溏。苔薄，舌淡，脉沉细。' },
  { id: 'T02', taskIntent: 'formula', ref: '子宫肌瘤-气滞血瘀-理气活血化瘀-桂枝茯苓丸', input: '患者于1978年经上海市第二军医大学妇科检查发现子宫肌瘤。月经超前量多四年余，经后带下绵绵，并有腥味，大便秘结。于1981年10月31日B型超声波检查报告：子宫前位，大小4.3cm×6.1cm×7.8cm。子宫左后壁向外突出，呈一实质性暗区，大小约2.4cm×3.0cm，与宫壁间无明显分界，提示为小型子宫肌瘤。' },
  { id: 'T03', taskIntent: 'formula', ref: '子宫肌瘤海扶术后-当前肝郁脾虚vs既往血瘀-健脾升清疏肝散结-妇2号方', input: '甄某某，女，32岁。主诉：子宫肿块海扶术治疗后一月，要求配合中医治疗。既往因进行性经行下腹疼痛2+年诊断子宫肌瘤、子宫腺肌瘤并行HIFU。上次月经量多、色黯、有较多血块且腹痛剧烈。现患者无明显腹痛，但觉腹胀，无法集中精力，疲乏困顿，无烦躁，无胸闷气促，食欲可，寐安，二便尚正常。舌偏暗，苔白，脉弦细涩。' },
  { id: 'T04', taskIntent: 'formula', ref: '带下病白带-脾虚-健脾益气除湿止带-参苓白术散/完带汤', input: '白带过多一周，色乳白，素有盆腔炎。LMP5月25日，5天净止，量中，色鲜红，少量血块；夜寐难以入睡，凌晨盗汗，腰酸，口渴多饮，少腹寒冷，纳可，二便调。舌淡苔白腻，脉濡滑。' },
  { id: 'T05', taskIntent: 'formula', ref: '咳嗽-风痰恋肺-宣肺化痰-肺系基础方', input: '张某，女，42岁，受凉后起病。咳嗽3周，阵发性咽痒即咳，痰白黏量中、难咯，夜间及遇风加重；胸闷、偶有喘息，纳可，二便调。外院予抗生素及止咳药效差，肺CT未见明显异常。双肺呼吸音清，无啰音；舌淡红、苔白腻，脉弦滑。' },
  { id: 'T06', taskIntent: 'formula', ref: '胃痛-湿热气滞-和胃降浊疏肝理气-左金丸类', input: '患者，男，38岁。反复胃脘胀痛3月余，加重1周，胀痛以餐后1小时明显，伴反酸、口苦，口中黏腻，大便黏滞不畅，小便偏黄，舌质红、苔黄腻，脉滑数。平素喜食辛辣、肥甘食物，既往无胃病史。' },
  { id: 'T07', taskIntent: 'formula', ref: '便秘-阴液亏损郁热-养血增液和胃通幽-当归肉苁蓉类', input: '患者，男，72岁。大便干结难解1年，每3~4天排便1次，排便时费力，伴口干咽燥，手足心热，心烦失眠，舌质红、少苔，脉细数。既往无肠道器质性疾病病史。' },
  { id: 'T08', taskIntent: 'pattern_only', ref: '失眠-阴虚心火偏亢-养阴宁心-不开方', input: '陈某，女，45岁，更年期综合征，失眠3年，近期加重。入睡困难、多梦易醒，每晚睡2～3小时；伴心烦心悸、口干咽燥、手足心热、盗汗、舌尖溃疡；舌红少苔、舌尖红赤，脉细数。甲状腺功能正常。本次只需要辨证和治法，不需要开方。' },
  { id: 'T09', taskIntent: 'pattern_only', ref: '月经推迟-信息不足-不强行辨证-不开方', input: '患者女，29岁。近两个月月经各推迟约10天，经量较平时略少。未提供腹痛、寒热、带下、睡眠、饮食、二便等伴随情况，也未提供舌象和脉象。想知道中医属于什么证。先判断现有信息是否足够，不要猜。' },
  { id: 'T10', taskIntent: 'formula', ref: '哮证-肺脾两虚挟痰浊-养肺顺气化痰平喘-哮证基础方', input: '赵某，男，45岁。支气管哮喘病史10年，慢性持续期。反复胸闷喘息，喉中哮鸣，遇冷或劳累诱发；咳白稀痰、量多，气短声低，自汗怕风，易感冒。长期吸入布地奈德福莫特罗，仍有间断发作。双肺呼气相哮鸣音；舌淡胖、苔白腻，脉细滑。肺功能示FEV1占预计值78%，支气管舒张试验阳性。' },
  { id: 'T11', taskIntent: 'gaofang', ref: '月经失调膏方-气血不足脾肾两亏-膏方调理-GF010', input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。患者希望冬令长期调理，明确要求以膏代煎药，请按膏方思路给方案，不想每天煎汤药。' },
  { id: 'T12', taskIntent: 'gaofang', ref: '虚劳膏方-脾肾两亏卫阳不足-温补脾肾益气固表-GF007', input: '周某，女，39岁，企业文员。神疲乏力、反复感冒2年，加重1月。近2年体质虚弱，每遇气候变化即感冒，伴面色萎黄，食欲不振，腹胀便溏（每日2~3次），畏寒肢冷，自汗易感，腰膝酸软。血红蛋白105g/L，IgG略偏低。舌淡胖，边有齿痕，苔薄白，脉沉细无力。希望趁冬令开膏方调体，重点改善反复感冒和虚弱，不想长期服普通汤剂。' },
  { id: 'T13', taskIntent: 'gaofang', ref: '肺结核后膏方-肺肾阴亏气血不足-调养肺肾益气养阴-GF001', input: '宋某，男，42岁。肺结核1年，已规律接受抗痨治疗。现干咳少痰，偶带血丝，午后潮热，夜间盗汗，神疲乏力，腰膝酸软，面色㿠白，体重下降。胸部CT示双肺上叶结核病灶部分纤维化；舌红少苔，脉细数无力。在继续规范抗痨治疗的前提下，希望用膏方长期调养，明确不要把膏方当作替代抗痨治疗。' },
  { id: 'T14', taskIntent: 'formula', ref: '月经失调-无膏方意图-常规辨证开方-不得触发膏方', input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。请按中医辨证给出治疗建议。' },
  { id: 'T15', taskIntent: 'acupuncture', ref: '痛经针灸-气滞-疏肝理气调经止痛-AC049', input: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。' },
  { id: 'T16', taskIntent: 'acupuncture', ref: '人流后闭经针灸-肝肾不足-补益肝肾和营通经-AC002', input: '人流后月经不转，头晕乏力，腰膝痠软，四肢畏寒，带少几无。苔薄淡，脉细弱。患者明确希望优先采用针灸/耳针调理，不需要中药处方。' },
  { id: 'T17', taskIntent: 'acupuncture', ref: '产后腰痛针灸-肾虚-益肾养血和络补腰-AC005', input: '产后腰腹空痛，足跟疼痛，恶露量少，头晕耳鸣，两眼干涩。苔薄，脉细。希望以针灸为主，可以考虑艾灸或拔罐，请不要开汤药。' },
  { id: 'T18', taskIntent: 'preparation', ref: '人流后恶露不净-气血两虚-益气祛瘀生新-益母草膏PR003', input: '人流后恶露淋漓不净，色淡质稀，面色㿠白，神疲乏力，头晕乏力。苔薄，舌淡，脉细弱。患者不方便煎药，明确想优先了解成药或现成膏剂的选择和用法，不要给复杂汤剂。' },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function clinicalField(trace: { finalResult?: unknown }, field: 'disease' | 'syndrome' | 'formula'): Record<string, unknown> | undefined {
  const r = trace.finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

interface RunRec {
  id: string; taskIntent: TaskIntent; error?: string;
  diseaseName: string; syndromeName: string; primaryPattern: string; secondaryPatterns: string[];
  treatmentPrinciple: string;
  candidateNames: string[]; selectedFormulaName: string;
  proposalMode: string; authority: string;
  successfulSubmit: boolean; forcedFinalization: boolean;
  stepCount: number; toolCalls: number; tokens: number; latencyMs: number;
  gateEvents: string[];
  capabilities: string[];
}

async function runOne(def: CaseDef): Promise<RunRec> {
  try {
    const { trace, workspace } = await runCase(def.input);
    const diseaseField = clinicalField(trace, 'disease');
    const syndromeField = clinicalField(trace, 'syndrome');
    const formulaField = clinicalField(trace, 'formula');
    const pa = workspace.patternAssessment;
    const spine = workspace.clinicalDecisionSpine;
    const names: string[] = [];
    for (const tc of trace.toolCalls ?? []) {
      const t = (tc as { toolName: string; output: unknown }).toolName;
      if (t === 'formula.search_candidates' || t === 'formula.search_normative') {
        const out = (tc as { output: unknown }).output as { candidates?: { formulaName?: string }[] } | { formulaName?: string; name?: string }[] | undefined;
        if (out && 'candidates' in out) for (const c of out.candidates ?? []) if (typeof c?.formulaName === 'string') names.push(c.formulaName);
        else if (Array.isArray(out)) for (const c of out) { const n = c?.formulaName ?? c?.name; if (typeof n === 'string') names.push(n); }
      }
    }
    const gateEvents: string[] = [];
    for (const tc of trace.toolCalls ?? []) {
      const out = (tc as { output: unknown }).output as Record<string, unknown> | undefined;
      if (out && typeof out === 'object' && out.notReady === true) gateEvents.push(typeof out.code === 'string' ? out.code : 'UNRESOLVED_HYPOTHESES');
    }
    return {
      id: def.id, taskIntent: def.taskIntent,
      diseaseName: typeof diseaseField?.name === 'string' ? diseaseField.name : '',
      syndromeName: typeof syndromeField?.name === 'string' ? syndromeField.name : '',
      primaryPattern: pa?.primary?.statement ?? '',
      secondaryPatterns: (pa?.secondary ?? []).map((s) => s.statement).filter(Boolean),
      treatmentPrinciple: spine.treatmentPlan?.primaryPrinciple ?? '',
      candidateNames: [...new Set(names)],
      selectedFormulaName: typeof formulaField?.name === 'string' ? formulaField.name : '',
      proposalMode: (() => { const m = (trace.finalResult as Record<string, unknown> | undefined)?.mode; return typeof m === 'string' ? m : ''; })(),
      authority: typeof formulaField?.authority === 'string' ? formulaField.authority : '',
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: num(trace.agentLoop?.stepCount), toolCalls: num((trace.runMetrics ?? {} as { totalToolCalls?: number }).totalToolCalls),
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens), latencyMs: num(trace.totalMs),
      gateEvents,
      capabilities: (trace.capabilities ?? []) as string[],
    };
  } catch (e) {
    return {
      id: def.id, taskIntent: def.taskIntent, error: e instanceof Error ? e.message : String(e),
      diseaseName: '', syndromeName: '', primaryPattern: '', secondaryPatterns: [], treatmentPrinciple: '',
      candidateNames: [], selectedFormulaName: '', proposalMode: '', authority: '',
      successfulSubmit: false, forcedFinalization: false, stepCount: 0, toolCalls: 0, tokens: 0, latencyMs: 0,
      gateEvents: [], capabilities: [],
    };
  }
}

await loadIndex();

const OUT_FILE = `reports/h18-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
writeFileSync(OUT_FILE, '');

const results: RunRec[] = [];
const queue = CASES.map((c, idx) => ({ c, slot: idx }));
async function worker() {
  while (queue.length > 0) {
    const item = queue.shift()!;
    const r = await runOne(item.c);
    results[item.slot] = r;
    appendFileSync(OUT_FILE, JSON.stringify(r) + '\n');
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, CASES.length) }, () => worker()));

for (const r of results) {
  console.log(`${r.id} [${r.taskIntent}] ${r.error ? 'ERR' : (r.successfulSubmit ? 'OK' : r.forcedFinalization ? 'FORCED' : 'STOP')} ` +
    `dis=${r.diseaseName || '-'} primary=${r.primaryPattern.slice(0, 14) || '-'} sel=${r.selectedFormulaName || '-'} ` +
    `steps=${r.stepCount} caps=${r.capabilities.join(',') || '-'} mode=${r.proposalMode}${r.gateEvents.length ? ' gates=' + r.gateEvents.join('|') : ''}`);
}
