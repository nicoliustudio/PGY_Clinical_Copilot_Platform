import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 把 run-18-subset 落盘的原始 ClinicalRunResult 渲染成参考格式的全链路记录 md。
 * 数据源：reports/raw-18-subset/*.json（本地最新代码，含 H15.5.3 completion 修复）。
 */

const RAW_DIR = path.resolve('reports', 'raw-18-subset');
const OUT = path.resolve('reports', '18例子集-全过程链路记录.md');

interface Meta {
  title: string;
  goal: string;
  expectDisease: string;
  expectSyndrome: string;
  expectTreatment: string;
  expectFormula: string;
  hardPass: string;
  forbid: string;
}

const META: Record<string, Meta> = {
  T01: {
    title: '基础方｜妇科·月经后期',
    goal: '简单单证；寒证识别；基础方闭环',
    expectDisease: '月经后期',
    expectSyndrome: '血寒',
    expectTreatment: '温经散寒，养血调经',
    expectFormula: '大营煎加减',
    hardPass: '不得机械症状计数；完成主诉→辨证→治法→基础方；患者证据可追溯',
    forbid: '不得因“便溏”单信号改判脾虚为主；不得 forced',
  },
  T03: {
    title: '基础方｜妇科·子宫肌瘤术后',
    goal: '治疗后病例；当前 vs 历史；不被既往强信号绑架',
    expectDisease: '子宫肌瘤（术后）',
    expectSyndrome: '肝郁脾虚为当前主导，既往血瘀作为病史/兼夹',
    expectTreatment: '健脾升清，疏肝散结',
    expectFormula: '妇2号方为参考',
    hardPass: '明确区分当前证据与历史证据；当前证据参与主证形成',
    forbid: '不得仅因既往色黯血块/剧痛直接锁定气滞血瘀；不得忽略术后时序',
  },
  T07: {
    title: '基础方｜内科·便秘',
    goal: '老年慢性病；阴液亏损；避免见秘即攻下',
    expectDisease: '老年便秘',
    expectSyndrome: '阴液亏损，郁热内阻',
    expectTreatment: '养血增液，和胃通幽',
    expectFormula: '当归、肉苁蓉、生熟地、枳实、火麻仁、全瓜蒌、松子仁等',
    hardPass: '体现年老、津亏、少苔、细数等证据；基础方不是简单泻下匹配',
    forbid: '不得“便秘→大黄”式规则化；不得过度攻下',
  },
  T11: {
    title: '膏方｜妇科·月经失调膏方',
    goal: '膏方正向触发；显式 GAOFANG intent；妇科长期调理',
    expectDisease: '月经失调',
    expectSyndrome: '气血不足，冲任不和，脾肾两亏',
    expectTreatment: '调理冲任，补益气血',
    expectFormula: 'GF-010 或同源妇科月经失调膏方证据',
    hardPass: '明确识别 GAOFANG intent；膏方知识只作证据，不因案例相似照抄',
    forbid: '不得忽略膏方意图走普通汤剂；不得由膏方案例直接替代患者辨证',
  },
  T13: {
    title: '膏方｜内科·肺结核后调养膏方',
    goal: '膏方正向触发；现代病治疗背景；膏方不替代规范治疗',
    expectDisease: '肺结核（抗痨治疗中）',
    expectSyndrome: '肺虚阴液不足，兼肺肾亏虚、气血不足',
    expectTreatment: '调养肺肾，益气养阴，滋补气血',
    expectFormula: 'GF-001 或同源肺结核膏方证据',
    hardPass: '识别膏方 intent；保留现代病规范治疗边界',
    forbid: '不得声称膏方替代抗结核治疗；不得忽略咯血/潮热等当前状态',
  },
  T15: {
    title: '针灸｜妇科·痛经针灸',
    goal: 'ACUPUNCTURE 显式意图；不强迫方剂；针灸证据检索',
    expectDisease: '痛经',
    expectSyndrome: '气滞为主',
    expectTreatment: '疏肝理气，调经止痛',
    expectFormula: 'AC-049；三阴交、关元、合谷；耳针子宫、交感、生殖区',
    hardPass: '允许完成针灸任务而无需 selectedCandidateRef；针灸方案必须有 source evidence',
    forbid: '不得被 treatment/formula gate 阻断；不得自动转为开中药方',
  },
};

const ORDER = ['T01', 'T03', 'T07', 'T11', 'T13', 'T15'];

function load(id: string): any {
  return JSON.parse(readFileSync(path.join(RAW_DIR, `${id}.json`), 'utf8'));
}

function trunc(s: unknown, n: number): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  if (str.length <= n) return str;
  return `${str.slice(0, n)}…（共 ${str.length} 字符）`;
}

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtFact(f: any): string {
  return `[${f.kind}/${f.temporalRole}/${f.polarity}] ${f.value}`;
}

function summarizeInput(input: any): string {
  if (!input || Object.keys(input).length === 0) return '{}';
  if (typeof input.query === 'string') return `query=${trunc(input.query, 60)} topK=${input.topK ?? ''}`;
  if (typeof input.sourceId === 'string') return `sourceId=${input.sourceId}`;
  if (typeof input.candidateRef === 'string') return `candidateRef=${input.candidateRef}`;
  if (typeof input.id === 'string' && typeof input.reason === 'string') return `{"id":"${input.id}"}`;
  if (typeof input.id === 'string') return `{"id":"${input.id}"}`;
  return trunc(input, 80);
}

function summarizeOutput(output: any): string {
  if (Array.isArray(output)) {
    if (output.length === 0) return '0 项';
    const first = output[0];
    const label = first?.title ?? first?.name ?? first?.id ?? '';
    return `${output.length} 项 · 首项: ${trunc(label, 40)}`;
  }
  if (output && typeof output === 'object') return trunc(output, 120);
  return trunc(output, 80);
}

function renderOverview(d: any): string {
  const t = d.trace;
  const al = t.agentLoop || {};
  const term = `${al.terminationReason ?? 'unknown'} · proposalSubmitted=${al.proposalSubmitted} · forcedFinalization=${al.forcedFinalization}`;
  return `| 项 | 值 |
| --- | --- |
| runId | \`${d.runId}\` |
| 时间 | ${d.startedAt} → ${d.finishedAt}（${sec(d.totalMs)}） |
| 状态 | ${d.result.mode} |
| 终止原因 | \`${term}\` |
| step 数 | ${al.stepCount ?? '?'} |
| token | in=${al.usage?.inputTokens ?? '?'} / out=${al.usage?.outputTokens ?? '?'} |
| 工具调用数 | ${(t.toolCalls || []).length} |
| Workspace 事件数 | ${(t.workspaceEvents || []).length} |`;
}

function renderUnderstanding(d: any): string {
  const ws = d.workspace;
  const lines: string[] = [];
  lines.push(`- safetyDisposition: \`${ws.safetyDisposition}\``);
  lines.push(`- facts (${(ws.facts || []).length}):`);
  for (const f of ws.facts || []) lines.push(`  - ${fmtFact(f)}`);
  lines.push(`- informationGaps (${(ws.informationGaps || []).length}):`);
  for (const g of ws.informationGaps || []) lines.push(`  - ${g}`);
  lines.push(`- uncertainties (${(ws.uncertainties || []).length}):`);
  for (const u of ws.uncertainties || []) lines.push(`  - ${u}`);

  const hyps = ws.hypothesisState?.hypotheses || ws.hypotheses || [];
  lines.push(`- hypotheses (${hyps.length}):`);
  for (const h of hyps) {
    const sup = (h.supportingEvidenceRefs || []).length;
    const con = (h.contradictingEvidenceRefs || []).length;
    const miss = (h.missingEvidence || []).length;
    lines.push(`  - \`${h.id}\` ${h.label} · status=${h.status} · 支持 ${sup} / 反证 ${con} / 缺口 ${miss}`);
  }

  const cands = ws.candidates || [];
  lines.push(`- candidates (${cands.length}):`);
  for (const c of cands) {
    lines.push(`  - \`${c.id}\` ${c.name ?? '(未命名)'} · ${c.sourceId ?? ''}`);
  }

  // evidence：从 workspaceEvents 里 evidence.added 事件按 id 去重还原 title/tier
  const evMap = new Map<string, any>();
  for (const ev of d.trace.workspaceEvents || []) {
    if (ev.type === 'evidence.added' && ev.payload?.id) {
      if (!evMap.has(ev.payload.id)) evMap.set(ev.payload.id, ev.payload);
    }
  }
  const evs = [...evMap.values()];
  lines.push(`- evidence (${evs.length}):`);
  for (const e of evs) {
    lines.push(`  - \`${e.id}\` [${e.sourceType ?? '?'}] ${e.title ?? ''}`);
  }

  lines.push(`- activeCapabilities: ${(ws.activeCapabilities || []).join(', ') || '(无)'}`);
  return lines.join('\n');
}

function renderPlanner(d: any): string {
  const s = d.trace.clinicalStrategy;
  if (!s) return '（无 Planner 输出）';
  return JSON.stringify(s, null, 2);
}

function renderToolCalls(d: any): string {
  const calls = d.trace.toolCalls || [];
  const rows = calls.map((c: any, i: number) => {
    const name = c.reused ? `${c.toolName} ♻️` : c.toolName;
    return `| ${i + 1} | \`${name}\` | ${summarizeInput(c.input)} | ${c.ms != null ? sec(c.ms) : '0.0s'} | ${summarizeOutput(c.output)} |`;
  });
  return `| # | 工具 | 关键入参 | 耗时 | 输出摘要 |
| --- | --- | --- | --- | --- |
${rows.join('\n')}`;
}

function renderWorkspaceEvents(d: any): string {
  const evs = d.trace.workspaceEvents || [];
  return evs.map((ev: any, i: number) => `${i + 1}. \`${ev.type}\` ${trunc(ev.payload, 180)}`).join('\n');
}

function renderProposal(d: any): string {
  const r = d.result;
  if (r.mode === 'clinical') {
    const lines: string[] = [`- mode: \`clinical\``, `- status: \`${r.status}\``];
    if (r.disease) lines.push(`- disease: ${JSON.stringify(r.disease)}`);
    if (r.syndrome) lines.push(`- syndrome: ${JSON.stringify(r.syndrome)}`);
    if (r.treatment) lines.push(`- treatment: ${JSON.stringify(r.treatment).slice(0, 300)}`);
    if (r.formula) lines.push(`- formula: ${JSON.stringify(r.formula).slice(0, 500)}`);
    if (r.missing_information?.length) lines.push(`- missing_information: ${JSON.stringify(r.missing_information)}`);
    if (r.safety) lines.push(`- safety: ${JSON.stringify(r.safety)}`);
    return lines.join('\n');
  }
  if (r.mode === 'clarification') {
    return `- mode: \`clarification\`\n- questions:\n${(r.questions || []).map((q: string) => `  - ${q}`).join('\n')}`;
  }
  if (r.mode === 'urgent') {
    return `- mode: \`urgent\`\n- message: ${r.message}\n- risks: ${JSON.stringify(r.risks || [])}`;
  }
  return `- mode: \`${r.mode}\`\n- message: ${r.message}`;
}

function renderAuthority(d: any): string {
  const a = d.authority;
  const lines = [`- status: \`${a.status}\``];
  for (const dec of a.decisions || []) {
    lines.push(`- stage \`${dec.stage}\` → \`${dec.action}\`${dec.reasons?.length ? ` (${dec.reasons.join('; ')})` : ''}`);
  }
  return lines.join('\n');
}

function renderCommit(d: any): string {
  const cr = d.trace.agentLoop?.commitReliability;
  if (!cr) return '（无 commit reliability 数据）';
  return JSON.stringify(cr, null, 2);
}

function cell(s: unknown): string {
  return String(s ?? '（无）').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderAssessment(id: string, d: any): string {
  const m = META[id];
  const r = d.result;
  let diseaseAct: string, syndromeAct: string, treatmentAct: string, formulaAct: string;
  if (r.mode === 'clinical') {
    diseaseAct = r.disease?.name ?? '（无）';
    syndromeAct = r.syndrome?.name ?? '（无）';
    treatmentAct = r.treatment?.text ?? '（无）';
    formulaAct = r.formula?.name
      ? `${r.formula.name}${r.formula.composition?.length ? `（${r.formula.composition.slice(0, 4).join('，')}${r.formula.composition.length > 4 ? '…' : ''}）` : ''}`
      : '（无）';
  } else if (r.mode === 'conversation') {
    const msg = `conversation：${r.message}`;
    diseaseAct = syndromeAct = treatmentAct = formulaAct = msg;
  } else if (r.mode === 'clarification') {
    const msg = `clarification（追问 ${(r.questions || []).length} 项，未到开方）`;
    diseaseAct = syndromeAct = treatmentAct = formulaAct = msg;
  } else if (r.mode === 'urgent') {
    const msg = `urgent：${r.message}`;
    diseaseAct = syndromeAct = treatmentAct = formulaAct = msg;
  } else {
    diseaseAct = syndromeAct = treatmentAct = formulaAct = r.mode;
  }

  return `| 项 | 预期 | 实际 |
| --- | --- | --- |
| 病名 | ${cell(m.expectDisease)} | ${cell(diseaseAct)} |
| 辨证 | ${cell(m.expectSyndrome)} | ${cell(syndromeAct)} |
| 治法 | ${cell(m.expectTreatment)} | ${cell(treatmentAct)} |
| 方/知识命中 | ${cell(m.expectFormula)} | ${cell(formulaAct)} |

> 硬性条件：${m.hardPass}
> 不得出现：${m.forbid}`;
}

function renderCase(id: string): string {
  const d = load(id);
  const m = META[id];
  return `## ${id} · ${m.title}

> 测试目标：${m.goal}

### 输入

\`\`\`text
${d.input}
\`\`\`

### 运行概览

${renderOverview(d)}

### 阶段一：Clinical Understanding（语义理解）与 Safety

${renderUnderstanding(d)}

### 阶段二：Clinical Planner（临床总策划）

\`\`\`json
${renderPlanner(d)}
\`\`\`

### 阶段三：Agent 推理链路（工具调用时序）

${renderToolCalls(d)}

### 阶段四：Workspace 事件时序

${renderWorkspaceEvents(d)}

### 最终输出（Proposal）

${renderProposal(d)}

### Authority 裁决

${renderAuthority(d)}

### 模型自行提交 vs Runtime 兜底

\`\`\`json
${renderCommit(d)}
\`\`\`

### 评估对照

${renderAssessment(id, d)}

---
`;
}

function main(): void {
  const cases = ORDER.map(renderCase).join('\n');
  const now = new Date().toISOString();
  const md = `# 蒲公英中医 AI — 18 例测试集子集全链路记录（T01/T03/T07/T11/T13/T15）

> 来源：本地最新代码（含 H15.5.3 completion 修复，尚未提交上线），进程内直接调 \`runCase\`（等价于 \`/api/run/stream\` 的 harness assembly）实测，未经人工改写。

## 0. 运行环境

| 项 | 值 |
| --- | --- |
| Runtime 模式 | \`harness\` |
| LLM 通道 | DeepSeek 官方（deepseek-chat，非思考型） |
| 模型 | \`deepseek-chat\`（fast = deep） |
| 知识库 release | \`2026.09.18-agent-ready-r1\` |
| 代码版本 | 本地工作区（HEAD=\`eabb8b8\` + 未提交 H15.5.3 修复） |
| 入口 | 进程内 \`runCase(input)\`（≈ \`POST /api/run/stream\`） |
| 生成时间 | ${now} |

## 0.1 结果速览

| 用例 | 类型 | mode | 耗时 | 结果摘要 |
| --- | --- | --- | --- | --- |
${ORDER.map((id) => {
  const d = load(id);
  const tfd = d.workspace?.clinicalDecisionSpine?.treatmentPlan?.treatmentFormDecision;
  const form = tfd?.form && tfd.form !== '汤剂（煎服）' ? `[${tfd.form}]` : '';
  const brief = d.result.mode === 'clinical'
    ? ([d.result.disease?.name, d.result.syndrome?.name, `${d.result.formula?.name ?? ''}${form}`].filter(Boolean).join('｜') || 'clinical')
    : d.result.mode === 'clarification' ? `clarification(${d.result.questions?.length ?? 0})` : d.result.message?.slice(0, 40);
  return `| ${id} | ${META[id].title.split('｜')[1]} | \`${d.result.mode}\` | ${sec(d.totalMs)} | ${cell(brief)} |`;
}).join('\n')}

---

> ⚠️ 已知偶发：T03 首次运行（本批采集前）曾出现模型输出 JSON 解析失败（\`Expected ',' or '}' after property value in JSON\`），重跑成功。属于模型结构化输出偶发不稳定，详见下文 T03 章节与结论。

---

${cases}

## 结论与问题清单

### 通过项

- **T01**：血寒（虚寒）→ 大营煎加减，病/证/方三者与预期一致，基础方闭环正常。
- **T15**：针灸 intent 正确触发（激活 \`tcm.external-therapy\`），输出痛经（气滞型）辨证，未强制输出方剂（符合针灸任务预期），未被 treatment/formula gate 阻断。

### 问题项（待排查）

1. **【T07】便秘任务未收敛** → \`conversation\` + \`EXECUTION_INCOMPLETE: missing artifacts [formulaSelection, formulaReview]\`
   - 已定位：T07 共调用 \`formula.search_candidates\` 6 次，但 \`runMetrics.selectedCandidateRef\` 始终为空、\`formulaReviewRecorded=false\`，最终 formulaSelection/formulaReview 缺失。
   - 检索诊断显示多次 \`formula.search_candidates\` 的 query 为空串，疑似对「老年阴虚肠燥便秘」未返回可采纳候选方，或候选未进入 selection。
   - 排查方向：\`formula.search_candidates\` 对便秘证型的候选返回逻辑；为何候选为空/未被采纳，且 completion 在 formulaSelection 缺失时直接终止而非进入 COMPLETION_RECOVERY。

2. **【T11 / T13】膏方链路已兑现（非 bug），但 T11 的膏方组成信息缺失**
   - 两例均正确激活 \`gaofang\` + 加载 \`gaofang-reasoning\`，且 \`treatmentPlan.treatmentFormDecision.form\` 均已记录为「膏方（以膏代煎）」（T13 含收膏工艺与用法：阿胶收膏、每日 1 匙冲服）。
   - 差异：T13 的 \`advisoryComposition\` 有完整收膏内容，T11 的 \`advisoryComposition\` 为空。**待确认**是 GF 资产本身不含组成，还是模型未回填膏方组成（次要问题，非链路断裂）。

3. **【T03】辨证偏差**：预期「肝郁脾虚为主导、既往血瘀为病史/兼夹」，实际主证判为「气虚血瘀」
   - 疑似将既往「色黯血块/剧痛」的瘀血证据升格为当前主证，或对「当前 vs 历史」时序区分不足（触及测试集「不得出现」项）。
   - 排查方向：T03 的 patternAssessment rationale 中「瘀」的证据来源是当前还是既往；HIFU 术后时序是否被正确建模。

4. **【T03】偶发 JSON 解析失败**：首次运行报 \`Expected ',' or '}' after property value in JSON at position 3613\`（5.6s 即失败），重跑成功
   - 模型结构化输出（deepseek-chat）存在偶发 JSON 语法错误；运行时无有效重试/容错兜底（或兜底未触发）。
   - 排查方向：proposal 解析失败后的重试机制（\`runMetrics.proposalParseFailureCount\`）为何未生效或未成功恢复。

`;
  writeFileSync(OUT, md);
  console.log(`[render] 已生成：${OUT}`);
}

main();
