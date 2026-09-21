import { runCase } from '../src/composition/runtime.js';

const INPUT = '患者，男，72岁。大便干结难解1年，每3~4天排便1次，排便时费力，伴口干咽燥，手足心热，心烦失眠，舌质红、少苔，脉细数。既往无肠道器质性疾病病史。';

function summarize(id: string, r: Awaited<ReturnType<typeof runCase>>): void {
  const t = r.trace;
  const toolCalls = t.toolCalls || [];
  const searchIdx = toolCalls.map((c, i) => (c.toolName === 'formula.search_candidates' ? i : -1)).filter((x) => x >= 0);
  const searchCount = searchIdx.length;

  // 第一次 candidate.presented 在 workspaceEvents 中的位置，用于判断候选面形成后是否还反复检索
  const events = t.workspaceEvents || [];
  const firstCandidateAt = events.findIndex((e) => e.type === 'candidate.presented');

  const term = t.agentLoop?.terminationReason ?? '?';
  const mode = r.result.mode;
  const message = mode === 'conversation' ? (r.result.message ?? '') : '';
  const formulaName = mode === 'clinical' ? (r.result.formula?.name ?? '') : '';

  console.log(
    `[${id}] mode=${mode} term=${term} search_candidates=${searchCount} firstCandidateEvent#=${firstCandidateAt} ` +
    `selected=${t.runMetrics?.selectedCandidateRef ?? '无'} formula=${formulaName}${message ? ` msg=${message.slice(0, 60)}` : ''}`,
  );
}

let executionIncomplete = 0;
let resourceLimit = 0;
let maxSearch = 0;
const results: string[] = [];

for (let i = 1; i <= 5; i++) {
  const started = Date.now();
  try {
    const r = await runCase(INPUT);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const t = r.trace;
    const term = t.agentLoop?.terminationReason ?? '?';
    const searchCount = (t.toolCalls || []).filter((c) => c.toolName === 'formula.search_candidates').length;
    maxSearch = Math.max(maxSearch, searchCount);
    if (r.result.mode === 'conversation' && (r.result.message ?? '').includes('EXECUTION_INCOMPLETE')) executionIncomplete++;
    if (term === 'resource_limit_fallback') resourceLimit++;
    results.push(`#${i} mode=${r.result.mode} term=${term} search=${searchCount} ${elapsed}s formula=${r.result.mode === 'clinical' ? r.result.formula?.name : '-'}`);
    summarize(`T07#${i}`, r);
  } catch (e) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    results.push(`#${i} ERROR ${e instanceof Error ? e.message : e} ${elapsed}s`);
    console.log(`[T07#${i}] ERROR ${elapsed}s: ${e instanceof Error ? e.message : e}`);
  }
}

console.log('\n========== T07 × 5 汇总 ==========');
for (const line of results) console.log(line);
console.log(`execution_incomplete = ${executionIncomplete} / 5`);
console.log(`resource_limit_fallback = ${resourceLimit} / 5`);
console.log(`max formula.search_candidates per run = ${maxSearch}`);
