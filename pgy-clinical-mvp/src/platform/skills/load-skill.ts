import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillDescriptor } from '../../contracts/skill.js';

/** 从 `skills/<id>/skill.json + SKILL.md` 加载 Skill（JIT）。 */
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
  const instruction = await readFile(join(base, 'SKILL.md'), 'utf8');
  return { ...meta, instruction };
}
