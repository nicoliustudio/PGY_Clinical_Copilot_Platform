import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { ClinicalWorkspace } from '../contracts/workspace.js';

/**
 * H15.3 —— Minimal ADD Modification Evidence
 *
 * 只做一件事：基础方已选后，从 medication_rules.json（action=ADD）做确定性
 * normalization + alias（trigger 内部同义词）匹配，返回少量候选加减证据。
 *
 * 强制边界：
 * - 只读资产，不做 rule engine、不做 runtime LLM matcher、不做 embedding threshold。
 * - auto_apply_default 一律不执行；所有命中均 ADVISORY + 显式患者证据。
 * - 检索到 ≠ 采用；Agent 自行决定是否写入已有 ModificationPlan。
 */

interface ModificationRule {
  id?: string;
  action?: string;
  scope?: string;
  trigger?: string;
  medication?: string;
  source?: string;
  source_tier?: string;
  source_priority?: number;
  knowledge_role?: string;
  auto_apply_default?: boolean;
  requires_explicit_patient_trigger?: boolean;
}

export interface ModificationEvidenceCandidate {
  modificationEvidenceRef: string;
  trigger: string;
  matchedPatientEvidenceRefs: string[];
  medication: string;
  dose: string;
  sourceRef: string;
}

export interface ModificationEvidenceResult {
  result: 'FOUND' | 'NONE';
  candidates: ModificationEvidenceCandidate[];
}

let rulesCache: ModificationRule[] | null = null;

function loadRules(): ModificationRule[] {
  if (rulesCache) return rulesCache;
  const p = join(config.kb.releaseDir, 'medication_rules.json');
  rulesCache = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as ModificationRule[]) : [];
  return rulesCache;
}

function normalize(s: string): string {
  return s.replace(/[\s，。、,.;；：:()（）\[\]【】{}《》<>'"“”‘’\-_·／/\\]/g, '');
}

/** trigger → OR groups，每个 group 为 AND tokens。括号内为并列限定（肿块(无痛) → 肿块 AND 无痛）。 */
function triggerGroups(trigger: string): string[][] {
  const parts = trigger.split(/[、，；;]/).map((x) => x.trim()).filter(Boolean);
  const groups: string[][] = [];
  for (const p of parts) {
    const m = p.match(/^([^()（）]+)[(（]([^()（）]+)[)）]$/);
    if (m) groups.push([normalize(m[1]), normalize(m[2])].filter(Boolean));
    else groups.push([normalize(p)].filter(Boolean));
  }
  return groups.filter((g) => g.length > 0);
}

function parseMedication(medication: string): { medication: string; dose: string } {
  const items = medication.split(/[、，；;]/).map((x) => x.trim()).filter(Boolean);
  const herbs: string[] = [];
  const doses: string[] = [];
  for (const item of items) {
    const m = item.match(/^(.*?)(\d.*)?$/);
    const herb = (m?.[1] ?? item).trim();
    const dose = (m?.[2] ?? '').trim();
    if (herb) herbs.push(herb);
    if (dose) doses.push(dose);
  }
  return { medication: herbs.join('、'), dose: doses.join('、') };
}

function patientTargets(workspace: ClinicalWorkspace, scope: string): { text: string; ref: string }[] {
  if (scope === 'DISEASE') {
    const out: { text: string; ref: string }[] = [];
    const stmt = workspace.clinicalDecisionSpine.diseaseAssessment?.statement;
    if (stmt) out.push({ text: stmt, ref: 'diseaseAssessment' });
    return out;
  }
  if (scope === 'SYNDROME') {
    const out: { text: string; ref: string }[] = [];
    const pa = workspace.patternAssessment;
    if (pa?.primary?.statement) out.push({ text: pa.primary.statement, ref: pa.primary.hypothesisRef ?? 'patternPrimary' });
    for (const s of pa?.secondary ?? []) if (s.statement) out.push({ text: s.statement, ref: s.hypothesisRef ?? 'patternSecondary' });
    if (pa?.currentDominantMechanism?.statement) out.push({ text: pa.currentDominantMechanism.statement, ref: pa.currentDominantMechanism.hypothesisRef ?? 'patternDominant' });
    return out;
  }
  // SYMPTOM（默认）：患者现症 caseFacts（CF_xxx）。
  return workspace.caseFacts.map((f) => ({ text: f.value, ref: f.id }));
}

/** 纯函数：确定性匹配（normalization + trigger 内部同义词 alias）。 */
export function searchModificationEvidence(workspace: ClinicalWorkspace, topK = 3): ModificationEvidenceResult {
  const rules = loadRules();
  const candidates: ModificationEvidenceCandidate[] = [];

  for (const r of rules) {
    if (r.action !== 'ADD') continue;
    const scope = r.scope ?? 'SYMPTOM';
    const trigger = r.trigger ?? '';
    if (!trigger) continue;
    const groups = triggerGroups(trigger);
    const targets = patientTargets(workspace, scope);
    const normalizedTargets = targets.map((t) => ({ ...t, n: normalize(t.text) }));

    // 任一 OR group 内全部 AND token 命中即算命中。
    const matchedRefs = new Set<string>();
    for (const group of groups) {
      const groupAll = group.every((tok) => normalizedTargets.some((t) => t.n.includes(tok)));
      if (!groupAll) continue;
      for (const t of normalizedTargets) {
        for (const tok of group) if (t.n.includes(tok)) matchedRefs.add(t.ref);
      }
    }

    if (matchedRefs.size === 0) continue;
    const { medication, dose } = parseMedication(r.medication ?? '');
    candidates.push({
      modificationEvidenceRef: r.id ?? '',
      trigger,
      matchedPatientEvidenceRefs: [...matchedRefs],
      medication,
      dose,
      sourceRef: r.source ?? '',
    });
    if (candidates.length >= topK) break;
  }

  return candidates.length > 0 ? { result: 'FOUND', candidates } : { result: 'NONE', candidates: [] };
}
