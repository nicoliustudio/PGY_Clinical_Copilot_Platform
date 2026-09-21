import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 从 reports/8cases-x3-raw/*.json 渲染两份交付物：
 * 1. PGY-8cases-x3-全过程链路记录.md
 * 2. PGY-8cases-x3-稳定性摘要.md
 */

const rawDir = path.resolve('reports', '8cases-x3-raw');
const outDir = path.resolve('reports');
mkdirSync(outDir, { recursive: true });

interface Rec {
  label: string; caseId: string; runIndex: number; input: string;
  collectedAt: string; elapsedMs: number;
  result: any; trace: any; workspace: any; authority: any;
}

const CASE_ORDER = ['T03', 'T07', 'T08', 'T09', 'T11', 'T14', 'T15', 'T18'];

const files = readdirSync(rawDir).filter((f) => /^T\d{2}-R\d\.json$/.test(f));
const recs: Rec[] = files.map((f) => JSON.parse(readFileSync(path.join(rawDir, f), 'utf-8')));
recs.sort((a, b) => {
  const ai = CASE_ORDER.indexOf(a.caseId); const bi = CASE_ORDER.indexOf(b.caseId);
  if (ai !== bi) return ai - bi;
  return a.runIndex - b.runIndex;
});

// ---------- helpers ----------

function short(s: unknown, n = 220): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  if (str == null) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function toolCallCounts(rec: Rec): Record<string, number> {
  const m: Record<string, number> = {};
  for (const tc of rec.trace.toolCalls ?? []) m[tc.toolName] = (m[tc.toolName] ?? 0) + 1;
  return m;
}

function repeatedRuns(toolCalls: Array<{ toolName: string }>): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < toolCalls.length) {
    let j = i;
    while (j < toolCalls.length && toolCalls[j].toolName === toolCalls[i].toolName) j++;
    if (j - i >= 3) out.push(`${toolCalls[i].toolName}×${j - i}`);
    i = j;
  }
  return out;
}

function term(rec: Rec): string { return rec.trace.agentLoop?.terminationReason ?? '?'; }
function mode(rec: Rec): string { return rec.result?.mode ?? '?'; }

// ---------- 摘要统计 ----------

interface Row { case: string; run: number; mode: string; term: string; steps: number; formula: string; primary: string; ms: number; incomplete: boolean; clarification: boolean; }

const rows: Row[] = recs.map((rec) => {
  const t = rec.trace;
  const ws = rec.workspace;
  const primary = ws.patternAssessment?.primary?.statement ?? ws.clinicalDecisionSpine?.diseaseAssessment?.statement ?? '';
  const formula = rec.result?.mode === 'clinical' ? (rec.result.formula?.name ?? '') : '';
  const isIncomplete = term(rec) === 'execution_incomplete';
  const isClarification = mode(rec) === 'clarification';
  return {
    case: rec.caseId, run: rec.runIndex, mode: mode(rec), term: term(rec),
    steps: t.agentLoop?.stepCount ?? -1, formula, primary, ms: rec.elapsedMs,
    incomplete: isIncomplete, clarification: isClarification,
  };
});

const total = rows.length;
const clinicalCount = rows.filter((r) => r.mode === 'clinical').length;
const incompleteCount = rows.filter((r) => r.incomplete).length;
const resourceLimit = rows.filter((r) => r.term === 'resource_limit_fallback').length;
const structuredFailed = rows.filter((r) => r.term === 'provider_error').length;
const clarificationCount = rows.filter((r) => r.clarification).length;
const stepsSorted = rows.map((r) => r.steps).sort((a, b) => a - b);
const latSorted = rows.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p: number) => stepsSorted[Math.min(stepsSorted.length - 1, Math.floor((p / 100) * stepsSorted.length))];
const pctLat = (p: number) => latSorted[Math.min(latSorted.length - 1, Math.floor((p / 100) * latSorted.length))];
const meanSteps = (stepsSorted.reduce((a, b) => a + b, 0) / stepsSorted.length).toFixed(1);
const meanLat = (latSorted.reduce((a, b) => a + b, 0) / latSorted.length / 1000).toFixed(1);

// ---------- failure clustering ----------

const failures = rows.filter((r) => r.incomplete || r.term === 'resource_limit_fallback');
const clusters = new Map<string, Row[]>();
for (const f of failures) {
  const rec = recs.find((x) => x.caseId === f.case && x.runIndex === f.run) as Rec;
  const missing = (rec.trace.runMetrics?.completionMissingArtifactsAtEnd ?? []).join(',') || '(n/a)';
  const key = `${missing}`;
  if (!clusters.has(key)) clusters.set(key, []);
  clusters.get(key)!.push(f);
}

// ---------- render full md ----------

const fullLines: string[] = [];
fullLines.push('# PGY Clinical Runtime — 8 例 × 3 全链路稳定性诊断 · 全过程链路记录');
fullLines.push('');
fullLines.push(`> 采集完成时间：${recs[0]?.collectedAt ?? ''}`);
fullLines.push(`> 原始 JSON 全量保存在 \`reports/8cases-x3-raw/\`（含完整 toolCalls input/output、workspaceEvents、actionReceipts）。`);
fullLines.push('');

for (const rec of recs) {
  const t = rec.trace; const ws = rec.workspace; const au = rec.authority;
  const label = rec.label;
  fullLines.push(`---`);
  fullLines.push(`# ${label}`);
  fullLines.push('');
  fullLines.push(`- mode=${mode(rec)}  terminationReason=${term(rec)}  steps=${t.agentLoop?.stepCount ?? '-'}  elapsedMs=${rec.elapsedMs}  forcedFinalization=${t.agentLoop?.forcedFinalization ?? '-'}`);
  fullLines.push('');

  // A 输入
  fullLines.push('## A. 原始输入');
  fullLines.push('');
  fullLines.push('```text');
  fullLines.push(rec.input);
  fullLines.push('```');
  fullLines.push('');

  // B Understanding（从 workspace 投影恢复）
  const chief = ws.caseFacts?.find((f: any) => f.kind === 'chief_complaint');
  fullLines.push('## B. Understanding（投影自 workspace.caseFacts）');
  fullLines.push('');
  fullLines.push(`- chiefComplaint：${chief?.value ?? '（无）'}`);
  fullLines.push(`- safetyDisposition：${ws.safetyDisposition ?? '?'}`);
  fullLines.push(`- activeCapabilities：${(ws.activeCapabilities ?? []).join(', ') || '（无）'}`);
  fullLines.push('');
  fullLines.push('| # | kind | value | temporalRole | polarity |');
  fullLines.push('|---|------|-------|--------------|----------|');
  for (const f of ws.caseFacts ?? []) {
    fullLines.push(`| ${f.id} | ${f.kind} | ${short(f.value, 60)} | ${f.temporalRole ?? '-'} | ${f.polarity ?? '-'} |`);
  }
  fullLines.push('');
  fullLines.push(`- informationGaps：${(ws.informationGaps ?? []).length ? (ws.informationGaps ?? []).map((g: string) => short(g, 80)).join('；') : '（无）'}`);
  fullLines.push(`- uncertainties：${(ws.uncertainties ?? []).length ? (ws.uncertainties ?? []).map((u: string) => short(u, 80)).join('；') : '（无）'}`);
  fullLines.push('');

  // C Planner
  const s = t.clinicalStrategy ?? {};
  fullLines.push('## C. Planner（clinicalStrategy）');
  fullLines.push('');
  fullLines.push(`- goal：${short(s.goal) || '（无）'}`);
  fullLines.push(`- decisionQuestion：${short(s.decisionQuestion) || '（无）'}`);
  fullLines.push(`- criticalEvidenceNeeds：${(s.criticalEvidenceNeeds ?? []).map((x: string) => short(x, 80)).join('；') || '（无）'}`);
  fullLines.push(`- stopWhen：${(s.stopWhen ?? []).join('；') || '（无）'}`);
  fullLines.push(`- provisionalRequiredArtifacts：${(s.provisionalRequiredArtifacts ?? []).join(', ') || '（无）'}`);
  fullLines.push('');

  // D Agent steps
  fullLines.push('## D. Agent 全部 steps（toolCalls 顺序）');
  fullLines.push('');
  const tcs = t.toolCalls ?? [];
  const counts = toolCallCounts(rec);
  fullLines.push(`**工具调用统计**：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('；') || '（无）'}`);
  const reps = repeatedRuns(tcs);
  if (reps.length) fullLines.push(`**连续重复（≥3 连击）**：${reps.join('；')}`);
  fullLines.push('');
  fullLines.push('| step | toolName | input | output | ms | reused |');
  fullLines.push('|------|----------|-------|--------|----|--------|');
  tcs.forEach((tc: any, idx: number) => {
    fullLines.push(`| ${idx + 1} | ${tc.toolName} | ${short(tc.input, 70)} | ${short(tc.output, 70)} | ${tc.ms} | ${tc.reused ? 'Y' : '-'} |`);
  });
  fullLines.push('');

  // E Workspace durable state
  fullLines.push('## E. Workspace / durable clinical state');
  fullLines.push('');
  const hyp = ws.hypothesisState?.hypotheses ?? [];
  fullLines.push('### hypotheses');
  for (const h of hyp) fullLines.push(`- [${h.id}] ${h.label} (${h.status}${h.origin ? ', origin=' + h.origin : ''})`);
  if (!hyp.length) fullLines.push('- （无）');
  fullLines.push('');
  const da = ws.clinicalDecisionSpine?.diseaseAssessment;
  const pa = ws.patternAssessment;
  const tp = ws.clinicalDecisionSpine?.treatmentPlan;
  const fs = ws.clinicalDecisionSpine?.formulaSelection;
  const fr = ws.clinicalDecisionSpine?.formulaReview;
  const tfd = tp?.treatmentFormDecision;
  fullLines.push('### clinicalDecisionSpine');
  fullLines.push(`- diseaseAssessment：${da?.statement ? short(da.statement, 120) : '（无）'}`);
  fullLines.push(`- primary pattern：${pa?.primary?.statement ? short(pa.primary.statement, 120) : '（无）'}`);
  fullLines.push(`- treatmentPlan.primaryPrinciple：${tp?.primaryPrinciple ? short(tp.primaryPrinciple, 120) : '（无）'}`);
  fullLines.push(`- treatmentFormDecision：${tfd ? `${tfd.form} (${tfd.disposition}) sourceRefs=[${(tfd.sourceEvidenceRefs ?? []).join(',')}]` : '（无）'}`);
  fullLines.push(`- formulaSelection.selectedCandidateRef：${fs?.selectedCandidateRef ?? '（无）'}`);
  fullLines.push(`- formulaReview：${fr ? `${fr.disposition} ${short(fr.assessment, 80)}` : '（无）'}`);
  fullLines.push('');
  fullLines.push('### candidates / frontier / evidence');
  const cands = ws.candidates ?? [];
  fullLines.push(`- candidates (${cands.length})：${cands.map((c: any) => c.id).join(', ') || '（无）'}`);
  fullLines.push(`- frontier：${(ws.deliberationState?.frontier ?? []).join(', ') || '（无）'}`);
  fullLines.push(`- evidenceItems：${(ws.evidenceState?.evidenceItems ?? []).length} 条`);
  fullLines.push(`- deliberation.assessments：${(ws.deliberationState?.assessments ?? []).length} 条`);
  fullLines.push('');

  // F Completion / Readiness
  fullLines.push('## F. Completion / Readiness');
  fullLines.push('');
  const obl = ws.clinicalDecisionSpine?.completionObligation;
  const rm = t.runMetrics ?? {};
  fullLines.push(`- completionObligation.requiredArtifacts：${(obl?.requiredArtifacts ?? []).join(', ') || '（无）'}`);
  fullLines.push(`- completionObligation.satisfiedArtifacts：${(obl?.satisfiedArtifacts ?? []).join(', ') || '（无）'}`);
  fullLines.push(`- completionObligation.missingArtifacts：${(obl?.missingArtifacts ?? []).join(', ') || '（无）'}`);
  fullLines.push(`- runMetrics.completionRequiredArtifacts：${(rm.completionRequiredArtifacts ?? []).join(', ') || '（无）'}`);
  fullLines.push(`- runMetrics.completionMissingArtifactsAtEnd：${(rm.completionMissingArtifactsAtEnd ?? []).join(', ') || '（无）'}`);
  fullLines.push('');

  // G Proposal / Final output
  fullLines.push('## G. Proposal / Final Output');
  fullLines.push('');
  fullLines.push(`- terminationReason：${term(rec)}`);
  fullLines.push(`- runtimeReadyStateCommit：${t.agentLoop?.commitReliability?.runtimeReadyStateCommitCount ?? 0}`);
  const r = rec.result ?? {};
  if (r.mode === 'clinical') {
    fullLines.push(`- disease：${r.disease?.name ?? '-'}`);
    fullLines.push(`- syndrome：${r.syndrome?.name ?? '-'}`);
    fullLines.push(`- treatment：${short(r.treatment?.text, 200)}`);
    fullLines.push(`- formula：${r.formula?.name ?? '-'} (authority=${r.formula?.authority ?? '-'}, candidate_ref=${r.formula?.candidate_ref ?? '-'}, source_authority=${r.formula?.source_authority ?? '-'})`);
    fullLines.push(`- safety：${r.safety?.status ?? '-'} reviewRequired=${r.safety?.reviewRequired ?? '-'}`);
  } else if (r.mode === 'clarification') {
    fullLines.push(`- questions：${(r.questions ?? []).join('；')}`);
  } else if (r.mode === 'conversation') {
    fullLines.push(`- message：${r.message ?? '-'}`);
  } else if (r.mode === 'urgent') {
    fullLines.push(`- message：${r.message ?? '-'}`);
  }
  fullLines.push(`- authority.status：${au?.status ?? '-'}`);
  for (const d of au?.decisions ?? []) fullLines.push(`  - [${d.stage}] ${d.action} ${(d.reasons ?? []).join('; ')}`);
  fullLines.push('');

  // H Metrics
  fullLines.push('## H. Metrics');
  fullLines.push('');
  fullLines.push(`- stepsUsed：${t.agentLoop?.stepCount ?? '-'}`);
  fullLines.push(`- formula.search_candidates：${counts['formula.search_candidates'] ?? 0}`);
  fullLines.push(`- formula.get_evidence：${counts['formula.get_evidence'] ?? 0}`);
  fullLines.push(`- knowledge.search：${counts['knowledge.search'] ?? 0}`);
  fullLines.push(`- knowledge.get_source：${counts['knowledge.get_source'] ?? 0}`);
  fullLines.push(`- knowledge.search_cards：${counts['knowledge.search_cards'] ?? 0}`);
  fullLines.push(`- knowledge.get_asset：${counts['knowledge.get_asset'] ?? 0}`);
  fullLines.push(`- candidateCount：${(ws.candidates ?? []).length}`);
  fullLines.push(`- selectedCandidateRef：${rm.selectedCandidateRef ?? '（无）'}`);
  fullLines.push(`- redundantSearchCount：${rm.redundantSearchCount ?? 0}`);
  fullLines.push(`- structuredOutputRepairCount：${t.agentLoop?.commitReliability?.proposalRetryCount ?? 0}`);
  fullLines.push(`- agentProposalSubmitCount：${t.agentLoop?.commitReliability?.agentProposalSubmitCount ?? 0}`);
  fullLines.push(`- runtimeCommitCount：${t.agentLoop?.commitReliability?.runtimeReadyStateCommitCount ?? 0}`);
  fullLines.push('');

  // 失败轮诊断
  if (term(rec) === 'execution_incomplete') {
    fullLines.push('## I. execution_incomplete 完整诊断');
    fullLines.push('');
    const missing = rm.completionMissingArtifactsAtEnd ?? [];
    fullLines.push(`- 最终 missingArtifacts：${missing.join(', ') || '（无）'}`);
    fullLines.push(`- 最后 5 个 toolCalls：${tcs.slice(-5).map((tc: any) => tc.toolName).join(' → ')}`);
    fullLines.push(`- firstViableCandidateRef：${rm.firstViableCandidateRef ?? '（无）'}（step ${rm.firstViableCandidateStep ?? '-'}）`);
    fullLines.push(`- formulaCandidateRetrievalCount：${rm.formulaCandidateRetrievalCount ?? 0}`);
    fullLines.push(`- formulaEvidenceRetrievalCount：${rm.formulaEvidenceRetrievalCount ?? 0}`);
    fullLines.push(`- repeatedNoProgressCorrectionCount：${rm.repeatedNoProgressCorrectionCount ?? 0}`);
    fullLines.push(`- finishReason：${t.agentLoop?.finishReason ?? '-'}`);
    fullLines.push(`- 是否 readiness=true 但未 commit：${t.agentLoop?.commitReliability?.runtimeReadyStateCommitCount ? 'runtimeReadyStateCommitCount>0（需核查）' : '否（ready 未达成）'}`);
    fullLines.push('');
  }
}

writeFileSync(path.join(outDir, 'PGY-8cases-x3-全过程链路记录.md'), fullLines.join('\n'), 'utf-8');

// ---------- render summary md ----------

const sum: string[] = [];
sum.push('# PGY Clinical Runtime — 8 例 × 3 稳定性摘要');
sum.push('');
sum.push(`> 采集完成：${recs[0]?.collectedAt ?? ''}`);
sum.push('');
sum.push('## 汇总表');
sum.push('');
sum.push('| case | R1 | R2 | R3 | incomplete | steps | variance |');
sum.push('|------|----|----|----|-----------:|-------|----------|');

for (const cid of CASE_ORDER) {
  const rs = rows.filter((r) => r.case === cid);
  const mk = (r: Row) => r.incomplete ? '⚠️ incomplete' : (r.clarification ? 'clarification' : `${r.mode}·${short(r.formula || r.primary, 18)}`);
  const inc = rs.filter((r) => r.incomplete).length;
  const steps = rs.map((r) => r.steps).join('/');
  const variance = varianceOf(rs);
  sum.push(`| ${cid} | ${mk(rs[0])} | ${mk(rs[1])} | ${mk(rs[2])} | ${inc} | ${steps} | ${variance} |`);
}
sum.push('');
sum.push('## 统计');
sum.push('');
sum.push(`- 总运行数 = ${total}`);
sum.push(`- clinical completion count = ${clinicalCount}`);
sum.push(`- execution_incomplete count = ${incompleteCount}`);
sum.push(`- resource_limit_fallback count = ${resourceLimit}`);
sum.push(`- structured_output_failed count = ${structuredFailed}`);
sum.push(`- 合法 clarification count = ${clarificationCount}`);
sum.push(`- mean steps = ${meanSteps}`);
sum.push(`- P50 steps = ${pct(50)}`);
sum.push(`- P95 steps = ${pct(95)}`);
sum.push(`- mean latency = ${meanLat}s`);
sum.push('');

sum.push('## Failure clustering');
sum.push('');
if (!failures.length) {
  sum.push('- 无 failure。');
} else {
  sum.push('| missing artifacts | 命中 case | 次数 |');
  sum.push('|-------------------|-----------|------|');
  for (const [missing, list] of clusters) {
    const cases = [...new Set(list.map((f) => f.case))].join(',');
    sum.push(`| ${missing} | ${cases} | ${list.length} |`);
  }
  sum.push('');
  sum.push('### 每个 failure 的 tool 调用画像');
  for (const f of failures) {
    const rec = recs.find((x) => x.caseId === f.case && x.runIndex === f.run) as Rec;
    const c = toolCallCounts(rec);
    const reps = repeatedRuns(rec.trace.toolCalls ?? []);
    sum.push(`- **${f.case}-R${f.run}**（steps=${f.steps}）：${Object.entries(c).map(([k, v]) => `${k}=${v}`).join('、')}${reps.length ? `；重复段=[${reps.join('、')}]` : ''}`);
  }
}
sum.push('');

writeFileSync(path.join(outDir, 'PGY-8cases-x3-稳定性摘要.md'), sum.join('\n'), 'utf-8');

function varianceOf(rs: Row[]): string {
  const formulas = [...new Set(rs.map((r) => r.formula).filter(Boolean))];
  const primaries = [...new Set(rs.map((r) => r.primary).filter(Boolean))];
  if (rs.some((r) => r.incomplete)) return '含 incomplete';
  if (rs.every((r) => r.clarification)) return 'N/A (clarification)';
  if (formulas.length === 1 && primaries.length === 1) return 'HIGH_CONSISTENCY';
  if (primaries.length === 1) return 'ACCEPTABLE_VARIANCE';
  return 'ACCEPTABLE_VARIANCE';
}

console.log(`[render] 全过程链路记录.md (${fullLines.length} 行)`);
console.log(`[render] 稳定性摘要.md (${sum.length} 行)`);
console.log(`[render] 总 ${recs.length} runs，incomplete=${incompleteCount}，clarification=${clarificationCount}`);
