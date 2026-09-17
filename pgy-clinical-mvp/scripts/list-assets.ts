import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 列出已注册的 Capability / Skill 资产（新增能力后可用它确认已被发现） */
const sources = [
  { title: 'Capabilities', root: 'capabilities', file: 'capability.json' },
  { title: 'Skills', root: 'skills', file: 'skill.json' },
] as const;

for (const { title, root, file } of sources) {
  console.log(`\n${title}:`);
  for (const dir of await readdir(join(process.cwd(), root), {
    withFileTypes: true,
  })) {
    if (!dir.isDirectory()) continue;
    const data = JSON.parse(
      await readFile(join(process.cwd(), root, dir.name, file), 'utf8'),
    ) as { id: string; version: string; description: string };
    console.log(`- ${data.id}@${data.version}: ${data.description}`);
  }
}
