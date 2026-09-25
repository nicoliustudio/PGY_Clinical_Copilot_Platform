import { runCase } from '../src/composition/runtime.js';
import { loadIndex } from '../src/knowledge/build.js';
import { renderMedicationList } from '../src/clinical/modification-evidence.js';

/**
 * H15.3.2 — Minimal Modification Tool Wiring
 *
 * 只验证一件事：Skill 已把「individualized modification」接线到
 * formula.get_modification_evidence 后，正向妇科机制病例是否真正端到端走通
 * （base → external modification tool → ModificationPlan → final output），
 * 且负向对照无额外调用。
 *
 * 正/负共用同一病机（月经先后无定期-肝郁 → 逍遥散，modification=None 无 inline 加减），
 * 正向仅多一个「大便秘结」（medication_rules 中存在 ADD evidence，且未被逍遥散 inline 覆盖）。
 */

const CASES = [
  {
    id: 'POSITIVE',
    label: '妇科机制病例（肝郁 + 未覆盖表现 大便秘结）',
    input: '患者，女，35岁。月经先后无定期3月，经血下行不畅，经前乳胀，下腹作胀，胸闷嗳气，大便秘结。苔薄白，脉弦。',
  },
  {
    id: 'NEGATIVE',
    label: '负向对照（肝郁，无未覆盖加减需求）',
    input: '患者，女，35岁。月经先后无定期3月，经血下行不畅，经前乳胀，下腹作胀，胸闷嗳气。苔薄白，脉弦。',
  },
];

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

await loadIndex();

const results: Record<string, Record<string, unknown>> = {};

for (const c of CASES) {
  const { trace, workspace } = await runCase(c.input);
  const r = trace.finalResult as Record<string, unknown> | undefined;
  const toolCalls = trace.toolCalls ?? [];
  const modCalls = toolCalls.filter((x) => x.toolName === 'formula.get_modification_evidence');
  const getModCalls = modCalls.length;
  const mp = workspace.clinicalDecisionSpine.modificationPlan;
  const f = (r?.mode === 'clinical' && typeof r.formula === 'object' && r.formula !== null ? r.formula as Record<string, unknown> : undefined);
  const comp = (v: unknown) => Array.isArray(v) ? (v as string[]).join('') : str(v);

  // 收集工具本次返回的 provenance refs（sourceRef + modificationEvidenceRef）。
  const toolReturnedSourceRefs: string[] = [];
  const toolReturnedModRefs: string[] = [];
  const toolReturnedMedications: string[] = [];
  for (const mc of modCalls) {
    const out = (mc.output ?? {}) as { candidates?: Array<{ sourceRef?: string; modificationEvidenceRef?: string; medications?: Array<{ herb: string; dose?: string }>; matchedPatientEvidenceRefs?: string[] }> };
    for (const cand of out.candidates ?? []) {
      if (cand.sourceRef) toolReturnedSourceRefs.push(cand.sourceRef);
      if (cand.modificationEvidenceRef) toolReturnedModRefs.push(cand.modificationEvidenceRef);
      if (cand.medications?.length) toolReturnedMedications.push(renderMedicationList(cand.medications));
    }
  }

  const baseComp = comp(f?.composition) || '-';
  const baseAuthority = str(f?.authority);
  const baseSourceAuthority = str(f?.source_authority);

  console.log(`\n=== Case ${c.id} [${c.label}] ${trace.agentLoop?.forcedFinalization ? 'FORCED' : 'OK'} steps=${num(trace.agentLoop?.stepCount)} ===`);
  console.log(`mode=${str(r?.mode)} getModCalls=${getModCalls}`);
  console.log(`baseFormula: ${str(f?.name)} [${baseAuthority}${baseSourceAuthority ? '/' + baseSourceAuthority : ''}]`);
  console.log(`baseComposition: ${baseComp}`);
  console.log(`modificationPlan items=${mp?.items?.length ?? 0}`);
  for (const it of (mp?.items ?? [])) {
    console.log(`  - ${str(it.statement)}`);
    console.log(`      patientEvidence=${(it.patientEvidenceRefs ?? []).join(',') || '-'}`);
    console.log(`      sourceEvidence=${(it.sourceEvidenceRefs ?? []).join(',') || '-'}`);
  }
  if (getModCalls > 0) {
    console.log(`toolReturned.sourceRefs=${[...new Set(toolReturnedSourceRefs)].join(' | ') || '-'}`);
    console.log(`toolReturned.modificationEvidenceRefs=${[...new Set(toolReturnedModRefs)].join(' | ') || '-'}`);
    console.log(`toolReturned.medications=${[...new Set(toolReturnedMedications)].join(' | ') || '-'}`);
  }

  results[c.id] = {
    mode: str(r?.mode),
    forced: !!trace.agentLoop?.forcedFinalization,
    getModCalls,
    baseName: str(f?.name),
    baseAuthority,
    baseSourceAuthority,
    baseComp,
    baseCompCanonical: baseComp,
    items: (mp?.items ?? []).map((it: any) => ({
      statement: str(it.statement),
      patientEvidenceRefs: it.patientEvidenceRefs ?? [],
      sourceEvidenceRefs: it.sourceEvidenceRefs ?? [],
    })),
    toolReturnedSourceRefs,
    toolReturnedModRefs,
    toolReturnedMedications,
  };
}

// ---- PASS 判定 ----
console.log('\n\n========== H15.3.2 判定 ==========');

const pos = results['POSITIVE'];
const neg = results['NEGATIVE'];

const posItems = (pos.items as any[]) ?? [];
const posHasEvidenceBackedItem = posItems.some((it) => (it.patientEvidenceRefs?.length ?? 0) > 0 && (it.sourceEvidenceRefs?.length ?? 0) > 0);
const toolRefs = new Set([...(pos.toolReturnedSourceRefs as string[]), ...(pos.toolReturnedModRefs as string[])]);
const posSourceFromTool = posItems.some((it) => (it.sourceEvidenceRefs ?? []).some((s: string) => toolRefs.has(s)));
const modHerbs = new Set((pos.toolReturnedMedications as string[]).flatMap((m) => m.split(/[、，；;]/).map((x) => x.trim()).filter(Boolean)));
const posBaseUnchanged = (pos.baseComp as string).length > 0 && ![...modHerbs].some((h) => (pos.baseComp as string).includes(h));

const checks: Array<[string, boolean, string]> = [
  ['正向 base selected', pos.mode === 'clinical' && !!pos.baseName, `mode=${pos.mode} base=${pos.baseName}`],
  ['正向 get_modification_evidence = 1', pos.getModCalls === 1, `getModCalls=${pos.getModCalls}`],
  ['正向 evidence-backed ModificationPlan (patient + source 均非空)', posHasEvidenceBackedItem, `items=${posItems.length}`],
  ['正向 sourceEvidenceRef 来自 tool 本次返回', posSourceFromTool, `toolRefs=[${[...toolRefs].join('|')}]`],
  ['正向 base canonical composition 未变（不含加减药味）', posBaseUnchanged, `base=${(pos.baseComp as string).slice(0, 60)}...`],
  ['正向 base authority 未变（NORMATIVE）', pos.baseAuthority === 'NORMATIVE', `authority=${pos.baseAuthority}`],
  ['负向 getModCalls = 0', neg.getModCalls === 0, `getModCalls=${neg.getModCalls}`],
  ['负向 正常 submit（非 forced）', neg.mode === 'clinical' && !neg.forced, `mode=${neg.mode} forced=${neg.forced}`],
];

let allPass = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!pass) allPass = false;
}

console.log('\n' + (allPass ? 'EXTERNAL MODIFICATION PATH VERIFIED' : 'NOT VERIFIED'));
