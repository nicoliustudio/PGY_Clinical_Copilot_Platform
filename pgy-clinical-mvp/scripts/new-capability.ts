import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const id = process.argv[2];
if (!id) {
  console.error('Usage: npm run capability:new -- <capability.id>');
  process.exit(1);
}

const folder = id.replace(/[^a-zA-Z0-9._-]/g, '-').replaceAll('.', '-');
const base = join(process.cwd(), 'capabilities', folder);
await mkdir(base, { recursive: true });

const manifest = {
  id,
  version: '0.1.0',
  enabled: false,
  description: 'TODO',
  semanticDescription:
    'TODO: 描述该能力在什么语义语境下适用（供语义解析使用，不是规则条件树）。',
  provides: ['TODO.semantic_need'],
  positiveExamples: ['TODO: 一条真实语料正例'],
  negativeExamples: ['TODO: 一条易混淆反例'],
  knowledgeScopes: [],
  skillIds: [],
  toolIds: [],
};
await writeFile(join(base, 'capability.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`Created ${join('capabilities', folder, 'capability.json')}`);
console.log('Core runtime files were not modified.');
