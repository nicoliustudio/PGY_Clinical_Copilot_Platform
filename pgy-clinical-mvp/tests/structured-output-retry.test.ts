import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildStructuredRepairPrompt, generateStructuredWithRetry } from '../src/adapters/ai-sdk/model-adapter.js';

test('structured output parse/schema failure 只做一次 format repair', async () => {
  let calls = 0;
  const schema = z.object({ values: z.array(z.string()) });
  const out = await generateStructuredWithRetry(
    { operation: 'unit', system: 's', prompt: 'return json', schema },
    async () => {
      calls += 1;
      return calls === 1 ? '{"values":["a"}' : '{"values":["a"]}';
    },
  );
  assert.deepEqual(out, { values: ['a'] });
  assert.equal(calls, 2);
});

test('structured output 第二次仍失败 → stable infrastructure error，不无限重试', async () => {
  let calls = 0;
  const schema = z.object({ values: z.array(z.string()) });
  await assert.rejects(
    () => generateStructuredWithRetry(
      { operation: 'clinical_planner', prompt: 'return json', schema },
      async () => { calls += 1; return '{broken'; },
    ),
    /STRUCTURED_OUTPUT_FAILED\[clinical_planner\]/,
  );
  assert.equal(calls, 2);
});

test('format repair prompt 明确禁止重做 best-of-N 临床推理', () => {
  const prompt = buildStructuredRepairPrompt('P', '{bad', 'parse failed');
  assert.ok(prompt.includes('Do not change the substantive clinical/planning content'));
  assert.ok(prompt.includes('Return exactly one valid JSON object'));
});
