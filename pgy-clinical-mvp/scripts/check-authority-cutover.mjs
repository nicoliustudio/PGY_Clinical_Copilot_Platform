import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

const platform = read('src/composition/platform-assets.ts');
check('delivery.commit is registered', platform.includes("id: 'delivery.commit'"));
check('Workspace cannot claim terminal treatment-delivery effect', !/workspace\.record_deliberation[\s\S]{0,900}target: \{ type: 'artifact:treatment-delivery'/.test(platform));
check('Workspace writes prepared treatment-draft', /workspace\.record_deliberation[\s\S]{0,900}artifact:treatment-draft/.test(platform));

const bridge = read('src/platform/control-plane/artifact-bridge.ts');
check('terminal treatment delivery reads CommitLedger', /artifact:treatment-delivery[\s\S]{0,900}commitLedger\?\.delivered/.test(bridge));
check('prepared treatment draft has a separate truth reader', bridge.includes("'artifact:treatment-draft'"));

const source = read('src/clinical/source-formula-set.ts');
check('source membership does not filter by composition', !/activeFormulas\s*=\s*parent\.formulas\.filter\([^;]*composition/s.test(source));
check('source product tracks composition presence', source.includes('compositionPresence'));

const projection = read('src/control-plane-v2/result-projection.ts');
check('projection does not drop CLINICALLY_EXCLUDED source members', !/filter\([^\n]*CLINICALLY_EXCLUDED/.test(projection));

const runtime = read('src/platform/agent/clinical-runtime.ts');
check('authoritative final is generated from CommitLedger', runtime.includes('committedFormulaSet(context.commitLedger.all())'));
check('proposal product fields are stripped before final projection', runtime.includes('proposalWithoutProducts'));
check('post-submit treatment auto-commit removed', !runtime.includes('commitDeliveries(context'));

const trace = read('src/trace.ts');
check('raw trace has CommitRecord surface', trace.includes('commits?: CommitRecord[]') && trace.includes('commits: []'));

for (const name of ['gaofang', 'tcm.external-therapy', 'tcm.preparation']) {
  const manifest = json(`capabilities/${name}/capability.json`);
  const rules = manifest.controlPlaneV21?.rules ?? [];
  const draft = rules.find((r) => r.id === 'treatment-draft');
  const terminal = rules.find((r) => r.id === 'treatment-delivery');
  check(`${name}: has prepared draft rule`, draft?.produces?.type === 'artifact:treatment-draft');
  check(`${name}: terminal requires draft`, terminal?.requires?.some((r) => r.type === 'artifact:treatment-draft'));
  check(`${name}: terminal is exact outcome delivery`, terminal?.produces?.type === 'artifact:treatment-delivery' && Array.isArray(terminal.forOutcomes));
}
const core = json('capabilities/tcm-core/capability.json');
const formulaTerminal = core.controlPlaneV21?.rules?.find((r) => r.id === 'formula-delivery');
check('herbal formula terminal is a treatment delivery', formulaTerminal?.produces?.type === 'artifact:treatment-delivery');
check('herbal materialization is canonical candidate', core.deliveryObligations?.some((o) => o.materialization === 'CANONICAL_CANDIDATE'));

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nAuthority cutover checks: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
