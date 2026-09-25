import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 从 data/runs.sqlite3 已落盘记录渲染「最新 8 例全链路排查记录」md。
 *
 * 只读渲染，不参与 Runtime 装配、不改变任何 closure / readiness 语义：
 * 输入 = 服务端已产生的 session_json（SessionView，内含 trace）；
 * 输出 = 逐例的 输入 / 最终结果 / Control Plane / 工具调用全链路 / Kernel 提交 / 遥测。
 * 工具调用 input/output 为原文全量（2 空格缩进），不做截断。
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown } } };

const DB_FILE = path.resolve('data', 'runs.sqlite3');
const LIMIT = 8;
const OUT_FILE = path.resolve('蒲公英中医AI-最新八例全链路排查记录.md');

interface Row {
  run_id: string;
  input: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  model: string;
  error: string | null;
  session_json: string;
}

const db = new DatabaseSync(DB_FILE, { readOnly: true });
const rows = db.prepare(
  'SELECT run_id, input, started_at, finished_at, status, model, error, session_json FROM runs ORDER BY started_at DESC LIMIT ?',
).all(LIMIT) as unknown as Row[];

// ---------- helpers ----------

function j(v: unknown): string {
  return JSON.stringify(v);
}

function jp(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/** 单值 JSON；undefined 渲染为（无）。 */
function jv(v: unknown): string {
  return v === undefined ? '（无）' : j(v);
}

function asList(v: unknown): string {
  return Array.isArray(v) ? `[${v.map((x) => (typeof x === 'string' ? JSON.stringify(x) : j(x))).join(', ')}]` : j(v);
}

function localTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return s.replace(' ', 'T');
}

function ms(v: unknown): string {
  if (typeof v !== 'number') return '-';
  return `${Math.round(v * 1000) / 1000}ms`;
}

function shortInput(s: string, n = 46): string {
  return s.replace(/\s+/g, ' ').slice(0, n) + (s.replace(/\s+/g, ' ').length > n ? '…' : '');
}

function isToolError(out: unknown): boolean {
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (o.ok === false) return true;
    if (o.error !== undefined && o.error !== null) return true;
  }
  return false;
}

// ---------- per-run derived ----------

interface Derived {
  row: Row;
  input: string;
  session: any;
  result: any;
  workspace: any;
  authority: any;
  trace: any;
  agentLoop: any;
  cp: any;
  toolCalls: any[];
  commits: any[];
  runMetrics: any;
  candidateRefs: string[];
  hydratedCount: number;
  searchCandidatesCallCount: number;
  selectCalls: any[];
  selectSuccess: any;
  errorCount: number;
  sourceAuthority: string | undefined;
  selectedSourceRef: string | undefined;
}

function derive(row: Row): Derived {
  const session = JSON.parse(row.session_json);
  const trace = session.trace;
  const agentLoop = trace.agentLoop ?? {};
  const cp = agentLoop.controlPlane ?? {};
  const toolCalls: any[] = trace.toolCalls ?? [];
  const commits: any[] = trace.commits ?? [];

  const searchCalls = toolCalls.filter((t) => t.toolName === 'formula.search_candidates');
  const lastSearch = searchCalls[searchCalls.length - 1];
  const cands: any[] = lastSearch?.output?.candidates ?? [];
  const candidateRefs: string[] = [...new Set(cands.map((c) => c.candidateRef).filter(Boolean))];
  const hydrated = lastSearch?.output?.hydratedEvidence;
  const hydratedCount = Array.isArray(hydrated)
    ? hydrated.length
    : hydrated && typeof hydrated === 'object'
      ? Object.keys(hydrated).length
      : 0;

  const selectCalls = toolCalls.filter((t) => t.toolName === 'formula.select');
  const selectSuccess = selectCalls.map((c) => c.output).find((o) => o && o.ok === true);

  return {
    row,
    input: row.input,
    session,
    result: session.result,
    workspace: session.workspace,
    authority: session.authority,
    trace,
    agentLoop,
    cp,
    toolCalls,
    commits,
    runMetrics: trace.runMetrics ?? {},
    candidateRefs,
    hydratedCount,
    searchCandidatesCallCount: searchCalls.length,
    selectCalls,
    selectSuccess,
    errorCount: toolCalls.filter((t) => isToolError(t.output)).length,
    sourceAuthority: selectSuccess?.sourceAuthority ?? commits.find((c) => c.sourceBundle)?.sourceBundle?.sourceFacts?.sourceAuthority,
    selectedSourceRef: selectSuccess?.selectedSourceRef ?? commits.find((c) => c.sourceBundle)?.sourceBundle?.sourceId,
  };
}

const runs = rows.map(derive);

// ---------- header ----------

const header: string[] = [];
header.push('# 蒲公英中医 AI · 最新八例全链路排查记录');
header.push('');
header.push('> 数据 100% 来自本地服务 `http://localhost:8787/` 的落盘记录 `data/runs.sqlite3`（`session.result / session.workspace / trace.toolCalls / trace.agentLoop.controlPlane / trace.commits / trace.runMetrics`），未做人工润色。');
header.push(`> 取数口径：按 \`started_at\` 倒序的最新 ${LIMIT} 条运行记录（原样，含重复 input）。`);
header.push(`> 时间范围：${localTime(runs[runs.length - 1].row.started_at)} ～ ${localTime(runs[0].row.finished_at ?? runs[0].row.started_at)}（本地 Asia/Shanghai），共 ${runs.length} 例。`);
header.push('> 详略：工具调用 input/output 为 **原文全量**（2 空格缩进 JSON），不做截断。');
header.push('> 代码基线：工作区 HEAD `bcb7c8a`（Truth Genesis / Source Authority Closure）+ 72 项未提交改动；Root Architecture Closure —— P1 `source-node:*` / P2 `case-visit:*` typed candidate identity；`formula.search_candidates`（CandidateSet + canonical evidence 原子冻结）+ `formula.select`（闭世界 decision 事务）。');
header.push('');
header.push('## 总览');
header.push('');
header.push('| 例 | runId | 输入摘要 | termination | steps | mode/status | CandidateSet | Source domain | formula_set | deliveries | tool 错误 |');
header.push('|---|---|---|---|---|---|---|---|---|---|---|');

runs.forEach((r, i) => {
  const fs = r.result.formula_set ?? [];
  const deliveries = (r.result.deliveries ?? []).map((d: any) => `${d.outcome}:${d.delivery_status}`).join('、') || '（无）';
  const sourceDomain = r.selectedSourceRef ? (r.sourceAuthority ? `${r.sourceAuthority}（${r.selectedSourceRef}）` : `${r.selectedSourceRef}`) : '-';
  const modeStatus = `${r.result.mode}/${r.result.status ?? '-'}`;
  header.push(
    `| 例${i + 1} | ${r.row.run_id} | ${shortInput(r.input)} | ${r.agentLoop.terminationReason ?? '?'} | ${r.agentLoop.stepCount ?? -1} | ${modeStatus} | ${r.candidateRefs.length} | ${sourceDomain} | ${fs.length} | ${deliveries} | ${r.errorCount} |`,
  );
});
header.push('');

// ---------- per example ----------

const body: string[] = [];

function bullets(lines: string[], arr: unknown, indent = ''): void {
  if (Array.isArray(arr) && arr.length) {
    for (const it of arr) lines.push(`${indent}- ${typeof it === 'string' ? it : j(it)}`);
  } else {
    lines.push(`${indent}- （无）`);
  }
}

runs.forEach((r, idx) => {
  const i = idx + 1;
  body.push('---');
  body.push('');
  body.push(`# 例${i} ｜ ${r.row.run_id}`);
  body.push('');

  // 0. 元信息
  body.push('## 0. 元信息');
  body.push('');
  body.push(`- runId：${r.row.run_id}`);
  body.push(`- 开始：${localTime(r.row.started_at)}｜结束：${localTime(r.row.finished_at ?? undefined)}｜状态：${r.row.status}｜模型：${r.session.model}`);
  const modelExecution = r.trace.snapshot?.modelExecution;
  if (modelExecution) {
    body.push(`- 模型执行真值：clinical requested=${modelExecution.requestedClinicalOptionId} → resolved=${modelExecution.resolvedClinicalOptionId}（thinking=${modelExecution.clinicalThinking}, budget=${modelExecution.clinicalBudget}）｜control requested=${modelExecution.requestedControlOptionId} → resolved=${modelExecution.resolvedControlOptionId}（thinking=${modelExecution.controlThinking}, budget=${modelExecution.controlBudget}）${modelExecution.controlFallbackReason ? `｜controlFallback=${modelExecution.controlFallbackReason}` : ''}`);
  }
  body.push(`- agentLoop：stepCount=${r.agentLoop.stepCount ?? '-'}｜terminationReason=${r.agentLoop.terminationReason ?? '-'}｜proposalSubmitted=${r.agentLoop.proposalSubmitted ?? '-'}｜forcedFinalization=${r.agentLoop.forcedFinalization ?? '-'}`);
  body.push(`- 候选方数（workspace.candidates）：${(r.workspace.candidates ?? []).length}`);
  body.push(`- token：input=${r.agentLoop.usage?.inputTokens ?? '-'}｜output=${r.agentLoop.usage?.outputTokens ?? '-'}｜总耗时=${ms(r.trace.totalMs)}`);
  body.push(`- Knowledge scopes：${asList(r.trace.snapshot?.knowledgeScopes)}｜activeSkills：${asList(r.trace.snapshot?.activeSkills)}`);
  body.push(`- CandidateSet（formula.search_candidates 冻结，调用 ${r.searchCandidatesCallCount} 次）：${asList(r.candidateRefs)}`);
  body.push(`- CandidateSet evidence binding：${r.candidateRefs.length ? `${r.hydratedCount}/${r.candidateRefs.length} 个候选已在同一事务内水合 canonical evidence` : '（无候选，未触发 CandidateSet 事务）'}`);
  body.push(`- formula.select 调用次数：${r.selectCalls.length}｜成功结果：${r.selectSuccess ? j(r.selectSuccess) : '（无成功调用）'}`);
  body.push('');

  // 1. 输入
  body.push('## 1. 输入');
  body.push('');
  body.push('```text');
  body.push(r.input);
  body.push('```');
  body.push('');

  // 2. 最终结果
  const res = r.result;
  body.push('## 2. 最终结果（session.result）');
  body.push('');
  body.push(`- mode：${res.mode}｜status：${res.status ?? '-'}`);
  if (res.mode === 'clinical') {
    body.push(`- disease：${j(res.disease)}`);
    body.push(`- syndrome：${j(res.syndrome)}`);
    body.push(`- treatment：${j(res.treatment)}`);
    body.push(`- formula（单方兼容投影）：${jv(res.formula)}`);
    const deliveries: any[] = res.deliveries ?? [];
    body.push(`- deliveries（${deliveries.length}）：`);
    if (deliveries.length) {
      for (const d of deliveries) {
        body.push(`  - ${d.outcome}｜delivery=${d.delivery_status}｜clearance=${d.execution_clearance}｜prov=${d.provenance?.kind}｜sourceRefs=${asList(d.provenance?.sourceRefs ?? [])}｜sourceBundle.products=${(d.source_bundle?.products ?? []).length}`);
      }
    } else {
      body.push('  - （无）');
    }
    const fset: any[] = res.formula_set ?? [];
    body.push(`- formula_set（${fset.length}）：`);
    if (fset.length) {
      for (const f of fset) {
        body.push(`  - ${f.formula_ref}｜${f.name}｜relation=${f.relation}｜mod_status=${f.modification_status}`);
        body.push(`    - 方内原始（${f.formula_local_modification_text ?? '-'}）`);
        body.push(`    - 病证共享（${f.source_shared_modification_text ?? '-'}）`);
        body.push(`    - 患者特异（${f.patient_specific_modification_text ?? '-'}）`);
        body.push(`    - composition presence=${f.facts?.composition?.presence ?? '-'}｜preparation presence=${f.facts?.preparation?.presence ?? '-'}｜usage presence=${f.facts?.usage?.presence ?? '-'}`);
      }
    } else {
      body.push('  - （无）');
    }
    if (res.treatment_deliveries) {
      const td: any[] = res.treatment_deliveries ?? [];
      body.push(`- treatment_deliveries（${td.length}）：`);
      if (td.length) {
        for (const t of td) body.push(`  - ${j(t)}`);
      } else {
        body.push('  - （无）');
      }
    }
    body.push(`- missing_information：${asList(res.missing_information ?? [])}`);
    body.push(`- safety：${j(res.safety)}`);
  } else if (res.mode === 'clarification') {
    body.push(`- questions：${asList(res.questions ?? [])}`);
  } else if (res.mode === 'conversation' || res.mode === 'urgent') {
    body.push(`- message：${res.message ?? '-'}`);
    if (res.risks) body.push(`- risks：${j(res.risks)}`);
  }
  body.push('');

  // 3. Control Plane
  const cp = r.cp;
  body.push('## 3. Control Plane（Request IR / obligation / readiness / surface）');
  body.push('');
  body.push(`- requestCompileStatus：${cp.requestCompileStatus ?? '-'}`);
  body.push(`- requiredOutcomes：${asList(cp.requiredOutcomes ?? [])}`);
  body.push(`- adoptedOutcomes：${asList(cp.adoptedOutcomes ?? [])}`);
  body.push(`- effectiveRequiredOutcomes：${asList(cp.effectiveRequiredOutcomes ?? [])}`);
  body.push(`- excludedOutcomes：${asList(cp.excludedOutcomes ?? [])}`);
  body.push(`- unresolvedOutcomes：${asList(cp.unresolvedOutcomes ?? [])}`);
  body.push(`- preferredOutcomes：${asList(cp.preferredOutcomes ?? [])}｜allowedOutcomes：${asList(cp.allowedOutcomes ?? [])}`);
  body.push(`- mentionOutcomes：${asList(cp.mentionOutcomes ?? [])}`);
  body.push(`- exclusive：${cp.exclusive ?? '-'}｜formulaCardinality：${cp.formulaCardinality ?? '-'}｜knowledgeSourcePolicy：${cp.knowledgeSourcePolicy ?? '-'}`);
  body.push(`- planningIssues：${asList(cp.planningIssues ?? [])}`);
  body.push(`- graphComplete：${cp.graphComplete ?? '-'}｜required=${cp.requiredObligationCount ?? '-'}｜satisfied=${cp.satisfiedObligationCount ?? '-'}`);
  body.push(`- openObligations：${asList(cp.openObligations ?? [])}`);
  body.push(`- blockedObligations：${asList(cp.blockedObligations ?? [])}`);
  body.push(`- notDeliverableObligations：${asList(cp.notDeliverableObligations ?? [])}`);
  body.push(`- unmetObligations：${asList(cp.unmetObligations ?? [])}`);
  body.push(`- appliedBlockers：${j(cp.appliedBlockers ?? [])}`);
  body.push(`- outcomeCoverage：${j(cp.outcomeCoverage ?? [])}`);
  body.push('- **readiness**：');
  body.push('```json');
  body.push(jp(cp.readiness ?? {}));
  body.push('```');
  body.push('');
  body.push('- **obligation 图**：');
  body.push('');
  body.push('| id | type | outcome | provider | status | required | rootOutcomes | dependsOn |');
  body.push('|---|---|---|---|---|---|---|---|');
  for (const o of cp.obligations ?? []) {
    body.push(`| ${o.id} | ${o.type} | ${o.outcome ?? ''} | ${o.provider ?? ''} | ${o.status} | ${o.required} | ${(o.rootOutcomes ?? []).join(', ')} | ${(o.dependsOn ?? []).join(', ')} |`);
  }
  body.push('');
  body.push('- **每步 runnable obligation 与 legal surface**：');
  body.push('');
  body.push('| step | runnable | surface |');
  body.push('|---|---|---|');
  for (const s of cp.steps ?? []) {
    body.push(`| ${s.step} | ${(s.runnable ?? []).join(', ')} | ${(s.surface ?? []).join(', ')} |`);
  }
  body.push('');

  // 4. tool calls
  body.push('## 4. 工具调用全链路（trace.toolCalls）');
  body.push('');
  const counts: Record<string, number> = {};
  for (const t of r.toolCalls) counts[t.toolName] = (counts[t.toolName] ?? 0) + 1;
  body.push(`- 调用总数：${r.toolCalls.length}｜按工具统计：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('、') || '（无）'}`);
  body.push('');
  r.toolCalls.forEach((t, k) => {
    body.push(`#### 步骤 ${k + 1}｜${t.toolName}`);
    body.push('');
    body.push('- **input**：');
    body.push('```json');
    body.push(jp(t.input));
    body.push('```');
    body.push('');
    body.push('- **output**：');
    body.push('```json');
    body.push(jp(t.output));
    body.push('```');
    body.push('');
    body.push(`- 耗时：${ms(t.ms)}${t.reused ? '｜reused=true' : ''}`);
    body.push('');
  });

  // 5. commits
  body.push('## 5. Kernel 提交（trace.commits）');
  body.push('');
  if (!r.commits.length) {
    body.push('（无 commit）');
    body.push('');
  }
  r.commits.forEach((c, k) => {
    body.push(`#### commit ${k + 1}｜${c.semanticIdentity ?? c.outcome ?? '-'}`);
    body.push('');
    body.push(`- commitId：${c.commitId}｜semanticIdentity：${c.semanticIdentity ?? '-'}｜providerId：${c.providerId ?? '-'}`);
    body.push(`- deliveryStatus：${c.deliveryStatus ?? '-'}｜executionClearance：${c.executionClearance ?? '-'}｜committedAt：${localTime(c.committedAt)}`);
    body.push(`- provenance：${j(c.provenance)}`);
    body.push('- product：');
    body.push('```json');
    body.push(jp(c.product));
    body.push('```');
    if (c.sourceBundle) {
      const sb = c.sourceBundle;
      body.push(`- sourceBundle.sourceId：${sb.sourceId ?? '-'}｜products=${(sb.products ?? []).length}`);
      for (const p of sb.products ?? []) {
        body.push(`  - ${p.productId}｜${p.name}｜qualification=${p.qualification}`);
        body.push('```json');
        body.push(jp(p.payload));
        body.push('```');
      }
      if (sb.sourceFacts) {
        body.push(`  - sourceFacts：${j(sb.sourceFacts)}`);
      }
    }
    body.push('');
  });

  // 6. runMetrics 节选
  const rm = r.runMetrics;
  const metrics = {
    totalToolCalls: rm.totalToolCalls,
    decisionChangingToolCalls: rm.decisionChangingToolCalls,
    reinforcingToolCalls: rm.reinforcingToolCalls,
    nonDecisionChangingToolCalls: rm.nonDecisionChangingToolCalls,
    unresolvedToolCalls: rm.unresolvedToolCalls,
    redundantSearchCount: rm.redundantSearchCount,
    knowledgeSearchCount: rm.knowledgeSearchCount,
    resolvedDiseaseConcepts: rm.resolvedDiseaseConcepts,
    patternAssessmentRecorded: rm.patternAssessmentRecorded,
    primaryPatternRef: rm.primaryPatternRef,
    secondaryPatternRefs: rm.secondaryPatternRefs,
    diseaseAssessmentBeforeTreatmentRetrieval: rm.diseaseAssessmentBeforeTreatmentRetrieval,
    treatmentRetrievalCount: rm.treatmentRetrievalCount,
    formulaCandidateRetrievalCount: rm.formulaCandidateRetrievalCount,
    formulaEvidenceRetrievalCount: rm.formulaEvidenceRetrievalCount,
    formulaSelectionFromEvidence: rm.formulaSelectionFromEvidence,
    uniqueCandidatesDiscovered: rm.uniqueCandidatesDiscovered,
    uniqueCandidatesHydrated: rm.uniqueCandidatesHydrated,
    selectedCandidateRef: rm.selectedCandidateRef,
    firstViableCandidateRef: rm.firstViableCandidateRef,
    firstViableCandidateStep: rm.firstViableCandidateStep,
    retrievalsBeforeFirstViableCandidate: rm.retrievalsBeforeFirstViableCandidate,
    formulaReviewRecorded: rm.formulaReviewRecorded,
    modificationItemsWithPatientEvidence: rm.modificationItemsWithPatientEvidence,
    clinicalCompletionObligationCreated: rm.clinicalCompletionObligationCreated,
    completionRequiredArtifacts: rm.completionRequiredArtifacts,
    completionMissingArtifactsAtEnd: rm.completionMissingArtifactsAtEnd,
    falseCompletionAttemptCount: rm.falseCompletionAttemptCount,
    repeatedNoProgressCorrectionCount: rm.repeatedNoProgressCorrectionCount,
    repeatedUnresolvedHypothesisCorrectionCount: rm.repeatedUnresolvedHypothesisCorrectionCount,
  };
  body.push('## 6. 关键遥测（runMetrics 节选）');
  body.push('');
  body.push('```json');
  body.push(jp(metrics));
  body.push('```');
  body.push('');
});

const out = [...header, ...body].join('\n');
writeFileSync(OUT_FILE, out, 'utf-8');

console.log(`[render-runs-md] ${runs.length} runs -> ${path.basename(OUT_FILE)}`);
console.log(`[render-runs-md] ${out.split('\n').length} 行 / ${(Buffer.byteLength(out, 'utf-8') / 1024).toFixed(0)} KB`);
for (const r of runs) {
  console.log(`  - ${r.row.run_id}  term=${r.agentLoop.terminationReason} steps=${r.agentLoop.stepCount} candidates=${r.candidateRefs.length} formula_set=${(r.result.formula_set ?? []).length} tools=${r.toolCalls.length} errors=${r.errorCount}`);
}
