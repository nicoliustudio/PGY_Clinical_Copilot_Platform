import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Architecture Guard —— 让 `pgy_code_rules.md` 从文字提醒变成可执行的测试。
 *
 * 它动态读取 `capabilities/<pack>/capability.json`，把已注册的具体业务 ID / 目录名 /
 * displayName 作为 Core 禁入标记。因此新增儿科、男科、肿瘤等能力后，
 * 守卫会自动跟着扩展，不需要手工追加字符串规则。
 */

const root = fileURLToPath(new URL('../', import.meta.url));

/** 受保护的核心层：这些目录不允许认识具体业务 */
const guarded = [
  'src/contracts',
  'src/platform/runtime',
  'src/platform/authority',
  'src/platform/agent',
  'src/platform/registry',
  'src/platform/skills',
];

const capabilityMarkers = await discoverCapabilityMarkers(join(root, 'capabilities'));
const forbiddenSdkImports = ["from 'ai'", 'from "ai"', '@ai-sdk/'];
const forbiddenEvalImports = ['calibration_40', 'holdout_113', 'gold_variant_map'];
const forbiddenCapabilityImports = [
  '/capabilities/',
  "from '../../capabilities",
  "from '../capabilities",
];

const violations: string[] = [];
for (const dir of guarded) {
  for (const file of await walk(join(root, dir))) {
    if (!['.ts', '.tsx', '.js', '.mjs'].includes(extname(file))) continue;
    const text = await readFile(file, 'utf8');
    const lower = text.toLowerCase();
    const rel = relative(root, file);

    for (const marker of capabilityMarkers) {
      if (lower.includes(marker.toLowerCase())) {
        violations.push(`${rel}: core contains concrete capability marker "${marker}"`);
      }
    }
    for (const marker of forbiddenSdkImports) {
      if (text.includes(marker)) {
        violations.push(`${rel}: core directly imports AI SDK marker "${marker}"`);
      }
    }
    for (const marker of forbiddenEvalImports) {
      if (text.includes(marker)) {
        violations.push(`${rel}: runtime references evaluation data "${marker}"`);
      }
    }
    for (const marker of forbiddenCapabilityImports) {
      if (text.includes(marker)) {
        violations.push(`${rel}: core directly imports capability package data`);
      }
    }
  }
}

if (violations.length) {
  console.error(
    'Architecture guard FAILED:\n' + violations.map((x) => `- ${x}`).join('\n'),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Architecture guard PASSED (${capabilityMarkers.length} capability markers protected).`,
  );
}

async function discoverCapabilityMarkers(dir: string): Promise<string[]> {
  const markers = new Set<string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    markers.add(entry.name);
    const manifestPath = join(dir, entry.name, 'capability.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        id?: string;
        displayName?: string;
      };
      if (manifest.id) markers.add(manifest.id);
      if (manifest.displayName) markers.add(manifest.displayName);
    } catch {
      // Manifest 校验属于发布流程；守卫只关心架构边界。
    }
  }
  return [...markers].filter((x) => x.length >= 4);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
