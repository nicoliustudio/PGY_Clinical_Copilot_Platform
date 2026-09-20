import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import type { SkillDescriptor } from '../../contracts/skill.js';

/** H14：关闭时从 SKILL.md 中移除 Treatment Decision Causality 章节（A/B 行为差异只在此处）。 */
function gateH14Section(instruction: string): string {
  if (config.experiment.h14) return instruction;
  return instruction.replace(/<!-- H14:START -->[\s\S]*?<!-- H14:END -->\s*/g, '');
}

async function loadPromptSections(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    const mdFiles = entries.filter((name) => name.endsWith('.md')).sort();
    return await Promise.all(mdFiles.map((name) => readFile(join(dir, name), 'utf8')));
  } catch {
    return [];
  }
}

/** 从 `skills/<id>/skill.json + SKILL.md + prompts/*.md` 加载 Skill（JIT）。 */
export async function loadSkillFromDirectory(
  root: string,
  id: string,
): Promise<SkillDescriptor> {
  const base = join(root, id);
  const meta = JSON.parse(
    await readFile(join(base, 'skill.json'), 'utf8'),
  ) as {
    id: string;
    version: string;
    description: string;
  };
  const instruction = gateH14Section(await readFile(join(base, 'SKILL.md'), 'utf8'));
  const promptSections = await loadPromptSections(join(base, 'prompts'));
  return { ...meta, instruction, promptSections };
}
