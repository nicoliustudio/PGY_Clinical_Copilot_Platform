import { readFileSync } from 'node:fs';

const base = '../assets/knowledge/releases/2026.09.18-agent-ready-r1';
const rules = JSON.parse(readFileSync(`${base}/medication_rules.json`, 'utf8')) as Record<string, unknown>[];
const policy = JSON.parse(readFileSync(`${base}/modification_policy.json`, 'utf8')) as Record<string, unknown>;

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// 基础计数
const total = rules.length;
const actionDist: Record<string, number> = {};
const scopeDist: Record<string, number> = {};
const sourceDist: Record<string, number> = {};
const sourceTierDist: Record<string, number> = {};
const roleDist: Record<string, number> = {};
const explicitTriggerTrue = rules.filter((r) => r.requires_explicit_patient_trigger === true).length;
const autoApplyTrue = rules.filter((r) => r.auto_apply_default === true).length;

let triggerEmpty = 0;
let medicationEmpty = 0;
let medicationWithDose = 0;
for (const r of rules) {
  const action = s(r.action) || '（空）';
  const scope = s(r.scope) || '（空）';
  const source = s(r.source) || '（空）';
  const tier = s(r.source_tier) || '（空）';
  const role = s(r.knowledge_role) || '（空）';
  actionDist[action] = (actionDist[action] ?? 0) + 1;
  scopeDist[scope] = (scopeDist[scope] ?? 0) + 1;
  sourceDist[source] = (sourceDist[source] ?? 0) + 1;
  sourceTierDist[tier] = (sourceTierDist[tier] ?? 0) + 1;
  roleDist[role] = (roleDist[role] ?? 0) + 1;
  if (!s(r.trigger)) triggerEmpty += 1;
  const med = s(r.medication);
  if (!med) medicationEmpty += 1;
  else if (/\d/.test(med)) medicationWithDose += 1;
}

// 重复：同 scope+trigger+medication+action
const keyCount = new Map<string, number>();
for (const r of rules) {
  const k = `${s(r.scope)}\u0000${s(r.action)}\u0000${s(r.trigger)}\u0000${s(r.medication)}`;
  keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
}
const duplicateRules = [...keyCount.values()].filter((n) => n > 1).reduce((a, b) => a + (b - 1), 0);
const duplicateGroups = [...keyCount.values()].filter((n) => n > 1).length;

// 冲突：同 scope+trigger+action，但不同 medication
const sigToMeds = new Map<string, Set<string>>();
for (const r of rules) {
  const sig = `${s(r.scope)}\u0000${s(r.action)}\u0000${s(r.trigger)}`;
  const meds = sigToMeds.get(sig) ?? new Set<string>();
  meds.add(s(r.medication));
  sigToMeds.set(sig, meds);
}
const conflictGroups = [...sigToMeds.values()].filter((m) => m.size > 1).length;

function sorted(obj: Record<string, number>): [string, number][] {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
}

console.log(JSON.stringify({
  policy,
  total,
  actionDist,
  scopeDist,
  sourceDist,
  sourceTierDist,
  roleDist,
  triggerEmpty,
  medicationEmpty,
  medicationWithDose,
  medicationDoseCoverage: total ? (medicationWithDose / total).toFixed(3) : '0',
  triggerCompleteness: total ? ((total - triggerEmpty) / total).toFixed(3) : '0',
  medicationCompleteness: total ? ((total - medicationEmpty) / total).toFixed(3) : '0',
  requiresExplicitPatientTrigger: { true: explicitTriggerTrue, false: total - explicitTriggerTrue },
  autoApplyDefault: { true: autoApplyTrue, false: total - autoApplyTrue },
  duplicateRules,
  duplicateGroups,
  conflictGroups,
}, null, 2));
