import { runCase } from '../src/composition/runtime.js';
import { config } from '../src/config.js';
import { loadIndex } from '../src/knowledge/build.js';

const CASES = [
  { id: 'A', label: 'MECHANISM_TEST_ONLY', input: '患者，女，52岁。大便秘结，排便困难，3-4日一行，腹胀，纳差，口干口苦。舌红苔黄，脉弦数。' },
  { id: 'B', label: 'NEGATIVE_CONTROL', input: '患者，女，35岁。月经先后无定期3月，经量中等，色暗，偶有血块，小腹隐痛。舌淡红苔薄白，脉弦。' },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

await loadIndex();

for (const c of CASES) {
  const { trace, workspace } = await runCase(c.input);
  const r = trace.finalResult as Record<string, unknown> | undefined;
  const toolCalls = trace.toolCalls ?? [];
  const getModCalls = toolCalls.filter((x) => x.toolName === 'formula.get_modification_evidence').length;
  const mp = workspace.clinicalDecisionSpine.modificationPlan;
  const f = (r?.mode === 'clinical' && typeof r.formula === 'object' && r.formula !== null ? r.formula as Record<string, unknown> : undefined);
  const comp = (v: unknown) => Array.isArray(v) ? (v as string[]).join('') : str(v);

  console.log(`\n=== Case ${c.id} [${c.label}] ${trace.agentLoop?.forcedFinalization ? 'FORCED' : 'OK'} steps=${num(trace.agentLoop?.stepCount)} tools=${num((trace.runMetrics as any)?.totalToolCalls)} tokens=${num(trace.usage?.inputTokens) + num(trace.usage?.outputTokens)} ===`);
  console.log(`mode=${str(r?.mode)} getModCalls=${getModCalls}`);
  console.log(`baseFormula: ${str(f?.name)} [${str(f?.authority)}${str(f?.source_authority) ? '/' + str(f?.source_authority) : ''}]`);
  console.log(`baseComposition: ${comp(f?.composition) || '-'}`);
  console.log(`modificationPlan items=${mp?.items?.length ?? 0}`);
  for (const it of (mp?.items ?? [])) {
    console.log(`  - ${str(it.statement)}`);
    console.log(`      patientEvidence=${(it.patientEvidenceRefs ?? []).join(',') || '-'}`);
    console.log(`      sourceEvidence=${(it.sourceEvidenceRefs ?? []).join(',') || '-'}`);
  }
}
