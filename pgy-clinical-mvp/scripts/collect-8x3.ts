import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCase } from '../src/composition/runtime.js';

/**
 * 8 例 × 3 次 全链路稳定性采集。
 * 每个 run 是独立 first-run；完整 {result, trace, workspace, authority} 落盘。
 * 禁止覆盖失败：execution_incomplete 是正式结果，原样保留。
 */

const CASES: Array<{ id: string; input: string }> = [
  {
    id: 'T03',
    input: '甄某某，女，32岁。主诉：子宫肿块海扶术治疗后一月，要求配合中医治疗。既往因进行性经行下腹疼痛2+年诊断子宫肌瘤、子宫腺肌瘤并行HIFU。上次月经量多、色黯、有较多血块且腹痛剧烈。现患者无明显腹痛，但觉腹胀，无法集中精力，疲乏困顿，无烦躁，无胸闷气促，食欲可，寐安，二便尚正常。舌偏暗，苔白，脉弦细涩。',
  },
  {
    id: 'T07',
    input: '患者，男，72岁。大便干结难解1年，每3~4天排便1次，排便时费力，伴口干咽燥，手足心热，心烦失眠，舌质红、少苔，脉细数。既往无肠道器质性疾病病史。',
  },
  {
    id: 'T08',
    input: '陈某，女，45岁，更年期综合征，失眠3年，近期加重。入睡困难、多梦易醒，每晚睡2～3小时；伴心烦心悸、口干咽燥、手足心热、盗汗、舌尖溃疡；舌红少苔、舌尖红赤，脉细数。甲状腺功能正常。本次只需要辨证和治法，不需要开方。',
  },
  {
    id: 'T09',
    input: '患者女，29岁。近两个月月经各推迟约10天，经量较平时略少。未提供腹痛、寒热、带下、睡眠、饮食、二便等伴随情况，也未提供舌象和脉象。想知道中医属于什么证。先判断现有信息是否足够，不要猜。',
  },
  {
    id: 'T11',
    input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。患者希望冬令长期调理，明确要求以膏代煎药，请按膏方思路给方案，不想每天煎汤药。',
  },
  {
    id: 'T14',
    input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。请按中医辨证给出治疗建议。',
  },
  {
    id: 'T15',
    input: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。',
  },
  {
    id: 'T18',
    input: '人流后恶露淋漓不净，色淡质稀，面色㿠白，神疲乏力，头晕乏力。苔薄，舌淡，脉细弱。患者不方便煎药，明确想优先了解成药或现成膏剂的选择和用法，不要给复杂汤剂。',
  },
];

const RUNS = 3;
const outDir = path.resolve('reports', '8cases-x3-raw');
mkdirSync(outDir, { recursive: true });

// 冻结环境快照（采集侧补充，权威字段在报告头由 git/config 复核）。
const freeze = {
  collectedAt: new Date().toISOString(),
  mode: process.env.CLINICAL_RUNTIME_MODE ?? 'harness',
  llmFastModel: process.env.LLM_FAST_MODEL,
  llmDeepModel: process.env.LLM_DEEP_MODEL,
  llmBaseURL: process.env.LLM_BASE_URL,
  kbReleaseDir: process.env.KB_RELEASE_DIR,
};
writeFileSync(path.join(outDir, '_freeze.json'), JSON.stringify(freeze, null, 2));

function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val), 2);
}

function summaryLine(label: string, mode: string, term: string, steps: number, formula: string, ms: number): void {
  console.log(`[${label}] mode=${mode} term=${term} steps=${steps} formula=${formula} ${(ms / 1000).toFixed(1)}s`);
}

const manifest: string[] = [];

for (const c of CASES) {
  for (let i = 1; i <= RUNS; i++) {
    const label = `${c.id}-R${i}`;
    const started = Date.now();
    try {
      const r = await runCase(c.input);
      const elapsedMs = Date.now() - started;
      const term = r.trace.agentLoop?.terminationReason ?? '?';
      const steps = r.trace.agentLoop?.stepCount ?? -1;
      const formula = r.result.mode === 'clinical' ? (r.result.formula?.name ?? '无') : '-';
      const record = {
        label,
        caseId: c.id,
        runIndex: i,
        input: c.input,
        collectedAt: new Date().toISOString(),
        elapsedMs,
        result: r.result,
        trace: r.trace,
        workspace: r.workspace,
        authority: r.authority,
      };
      writeFileSync(path.join(outDir, `${label}.json`), safeJson(record));
      manifest.push(label);
      summaryLine(label, r.result.mode, term, steps, formula, elapsedMs);
    } catch (e) {
      const elapsedMs = Date.now() - started;
      const errMsg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      // 异常（非 execution_incomplete）也落盘，不覆盖，不重跑。
      writeFileSync(path.join(outDir, `${label}.error.json`), safeJson({ label, caseId: c.id, runIndex: i, input: c.input, error: errMsg, elapsedMs }));
      console.log(`[${label}] ERROR ${elapsedMs}ms: ${e instanceof Error ? e.message : e}`);
    }
  }
}

writeFileSync(path.join(outDir, '_manifest.json'), safeJson({ labels: manifest, total: manifest.length }));
console.log(`\n[collect] done. ${manifest.length} runs written to ${outDir}`);
