import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { runCase } from '../composition/runtime.js';
import { discoverCapabilityManifests, loadSkills } from '../composition/load-assets.js';
import { loadIndex } from '../knowledge/build.js';
import { buildKnowledgeSourceView, buildSessionView, buildTraceView, type SessionView, type TraceView } from '../ui/views.js';
import { classifyAudit, type ClinicalAudit } from '../ui/audit.js';
import { getGold } from '../eval/metrics.js';
import { isAsrEnabled, relayAsr } from './asr.js';
import { getTrace } from '../trace.js';

const UI_ROOT = fileURLToPath(new URL('../../ui/', import.meta.url));

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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
    llm: { fast: config.llm.fastModel, deep: config.llm.deepModel },
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
  if (!input.trim()) {
    json(res, 400, { detail: '请输入病例内容' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sse(res, 'meta', { requestId, mode, model: config.llm.deepModel, asrEnabled: isAsrEnabled() });

  const startedAt = new Date().toISOString();
  let rec: RunRecord | undefined;

  try {
    const result = await runCase(input, {
      mode,
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
      model: config.llm.deepModel,
      error: message,
      trace: trace ? buildTraceView(trace) : undefined,
    };
    runs.set(runId, rec);
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
    const rec = runs.get(decodeURIComponent(match[1]));
    if (!rec) return json(res, 404, { detail: '未找到该运行记录' });
    return json(res, 200, rec);
  }
  json(res, 200, { total: runs.size, items: listRuns().map((r) => ({ runId: r.runId, input: r.input, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status, model: r.model, error: r.error })) });
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
  if (!input.trim()) return json(res, 400, { detail: '请输入病例内容' });

  try {
    const result = await runCase(input);
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
  // 从最近的运行记录中按 sourceId 还原 provenance
  for (const rec of listRuns()) {
    if (!rec.session) continue;
    const view = buildKnowledgeSourceView(sourceId, rec.session.trace);
    if (view) return json(res, 200, view);
  }
  json(res, 404, { detail: '未找到该知识来源' });
}

export async function startServer(port = Number(process.env.APP_PORT ?? 8787)): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    try {
      if (pathname === '/api/health' && req.method === 'GET') return await handleHealth(res);
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

  const wss = new WebSocketServer({ server, path: '/ws/asr' });
  wss.on('connection', (ws) => relayAsr(ws));

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}
