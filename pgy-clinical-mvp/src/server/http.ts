import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { resetClinicalRuntimeCache, runCase } from '../composition/runtime.js';
import { describeActiveModel, applyModelSelection, getModelCatalog, snapshotModelExecution, BUDGET_LEVELS, type ThinkingBudgetLevel, type RunModelRequest } from '../model/model-registry.js';
import { discoverCapabilityManifests, loadSkills } from '../composition/load-assets.js';
import { loadIndex } from '../knowledge/build.js';
import { buildKnowledgeSourceView, buildSessionView, buildTraceView, type SessionView, type TraceView } from '../ui/views.js';
import { classifyAudit, type ClinicalAudit } from '../ui/audit.js';
import { getGold } from '../eval/metrics.js';
import { isAsrEnabled, relayAsr } from './asr.js';
import { getTrace } from '../trace.js';
import { json, readBody } from './http-utils.js';
import { RunStore } from './run-store.js';
import {
  clearedCookieValue,
  ensureBootstrapUsers,
  revokeSession,
  sessionCookieValue,
  sessionFromRequest,
  sessionTokenFromRequest,
  toSessionUser,
  verifyCredentials,
  type SessionUser,
} from './auth.js';

const UI_ROOT = fileURLToPath(new URL('../../ui/', import.meta.url));

/** 无需登录即可访问：健康探针、登录页及其静态资源、登录接口本身。 */
const PUBLIC_PATHS = new Set(['/login', '/login.js', '/styles.css', '/logo.png', '/favicon.ico', '/api/health', '/api/auth/login']);

/** 仅管理员可用：开发者/评测面（医生端视图不暴露）。 */
const ADMIN_ONLY_PREFIXES = ['/api/eval/'];

interface RunRecord {
  runId: string;
  input: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'error';
  model: string;
  session?: SessionView;
  error?: string;
  trace?: TraceView;
}

const runs = new Map<string, RunRecord>();

/**
 * 运行记录落盘（SQLite，随 data 卷保留）。null = 数据库不可用，退回纯内存态。
 * 内存 Map 仍是热路径（在跑 / 最近完成），落盘是「重启与容器重建后仍可取回」的真源。
 */
let runStore: RunStore | null = null;

/** 元数据列表项（与 RunRecord 同构，但不含 session/trace 大字段）。 */
function runSummaryOf(record: RunRecord): Omit<RunRecord, 'session' | 'trace'> {
  const { session: _session, trace: _trace, ...rest } = record;
  return rest;
}

function runModelRequestFromBody(body: Record<string, unknown>): RunModelRequest | undefined {
  if (typeof body.modelOptionId !== 'string') return undefined;
  return {
    optionId: body.modelOptionId,
    ...(typeof body.thinking === 'boolean' ? { thinking: body.thinking } : {}),
    ...(typeof body.budget === 'string' ? { budget: body.budget as ThinkingBudgetLevel } : {}),
  };
}

/** 内存热态 + 落盘历史合并（按 runId 去重，内存优先，按开始时间倒序）。 */
function mergedRunSummaries(limit = 500): Omit<RunRecord, 'session' | 'trace'>[] {
  const byId = new Map<string, Omit<RunRecord, 'session' | 'trace'>>();
  for (const item of runStore?.list(limit) ?? []) byId.set(item.runId, item);
  for (const record of runs.values()) byId.set(record.runId, runSummaryOf(record));
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/* ---------- 认证：登录 / 登出 / 当前会话 ---------- */

/** 已登录用户专用响应头，避免中间层缓存到他人会话。 */
function noStore(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
}

async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { detail: '请求体不是合法 JSON' });
  }
  const loginName = typeof body.loginName === 'string' ? body.loginName.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!loginName || !password) return json(res, 400, { detail: '请输入账号与密码' });

  const user = verifyCredentials(loginName, password);
  if (!user) return json(res, 401, { detail: '账号或密码不正确' });

  noStore(res);
  res.setHeader('Set-Cookie', sessionCookieValue(user));
  json(res, 200, { user: toSessionUser(user) });
  console.log(`[pgy] 登录成功：${user.loginName}（${user.role}）`);
}

function handleAuthLogout(req: IncomingMessage, res: ServerResponse): void {
  revokeSession(sessionTokenFromRequest(req));
  noStore(res);
  res.setHeader('Set-Cookie', clearedCookieValue());
  json(res, 200, { ok: true });
}

function handleAuthMe(res: ServerResponse, session: SessionUser | null): void {
  noStore(res);
  if (!session) return json(res, 401, { detail: '未登录' });
  json(res, 200, { user: session });
}

/** 未登录时：页面跳登录页，接口返回 401（前端据此跳转）。 */
function rejectUnauthenticated(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (pathname.startsWith('/api/') || pathname.startsWith('/ws/')) {
    return json(res, 401, { detail: '未登录' });
  }
  res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
  res.end();
}

async function serveLoginPage(res: ServerResponse): Promise<void> {
  const content = await readFile(path.join(UI_ROOT, 'login.html'));
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  res.end(content);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) {
    json(res, 403, { detail: '非法路径' });
    return;
  }
  if (!path.extname(rel)) rel = 'index.html';
  const file = path.join(UI_ROOT, rel);
  if (!existsSync(file)) {
    // SPA 回落
    const index = path.join(UI_ROOT, 'index.html');
    if (existsSync(index)) {
      const content = await readFile(index);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(content);
      return;
    }
    json(res, 404, { detail: 'Not found' });
    return;
  }
  const content = await readFile(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  res.end(content);
}

/** 模型目录 + 活动选择（前端右上角切换用）。 */
function handleModels(res: ServerResponse): void {
  noStore(res);
  json(res, 200, getModelCatalog());
}

/**
 * 应用模型 / 推理开关选择。
 * 返回服务端**确认后**的完整目录快照，前端据此渲染，因此不存在「本地改了、服务端没变」的假切换。
 */
async function handleModelSelect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { detail: '请求体不是合法 JSON' });
  }
  const optionId = typeof body.optionId === 'string' ? body.optionId.trim() : '';
  if (!optionId) return json(res, 400, { detail: '缺少 optionId' });
  const thinking = typeof body.thinking === 'boolean' ? body.thinking : undefined;
  const budgetRaw = typeof body.budget === 'string' ? body.budget.trim() : '';
  if (budgetRaw && !BUDGET_LEVELS.some((level) => level.value === budgetRaw)) {
    return json(res, 400, { detail: `未知思考预算档位：${budgetRaw}` });
  }
  const budget = budgetRaw ? (budgetRaw as ThinkingBudgetLevel) : undefined;

  const applied = applyModelSelection(optionId, thinking, budget);
  if (!applied.ok) return json(res, 400, { code: applied.code, detail: applied.message });

  // 模型身份变化后重建 Runtime 装配，保证 trace 快照记录的模型与实际调用一致。
  resetClinicalRuntimeCache();
  noStore(res);
  console.log(`[pgy] 模型切换：${describeActiveModel()}`);
  json(res, 200, getModelCatalog());
}

async function handleHealth(res: ServerResponse): Promise<void> {
  let knowledge: { ok: boolean; version?: string; docCount?: number; error?: string };
  try {
    const idx = await loadIndex();
    knowledge = { ok: true, version: idx.version, docCount: idx.docCount };
  } catch (e) {
    knowledge = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const manifests = await discoverCapabilityManifests();
  const skills = await loadSkills(manifests.flatMap((m) => m.skillIds));

  json(res, 200, {
    ok: true,
    service: 'pgy-clinical-copilot',
    runtimeMode: config.runtime.mode,
    llm: getModelCatalog().active,
    knowledge,
    capabilities: manifests.map((m) => ({ id: m.id, version: m.version, displayName: m.displayName, enabled: m.enabled !== false })),
    skills: skills.map((s) => ({ id: s.id, version: s.version })),
    asr: { enabled: isAsrEnabled() },
  });
}

async function handleRunStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { detail: '请求体不是合法 JSON' });
    return;
  }
  const input = typeof body.input === 'string' ? body.input : '';
  const mode = body.mode === 'classic' ? 'classic' : 'harness';
  const modelRequest = runModelRequestFromBody(body);
  if (!input.trim()) {
    json(res, 400, { detail: '请输入病例内容' });
    return;
  }

  let modelExecution;
  try {
    modelExecution = snapshotModelExecution(modelRequest);
  } catch (error) {
    json(res, 400, { detail: error instanceof Error ? error.message : String(error) });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sse(res, 'meta', {
    requestId,
    mode,
    model: modelExecution.clinicalProfile.id,
    modelOptionId: modelExecution.clinical.optionId,
    controlModelOptionId: modelExecution.control.optionId,
    controlFallbackReason: modelExecution.controlFallbackReason,
    asrEnabled: isAsrEnabled(),
  });

  const startedAt = new Date().toISOString();
  let rec: RunRecord | undefined;

  try {
    const result = await runCase(input, {
      mode,
      modelExecution,
      onEvent: (event) => {
        if (event.type === 'tool-call') sse(res, 'tool', event.toolCall);
        else if (event.type === 'workspace') sse(res, 'workspace', { events: event.events });
        else if (event.type === 'lifecycle') sse(res, 'lifecycle', { stage: event.stage });
      },
    });

    const session = buildSessionView(result);
    rec = {
      runId: session.runId,
      input,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'done',
      model: session.model,
      session,
    };
    runs.set(session.runId, rec);
    runStore?.save(rec);
    sse(res, 'result', session);
    sse(res, 'done', {});
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const runId = (e as { runId?: string }).runId ?? `run_err_${Date.now()}`;
    const trace = getTrace(runId);
    rec = {
      runId,
      input,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'error',
      model: trace?.modelRoles?.clinical.id ?? trace?.modelProfileId ?? describeActiveModel(),
      error: message,
      trace: trace ? buildTraceView(trace) : undefined,
    };
    runs.set(runId, rec);
    runStore?.save(rec);
    sse(res, 'error', { message, runId });
    sse(res, 'lifecycle', { stage: 'no-commit' });
    sse(res, 'done', {});
  } finally {
    res.end();
    // 收紧运行记录上限，避免内存无界增长
    while (runs.size > 200) {
      const oldest = runs.keys().next().value as string | undefined;
      if (oldest) runs.delete(oldest);
      else break;
    }
  }
}

function listRuns(): RunRecord[] {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function handleTraces(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const match = pathname.match(/^\/api\/traces\/([^/]+)$/);
  if (match) {
    const runId = decodeURIComponent(match[1]);
    const rec = runs.get(runId) ?? runStore?.get(runId) ?? null;
    if (!rec) return json(res, 404, { detail: '未找到该运行记录' });
    return json(res, 200, rec);
  }
  const items = mergedRunSummaries();
  json(res, 200, { total: items.length, items });
}

async function handleEvalCases(res: ServerResponse): Promise<void> {
  // 数据集资产可能在仓库外（assets/），缺失时不阻塞 UI，返回空列表。
  json(res, 200, { cases: [], available: false, goldAvailable: false, note: '回归数据集与 gold 文件不在当前工作区，可粘贴自定义病例并通过 goldKey 对比。' });
}

async function handleEvalRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { detail: '请求体不是合法 JSON' });
  }
  const input = typeof body.input === 'string' ? body.input : '';
  const caseKey = typeof body.caseKey === 'string' ? body.caseKey : '';
  const modelRequest = runModelRequestFromBody(body);
  if (!input.trim()) return json(res, 400, { detail: '请输入病例内容' });

  try {
    const modelExecution = snapshotModelExecution(modelRequest);
    const result = await runCase(input, { modelExecution });
    const session = buildSessionView(result);

    let gold: ReturnType<typeof getGold> | undefined;
    let audit: ClinicalAudit | undefined;
    if (caseKey) {
      try {
        gold = getGold(caseKey);
      } catch {
        gold = undefined;
      }
      if (gold) audit = classifyAudit(result.result, gold);
    }

    json(res, 200, { session, gold: gold ?? null, audit: audit ?? null });
  } catch (e) {
    json(res, 500, { detail: e instanceof Error ? e.message : String(e) });
  }
}

async function handleKnowledgeSource(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const match = pathname.match(/^\/api\/knowledge\/source\/([^/]+)$/);
  if (!match) return json(res, 404, { detail: 'Not found' });
  const sourceId = decodeURIComponent(match[1]);
  // 从最近的运行记录中按 sourceId 还原 provenance：
  // 先内存热态；未命中再回落到落盘记录（有上限，避免反序列化全部历史），重启后溯源页仍可用。
  const visited = new Set<string>();
  const candidates: RunRecord[] = [];
  for (const rec of listRuns()) {
    visited.add(rec.runId);
    candidates.push(rec);
  }
  for (const summary of runStore?.list(20) ?? []) {
    if (visited.has(summary.runId)) continue;
    const rec = runStore?.get(summary.runId);
    if (rec) candidates.push(rec);
  }
  for (const rec of candidates) {
    if (!rec.session) continue;
    const view = buildKnowledgeSourceView(sourceId, rec.session.trace);
    if (view) return json(res, 200, view);
  }
  json(res, 404, { detail: '未找到该知识来源' });
}

export async function startServer(port = Number(process.env.APP_PORT ?? 8787)): Promise<ReturnType<typeof createServer>> {
  const bootstrapped = ensureBootstrapUsers();
  if (bootstrapped.created.length) {
    console.log(`[pgy] 已建立账号：${bootstrapped.created.join('、')}`);
  }

  runStore = RunStore.open(path.resolve(process.env.RUN_DB_FILE ?? 'data/runs.sqlite3'));
  if (runStore) console.log(`[pgy] 运行记录库：${runStore.file}（已有 ${runStore.count()} 条，重启/容器重建后仍可取回）`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      // 1) 无需登录的入口
      if (pathname === '/api/health' && req.method === 'GET') return await handleHealth(res);
      if (pathname === '/api/auth/login' && req.method === 'POST') return await handleAuthLogin(req, res);
      if (pathname === '/login' && req.method === 'GET') return await serveLoginPage(res);

      // 2) 会话判定：除白名单外一律要求登录
      const session = sessionFromRequest(req);
      if (pathname === '/api/auth/me' && req.method === 'GET') return handleAuthMe(res, session);
      if (pathname === '/api/auth/logout' && req.method === 'POST') return handleAuthLogout(req, res);
      if (!session && !PUBLIC_PATHS.has(pathname)) return rejectUnauthenticated(req, res, pathname);

      // 3) 角色判定：评测/开发者面仅管理员可用
      if (session && ADMIN_ONLY_PREFIXES.some((p) => pathname.startsWith(p)) && session.role !== 'admin') {
        return json(res, 403, { detail: '仅管理员可访问该功能' });
      }

      if (pathname === '/api/models' && req.method === 'GET') return handleModels(res);
      if (pathname === '/api/models/select' && req.method === 'POST') return await handleModelSelect(req, res);
      if (pathname === '/api/run/stream' && req.method === 'POST') return await handleRunStream(req, res);
      if (pathname === '/api/traces' || pathname.startsWith('/api/traces/')) return await handleTraces(req, res, pathname);
      if (pathname === '/api/eval/cases' && req.method === 'GET') return await handleEvalCases(res);
      if (pathname === '/api/eval/run' && req.method === 'POST') return await handleEvalRun(req, res);
      if (pathname.startsWith('/api/knowledge/source/') && req.method === 'GET') return await handleKnowledgeSource(req, res, pathname);

      if (pathname.startsWith('/api/') || pathname.startsWith('/ws/')) {
        return json(res, 404, { detail: 'Not found' });
      }
      return await serveStatic(req, res, pathname);
    } catch (e) {
      json(res, 500, { detail: e instanceof Error ? e.message : String(e) });
    }
  });

  // 语音 WebSocket 与 HTTP 共用同一会话：升级握手时校验签名 Cookie。
  const wss = new WebSocketServer({
    server,
    path: '/ws/asr',
    verifyClient: (info: { req: IncomingMessage }) => sessionFromRequest(info.req) !== null,
  });
  wss.on('connection', (ws) => relayAsr(ws));

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
