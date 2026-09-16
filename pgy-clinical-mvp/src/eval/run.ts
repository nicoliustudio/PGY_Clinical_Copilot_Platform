import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runCase } from '../agent/primary.js';
import { buildIndex } from '../knowledge/build.js';
import {
  getGold,
  matchDisease,
  matchSyndrome,
  matchFormula,
} from './metrics.js';

interface TestCase {
  key: string;
  disease?: string;
  group?: string;
  sheet?: string;
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

/** 错误分层：回答「错在哪一层」 */
type ErrorLayer =
  | 'OK'
  | 'MODEL_OUTPUT_SCHEMA_ERROR'
  | 'RUNTIME_CRASH'
  | 'SAFETY_BLOCK'
  | 'DISEASE_REASONING_ERROR'
  | 'SYNDROME_REASONING_ERROR'
  | 'FORMULA_RETRIEVAL_MISS'
  | 'FORMULA_AUTHORITY_ERROR';

interface RowResult {
  key: string;
  group?: string;
  ok: boolean;
  errorLayer: ErrorLayer;
  status?: string;
  authority?: string;
  disease?: string;
  syndrome?: string;
  formulaName?: string;
  sourceId?: string;
  ms?: number;
  toolCalls?: number;
  // gold 对比
  hasGold?: boolean;
  diseaseHit?: boolean;
  syndromeHit?: boolean;
  formulaHit?: boolean;
  goldVariantId?: string;
  error?: string;
}

function classifyCrash(msg: string): ErrorLayer {
  if (/zod|json|schema|output/i.test(msg)) return 'MODEL_OUTPUT_SCHEMA_ERROR';
  return 'RUNTIME_CRASH';
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

  // gold 指标
  let goldTotal = 0;
  let diseaseHit = 0;
  let syndromeHit = 0;
  let formulaHit = 0;

  for (const c of ts.cases) {
    const started = Date.now();
    const gold = getGold(c.key);
    try {
      const { result, trace } = await runCase(c.input);
      completed++;

      if (result.mode !== 'clinical') {
        // 非临床模式（conversation/clarification/urgent），不做病证方对比
        rows.push({
          key: c.key,
          group: c.group,
          ok: true,
          errorLayer: 'OK',
          authority: result.mode,
          ms: Date.now() - started,
          toolCalls: trace.toolCalls.length,
          hasGold: !!gold,
        });
        console.log(
          `[${c.key}] mode=${result.mode} 非临床输出 ${Date.now() - started}ms`,
        );
        continue;
      }

      const auth = result.formula.authority;
      if (auth === 'NORMATIVE') normative++;
      else if (auth === 'GENERATED_DRAFT') generatedDraft++;
      else if (auth === 'BLOCKED') blocked++;

      // gold 对比
      let dHit: boolean | undefined;
      let sHit: boolean | undefined;
      let fHit: boolean | undefined;
      let layer: ErrorLayer = 'OK';

      if (gold && gold.evaluable) {
        goldTotal++;
        dHit = matchDisease(result.disease.name, gold);
        sHit = matchSyndrome(result.syndrome.name, gold);
        fHit = matchFormula(result.formula.source_id, gold);
        if (dHit) diseaseHit++;
        if (sHit) syndromeHit++;
        if (fHit) formulaHit++;

        if (auth === 'BLOCKED') layer = 'SAFETY_BLOCK';
        else if (!dHit) layer = 'DISEASE_REASONING_ERROR';
        else if (!sHit) layer = 'SYNDROME_REASONING_ERROR';
        else if (!fHit) layer = 'FORMULA_RETRIEVAL_MISS';
      } else if (auth === 'BLOCKED') {
        layer = 'SAFETY_BLOCK';
      }

      rows.push({
        key: c.key,
        group: c.group,
        ok: true,
        errorLayer: layer,
        status: result.status,
        authority: auth,
        disease: result.disease.name,
        syndrome: result.syndrome.name,
        formulaName: result.formula.name,
        sourceId: result.formula.source_id,
        ms: Date.now() - started,
        toolCalls: trace.toolCalls.length,
        hasGold: !!gold,
        diseaseHit: dHit,
        syndromeHit: sHit,
        formulaHit: fHit,
        goldVariantId: gold?.variantId,
      });
      console.log(
        `[${c.key}] ${auth.padEnd(15)} ${layer.padEnd(24)} ` +
          `病=${result.disease.name || '-'} 证=${result.syndrome.name || '-'} ` +
          `方=${result.formula.name || '-'} ` +
          (gold ? `hit=病${dHit ? 1 : 0}/证${sHit ? 1 : 0}/方${fHit ? 1 : 0}` : '无gold') +
          ` ${Date.now() - started}ms`,
      );
    } catch (e) {
      crashed++;
      const msg = e instanceof Error ? e.message : String(e);
      const layer = classifyCrash(msg);
      rows.push({
        key: c.key,
        group: c.group,
        ok: false,
        errorLayer: layer,
        hasGold: !!gold,
        error: msg.slice(0, 500),
      });
      console.error(`[${c.key}] ${layer}: ${msg.slice(0, 200)}`);
    }
  }

  // 错误分层分布
  const layerDist: Record<string, number> = {};
  for (const r of rows) layerDist[r.errorLayer] = (layerDist[r.errorLayer] ?? 0) + 1;

  const report = {
    dataset: name,
    total: ts.cases.length,
    completed,
    crashed,
    normative,
    generatedDraft,
    blocked,
    // 效果指标（Gate D）
    metrics: {
      goldTotal,
      diseaseHit,
      syndromeHit,
      formulaHit,
      diseaseHitRate: goldTotal ? +(diseaseHit / goldTotal).toFixed(3) : null,
      syndromeHitRate: goldTotal ? +(syndromeHit / goldTotal).toFixed(3) : null,
      formulaHitRate: goldTotal ? +(formulaHit / goldTotal).toFixed(3) : null,
    },
    errorLayers: layerDist,
    gates: {
      A_integrity: completed === ts.cases.length && crashed === 0,
      C_stability: crashed === 0 && completed === ts.cases.length,
    },
    rows,
  };

  const outDir = path.resolve('reports');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${name}_${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log('\n================ 评测报告 ================');
  console.log(
    `完成 ${completed}/${ts.cases.length} | 崩溃 ${crashed} | ` +
      `NORMATIVE ${normative} / GENERATED_DRAFT ${generatedDraft} / BLOCKED ${blocked}`,
  );
  console.log('\n--- 效果指标（gold 命中率）---');
  console.log(
    `Disease  ${report.metrics.diseaseHitRate ?? '-'}  (${diseaseHit}/${goldTotal})`,
  );
  console.log(
    `Syndrome ${report.metrics.syndromeHitRate ?? '-'}  (${syndromeHit}/${goldTotal})`,
  );
  console.log(
    `Formula  ${report.metrics.formulaHitRate ?? '-'}  (${formulaHit}/${goldTotal})`,
  );
  console.log('\n--- 错误分层 ---');
  for (const [k, v] of Object.entries(layerDist)) console.log(`  ${k}: ${v}`);
  console.log(`\n报告已写入 ${outFile}`);
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
