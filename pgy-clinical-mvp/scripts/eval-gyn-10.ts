import { runCase } from '../src/composition/runtime.js';

/**
 * 妇科 10 例评测（Source Replay 基线）—— 用于验证「disease identity 解析」修复前后的对比。
 * 指标：P1 命中率（source_authority === 'P1'）+ 辨证方向（人工核对 syndrome）。
 */
interface EvalCase {
  id: string;
  goldDisease: string;
  goldSyndrome: string;
  goldFormula: string;
  input: string;
}

const CASES: EvalCase[] = [
  { id: '子宫肌瘤', goldDisease: '子宫肌瘤', goldSyndrome: '气滞血瘀', goldFormula: '桂枝茯苓丸', input: '患者于1978年经上海市第二军医大学妇科检查发现子宫肌瘤。月经超前量多四年余，经后带下绵绵，并有腥味，大便秘结。于1981年10月31日B型超声波检查报告：子宫前位，大小4.3cm×6.1cm×7.8cm。子宫左后壁向外突出，呈一实质性暗区，大小约2.4cm×3.0cm，与宫壁间无明显分界，提示为小型子宫肌瘤' },
  { id: '月经先期', goldDisease: '月经先期', goldSyndrome: '脾肾两亏', goldFormula: '(自拟方)', input: '1977年12月20日。月经先期而来，现已净止，大便经常溏薄，婚后四年不孕，四肢欠温，苔薄，脉沉细。脾肾两亏，阳气不足，子宫寒冷。治拟益气健脾，补肾暖宫。' },
  { id: '黄带', goldDisease: '带下病-黄带', goldSyndrome: '脾虚湿热', goldFormula: '易黄汤', input: '带下色黄有腥味，虽轻未止，腰痛如折，四肢酸麻怕冷，舌淡白，脉细小。' },
  { id: '胎漏', goldDisease: '胎漏', goldSyndrome: '脾胃虚弱', goldFormula: '寿胎丸', input: '女，29岁。妊娠五月余，漏下不止，腹内隐痛，据妇科检查有息肉，故漏红不止，带下如清水，便溏纳呆，面色萎黄，头晕神疲，四肢乏力，苔薄腻，脉弦滑。' },
  { id: '产后出血', goldDisease: '产后出血', goldSyndrome: '气虚', goldFormula: '独参汤', input: '产后出血。产后二月余，血崩2次，近日时有出血不多，或见黄水，少腹膨胀，头晕耳鸣，潮热自汗，腰背酸痛，苔薄，舌尖红，脉沉细。' },
  { id: '阴痒', goldDisease: '阴痒', goldSyndrome: '阴虚血燥', goldFormula: '四物加味汤', input: '女 43岁。外阴瘙痒症十一年，外阴粘膜粗糙，延及阴道作痒，脉沉小。' },
  { id: '盆腔炎', goldDisease: '盆腔炎', goldSyndrome: '热毒瘀阻', goldFormula: '银翘红酱解毒汤', input: '女 35岁。据述曾患慢性盆腔炎，平时腹痛带多，且有腥味，腰痛如折，经前头痛乳胀，舌胖，脉沉细。' },
  { id: '子宫内膜异位症', goldDisease: '子宫内膜异位症', goldSyndrome: '气滞血瘀', goldFormula: '验方', input: '女 27岁。子宫内膜异位囊肿。月经14岁来潮，婚后生产，婴儿健康，5月6日腹痛剧，经水淋漓，6月13日经量增多，腹内隐痛，舌质红，脉弦细。1986年6月16日据红光医院B型超声波检查示：子宫74mm80mm49mm，子宫右方见一39mm35mm，左方见一51mm52mm回声增强区，伴有左侧巧克力囊肿。' },
  { id: '宫颈癌术后', goldDisease: '妇科恶性肿瘤放化疗后副反应', goldSyndrome: '脾肾两虚', goldFormula: '人参养营汤', input: '女，57岁。子宫颈癌术后。病史：患者一年前因为出现阴道不规则出血，白带增多到医院就诊。经病理学检查，确诊为宫颈癌。于2019年9月行宫颈癌根治性切除手术，术后进行了放疗。几个疗程放疗后，身体极度虚弱，难以继续放疗。近一个月出现少腹坠痛、阴道白带量多，食欲下降、睡眠差。后经人介绍来我诊所求医。诊见：身体虚弱，神疲无力，腰酸腿软，左膝关节不适,纳呆,寐差，大便稀溏,白带多,而凊稀,舌红苔白颤抖，舌下瘀阻，左脉滑涩小数，右脉偏细。' },
  { id: '不孕症', goldDisease: '不孕症', goldSyndrome: '肝肾阴虚', goldFormula: '五子汤', input: '女 30岁。不孕症6年。婚后不育已有6年，月经失调，经行漏下不止，烘热心烦，夜寐不安，腰肢酸软，舌质淡白，脉细小。' },
];

function jv(v: unknown): string {
  return v === undefined || v === null || v === '' ? '-' : String(v);
}

let p1Hit = 0;
const results: Array<Record<string, unknown>> = [];

for (const c of CASES) {
  const t0 = Date.now();
  try {
    const { result, trace } = await runCase(c.input);
    const loop = trace.agentLoop;
    let row: Record<string, unknown> = { id: c.id, gold: `${c.goldDisease} | ${c.goldSyndrome} | ${c.goldFormula}` };
    if (result.mode === 'clinical') {
      const sourceAuthority = result.formula?.source_authority ?? '-';
      const isP1 = sourceAuthority === 'P1';
      if (isP1) p1Hit++;
      row = {
        ...row,
        termination: loop?.terminationReason,
        status: result.status,
        disease: result.disease.name.slice(0, 50),
        syndrome: result.syndrome.name.slice(0, 50),
        formula: jv(result.formula?.name),
        sourceId: jv(result.formula?.source_id),
        sourceAuthority,
        p1: isP1,
        ms: Date.now() - t0,
      };
      console.log(`[${c.id}] ${isP1 ? 'P1✓' : 'P2✗'} 方=${jv(result.formula?.name)} 源=${jv(result.formula?.source_id)} 证=${result.syndrome.name.slice(0, 32)}`);
    } else {
      row = { ...row, termination: loop?.terminationReason, mode: result.mode };
      console.log(`[${c.id}] mode=${result.mode}`);
    }
    results.push(row);
  } catch (e) {
    console.log(`[${c.id}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
    results.push({ id: c.id, error: e instanceof Error ? e.message : String(e) });
  }
}

console.log(`\n===== P1 命中率: ${p1Hit}/${CASES.length} =====`);
