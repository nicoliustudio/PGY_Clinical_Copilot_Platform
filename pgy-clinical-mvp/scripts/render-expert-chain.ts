import 'dotenv/config';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 全链路导出器（专家审核用）——只读。
 *
 * 从本地运行实例（默认 http://localhost:8787）读取已完成的运行记录：
 *   登录 → GET /api/traces → GET /api/traces/:runId → 渲染 md + 原样落盘 raw JSON。
 *
 * 不调用 runCase、不触发任何推理、不修改 Runtime / 资产 / 知识库；
 * 导出内容全部来自服务端已产生的可观测状态（result / authority / workspace / trace）。
 *
 * 用法：
 *   npx tsx scripts/render-expert-chain.ts [baseUrl] [outDir] [runId1,runId2,...]
 */

const BASE_URL = (process.argv[2] ?? `http://localhost:${process.env.APP_PORT ?? 8787}`).replace(/\/+$/, '');
const OUT_DIR = path.resolve(process.argv[3] ?? path.join('..', 'exports', 'PGY-FullChain-2026-09-22'));
const RUN_IDS = (process.argv[4] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

interface RunRecord {
  runId: string;
  input: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  model: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session?: any;
}

/** 导出时的代码基线：HEAD 短哈希 + 工作区未提交改动数（git 不可用时如实标注）。 */
function codeBaseline(): string {
  try {
    const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim().length > 0).length;
    return `${head}${dirty > 0 ? `（工作区有 ${dirty} 项未提交改动）` : '（工作区干净）'}`;
  } catch {
    return '（无法读取 git 状态）';
  }
}

async function login(): Promise<string> {
  const loginName = process.env.BOOTSTRAP_ADMIN_LOGIN ?? 'admin';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) throw new Error('缺少 BOOTSTRAP_ADMIN_PASSWORD（登录本地实例用，见 .env）');
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginName, password }),
  });
  if (!res.ok) throw new Error(`登录失败：${res.status} ${await res.text()}`);
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  const cookie = (headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0] ?? '')
    .filter(Boolean)
    .join('; ');
  if (!cookie) throw new Error('登录未返回会话 Cookie');
  return cookie;
}

async function apiGet<T>(cookie: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { cookie } });
  if (!res.ok) throw new Error(`GET ${url} 失败：${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/* ---------------- 通用格式化 ---------------- */

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function trunc(v: unknown, n: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  if (s == null) return '';
  return s.length <= n ? s : `${s.slice(0, n)}…（共 ${s.length} 字符）`;
}

/** 生成不会与内容冲突的代码围栏。 */
function fence(text: unknown, lang = ''): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? null, null, 2);
  let tick = '```';
  while (s.includes(tick)) tick += '`';
  return `${tick}${lang}\n${s}\n${tick}`;
}

function sec(ms: number | undefined): string {
  return ms == null ? '?' : `${(ms / 1000).toFixed(1)}s`;
}

/** 表格单元格用的短摘要（不带「共 N 字符」尾巴）。 */
function short(v: unknown, n: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** 由输入生成可读短标题：取首个语义片段，去掉 markdown 强调符。 */
function caseLabel(input: string): string {
  const flat = input.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const cut = flat.search(/[。，；,;\n]/);
  const head = cut > 8 ? flat.slice(0, cut) : flat.slice(0, 24);
  return short(head, 26);
}

function factLine(f: { kind?: string; value?: string; temporalRole?: string; polarity?: string; source?: string }, i: number): string {
  const id = `CF_${String(i + 1).padStart(3, '0')}`;
  return `| \`${id}\` | ${esc(f.kind)} | ${esc(f.value)} | ${esc(f.temporalRole ?? '-')} | ${esc(f.polarity ?? '-')} | ${esc(f.source ?? '-')} |`;
}

function itemLabel(item: any): string {
  if (item == null) return '';
  if (typeof item !== 'object') return trunc(item, 60);
  const o = item as Record<string, unknown>;
  const name = o.title ?? o.name ?? o.formulaName ?? o.formula_name ?? o.assetId ?? o.label;
  const id = o.sourceId ?? o.candidateId ?? o.formulaId ?? o.id ?? o.source_id;
  const parts = [id, name].filter((x) => typeof x === 'string' && x.length > 0);
  return parts.length ? parts.map((p) => String(p)).join(' ｜ ') : trunc(item, 80);
}

function summarizeInput(input: any): string {
  if (input == null || (typeof input === 'object' && Object.keys(input).length === 0)) return `{}`;
  if (typeof input.query === 'string') return `query="${trunc(input.query, 70)}" topK=${input.topK ?? '-'}${input.scopes ? ` scopes=[${(input.scopes as string[]).join(',')}]` : ''}`;
  if (typeof input.sourceId === 'string') return `sourceId=${input.sourceId}`;
  if (typeof input.candidateRef === 'string') return `candidateRef=${input.candidateRef}`;
  if (typeof input.id === 'string') return `id=${input.id}`;
  return trunc(input, 100);
}

function summarizeOutput(output: any): string {
  if (Array.isArray(output)) {
    if (output.length === 0) return '0 项';
    return `${output.length} 项 · 首项: ${trunc(itemLabel(output[0]), 60)}`;
  }
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    const keys = Object.keys(o);
    return `{${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}} ${trunc(JSON.stringify(o), 80)}`;
  }
  return trunc(output, 100);
}

/* ---------------- 各阶段渲染 ---------------- */

const KEY_EVENTS = new Set([
  'pattern.assessment.recorded',
  'disease.assessment.recorded',
  'treatment.plan.recorded',
  'formula.selection.recorded',
  'modification.plan.recorded',
  'formula.review.recorded',
  'completion.obligation.recorded',
  'safety.updated',
  'capability.activated',
  'candidate.selected',
  'candidate.rejected',
  'hypothesis.selected',
  'hypothesis.rejected',
  'hypothesis.preserved_as_uncertainty',
]);

function renderResult(r: any): string {
  if (r?.mode === 'clinical') {
    const lines: string[] = [];
    lines.push(`**mode = \`clinical\` · status = \`${r.status}\`**`);
    lines.push('');
    lines.push(`- 病名：${esc(r.disease?.name)}（confidence=${r.disease?.confidence ?? '-'}）`);
    lines.push(`  - evidence_refs: ${(r.disease?.evidence_refs ?? []).join(', ') || '（无）'}`);
    lines.push(`- 辨证：${esc(r.syndrome?.name)}（confidence=${r.syndrome?.confidence ?? '-'}）`);
    lines.push(`  - evidence_refs: ${(r.syndrome?.evidence_refs ?? []).join(', ') || '（无）'}`);
    lines.push(`- 治法/方案正文：`);
    lines.push('');
    lines.push(fence(r.treatment?.text ?? '（无）', 'text'));
    lines.push('');
    lines.push(`  - evidence_refs: ${(r.treatment?.evidence_refs ?? []).join(', ') || '（无）'}`);
    if (r.formula) {
      lines.push(`- 规范方：**${esc(r.formula.name)}**`);
      lines.push(`  - authority: \`${r.formula.authority}\` · formula_id: \`${r.formula.formula_id}\` · source_id: \`${r.formula.source_id}\``);
      if (r.formula.candidate_ref) lines.push(`  - candidate_ref: \`${r.formula.candidate_ref}\``);
      if (r.formula.source_authority) lines.push(`  - source_authority: \`${r.formula.source_authority}\``);
      lines.push(`  - 组成：${(r.formula.composition ?? []).map((c: string) => esc(c)).join('；') || '（无）'}`);
      lines.push(`  - evidence_refs: ${(r.formula.evidence_refs ?? []).join(', ') || '（无）'}`);
    } else {
      lines.push('- 规范方：（无）');
    }
    if (r.missing_information?.length) lines.push(`- missing_information: ${r.missing_information.map((m: string) => esc(m)).join('；')}`);
    if (r.safety) {
      lines.push(`- safety: status=\`${r.safety.status}\`` + (r.safety.reviewRequired ? ` · reviewRequired=\`true\`（${(r.safety.reviewReasons ?? []).join('；')}）` : ''));
    }
    return lines.join('\n');
  }
  if (r?.mode === 'clarification') {
    return [`**mode = \`clarification\`（未形成结论，向医生追问）**`, '', ...(r.questions ?? []).map((q: string) => `- ${esc(q)}`)].join('\n');
  }
  if (r?.mode === 'urgent') {
    return [`**mode = \`urgent\`**`, '', fence(r.message ?? '', 'text'), '', `- risks: ${JSON.stringify(r.risks ?? [])}`].join('\n');
  }
  return [`**mode = \`${esc(r?.mode)}\`**`, '', fence(r?.message ?? '', 'text')].join('\n');
}

function renderUnderstanding(ws: any): string {
  const lines: string[] = [];
  lines.push(`- safetyDisposition：\`${ws.safetyDisposition}\`（routine / uncertain / urgent）`);
  lines.push('');
  const facts = ws.facts ?? [];
  lines.push(`**病例事实（${facts.length} 条 · CF_xxx 为工作区稳定身份）**`);
  lines.push('');
  lines.push('| 证据ID | 类型 | 事实 | 时间角色 | 极性 | 原文来源 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  facts.forEach((f: any, i: number) => lines.push(factLine(f, i)));
  lines.push('');
  lines.push(`**信息缺口（${(ws.informationGaps ?? []).length}）**`);
  for (const g of ws.informationGaps ?? []) lines.push(`- ${esc(g)}`);
  if (!(ws.informationGaps ?? []).length) lines.push('- （无）');
  lines.push('');
  lines.push(`**不确定项（${(ws.uncertainties ?? []).length}）**`);
  for (const u of ws.uncertainties ?? []) lines.push(`- ${esc(u)}`);
  if (!(ws.uncertainties ?? []).length) lines.push('- （无）');
  return lines.join('\n');
}

function renderStrategy(s: any): string {
  if (!s) return '（无 Planner 输出）';
  const l: string[] = [];
  l.push(`- goal（本轮目标）：${esc(s.goal)}`);
  l.push(`- decisionQuestion（当前需回答的临床问题）：${esc(s.decisionQuestion)}`);
  l.push(`- criticalEvidenceNeeds（关键证据需求，${(s.criticalEvidenceNeeds ?? []).length}）：`);
  for (const c of s.criticalEvidenceNeeds ?? []) l.push(`  - ${esc(c)}`);
  l.push(`- stopWhen（停止条件，${(s.stopWhen ?? []).length}）：`);
  for (const c of s.stopWhen ?? []) l.push(`  - ${esc(c)}`);
  l.push(`- uncertainty（策略层不确定项，${(s.uncertainty ?? []).length}）：`);
  for (const u of s.uncertainty ?? []) l.push(`  - ${esc(u.item)}：${esc(u.reason)}`);
  l.push(`- provisionalRequiredArtifacts：${(s.provisionalRequiredArtifacts ?? []).join(', ') || '（无）'}`);
  return l.join('\n');
}

function renderToolCalls(trace: any): string {
  const calls = trace.toolCalls ?? [];
  const lines: string[] = [];
  lines.push('| # | 工具 | 关键入参 | 耗时 | 输出摘要 | 复用 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  calls.forEach((c: any, i: number) => {
    lines.push(`| ${i + 1} | \`${c.toolName}\` | ${esc(summarizeInput(c.input))} | ${sec(c.ms)} | ${esc(summarizeOutput(c.output))} | ${c.reused ? '♻️' : '-'} |`);
  });
  if (!calls.length) lines.push('| - | （无） | | | | |');
  return lines.join('\n');
}

function renderRetrievalDetail(trace: any): string {
  const items = trace.retrievalDiagnostics ?? [];
  const lines: string[] = [];
  if (!items.length) return '（本轮无检索诊断记录）';
  items.forEach((d: any, i: number) => {
    lines.push(`**检索 ${i + 1}｜\`${d.tool}\`**`);
    lines.push(`- 查询词：\`${esc(d.query)}\``);
    lines.push(
      `- 范围：scopes=[${(d.scopes ?? []).join(', ')}] · topK=${d.topK} · 请求角色=\`${d.requestedRole ?? '-'}\` · 命中层级=\`${d.sourceTier ?? '-'}\` · 流派=\`${d.sourceSchool ?? '-'}\``,
    );
    if (d.p1Attempted != null || d.fallbackToP2 != null) {
      lines.push(`- P1 尝试=${d.p1Attempted ?? '-'} · P1 可用=${d.p1Usable ?? '-'} · P2 尝试=${d.p2Attempted ?? '-'} · fallback=${d.fallbackToP2 ?? '-'}`);
    }
    if (d.retrievalContext) {
      const rc = d.retrievalContext;
      lines.push(`- 检索时所处决策态：question=\`${esc(rc.decisionQuestion ?? '-')}\` · leading=[${(rc.leadingHypothesisRefs ?? []).join(', ')}] · alternatives=[${(rc.alternativeHypothesisRefs ?? []).join(', ')}]`);
    }
    if (d.promotionWorkItemRef) lines.push(`- promotionWorkItemRef=\`${d.promotionWorkItemRef}\` → resolvedHypothesisRef=\`${d.resolvedHypothesisRef ?? '-'}\``);
    if (d.candidateRefs?.length) lines.push(`- 返回 candidateRefs(${d.candidateRefs.length})：${d.candidateRefs.slice(0, 12).join(', ')}`);
    const top = (arr: any[]) => (arr ?? []).slice(0, 5).map((r) => `\`${r.sourceId}\`(${Number(r.score).toFixed(3)})`).join(' · ');
    if ((d.dense ?? []).length) lines.push(`- dense 召回 Top：${top(d.dense)}`);
    if ((d.reranked ?? []).length) lines.push(`- rerank 后 Top：${top(d.reranked)}`);
    if (d.runtimeCatalog) {
      const rc = d.runtimeCatalog;
      lines.push(`- Runtime Catalog：能力=\`${rc.requestedCapability ?? '-'}\` · 命中卡片=${rc.cardsReturnedCount}/${rc.candidateCount}（库内 ${rc.catalogTotalCount}） · 返回资产=[${(rc.cardsReturnedAssetIds ?? []).join(', ')}] · 收窄方式=\`${rc.narrowedBy}\``);
      if (rc.fullAssetIds?.length) lines.push(`- 取回完整资产：${rc.fullAssetIds.join(', ')}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

function renderToolIoDetail(trace: any): string {
  const calls = trace.toolCalls ?? [];
  const lines: string[] = [];
  calls.forEach((c: any, i: number) => {
    if (Array.isArray(c.output)) {
      if (!c.output.length) {
        lines.push(`${i + 1}. \`${c.toolName}\` → 返回 0 项`);
        return;
      }
      lines.push(`${i + 1}. \`${c.toolName}\` → 返回 ${c.output.length} 项`);
      c.output.slice(0, 12).forEach((it: any) => lines.push(`   - ${esc(itemLabel(it))}`));
      if (c.output.length > 12) lines.push(`   - …其余 ${c.output.length - 12} 项见原样数据（raw JSON）`);
      return;
    }
    if (c.output && typeof c.output === 'object') {
      lines.push(`${i + 1}. \`${c.toolName}\` → ${esc(trunc(JSON.stringify(c.output), 300))}`);
      return;
    }
    lines.push(`${i + 1}. \`${c.toolName}\` → ${esc(trunc(c.output, 200))}`);
  });
  return lines.length ? lines.join('\n') : '（无工具调用）';
}

function renderWorkspaceEvents(trace: any): string {
  const evs = trace.workspaceEvents ?? [];
  if (!evs.length) return '（无工作区事件）';
  const t0 = new Date(trace.startedAt).getTime();
  const lines: string[] = [];
  lines.push('| # | 事件类型 | 相对时刻 | 载荷摘要 |');
  lines.push('| --- | --- | --- | --- |');
  evs.forEach((e: any, i: number) => {
    const at = new Date(e.timestamp).getTime();
    const rel = Number.isFinite(at) ? `+${((at - t0) / 1000).toFixed(1)}s` : '-';
    lines.push(`| ${i + 1} | \`${e.type}\` | ${rel} | ${esc(trunc(JSON.stringify(e.payload ?? {}), 160))} |`);
  });
  return lines.join('\n');
}

function renderKeyEventPayloads(trace: any): string {
  const evs = (trace.workspaceEvents ?? []).filter((e: any) => KEY_EVENTS.has(e.type));
  if (!evs.length) return '（无结构性决策事件）';
  return evs
    .map((e: any, i: number) => `**${i + 1}. \`${e.type}\`**（${e.timestamp}）\n\n${fence(e.payload ?? {}, 'json')}`)
    .join('\n\n');
}

function renderWorkspaceFinal(ws: any): string {
  const lines: string[] = [];
  const evs = ws.evidence ?? [];
  lines.push(`**证据清单（${evs.length} 条 · 由检索写入工作区）**`);
  lines.push('');
  evs.forEach((e: any) => {
    lines.push(`- \`${e.id}\` [${e.sourceType}${e.sourceSchool ? `/${e.sourceSchool}` : ''}] ${esc(e.title ?? '')}${e.evidenceKind ? ` · kind=${e.evidenceKind}` : ''}`);
    if (e.summary) lines.push(`  - 摘要：${esc(trunc(e.summary, 600))}`);
    if (e.relatedCandidates?.length) lines.push(`  - 关联候选：${e.relatedCandidates.join(', ')}`);
    if (e.supportingSignals?.length) lines.push(`  - supportingSignals：${e.supportingSignals.join('；')}`);
    if (e.contradictingSignals?.length) lines.push(`  - contradictingSignals：${e.contradictingSignals.join('；')}`);
  });
  if (!evs.length) lines.push('- （无）');

  const hyps = ws.hypotheses ?? [];
  lines.push('');
  lines.push(`**正式假设（${hyps.length} 条）**`);
  lines.push('');
  if (hyps.length) {
    lines.push('| 假设ID | 标签 | 状态 | 支持 | 反证 | 证据缺口 | 描述 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const h of hyps) {
      lines.push(
        `| \`${h.id}\` | ${esc(h.label)} | \`${h.status}\` | ${(h.supportingEvidenceRefs ?? []).join(', ') || '-'} | ${(h.contradictingEvidenceRefs ?? []).join(', ') || '-'} | ${(h.missingEvidence ?? []).join('；') || '-'} | ${esc(trunc(h.description ?? '', 160))} |`,
      );
    }
  } else {
    lines.push('- （无正式假设）');
  }

  const cands = ws.candidates ?? [];
  lines.push('');
  lines.push(`**候选（${cands.length} 条）**`);
  lines.push('');
  if (cands.length) {
    lines.push('| 候选ref | 类型 | 名称 | formulaId | sourceId | 状态 | 归属假设 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of cands) {
      lines.push(
        `| \`${c.id}\` | ${c.kind} | ${esc(c.name ?? '')} | \`${c.formulaId ?? '-'}\` | \`${c.sourceId ?? '-'}\` | \`${c.status}\` | ${(c.hypothesisRefs ?? []).join(', ') || '-'} |`,
      );
    }
  } else {
    lines.push('- （无候选）');
  }

  const delib = ws.deliberation ?? {};
  const rows = delib.rows ?? [];
  lines.push('');
  lines.push(`**候选 × 假设 权衡（${rows.length} 行）**`);
  lines.push('');
  if (rows.length) {
    lines.push('| 候选ref | 归属假设 | 评估状态 | 支持证据 | 反证证据 | 未决问题 | 评估结论 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      lines.push(
        `| \`${r.candidateRef}\` | ${(r.hypothesisRefs ?? []).join(', ') || '-'} | \`${r.assessmentStatus}\` | ${(r.supportingEvidenceRefs ?? []).join(', ') || '-'} | ${(r.contradictingEvidenceRefs ?? []).join(', ') || '-'} | ${esc((r.unresolvedQuestions ?? []).join('；')) || '-'} | ${esc((r.assessmentSummaries ?? []).join(' / ')) || '-'} |`,
      );
    }
  } else {
    lines.push('- （无）');
  }

  const coverage = delib.coverage ?? [];
  lines.push('');
  lines.push(`**Deliberation 覆盖（${coverage.length}）**：${coverage.map((c: any) => `\`${c.candidateRef}\`=${c.assessmentStatus}${c.exclusionReason ? `(${c.exclusionReason})` : ''}`).join(' · ') || '（无）'}`);
  return lines.join('\n');
}

const METRIC_LABELS: [string, string][] = [
  ['totalToolCalls', '工具调用总数'],
  ['decisionChangingToolCalls', '改变决策的调用'],
  ['reinforcingToolCalls', '强化既有判断的调用'],
  ['nonDecisionChangingToolCalls', '不改变决策的调用'],
  ['knowledgeSearchCount', '知识检索次数'],
  ['formulaSearchCount', '规范方检索次数'],
  ['capabilityActivationCount', '能力激活次数'],
  ['workspaceEventsWritten', '工作区写入事件数'],
  ['redundantSearchCount', '冗余检索次数'],
  ['deduplicatedCallCount', '去重命中次数'],
  ['uniqueCandidatesDiscovered', '发现候选总数'],
  ['uniqueCandidatesPromoted', '被提升为假设归属的候选'],
  ['uniqueCandidatesHydrated', 'canonical 水合的候选'],
  ['uniqueCandidatesValidated', '通过校验的候选'],
  ['retrievalsBeforeFirstViableCandidate', '首个可用候选前的检索次数'],
  ['retrievalsAfterFirstViableCandidate', '首个可用候选后的检索次数'],
  ['retrievalSuggestedHypothesisCount', '由检索自动生成的假设数（应恒为 0）'],
  ['formulaSearchBeforeFormalHypothesis', '是否先检索后立假设'],
  ['patternAssessmentRecorded', '是否记录辨证结构'],
  ['treatmentTargetRecorded', '是否记录治疗靶点'],
  ['currentDominantMechanismRecorded', '是否记录当前主导病机'],
  ['formulaReviewRecorded', '是否记录方剂复核'],
  ['modificationItemsWithPatientEvidence', '有患者证据支撑的加减项'],
  ['clinicalCompletionObligationCreated', '是否产生完成义务'],
  ['completionRequiredArtifacts', '完成义务要求的产物'],
  ['completionMissingArtifactsAtEnd', '结束时缺失的产物'],
  ['falseCompletionAttemptCount', '伪完成尝试次数（应恒为 0）'],
  ['firstViableCandidateRef', '首个可用候选'],
  ['firstViableCandidateStep', '首个可用候选出现的步号'],
];

function renderCommitLedger(trace: any): string {
  const commits = Array.isArray(trace.commits) ? trace.commits : [];
  if (commits.length === 0) return '- （无 CommitRecord）';
  const lines = [
    '| commitId | outcome | provider | delivery | clearance | source | products |',
    '| --- | --- | --- | --- | --- | --- | ---: |',
  ];
  for (const record of commits) {
    lines.push(`| \`${esc(record.commitId ?? '-')}\` | \`${esc(record.outcome ?? '-')}\` | \`${esc(record.providerId ?? '-')}\` | \`${esc(record.deliveryStatus ?? '-')}\` | \`${esc(record.executionClearance ?? '-')}\` | ${esc((record.sourceBundle?.sourceId ?? (record.provenance?.sourceRefs ?? []).join(', ')) || '-')} | ${record.sourceBundle?.products?.length ?? 0} |`);
  }
  lines.push('');
  lines.push('**CommitRecord 原样载荷**');
  commits.forEach((record: any, index: number) => {
    lines.push(`\n**${index + 1}. ${record.outcome ?? '-'}**\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``);
  });
  return lines.join('\n');
}

function renderMetrics(trace: any): string {
  const rm = trace.runMetrics ?? {};
  const al = trace.agentLoop ?? {};
  const lines: string[] = [];
  lines.push('| 指标 | 值 |');
  lines.push('| --- | --- |');
  for (const [k, label] of METRIC_LABELS) {
    const v = rm[k];
    const shown = Array.isArray(v) ? (v.length ? v.join(', ') : '（空）') : v === undefined ? '-' : String(v);
    lines.push(`| ${label} \`${k}\` | ${esc(shown)} |`);
  }
  const cr = al.commitReliability;
  if (cr) {
    lines.push(`| 模型主动提交成功次数 \`agentProposalSubmitSuccessCount\` | ${cr.agentProposalSubmitSuccessCount} |`);
    lines.push(`| Runtime 兜底序列化次数 \`runtimeReadyStateCommitCount\` | ${cr.runtimeReadyStateCommitCount} |`);
    lines.push(`| 最终提交次数 \`finalProposalCommittedCount\` | ${cr.finalProposalCommittedCount} |`);
    lines.push(`| proposal 解析失败 \`proposalParseFailureCount\` | ${cr.proposalParseFailureCount} |`);
    lines.push(`| proposal 重试/重试成功 \`proposalRetryCount\`/\`proposalRetrySuccessCount\` | ${cr.proposalRetryCount} / ${cr.proposalRetrySuccessCount} |`);
  }
  return lines.join('\n');
}

function renderOverview(d: RunRecord): string {
  const trace = d.session.trace;
  const al = trace.agentLoop ?? {};
  return `| 项 | 值 |
| --- | --- |
| runId | \`${d.runId}\` |
| 开始 / 结束（UTC） | ${d.startedAt} → ${d.finishedAt ?? '-'} |
| 总耗时 | ${sec(trace.totalMs)} |
| Runtime 模式 | \`${trace.snapshot?.modelProfileId ?? '-'}\` |
| 输出形态 | \`${d.session.result?.mode}\` |
| 终止原因 | \`${al.terminationReason ?? '-'}\` |
| 模型是否主动提交 | \`${al.proposalSubmitted}\` · 是否 Runtime 兜底 \`${al.forcedFinalization}\` |
| 推理步数 | ${al.stepCount ?? '-'} |
| token 用量 | in=${al.usage?.inputTokens ?? '-'} / out=${al.usage?.outputTokens ?? '-'} |
| 工具调用 / 工作区事件 | ${(trace.toolCalls ?? []).length} / ${(trace.workspaceEvents ?? []).length} |
| promptHash | \`${trace.snapshot?.promptHash ?? '-'}\` |
| 激活能力 | ${(trace.snapshot?.capabilities ?? []).join(', ') || '（无）'} |
| 装载技能 | ${(trace.snapshot?.skills ?? []).join(', ') || '（无）'} |
| 知识范围 | ${(trace.snapshot?.knowledgeScopes ?? []).join(', ') || '（无）'} |`;
}

/**
 * 确定性证据可追溯性自检：结论中每个 evidence_ref 是否能在工作区中找到对应项。
 * 只做身份解析（CF_xxx → 病例事实；其余 → 工作区证据/候选），不做任何临床判断。
 */
function renderTraceability(result: any, ws: any): string {
  if (result?.mode !== 'clinical') return '（非临床结论，无 evidence_refs 需核对）';
  const facts = ws.facts ?? [];
  const cfIds = new Map<string, string>();
  facts.forEach((f: any, i: number) => cfIds.set(`CF_${String(i + 1).padStart(3, '0')}`, String(f.value ?? '')));
  const evidenceIds = new Set<string>();
  for (const e of ws.evidence ?? []) {
    evidenceIds.add(e.id);
    evidenceIds.add(e.sourceRef);
  }
  const candidateIds = new Set<string>();
  for (const c of ws.candidates ?? []) {
    candidateIds.add(c.id);
    if (c.formulaId) candidateIds.add(c.formulaId);
    if (c.sourceId) candidateIds.add(c.sourceId);
  }
  const resolve = (ref: string): string => {
    if (cfIds.has(ref)) return `✓ 病例事实（2.2 表）：${trunc(cfIds.get(ref), 60)}`;
    if (evidenceIds.has(ref)) return '✓ 工作区知识证据（2.10 证据清单）';
    if (candidateIds.has(ref)) return '✓ 候选/来源身份（2.10 候选表）';
    return '✗ 未在工作区中找到';
  };
  const rows: string[] = [];
  const push = (field: string, refs: string[] | undefined) => {
    for (const ref of refs ?? []) rows.push(`| ${field} | \`${ref}\` | ${esc(resolve(ref))} |`);
  };
  push('病名', result.disease?.evidence_refs);
  push('辨证', result.syndrome?.evidence_refs);
  push('治法', result.treatment?.evidence_refs);
  push('规范方', result.formula?.evidence_refs);
  if (!rows.length) return '（结论未引用任何 evidence_ref）';
  return `| 结论字段 | 引用 | 解析结果（确定性） |
| --- | --- | --- |
${rows.join('\n')}`;
}

/** 例序号标签：例一 / 例二 / …（超出中文数字表时退回「例N」）。 */
function caseIndexLabel(idx: number): string {
  return `例${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][idx] ?? idx + 1}`;
}

/**
 * V2.1 执行契约与义务图（Control Plane）——运行结果的确定性骨架。
 *
 * Request IR 的 outcome 承诺（含 REQUIRED 不可表示 → blocking unresolved）与 obligation 终态、
 * readiness 缺失集在同一处呈现；`execution_incomplete` 这类终止原因只有在这里才能看到成因。
 */
function renderControlPlane(cp: any): string {
  if (!cp) return '（本运行没有 Control Plane 快照。）';
  const out: string[] = [];
  out.push(`- 编译状态：\`${cp.requestCompileStatus}\`${cp.requestCompileError ? `（${esc(cp.requestCompileError)}）` : ''}`);
  out.push(`- 输出策略：exclusive=\`${cp.exclusive}\` ｜ formulaCardinality=\`${cp.formulaCardinality}\` ｜ knowledgeSource=\`${cp.knowledgeSourcePolicy}\``);
  out.push('');
  out.push('**Request IR outcome 契约（承诺等级正交于语义身份）**');
  out.push('');
  out.push('| 等级 | 值 |');
  out.push('| --- | --- |');
  out.push(`| required（必须交付） | ${cp.requiredOutcomes?.length ? cp.requiredOutcomes.map((x: string) => `\`${esc(x)}\``).join('、') : '（空）'} |`);
  out.push(`| preferred（希望但不阻塞） | ${cp.preferredOutcomes?.length ? cp.preferredOutcomes.map((x: string) => `\`${esc(x)}\``).join('、') : '（空）'} |`);
  out.push(`| allowed（可以考虑，不产生义务） | ${cp.allowedOutcomes?.length ? cp.allowedOutcomes.map((x: string) => `\`${esc(x)}\``).join('、') : '（空）'} |`);
  out.push(`| excluded（明确不要） | ${cp.excludedOutcomes?.length ? cp.excludedOutcomes.map((x: string) => `\`${esc(x)}\``).join('、') : '（空）'} |`);
  out.push(`| unresolved（REQUIRED 且不可表示 → 阻断） | ${cp.unresolvedOutcomes?.length ? cp.unresolvedOutcomes.map((x: string) => `\`${esc(x)}\``).join('、') : '（无）'} |`);
  out.push(`| preferredShortfalls（非阻断缺口） | ${cp.preferredShortfalls?.length ? cp.preferredShortfalls.map((x: string) => `\`${esc(x)}\``).join('、') : '（无）'} |`);
  out.push('');
  out.push('**用户点名形式与承诺等级（mentions）**');
  out.push('');
  if (cp.mentionOutcomes?.length) {
    out.push('| 点名（原话） | 承诺等级 |');
    out.push('| --- | --- |');
    for (const m of cp.mentionOutcomes) out.push(`| ${esc(m.name)} | \`${esc(m.commitment)}\` |`);
  } else out.push('（无）');
  out.push('');
  out.push('**语义判定（Deterministic Semantic Validator）**');
  out.push('');
  if (cp.semanticValidation?.resolutions?.length) {
    out.push('| 点名 | 关系 | 解析到的 registry term |');
    out.push('| --- | --- | --- |');
    for (const r of cp.semanticValidation.resolutions) out.push(`| ${esc(r.mention)} | \`${esc(r.relation)}\` | ${r.term ? `\`${esc(r.term)}\`` : '-'} |`);
  } else out.push('- 解析结果：（无）');
  if (cp.semanticValidation?.rejected?.length) {
    out.push('');
    out.push('_被判定为「更宽泛家族项顶替具体点名形式」而移除的 required：_');
    out.push('');
    out.push('| term | 点名 | 关系 |');
    out.push('| --- | --- | --- |');
    for (const r of cp.semanticValidation.rejected) out.push(`| \`${esc(r.term)}\` | ${esc(r.mention)} | \`${esc(r.relation)}\` |`);
  }
  out.push('');
  out.push('**规划问题（planning issues）**');
  out.push('');
  out.push(cp.planningIssues?.length
    ? cp.planningIssues.map((i: any) => `- \`${esc(i.type)}\`：${esc(i.message)}`).join('\n')
    : '- （无）');
  out.push('');
  out.push('**义务图（obligation graph）**');
  out.push('');
  if (cp.obligations?.length) {
    out.push('| obligation | artifact 类型 | outcome | provider | 来源 | 必需 | 终态 | blocker |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const ob of cp.obligations) {
      out.push(`| \`${esc(ob.id)}\` | \`${esc(ob.type)}\` | ${ob.outcome ? `\`${esc(ob.outcome)}\`` : '-'} | ${ob.provider ? `\`${esc(ob.provider)}\`` : '-'} | \`${esc(ob.source)}\` | ${ob.required ? '是' : '否'} | \`${esc(ob.status)}\` | ${ob.blocker ? `\`${esc(ob.blocker)}\`` : '-'} |`);
    }
  } else out.push('（无）');
  out.push('');
  out.push('**终态汇总（与 readiness 同一真源）**');
  out.push('');
  out.push(`- 义务计数：required=${cp.requiredObligationCount ?? '-'} ｜ satisfied=${cp.satisfiedObligationCount ?? '-'} ｜ open=${cp.openObligations?.length ?? 0} ｜ blocked=${cp.blockedObligations?.length ?? 0} ｜ notDeliverable=${cp.notDeliverableObligations?.length ?? 0}`);
  out.push(`- graphComplete=\`${cp.graphComplete}\` ｜ readiness.ready=\`${cp.readiness?.ready}\` ｜ blockerCodes=[${(cp.readiness?.blockerCodes ?? []).map((c: string) => `\`${esc(c)}\``).join(', ')}]`);
  out.push(`- 未满足的必需义务（readiness 缺失集）：${cp.unmetObligations?.length ? cp.unmetObligations.map((x: string) => `\`${esc(x)}\``).join('、') : '（无）'}`);
  out.push(`- 缺失 artifact：${cp.readiness?.missingArtifacts?.length ? cp.readiness.missingArtifacts.map((x: string) => `\`${esc(x)}\``).join('、') : '（无）'}`);
  out.push('');
  out.push(`**outcome 覆盖投影（最终结果装配输入）**`);
  out.push('');
  out.push(cp.outcomeCoverage?.length
    ? `| outcome | 覆盖状态 |\n| --- | --- |\n${cp.outcomeCoverage.map((c: any) => `| \`${esc(c.outcome)}\` | \`${esc(c.status)}\` |`).join('\n')}`
    : '（无）');
  if (cp.appliedBlockers?.length) {
    out.push('');
    out.push('**已施加的 typed blocker（唯一允许重新打开定向检索的通道）**');
    out.push('');
    out.push('| obligation | 类型 | 问题 |');
    out.push('| --- | --- | --- |');
    for (const b of cp.appliedBlockers) out.push(`| \`${esc(b.obligationId)}\` | \`${esc(b.type)}\` | ${esc(b.question)} |`);
  }
  if (cp.steps?.length) {
    out.push('');
    out.push('**逐步 runnable 义务与当时可执行动作面**');
    out.push('');
    out.push('| 步 | runnable obligations | legal effect surface |');
    out.push('| --- | --- | --- |');
    for (const st of cp.steps) {
      out.push(`| ${st.step} | ${st.runnable?.length ? st.runnable.map((x: string) => `\`${esc(short(x, 40))}\``).join('、') : '-'} | ${st.surface?.length ? esc(short(st.surface.join(', '), 160)) : '-'} |`);
    }
  }
  return out.join('\n');
}

function renderCase(d: RunRecord, idx: number): string {
  const s = d.session;
  const trace = s.trace;
  const label = caseIndexLabel(idx);
  return `## ${label}｜${esc(caseLabel(d.input))}

> 运行 ID：\`${d.runId}\` ｜ 输出形态：\`${s.result?.mode}\` ｜ 耗时：${sec(trace.totalMs)}

### 一、输入（医生原始输入，原样保留）

${fence(d.input, 'text')}

### 二、处理过程

#### 2.1 运行概览

${renderOverview(d)}

#### 2.2 语义理解与安全处置（Understanding / Safety）

${renderUnderstanding(s.workspace)}

#### 2.3 临床总策划（Planner：只定策略，不下病/证/方结论）

${renderStrategy(s.strategy)}

#### 2.4 能力与技能激活（由 Agent 运行时发现并激活）

- 实际装载能力（运行快照）：${(trace.snapshot?.capabilities ?? []).join(', ') || '（无）'}
- 实际装载技能（运行快照）：${(trace.snapshot?.activeSkills ?? []).join(', ') || '（无）'}
- 工作区记录的激活结果：activeCapabilities=[${(s.workspace.activeCapabilities ?? []).join(', ') || '（无）'}] · activeSkills=[${(s.workspace.activeSkills ?? []).join(', ') || '（无）'}]
- 技能版本：${(trace.snapshot?.skillVersions ?? []).map((v: any) => `${v.id}@${v.version}`).join(', ') || '（无）'}
- 知识范围：${(trace.snapshot?.knowledgeScopes ?? []).join(', ') || '（无）'}

#### 2.5 工具调用时序

${renderToolCalls(trace)}

#### 2.6 检索诊断明细（检索与决策分离的可观测面）

${renderRetrievalDetail(trace)}

#### 2.7 工具返回内容（按调用顺序）

${renderToolIoDetail(trace)}

#### 2.8 工作区事件时序（事件溯源）

${renderWorkspaceEvents(trace)}

#### 2.9 结构性决策事件全文

${renderKeyEventPayloads(trace)}

#### 2.10 工作区终态

${renderWorkspaceFinal(s.workspace)}

#### 2.11 执行契约与义务图（Control Plane V2.1）

> Request IR 在 prepare 阶段编译；本节是运行结果的确定性骨架——outcome 承诺等级、obligation 终态、
> readiness 缺失集三者同源。\`execution_incomplete\` 之类终止原因的成因只在这里可见。

${renderControlPlane(trace.agentLoop?.controlPlane)}

### 三、结果输出

#### 3.1 最终结论（Proposal）

${renderResult(s.result)}

#### 3.2 内核裁决（Authority Pipeline）

- 裁决结果：\`${s.authority?.status}\`
${(s.authority?.decisions ?? []).map((dec: any) => `- 关卡 \`${dec.stage}\` → \`${dec.action}\`${dec.reasons?.length ? `（${dec.reasons.join('；')}）` : ''}`).join('\n')}

#### 3.3 Kernel Commit Ledger（权威交付真相）

${renderCommitLedger(trace)}

#### 3.4 提交可靠性与过程指标

> 以下为运行时遥测原值，仅作事实记录，不含通过/不通过判定；计数为 0 表示该路径本次未被触发，不等同于该环节缺失。

${renderMetrics(trace)}

#### 3.5 上下文度量

- 工作视图 token 估算：${trace.contextMetrics?.workingViewTokenEstimate ?? '-'}
- 原始上下文 token 估算：${trace.contextMetrics?.rawContextTokenEstimate ?? '-'}
- 压缩比：${trace.contextMetrics?.compressionRatio?.toFixed?.(2) ?? '-'}
- prompt 组成：${JSON.stringify(trace.agentLoop?.promptComponents ?? {})}

#### 3.6 证据可追溯性自检（确定性，无临床判断）

${renderTraceability(s.result, s.workspace)}

### 四、原样数据

- 本条完整原始记录：\`raw/${d.runId}.json\`

---
`;
}

/* ---------------- 主流程 ---------------- */

async function main(): Promise<void> {
  const cookie = await login();
  const list = await apiGet<{ total: number; items: RunRecord[] }>(cookie, `${BASE_URL}/api/traces`);
  const wanted = RUN_IDS.length ? RUN_IDS : list.items.map((i) => i.runId);
  const records: RunRecord[] = [];
  for (const id of wanted) {
    const rec = await apiGet<RunRecord>(cookie, `${BASE_URL}/api/traces/${encodeURIComponent(id)}`);
    if (!rec.session) throw new Error(`运行 ${id} 无 session（status=${rec.status}${rec.status === 'error' ? `, error=${(rec as any).error}` : ''}）`);
    records.push(rec);
  }
  // 按运行时间正序（最早的为「例一」）
  records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const rawDir = path.join(OUT_DIR, 'raw');
  mkdirSync(rawDir, { recursive: true });
  for (const r of records) writeFileSync(path.join(rawDir, `${r.runId}.json`), `${JSON.stringify(r, null, 2)}\n`);

  const cases = records.map(renderCase).join('\n');
  const md = `# 蒲公英中医临床 AI · ${records.length} 例全链路记录（专家审核用）

> **本文件为只读导出**：内容全部来自本地运行实例 \`${BASE_URL}\` 已完成的 ${records.length} 次真实运行记录，未经人工改写。
> 每条记录在链路中完全等价于医生端 \`POST /api/run/stream\` 的一次完整会话（同一套 Runtime 装配，不绕开 Authority）。
> 导出时间：${new Date().toISOString()} ｜ 时间戳均为 UTC。

## 0. 运行环境

| 项 | 值 |
| --- | --- |
| 实例地址 | \`${BASE_URL}\` |
| Runtime 模式 | \`clinical-primary:harness\`（Agent 自主发现能力） |
| 模型 | \`deepseek-chat\`（fast = deep） |
| 知识库 release | \`2026.09.18-agent-ready-r1\`（医生端 /api/health 报告 docCount=4428） |
| promptHash | \`${records[0]?.session?.trace?.snapshot?.promptHash ?? '-'}\`（${records.length} 例一致） |
| 代码基线（导出时） | \`${codeBaseline()}\` |
| 记录条数 | ${records.length} ｜ ${records.every((d) => d.status === 'done') ? '全部 `status=done`' : '存在非 done 记录'} |

> 关于代码基线：记录由**已在运行的本地服务进程**产出（不是导出时重新推理）。若该进程启动之后工作区又发生过改动，
> 运行实际加载的是**进程启动时**的代码，与导出时的 HEAD 可能不一致；跨版本对比研究时请以此为前提。

## 0.1 结果速览

| 例 | 运行 ID | 输出形态 | 终止原因 | 耗时 | graph / ready | outcome 覆盖 | unresolved | 结论摘要 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${records
  .map((d, i) => {
    const r = d.session.result;
    const cp = d.session.trace.agentLoop?.controlPlane;
    const graph = cp ? `${cp.graphComplete ? '✔' : '✘'} / ${cp.readiness?.ready ? '✔' : '✘'}` : '-';
    const coverage = cp?.outcomeCoverage?.length
      ? cp.outcomeCoverage.map((c: any) => `${c.outcome}=${c.status}`).join('、')
      : '-';
    const unresolved = cp?.unresolvedOutcomes?.length ? cp.unresolvedOutcomes.join('、') : '-';
    let brief: string;
    if (r?.mode === 'clinical') brief = [r.disease?.name, r.syndrome?.name, r.formula?.name].filter(Boolean).join('｜') || 'clinical';
    else if (r?.mode === 'clarification') brief = `追问 ${(r.questions ?? []).length} 项`;
    else brief = short(r?.message ?? '', 70);
    return `| ${caseIndexLabel(i)} | \`${d.runId}\` | \`${r?.mode}\` | \`${d.session.trace.agentLoop?.terminationReason ?? '-'}\` | ${sec(d.session.trace.totalMs)} | ${graph} | ${esc(coverage)} | ${esc(unresolved)} | ${esc(brief)} |`;
  })
  .join('\n')}

## 0.2 阅读指引

每条记录按 **输入 → 处理过程（2.1–2.11）→ 结果输出（3.1–3.5）→ 原样数据** 排列：

| 阶段 | 含义 | 对应代码位置（供核对） |
| --- | --- | --- |
| 2.2 语义理解 / 安全 | 把医生原话结构化为病例事实、信息缺口、不确定项与安全处置 | \`src/clinical/understanding.ts\`、\`src/clinical/risk.ts\` |
| 2.3 临床总策划 | 只确定「当前要回答什么问题、还缺什么证据、何时停」，不下病/证/方结论 | \`src/platform/planning/clinical-planner.ts\` |
| 2.4 能力与技能 | 由 Agent 依语义需求发现并激活，Core 不做业务预路由 | \`src/platform/runtime/harness-session.ts\`、\`src/platform/registry/*\` |
| 2.5–2.7 工具与检索 | Agent 每一步调了什么、拿到什么；检索诊断用于核对「检索不自动生成结论」 | \`src/adapters/ai-sdk/agent-runtime.ts\`、\`src/knowledge/diagnostics.ts\` |
| 2.8–2.10 工作区 | 事件溯源 + 终态（证据 / 假设 / 候选 / 权衡），是提交门禁的唯一依据 | \`src/platform/workspace/*\` |
| 2.11 执行契约与义务图 | Request IR 的 outcome 承诺等级、obligation graph 终态、readiness 缺失集（同一真源）；终止原因的成因面 | \`src/control-plane-v2/*\`、\`src/control-plane-v21/*\`、\`src/platform/control-plane/*\` |
| 3.1 结论 | 模型产出的 Proposal（未获授权前的形态） | \`src/contracts/result.ts\` |
| 3.2 内核裁决 | Safety 不变量 + 规范方 Authority；Agent 不可绕过 | \`src/platform/authority/*\`、\`src/authority/formula-authority.ts\` |
| 3.3 指标 | 提交可靠性（模型主动提交 vs Runtime 兜底）与完成义务缺失项 | \`src/platform/workspace/proposal-readiness.ts\` |
| 3.5 追溯自检 | 结论引用的每个 \`evidence_ref\` 能否在工作区解析到（确定性身份核对） | \`src/platform/workspace/clinical-workspace.ts\`（证据身份校验） |

**术语对照**

- \`Proposal\`：模型给出的建议，不是处方；只有通过内核裁决才是权威状态。
- \`CF_xxx\`：理解层写入工作区的病例事实稳定身份；结论中的 \`evidence_refs\` 若为 \`CF_xxx\` 即指向 2.2 表格中的同一行。
- \`P1:K_xxx\`：规范知识来源（病-证-法-方 原子），\`S1:xxx\`：辅助/鉴别知识来源。
- \`GF-xxx\` / \`AC-xxx\`：膏方 / 针灸等治疗形式资产编号。
- \`terminationReason\`：\`agent_submitted\`（模型主动提交）/ \`execution_incomplete\`（预算耗尽且产物不全，如实标记）。

---

${cases}
## 附录 A · ${records.length} 条记录的原始数据

| 例 | 原始记录文件 |
| --- | --- |
${records.map((d, i) => `| ${caseIndexLabel(i)} | \`raw/${d.runId}.json\` |`).join('\n')}

> 原始记录为服务端返回的完整 SessionView（result / authority / workspace / trace），未做任何裁剪。
`;

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${records.length}例全链路记录.md`);
  writeFileSync(outFile, md);
  console.log(`[expert-chain] 已生成：${outFile}`);
  console.log(`[expert-chain] 原始记录目录：${rawDir}`);
  console.log(`[expert-chain] 记录条数：${records.length}（${records.map((r) => r.runId).join(', ')}）`);
}

main().catch((e) => {
  console.error(`[expert-chain] 失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
