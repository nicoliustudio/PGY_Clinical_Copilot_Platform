import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** prompts/ 目录（位于包根，而非 src 内） */
const promptsRoot = fileURLToPath(new URL('../../prompts/', import.meta.url));

export interface LoadedPrompt {
  id: string;
  version: string;
  instructions: string;
  hash: string;
}

/**
 * 加载外置的版本化 Prompt 资产，并计算内容 hash。
 * Runtime 不硬编码 Prompt 文本；每次 Run 记录 hash，保证可溯源、可复现。
 */
export async function loadPromptProfile(id: string): Promise<LoadedPrompt> {
  const base = join(promptsRoot, id);
  const profile = JSON.parse(
    await readFile(join(base, 'profile.json'), 'utf8'),
  ) as { id: string; version: string };
  const instructions = await readFile(join(base, 'prompt.md'), 'utf8');
  const hash = createHash('sha256').update(instructions).digest('hex');
  return { id: profile.id, version: profile.version, instructions, hash };
}
