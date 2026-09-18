import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { compactAgentMessages } from '../src/adapters/ai-sdk/agent-runtime.js';

const user: ModelMessage = { role: 'user', content: '病例' };
const assistant = (content: string): ModelMessage => ({ role: 'assistant', content });
const tool: ModelMessage = { role: 'tool', content: [] };

test('empty steps 时保留 initialMessages', () => {
  assert.deepEqual(compactAgentMessages([user], []), [user]);
});

test('多轮后只保留 initial + 最近一步的 tool call/result，丢弃历史 raw result', () => {
  const steps = [
    { response: { messages: [assistant('c0'), tool] } },
    { response: { messages: [assistant('c1'), tool] } },
    { response: { messages: [assistant('c2'), tool] } },
  ];

  const compacted = compactAgentMessages([user], steps);
  assert.equal(compacted.length, 3);
  assert.deepEqual(compacted[0], user);
  assert.deepEqual(compacted[1], { role: 'assistant', content: 'c2' });
  assert.deepEqual(compacted[2], tool);

  const contents = compacted.map((m) => (m as { content?: unknown }).content);
  assert.ok(!contents.includes('c0'));
  assert.ok(!contents.includes('c1'));
});

test('single step 时只保留 initial + 该步结果', () => {
  const steps = [{ response: { messages: [assistant('c0'), tool] } }];
  const compacted = compactAgentMessages([user], steps);
  assert.equal(compacted.length, 3);
  assert.deepEqual(compacted[1], { role: 'assistant', content: 'c0' });
});
