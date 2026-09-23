import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionView, TraceView } from '../ui/views.js';

/**
 * 运行记录持久化（SQLite，单文件，随 data 卷保留）。
 *
 * 背景：RunRecord 此前只存在于进程内存（上限 200 条），服务重启 / 容器重建即丢，
 * 实测结果无法事后复查。
 *
 * 边界（刻意保持很窄）：
 * - 只做「落盘 + 按 runId 取回」，不参与 Runtime 装配、不改变 closure / readiness 语义；
 * - 写入内容仍是服务端已产生的可观测状态（result / authority / workspace / trace）原样；
 * - 数据库不可用时**不阻断服务**：降级为内存态并显式告警（见 RunStore.open）。
 */

export interface PersistedRunRecord {
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

/** 列表面：只回元数据，不回大体量 session/trace。 */
export interface RunSummary {
  runId: string;
  input: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'error';
  model: string;
  error?: string;
}

interface RunRow {
  run_id: string;
  input: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  model: string;
  error: string | null;
  session_json: string | null;
  trace_json: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  input        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  model        TEXT NOT NULL,
  error        TEXT,
  session_json TEXT,
  trace_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);
`;

export class RunStore {
  private warned = false;

  private constructor(private readonly db: DatabaseSync, readonly file: string) {}

  /**
   * 打开（必要时创建）运行记录库。
   *
   * `node:sqlite` 在 Node 22 需要 `--experimental-sqlite`（启动脚本与容器 entrypoint 已带该开关）；
   * 在缺少开关或文件不可写的环境下返回 null，调用方退回内存态，服务不因此启动失败。
   */
  static open(file: string): RunStore | null {
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync: SqliteDatabase } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
      mkdirSync(path.dirname(file), { recursive: true });
      const db = new SqliteDatabase(file);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 3000');
      db.exec(SCHEMA);
      return new RunStore(db, file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pgy] 运行记录数据库不可用（${file}）：${message}`);
      console.warn('[pgy] 本次运行记录仅保留在内存，服务继续启动。');
      return null;
    }
  }

  /** 写入 / 覆盖一条运行记录（按 runId 幂等）。失败只告警，不影响已交付的结果。 */
  save(record: PersistedRunRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO runs (run_id, input, started_at, finished_at, status, model, error, session_json, trace_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             finished_at = excluded.finished_at,
             status      = excluded.status,
             error       = excluded.error,
             session_json = excluded.session_json,
             trace_json  = excluded.trace_json`,
        )
        .run(
          record.runId,
          record.input,
          record.startedAt,
          record.finishedAt ?? null,
          record.status,
          record.model,
          record.error ?? null,
          record.session ? JSON.stringify(record.session) : null,
          record.trace ? JSON.stringify(record.trace) : null,
        );
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`[pgy] 运行记录写入失败（后续同类失败不再重复告警）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 按开始时间倒序返回元数据列表。 */
  list(limit = 500): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, input, started_at, finished_at, status, model, error
         FROM runs ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Omit<RunRow, 'session_json' | 'trace_json'>[];
    return rows.map((row) => ({
      runId: row.run_id,
      input: row.input,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      status: row.status as RunSummary['status'],
      model: row.model,
      error: row.error ?? undefined,
    }));
  }

  /** 取回完整记录（含 session / trace）。 */
  get(runId: string): PersistedRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE run_id = ?')
      .get(runId) as unknown as RunRow | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      input: row.input,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      status: row.status as PersistedRunRecord['status'],
      model: row.model,
      error: row.error ?? undefined,
      session: row.session_json ? (JSON.parse(row.session_json) as SessionView) : undefined,
      trace: row.trace_json ? (JSON.parse(row.trace_json) as TraceView) : undefined,
    };
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as unknown as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
