import test from 'node:test';
import assert from 'node:assert/strict';
import { addToolCall, finishTrace, getTrace, newTrace } from '../src/trace.js';

test('并发 run trace 按 runId 隔离', () => {
  const a = newTrace('a');
  const b = newTrace('b');
  addToolCall(a.runId, { toolName: 'a.tool', input: 1, output: 1, ms: 1 });
  addToolCall(b.runId, { toolName: 'b.tool', input: 2, output: 2, ms: 1 });
  finishTrace(a.runId, {});
  finishTrace(b.runId, {});
  assert.deepEqual(getTrace(a.runId)?.toolCalls.map((x) => x.toolName), ['a.tool']);
  assert.deepEqual(getTrace(b.runId)?.toolCalls.map((x) => x.toolName), ['b.tool']);
});
