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

// 外部参考包边界：production source 绝不能 import 外部专家参考包 / 历史交付解压目录。
// 参考包只用于人工 diff 对照（见仓库根 _reference/README.md），不参与构建；
// 这条守卫把「不要 import 参考包」从文字约定变成可执行测试（历史上曾因 reference-implementation/src
// 与主 src 并存而形成"第二真源"）。
const forbiddenReferenceImports = ['_reference/', 'reference-implementation/', '_extracted/'];
for (const file of await walk(join(root, 'src'))) {
  if (!['.ts', '.tsx', '.js', '.mjs'].includes(extname(file))) continue;
  const text = await readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import') && !trimmed.startsWith('export')) continue;
    for (const marker of forbiddenReferenceImports) {
      if (trimmed.includes(marker)) {
        violations.push(`${relative(root, file)}: source imports external reference package "${marker}"`);
      }
    }
  }
}


// H1 Harness invariants: the production Runtime must not regress to exact-key pre-routing.
const preparerPath = join(root, 'src/platform/runtime/runtime-preparer.ts');
const preparerText = await readFile(preparerPath, 'utf8');
for (const marker of ['capabilityResolver', 'capabilityNeeds.map', '.provides.filter']) {
  if (preparerText.includes(marker)) {
    violations.push(`src/platform/runtime/runtime-preparer.ts: H1 bootstrap regressed to pre-routing marker "${marker}"`);
  }
}
const harnessAgentPath = join(root, 'src/adapters/ai-sdk/agent-runtime.ts');
const harnessAgentText = await readFile(harnessAgentPath, 'utf8');
for (const marker of ['prepareStep', 'capability.discover', 'capability.activate', 'proposal.submit']) {
  if (!harnessAgentText.includes(marker)) {
    violations.push(`src/adapters/ai-sdk/agent-runtime.ts: missing H1 harness primitive "${marker}"`);
  }
}

// H12 invariant: retrieval must not directly materialize patient hypotheses.
// provenance.syndrome 是 SOURCE_SYNDROME_LABEL，不得自动升级为 hypothesis.presented。
const workspaceEventsPath = join(root, 'src/adapters/ai-sdk/workspace-events.ts');
const workspaceEventsText = await readFile(workspaceEventsPath, 'utf8');
for (const branch of ["toolName === 'knowledge.search'", "toolName === 'formula.search_normative'"]) {
  const body = branchBody(workspaceEventsText, branch);
  if (body.includes('hypothesis.presented')) {
    violations.push(`src/adapters/ai-sdk/workspace-events.ts: ${branch} directly materializes patient hypothesis (H12 regression)`);
  }
}

// Diagnostic Pattern Set + Disease Crosswalk Spike invariant：诊断模式查询/病名解析必须只读知识，不得读取 gold/eval。
for (const rel of ['src/knowledge/diagnostic-patterns.ts', 'src/knowledge/disease-concepts.ts', 'src/knowledge/standard-runtime.ts', 'src/knowledge/diagnostic-release.ts']) {
  const path = join(root, rel);
  const text = await readFile(path, 'utf8');
  for (const line of text.split('\n').filter((l) => l.trim().startsWith('import'))) {
    if (/(gold|eval)/i.test(line)) {
      violations.push(`${rel}: imports evaluation data "${line.trim()}"`);
    }
  }
}

// Diagnostic Knowledge Schema invariant：Open World 中医语义（证型/病机/病位/病性/治法）不得被枚举。
const diagnosticSchemaPath = join(root, 'src/knowledge/diagnostic-schema.ts');
const diagnosticSchemaText = await readFile(diagnosticSchemaPath, 'utf8');
if (/enum\s+(Syndrome|Mechanism|Organ|Pattern|TreatmentPrinciple|Disease|RootBranch)\s*\{/.test(diagnosticSchemaText)) {
  violations.push('src/knowledge/diagnostic-schema.ts: Open World semantics enumerated (enum Syndrome/Mechanism/Organ/Pattern/TreatmentPrinciple/Disease)');
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

/** 提取 workspaceEventsForTool 中某个 `if (toolName === '…')` 分支的函数体，用于分支级架构检查。 */
function branchBody(source: string, branch: string): string {
  const startIdx = source.indexOf(branch);
  if (startIdx === -1) return '';
  const rest = source.slice(startIdx + branch.length);
  const nextBranchIdx = rest.search(/if \(toolName === '/);
  return nextBranchIdx === -1 ? rest : rest.slice(0, nextBranchIdx);
}
