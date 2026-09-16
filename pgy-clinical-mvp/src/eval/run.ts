import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runCase } from '../agent/primary.js';
import { buildIndex } from '../knowledge/build.js';

interface TestCase {
  key: string;
  disease?: string;
  input: string;
}
interface TestSet {
  total: number;
  cases: TestCase[];
}

const DATASETS: Record<string, string> = {
  debug: '../assets/data/regression/debug_microset_12.json',
  calibration: '../assets/data/regression/calibration_40.json',
  holdout: '../assets/data/regression/holdout_113.json',
  external: '../assets/data/external_regression/v1.6.0/eval_v2512_full.json',
};

interface RowResult {
  key: string;
  ok: boolean;
  status?: string;
  authority?: string;
  disease?: string;
  syndrome?: string;
  formulaName?: string;
  sourceId?: string;
  ms?: number;
  toolCalls?: number;
  error?: string;
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? 'debug';
  const file = DATASETS[name];
  if (!file) {
    console.error(`未知数据集 "${name}"，可选：${Object.keys(DATASETS).join('/')}`);
    process.exit(1);
  }

  const abs = path.resolve(file);
  if (!readFileSyncSafe(abs)) {
    console.error(`测试集不存在：${abs}`);
    process.exit(1);
  }
  const ts = JSON.parse(readFileSync(abs, 'utf8')) as TestSet;

  console.log(`[eval] 数据集 ${name}（${ts.total} 例），先确保索引就绪...`);
  await buildIndex(false);

  const rows: RowResult[] = [];
  let completed = 0;
  let crashed = 0;
  let normative = 0;
  let generatedDraft = 0;
  let blocked = 0;
  let normativeWithoutSource = 0;

  for (const c of ts.cases) {
    const started = Date.now();
    try {
      const { result, trace } = await runCase(c.input);
      completed++;
      const auth = result.formula.authority;
      if (auth === 'NORMATIVE') {
        normative++;
        if (!result.formula.source_id) normativeWithoutSource++;
      } else if (auth === 'GENERATED_DRAFT') generatedDraft++;
      else if (auth === 'BLOCKED') blocked++;

      rows.push({
        key: c.key,
        ok: true,
        status: result.status,
        authority: auth,
        disease: result.disease.name,
        syndrome: result.syndrome.name,
        formulaName: result.formula.name,
        sourceId: result.formula.source_id,
        ms: Date.now() - started,
        toolCalls: trace.toolCalls.length,
      });
      console.log(
        `[${c.key}] ${result.status.padEnd(9)} ${auth.padEnd(15)} ` +
          `病=${result.disease.name || '-'} 证=${result.syndrome.name || '-'} ` +
          `方=${result.formula.name || '-'} src=${result.formula.source_id || '-'} ` +
          `tools=${trace.toolCalls.length} ${Date.now() - started}ms`,
      );
    } catch (e) {
      crashed++;
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ key: c.key, ok: false, error: msg });
      console.error(`[${c.key}] CRASH: ${msg.slice(0, 300)}`);
    }
  }

  const report = {
    dataset: name,
    total: ts.cases.length,
    completed,
    crashed,
    normative,
    generatedDraft,
    blocked,
    normativeWithoutSource,
    gates: {
      A_integrity: completed === ts.cases.length && crashed === 0,
      B_data: normativeWithoutSource === 0,
      C_stability: crashed === 0 && completed === ts.cases.length,
    },
    rows,
  };

  const outDir = path.resolve('reports');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${name}_${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('\n================ 报告 ================');
  console.log(JSON.stringify(report.gates, null, 2));
  console.log(
    `完成 ${completed}/${ts.cases.length} | 崩溃 ${crashed} | ` +
      `NORMATIVE ${normative} / GENERATED_DRAFT ${generatedDraft} / BLOCKED ${blocked}`,
  );
  console.log(`报告已写入 ${outFile}`);
}

function readFileSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
