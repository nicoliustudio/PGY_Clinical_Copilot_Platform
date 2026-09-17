import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityDescriptor } from '../contracts/capability.js';
import type { SkillDescriptor } from '../contracts/skill.js';
import { loadSkillFromDirectory } from '../platform/skills/load-skill.js';

/** 资产根目录（capabilities/ 与 skills/ 位于包根，而非 src 内） */
export const assetsRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 自动发现 `capabilities/<folder>/capability.json`。
 * Core 不持有任何具体 Capability ID：新增能力 = 新增目录，无需改代码。
 */
export async function discoverCapabilityManifests(
  root: string = assetsRoot,
): Promise<CapabilityDescriptor[]> {
  const dir = join(root, 'capabilities');
  const manifests: CapabilityDescriptor[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'capability.json');
    manifests.push(JSON.parse(await readFile(file, 'utf8')) as CapabilityDescriptor);
  }
  return manifests;
}

/** 按 id 加载 Skill（skill.json + SKILL.md） */
export async function loadSkills(
  ids: string[],
  root: string = assetsRoot,
): Promise<SkillDescriptor[]> {
  const skills: SkillDescriptor[] = [];
  for (const id of new Set(ids)) {
    skills.push(await loadSkillFromDirectory(join(root, 'skills'), id));
  }
  return skills;
}
