import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skillMd = readFileSync(
  fileURLToPath(new URL('../skills/tcm-clinical-reasoning/SKILL.md', import.meta.url)),
  'utf8',
);
const promptMd = readFileSync(
  fileURLToPath(new URL('../skills/tcm-clinical-reasoning/prompts/prompt.md', import.meta.url)),
  'utf8',
);

test('多个 syndrome candidates 可以保持并比较', () => {
  assert.ok(skillMd.includes('Build hypotheses'), 'skill 应包含多假设构建方法');
  assert.ok(skillMd.includes('supporting evidence'), 'skill 应包含支持证据比较');
  assert.ok(skillMd.includes('contradicting evidence'), 'skill 应包含反对证据比较');
  assert.ok(promptMd.includes('Maintain multiple hypotheses'), 'prompt 应要求保留多个假设');
  assert.ok(promptMd.includes('Compare syndrome candidates'), 'prompt 应要求比较证候候选');
});

test('多个 formula candidates 可以产生 candidate comparison', () => {
  assert.ok(skillMd.includes('Evaluate treatment candidates'), 'skill 应包含候选评价方法');
  assert.ok(skillMd.includes('Are alternatives better?'), 'skill 应要求候选间比较');
  assert.ok(promptMd.includes('Compare formula candidates'), 'prompt 应要求比较方剂候选');
});

test('证据冲突时 Agent 保留 uncertainty', () => {
  assert.ok(skillMd.includes('Maintain uncertainty'), 'skill 应包含不确定性处理');
  assert.ok(promptMd.includes('Preserve uncertainty'), 'prompt 应要求保留不确定性');
  assert.ok(promptMd.includes('Identify contradictions'), 'prompt 应要求识别矛盾证据');
});

test('不能生成 symptom→formula 硬映射', () => {
  assert.ok(skillMd.includes('Forbidden Reasoning'), 'skill 应包含禁止推理段');
  assert.ok(skillMd.includes('symptom X automatically means syndrome Y'), 'skill 应禁止症状→证型硬映射');
  assert.ok(skillMd.includes('syndrome Y automatically requires formula Z'), 'skill 应禁止证型→方剂硬映射');
  assert.ok(promptMd.includes('not to match symptoms to formulas'), 'prompt 应禁止症状→方剂直接匹配');
  assert.ok(promptMd.includes('Never convert one symptom directly into one syndrome or one formula'), 'prompt 应禁止一对一硬映射');
});
