import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunStore, type PersistedRunRecord } from '../src/server/run-store.js';

/**
 * 运行记录持久化（SQLite）不变量。
 *
 * 目标只有一个：服务重启（乃至容器重建）后，实测的输入 / 结果 / 全链路 trace 仍可取回。
 * 因此这里断言的是「关闭再打开仍与原记录同构」，而不是任何 Runtime 语义。
 */

function tmpFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pgy-run-store-'));
  return { dir, file: path.join(dir, 'nested', 'runs.sqlite3') };
}

function record(runId: string, startedAt: string, extra: Partial<PersistedRunRecord> = {}): PersistedRunRecord {
  return {
    runId,
    input: `输入 ${runId}`,
    startedAt,
    finishedAt: startedAt,
    status: 'done',
    model: 'test:run-store',
    session: {
      runId,
      model: 'test:run-store',
      result: { mode: 'clinical', disease: { name: '病名A' } },
      authority: { status: 'ALLOWED' },
      workspace: { facts: [] },
      trace: { runId, totalMs: 1234, toolCalls: [{ toolName: 'knowledge.search', input: { query: 'q' } }] },
      strategy: { goal: 'clinical-assessment' },
    } as unknown as PersistedRunRecord['session'],
    trace: { runId, totalMs: 1234 } as unknown as PersistedRunRecord['trace'],
    ...extra,
  };
}

test('RunStore：落盘后重新打开仍能取回完整记录（重启不丢）', () => {
  const { dir, file } = tmpFile();
  try {
    const store = RunStore.open(file);
    assert.ok(store, 'RunStore 应可用：测试脚本需带 --experimental-sqlite（Node 22）或 Node 24+');
    store.save(record('run_a', '2026-09-23T01:00:00.000Z'));
    store.save(record('run_b', '2026-09-23T02:00:00.000Z'));
    assert.equal(store.count(), 2);
    store.close();

    // 模拟服务重启：新进程 / 新实例重新打开同一文件
    const reopened = RunStore.open(file);
    assert.ok(reopened);
    assert.equal(reopened.count(), 2, '重启后记录数不变');

    const restored = reopened.get('run_a');
    assert.ok(restored, '重启后仍能按 runId 取回');
    assert.equal(restored.input, '输入 run_a');
    assert.equal(restored.session?.result?.disease?.name, '病名A');
    assert.equal(restored.trace?.totalMs, 1234);

    // 列表按开始时间倒序（最新的在最前）
    assert.deepEqual(reopened.list().map((r) => r.runId), ['run_b', 'run_a']);
    // 列表不回大体量字段
    assert.equal('session' in (reopened.list()[0] as object), false);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RunStore：同 runId 覆盖写入幂等，失败记录（无 session）可落盘', () => {
  const { dir, file } = tmpFile();
  try {
    const store = RunStore.open(file);
    assert.ok(store);
    store.save(record('run_x', '2026-09-23T03:00:00.000Z', { status: 'running', finishedAt: undefined }));
    store.save(record('run_x', '2026-09-23T03:00:00.000Z'));
    assert.equal(store.count(), 1, '同 runId 不得产生重复行');

    store.save({
      runId: 'run_err',
      input: '输入 run_err',
      startedAt: '2026-09-23T04:00:00.000Z',
      status: 'error',
      model: 'test:run-store',
      error: '缺少必需信息',
    });
    const failed = store.get('run_err');
    assert.equal(failed?.status, 'error');
    assert.equal(failed?.error, '缺少必需信息');
    assert.equal(failed?.session, undefined);
    assert.equal(store.get('不存在'), null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
