import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

/**
 * 第一轮真实回归：上一轮 live 10 例原样重跑（不改 input、不改 expected）。
 *
 * 通道：HTTP POST /api/run/stream（唯一落盘端点，runStore.save）。
 * 每例采集 12 项明细 + 4 探针判定 + 运行通过性检查（事务异常 / implicit primary / provenance 丢失）。
 * 输出：reports/live10-round1-analysis.json + 控制台汇总。完整 run trace 由 render-runs-md.ts 另行渲染。
 */

loadEnv();

const BASE = process.env.REG_BASE_URL ?? 'http://localhost:8787';
const CASES_FILE = process.env.REG_CASES ?? 'tmp-live10-cases.json';
const OUT_DIR = path.resolve('reports');
const OUT_FILE = path.join(OUT_DIR, 'live10-round1-analysis.json');
const PER_CASE_TIMEOUT_MS = Number(process.env.REG_TIMEOUT_MS ?? 8 * 60 * 1000);
const ADMIN_LOGIN = process.env.BOOTSTRAP_ADMIN_LOGIN ?? 'admin';
const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';

/* ---------- gold / probe 映射（KB = assets/knowledge/releases/2026.09.18-agent-ready-r1） ---------- */

interface GoldProduct {
  ref: string;
  name: string;
  expected?: 'PRIMARY' | 'ALTERNATIVE';
}
interface GoldSpec {
  label: string;
  source: string | null;
  products: GoldProduct[];
  probe?: string;
  note?: string;
  altSource?: string;
  altProducts?: GoldProduct[];
}

const GOLD: Record<number, GoldSpec> = {
  1: {
    label: '子宫肌瘤(1978·气滞血瘀·3产品源)',
    source: 'K_460013ecebf1',
    products: [
      { ref: 'F_033933373d17', name: '桂枝茯苓丸加味', expected: 'PRIMARY' },
      { ref: 'F_46afc5a024af', name: '消肌瘤方验方' },
      { ref: 'F_36795de326f2', name: '妇1号方' },
    ],
    probe: '肌瘤#1：K_460013ecebf1 已入 CandidateSet，本轮要求 3 产品全决策 + exactly-one-SELECT；若仍选 P2（消肌瘤方验方）须看 ProductDecision 证据链，而非再改 recall。',
  },
  2: {
    label: '子宫肌瘤(粘膜下·经量过多如注·3产品源)',
    source: 'K_460013ecebf1',
    products: [
      { ref: 'F_033933373d17', name: '桂枝茯苓丸加味', expected: 'PRIMARY' },
      { ref: 'F_46afc5a024af', name: '消肌瘤方验方' },
      { ref: 'F_36795de326f2', name: '妇1号方' },
    ],
    probe: '肌瘤#2：同 K_460013ecebf1；经量过多如注 + 贫血，ProductDecision 证据链是否针对本患者事实。',
  },
  3: {
    label: '产后出血(气虚·authored sequence·2产品源)',
    source: 'K_d9558a9badbe',
    products: [
      { ref: 'F_ba0e3bdc9bf9', name: '独参汤' },
      { ref: 'F_fef07865fac6', name: '回逆汤' },
    ],
    probe: 'source trajectory（先予益气回阳→待证情缓解→再随证施治）必须被模型实际看到并使用（两层 stage 呈现），而不仅"字段存在"。',
  },
  4: {
    label: '经期延长(阴虚·2产品源)',
    source: 'K_190d5eaee005',
    products: [
      { ref: 'F_1b9c5c678b94', name: '地芍凉血汤加减', expected: 'PRIMARY' },
      { ref: 'F_13aa2938c78a', name: '验方' },
    ],
  },
  5: {
    label: '黄带(脾虚湿热·单产品源)',
    source: 'K_39dc60c4a31c',
    products: [{ ref: 'F_3221b236a490', name: '易黄汤加减', expected: 'PRIMARY' }],
    probe: 'K_39dc60c4a31c 已可见；若仍走寒湿 P2，判断是临床选择问题还是 source-context applicability 问题。',
  },
  6: {
    label: '风寒感冒(跨科·无妇科 gold)',
    source: null,
    products: [],
    note: 'KB disease 字段无"感冒"；记录实际检索与选源路径。若命中 K_43c64eb586e2（产后发热外感，female/产后约束）需注意适用性边界。',
  },
  7: {
    label: '风热感冒(跨科探针·上轮缺陷例)',
    source: 'K_43c64eb586e2',
    products: [
      { ref: 'F_580eaeff1f43', name: '参苏饮' },
      { ref: 'F_de3a7deff6fc', name: '桂枝四物汤' },
      { ref: 'F_57e9057a4f01', name: '银翘散加减', expected: 'PRIMARY' },
    ],
    probe: '上轮缺陷：选中 K_43c64… 但三产品全 UNASSESSED 且外部给出参苏饮。本轮要求：显式 productDecisions（三选一 + fact-backed）、主方必须来自产品清单内（风热应 SELECT 银翘散加减）。',
  },
  8: {
    label: '胃脘胀痛(跨科·无 gold)',
    source: null,
    products: [],
    note: 'KB disease 字段无"胃"；记录实际路径。',
  },
  9: {
    label: '月经先后无定期(脾虚为主·以膏代煎)',
    source: 'K_493b440d15fa',
    products: [{ ref: 'F_531e1cae77cd', name: '参苓白术散加减', expected: 'PRIMARY' }],
    altSource: 'K_bff19fa0bbc0',
    altProducts: [{ ref: 'F_344a28cf9cfa', name: '定经汤加味' }],
    note: '神疲乏力/舌淡胖齿痕偏脾虚（肾虚为备选）；含「以膏代煎」gaofang 意图 — 检查意图保真。',
  },
  10: {
    label: '肺结核咯血(跨科·以膏代煎)',
    source: null,
    products: [],
    note: 'KB disease 字段无"肺"；记录实际路径；含「以膏代煎」gaofang 意图 — 检查意图保真。',
  },
};

/* ---------- HTTP / SSE ---------- */

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginName: ADMIN_LOGIN, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败：${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/pgy_session=([^;]+)/);
  if (!m) throw new Error(`未取到 pgy_session cookie：${setCookie}`);
  return `pgy_session=${m[1]}`;
}

interface SseRunResult {
  session: any | null;
  meta: any | null;
  errorEvent: { message: string; runId?: string } | null;
  aborted: boolean;
  toolCalls: any[];
  lifecycles: string[];
  timeout: boolean;
  durationMs: number;
}

async function runOne(cookie: string, input: string, requestId: string): Promise<SseRunResult> {
  const out: SseRunResult = {
    session: null,
    meta: null,
    errorEvent: null,
    aborted: false,
    toolCalls: [],
    lifecycles: [],
    timeout: false,
    durationMs: 0,
  };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    out.timeout = true;
    controller.abort();
  }, PER_CASE_TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE}/api/run/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ input, requestId }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await res.text()}`);

    const decoder = new TextDecoder();
    let buf = '';
    const handleBlock = (block: string) => {
      const lines = block.split('\n');
      let event = '';
      let data = '';
      for (const ln of lines) {
        if (ln.startsWith('event: ')) event = ln.slice(7).trim();
        else if (ln.startsWith('data: ')) data += ln.slice(6);
      }
      if (!event) return;
      let payload: any = null;
      try {
        payload = data ? JSON.parse(data) : {};
      } catch {
        payload = { _raw: data };
      }
      switch (event) {
        case 'meta': out.meta = payload; break;
        case 'tool': out.toolCalls.push(payload); break;
        case 'lifecycle': out.lifecycles.push(payload?.stage ?? '?'); break;
        case 'result': out.session = payload; break;
        case 'error': out.errorEvent = payload; break;
        case 'aborted': out.aborted = true; break;
        default: break;
      }
    };

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        handleBlock(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    if (buf.trim()) handleBlock(buf);
  } finally {
    clearTimeout(timer);
    out.durationMs = Date.now() - started;
  }
  return out;
}

/* ---------- 分析 ---------- */

function isToolError(out: unknown): boolean {
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (o.ok === false) return true;
    if (o.error !== undefined && o.error !== null) return true;
  }
  return false;
}

function analyze(idx: number, input: string, run: SseRunResult) {
  const gold = GOLD[idx];
  const session = run.session;
  const result = session?.result ?? {};
  const workspace = session?.workspace ?? {};
  const trace = session?.trace ?? {};
  const agentLoop = trace.agentLoop ?? {};
  const fsel = workspace.formulaSelection;
  const toolCalls = run.toolCalls;

  const toolErrors = toolCalls
    .filter((t) => isToolError(t?.output))
    .map((t) => ({
      tool: t.toolName,
      message: typeof t.output?.error === 'string' ? t.output.error : JSON.stringify(t.output).slice(0, 300),
    }));
  const txErrors = toolErrors.filter((e) => /PRODUCT_DECISION|SOURCE_BOUND|CANDIDATE/i.test(e.message));
  const selectCalls = toolCalls.filter((t) => t.toolName === 'formula.select');
  const selectRetries = Math.max(0, selectCalls.length - 1);

  const pd: any[] = Array.isArray(fsel?.productDecisions) ? fsel.productDecisions : [];
  const selectCount = pd.filter((d) => d.disposition === 'SELECT').length;
  const selectedRef = pd.find((d) => d.disposition === 'SELECT')?.formulaRef;
  const primaryRef: string | undefined = fsel?.primaryFormulaRef;
  const implicitPrimary = !!(fsel && (!primaryRef || (pd.length > 0 && (selectCount !== 1 || selectedRef !== primaryRef))));
  const pdFactBacked = pd.filter(
    (d) => (d.supportingFactRefs?.length ?? 0) > 0 || (d.contradictingFactRefs?.length ?? 0) > 0 || (d.missingCriticalEvidence?.length ?? 0) > 0,
  ).length;

  const fset: any[] = result.formula_set ?? [];
  const unassessedCount = fset.filter((f) => f.clinical_qualification === 'UNASSESSED').length;

  const facts: any[] = Array.isArray(workspace.caseFacts) ? workspace.caseFacts : [];
  const factIds = facts.map((f) => f.id).filter(Boolean);

  const deliveries: any[] = result.deliveries ?? [];
  const selectedSourceRef: string | undefined = fsel?.selectedSourceRef
    ?? selectCalls.map((c) => c.output).find((o) => o?.ok === true)?.selectedSourceRef
    ?? trace.commits?.find((c: any) => c.sourceBundle)?.sourceBundle?.sourceId;
  const provenanceLoss: string[] = [];
  for (const d of deliveries) {
    const refs: string[] = d.provenance?.sourceRefs ?? [];
    if (selectedSourceRef && !refs.includes(selectedSourceRef)) {
      provenanceLoss.push(`delivery(${d.outcome}) provenance.sourceRefs=${JSON.stringify(refs)} 未含 selectedSourceRef=${selectedSourceRef}`);
    }
    const sbProducts: any[] = d.source_bundle?.products ?? [];
    if (gold.source && gold.source === selectedSourceRef && sbProducts.length && sbProducts.length < gold.products.length) {
      provenanceLoss.push(`delivery(${d.outcome}) source_bundle.products=${sbProducts.length} < KB 产品数 ${gold.products.length}（source 不能缩水）`);
    }
  }

  const actualPrimaryName = fset.find((f) => f.formula_ref === primaryRef)?.name
    ?? pd.find((d) => d.formulaRef === primaryRef)?.rationale?.slice(0, 40)
    ?? primaryRef;

  const goldSourceHit = gold.source === null && !gold.altSource
    ? null
    : selectedSourceRef === gold.source || (!!gold.altSource && selectedSourceRef === gold.altSource);
  const goldProductRefs = new Set([...gold.products, ...(gold.altProducts ?? [])].map((p) => p.ref));
  const goldProductHit = goldProductRefs.size === 0 ? null : (primaryRef ? goldProductRefs.has(primaryRef) : false);

  const stages = fset.map((f) => ({
    formula: `${f.formula_ref}(${f.name})`,
    sourceScoped: {
      guidance: f.source_stage_guidance ?? [],
      conditional: f.source_conditional_guidance ?? [],
      sequence: f.source_sequence ?? null,
    },
    productScoped: {
      guidance: f.stage_guidance ?? [],
      conditional: f.conditional_guidance ?? [],
      sequence: f.sequence ?? null,
    },
  }));
  const stageVisible = stages.some(
    (s) => (s.sourceScoped.guidance?.length ?? 0) + (s.sourceScoped.conditional?.length ?? 0) > 0
      || s.sourceScoped.sequence
      || (s.productScoped.guidance?.length ?? 0) + (s.productScoped.conditional?.length ?? 0) > 0
      || s.productScoped.sequence,
  );

  const raw = JSON.stringify(session ?? {});
  const gaofangIntent = /以膏代煎|膏方|gaofang/i.test(input);
  const gaofangDelivered = /gaofang|膏方/i.test(raw);

  return {
    idx,
    label: gold.label,
    input,
    run: {
      runId: session?.runId ?? run.errorEvent?.runId ?? null,
      model: run.meta?.model ?? session?.model ?? null,
      mode: run.meta?.mode ?? null,
      status: run.session ? (run.errorEvent ? 'error' : 'done') : run.timeout ? 'timeout' : 'error',
      serverError: run.errorEvent?.message ?? null,
      durationMs: run.durationMs,
      steps: agentLoop.stepCount ?? null,
      termination: agentLoop.terminationReason ?? null,
      proposalSubmitted: agentLoop.proposalSubmitted ?? null,
      forcedFinalization: agentLoop.forcedFinalization ?? null,
      inputTokens: agentLoop.usage?.inputTokens ?? null,
      outputTokens: agentLoop.usage?.outputTokens ?? null,
      toolCallCount: toolCalls.length,
      toolErrorCount: toolErrors.length,
      selectCallCount: selectCalls.length,
      selectRetries,
      lifecycles: run.lifecycles,
    },
    clinical: {
      mode: result.mode ?? null,
      status: result.status ?? null,
      disease: result.disease ?? null,
      syndrome: result.syndrome ?? null,
      treatment: result.treatment ?? null,
      finalFormula: result.formula ?? null,
      formulaSet: fset.map((f) => ({ ref: f.formula_ref, name: f.name, qualification: f.clinical_qualification ?? null, relation: f.relation ?? null })),
      unassessedCount,
      deliveries: deliveries.map((d) => ({
        outcome: d.outcome,
        deliveryStatus: d.delivery_status,
        clearance: d.execution_clearance,
        provenanceKind: d.provenance?.kind ?? null,
        sourceRefs: d.provenance?.sourceRefs ?? [],
        sourceBundleProducts: (d.source_bundle?.products ?? []).map((p: any) => `${p.productId}(${p.name})=${p.clinicalQualification ?? p.qualification ?? '?'}`),
      })),
      missingInformation: result.missing_information ?? [],
      safety: result.safety ?? null,
    },
    selection: {
      selectionUnit: fsel?.selectedCandidateRef ?? null,
      selectedSourceRef: selectedSourceRef ?? null,
      primaryFormulaRef: primaryRef ?? null,
      primaryFormulaName: typeof actualPrimaryName === 'string' ? actualPrimaryName : null,
      rationale: fsel?.rationale ?? null,
      candidateCount: (trace.snapshot?.knowledgeScopes?.length ?? 0) || undefined,
      productDecisions: pd.map((d) => ({
        formulaRef: d.formulaRef,
        disposition: d.disposition,
        supportingFactRefs: d.supportingFactRefs ?? [],
        contradictingFactRefs: d.contradictingFactRefs ?? [],
        missingCriticalEvidence: d.missingCriticalEvidence ?? [],
        rationale: d.rationale ?? null,
      })),
      productDecisionCount: pd.length,
      exactlyOneSelect: pd.length > 0 && selectCount === 1,
      primaryMatchesSelect: pd.length > 0 && selectCount === 1 && selectedRef === primaryRef,
      productDecisionsFactBacked: pd.length > 0 ? `${pdFactBacked}/${pd.length}` : '0/0',
    },
    stages,
    stageVisible,
    patientFacts: { count: facts.length, ids: factIds },
    invariants: {
      txErrors,
      toolErrors,
      implicitPrimary,
      provenanceLoss,
    },
    gold: {
      expectedSource: gold.source,
      expectedProducts: gold.products,
      altSource: gold.altSource ?? null,
      sourceHit: goldSourceHit,
      productHit: goldProductHit,
    },
    probe: gold.probe ?? null,
    note: gold.note ?? null,
    gaofang: { intentInInput: gaofangIntent, delivered: gaofangIntent ? gaofangDelivered : null },
  };
}

/* ---------- 主流程 ---------- */

async function main() {
  if (!existsSync(CASES_FILE)) throw new Error(`找不到病例文件 ${CASES_FILE}`);
  const cases: { idx: number; input: string; run_id: string }[] = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  if (cases.length !== 10) throw new Error(`期望 10 例，实际 ${cases.length}`);

  const health = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, any>;
  const llm = health.llm as Record<string, any> | undefined;
  const knowledge = health.knowledge as Record<string, any> | undefined;
  console.log(`[reg] 服务健康：llm.active=${JSON.stringify(llm?.active ?? llm)}｜knowledge=${knowledge?.version}(${knowledge?.docCount} docs)`);

  const cookie = await login();
  console.log(`[reg] 已登录（${ADMIN_LOGIN}），开始 10 例串行回归…\n`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const results: any[] = [];
  for (const c of cases) {
    console.log(`── 例${c.idx} ${GOLD[c.idx].label}`);
    const run = await runOne(cookie, c.input, `reg-round1-case${c.idx}`);
    const a = analyze(c.idx, c.input, run);
    results.push(a);
    const pdStat = `${a.selection.productDecisionCount} 决策/SELECT×${a.selection.productDecisions.filter((d: any) => d.disposition === 'SELECT').length}/fact-backed ${a.selection.productDecisionsFactBacked}`;
    console.log(
      `   ${a.run.status}｜${Math.round(a.run.durationMs / 1000)}s｜steps=${a.run.steps}｜term=${a.run.termination}\n`
      + `   source=${a.selection.selectedSourceRef ?? '-'}｜primary=${a.selection.primaryFormulaRef ?? '-'}(${a.selection.primaryFormulaName ?? '?'})｜${pdStat}\n`
      + `   goldSource=${a.gold.sourceHit === null ? 'N/A' : a.gold.sourceHit}｜goldProduct=${a.gold.productHit === null ? 'N/A' : a.gold.productHit}｜UNASSESSED=${a.clinical.unassessedCount}｜stageVisible=${a.stageVisible}｜txErr=${a.invariants.txErrors.length}｜implicitPrimary=${a.invariants.implicitPrimary}｜provLoss=${a.invariants.provenanceLoss.length}`,
    );
    if (run.errorEvent) console.log(`   serverError: ${run.errorEvent.message}`);
    if (a.invariants.txErrors.length) console.log(`   txErrors: ${a.invariants.txErrors.map((e: any) => `${e.tool}:${e.message.slice(0, 120)}`).join(' | ')}`);
    if (a.invariants.provenanceLoss.length) console.log(`   provLoss: ${a.invariants.provenanceLoss.join(' | ')}`);
    console.log('');
    await new Promise((r) => setTimeout(r, 2000));
  }

  /* 汇总 */
  const knownGold = results.filter((r) => r.gold.sourceHit !== null);
  const runPass: Record<string, boolean> = {
    noTxErrors: results.every((r) => r.invariants.txErrors.length === 0),
    noImplicitPrimary: results.every((r) => !r.invariants.implicitPrimary),
    noProvenanceLoss: results.every((r) => r.invariants.provenanceLoss.length === 0),
    allDone: results.every((r) => r.run.status === 'done'),
  };
  runPass.overall =
    runPass.allDone && runPass.noTxErrors && runPass.noImplicitPrimary && runPass.noProvenanceLoss;
  const summary = {
    base: BASE,
    model: results[0]?.run.model ?? null,
    startedAt: new Date().toISOString(),
    caseCount: results.length,
    doneCount: results.filter((r) => r.run.status === 'done').length,
    totalDurationMs: results.reduce((s, r) => s + r.run.durationMs, 0),
    totalInputTokens: results.reduce((s, r) => s + (r.run.inputTokens ?? 0), 0),
    totalOutputTokens: results.reduce((s, r) => s + (r.run.outputTokens ?? 0), 0),
    goldSourceHit: `${knownGold.filter((r) => r.gold.sourceHit).length}/${knownGold.length}`,
    goldProductHit: `${knownGold.filter((r) => r.gold.productHit).length}/${knownGold.length}`,
    runPass,
    probeCases: results.filter((r) => r.probe).map((r) => ({ idx: r.idx, label: r.label, probe: r.probe })),
  };

  writeFileSync(OUT_FILE, JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log('================ 汇总 ================');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n[reg] 明细已写入 ${OUT_FILE}`);
  console.log('[reg] 下一步：RUNS_LIMIT=10 RUNS_OUT=... npx tsx scripts/render-runs-md.ts 渲染完整 run trace');
}

main().catch((e) => {
  console.error('[reg] 失败：', e);
  process.exit(1);
});
