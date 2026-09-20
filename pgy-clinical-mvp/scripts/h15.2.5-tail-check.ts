import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';
import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * H15.2.5 — Tail Convergence & Execution Headroom Check.
 * EVALUATION ONLY. Reproduce C1b / C4b forced finalization.
 */

const modelId = config.llm.deepModel;
const CONCURRENCY = 6;

const CASES = [
  { id: 'C1b', input: '患者女，30岁。平素工作较忙，睡眠一般。本次就诊诉经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。' },
  { id: 'C4b', input: '患者女，26岁。月经先期，量多色红，烦躁易怒，口苦，舌红苔黄，脉弦数，无腹痛。' },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function clinicalField(trace: { finalResult?: unknown }, field: 'disease' | 'syndrome' | 'formula'): Record<string, unknown> | undefined {
  const r = trace.finalResult as Record<string, unknown> | undefined;
  if (r?.mode !== 'clinical') return undefined;
  const f = r[field];
  return typeof f === 'object' && f !== null ? (f as Record<string, unknown>) : undefined;
}

interface RunRec {
  id: string; run: number; error?: string;
  primaryPattern: string; selectedFormulaName: string; proposalMode: string;
  successfulSubmit: boolean; forcedFinalization: boolean; stepCount: number;
  toolSequence: string[];
  eventSequence: string[];
  candidateSearchCount: number; evidenceFetchCount: number; knowledgeSearchCount: number;
  hypothesisPresentedCount: number; candidatePresentedCount: number;
  tokens: number; latencyMs: number;
}

async function runOne(id: string, run: number): Promise<RunRec> {
  try {
    const { trace, workspace } = await runCase(CASES.find((c) => c.id === id)!.input);
    const formulaField = clinicalField(trace, 'formula');
    const toolSequence = (trace.toolCalls ?? []).map((tc: { toolName: string }) => tc.toolName);
    const eventSequence = (trace.workspaceEvents ?? []).map((e: { type: string }) => e.type);
    return {
      id, run,
      primaryPattern: workspace.patternAssessment?.primary?.statement ?? '',
      selectedFormulaName: typeof formulaField?.name === 'string' ? formulaField.name : '',
      proposalMode: (() => { const m = (trace.finalResult as Record<string, unknown> | undefined)?.mode; return typeof m === 'string' ? m : ''; })(),
      successfulSubmit: trace.agentLoop?.proposalSubmitted === true,
      forcedFinalization: trace.agentLoop?.forcedFinalization === true,
      stepCount: num(trace.agentLoop?.stepCount),
      toolSequence,
      eventSequence,
      candidateSearchCount: toolSequence.filter((t) => t === 'formula.search_candidates' || t === 'formula.search_normative').length,
      evidenceFetchCount: toolSequence.filter((t) => t === 'formula.get_evidence').length,
      knowledgeSearchCount: toolSequence.filter((t) => t === 'knowledge.search' || t === 'knowledge.search_cards' || t === 'knowledge.get_asset' || t === 'knowledge.get_source').length,
      hypothesisPresentedCount: eventSequence.filter((t) => t === 'hypothesis.presented').length,
      candidatePresentedCount: eventSequence.filter((t) => t === 'candidate.presented').length,
      tokens: num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens),
      latencyMs: num(trace.totalMs),
    };
  } catch (e) {
    return {
      id, run, error: e instanceof Error ? e.message : String(e),
      primaryPattern: '', selectedFormulaName: '', proposalMode: '', successfulSubmit: false, forcedFinalization: false, stepCount: 0,
      toolSequence: [], eventSequence: [], candidateSearchCount: 0, evidenceFetchCount: 0, knowledgeSearchCount: 0,
      hypothesisPresentedCount: 0, candidatePresentedCount: 0, tokens: 0, latencyMs: 0,
    };
  }
}

await loadIndex();

const jobs = CASES.flatMap((c) => Array.from({ length: 3 }, (_, i) => ({ id: c.id, run: i + 1 })));
const OUT_FILE = `reports/h15.2.5-${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`;
writeFileSync(OUT_FILE, '');

const results: RunRec[] = [];
const queue = jobs.map((j, idx) => ({ j, slot: idx }));
async function worker() {
  while (queue.length > 0) {
    const item = queue.shift()!;
    const r = await runOne(item.j.id, item.j.run);
    results[item.slot] = r;
    appendFileSync(OUT_FILE, JSON.stringify(r) + '\n');
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

for (const r of results) {
  console.log(`\n=== ${r.id} r${r.run} ===`);
  console.log(`primary=${r.primaryPattern.slice(0, 30) || '-'} sel=${r.selectedFormulaName || '-'} mode=${r.proposalMode} submit=${r.successfulSubmit} forced=${r.forcedFinalization} steps=${r.stepCount}`);
  console.log(`toolSequence (${r.toolSequence.length}): ${r.toolSequence.join(' → ')}`);
  console.log(`counts: candidateSearch=${r.candidateSearchCount} evidenceFetch=${r.evidenceFetchCount} knowledgeSearch=${r.knowledgeSearchCount} hypPresented=${r.hypothesisPresentedCount} candPresented=${r.candidatePresentedCount}`);
}

const perCase: Record<string, RunRec[]> = {};
for (const r of results) (perCase[r.id] ??= []).push(r);
for (const [id, rs] of Object.entries(perCase)) {
  console.log(`\n${id}: forced=${rs.filter((r) => r.forcedFinalization).length}/${rs.length} submit=${rs.filter((r) => r.successfulSubmit).length}/${rs.length}`);
}
