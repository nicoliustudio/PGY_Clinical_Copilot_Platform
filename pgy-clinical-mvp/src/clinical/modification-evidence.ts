import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { ClinicalWorkspace, ModificationEvidenceCandidate, ModificationEvidenceClosure } from '../contracts/workspace.js';

/**
 * H15.6 Minimal ADD Modification Evidence（安全 + 闭环）
 *
 * 只做一件事：基础方已选后，从 medication_rules.json（action=ADD）做确定性
 * normalization + alias（trigger 内部同义词）匹配，返回少量候选加减证据。
 *
 * 强制边界：
 * - 只读资产，不做 rule engine、不做 runtime LLM matcher、不做 embedding threshold。
 * - auto_apply_default 一律不执行；所有命中均 ADVISORY + 显式患者证据。
 * - 检索到 ≠ 采用；Agent 自行决定是否写入已有 ModificationPlan。
 * - 症状 trigger 必须与规则所属知识上下文（当前 adopted disease/parent）共同成立。
 * - 仅 current + present 的患者症状事实可触发；无/既往/术后症状绝不触发。
 */

export interface ModificationRule {
  id?: string;
  action?: string;
  scope?: string;
  trigger?: string;
  medication?: string;
  /** 规则所属知识上下文（可选；存在时需与当前 adopted disease/parent 一致才可触发）。 */
  disease?: string;
  source?: string;
  source_tier?: string;
  source_priority?: number;
  knowledge_role?: string;
  auto_apply_default?: boolean;
  requires_explicit_patient_trigger?: boolean;
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

/** 仅供测试：重置规则缓存。 */
export function resetModificationRulesCache(): void {
  rulesCache = null;
}

function normalize(s: string): string {
  return s.replace(/[\s，。、,.;；：:()（）\[\]【】{}《》<>'"“”‘’\-_·／/\\]/g, '');
}

/**
 * 症状事实的触发资格（H15.6 安全不变式）：
 * - 必须是 symptom 事实（kind === symptom）。
 * - 排除显性阴性（explicitly_absent，如「无腰痛」）。
 * - 排除非当前时间角色（historical / post_treatment）。
 * temporalRole 未声明按 current 处理；polarity 未声明按 present 处理（与理解层默认一致）。
 */
export function eligibleSymptomFacts(workspace: ClinicalWorkspace): Array<{ id: string; value: string }> {
  return workspace.caseFacts
    .filter((f) => f.kind === 'symptom')
    .filter((f) => f.polarity !== 'explicitly_absent')
    .filter((f) => f.temporalRole !== 'historical' && f.temporalRole !== 'post_treatment')
    .map((f) => ({ id: f.id, value: f.value }));
}

/** 当前 adopted 病名（规范化后）；未形成辨病时返回 undefined。 */
function currentDisease(workspace: ClinicalWorkspace): string | undefined {
  const stmt = workspace.clinicalDecisionSpine.diseaseAssessment?.statement;
  if (!stmt || !stmt.trim()) return undefined;
  return normalize(stmt);
}

/** 规则所属知识上下文是否与当前病名一致（无 disease 字段视为全局；无当前病名无法判断则放行发现）。 */
function ruleDiseaseMatches(rule: ModificationRule, patientDisease: string | undefined): boolean {
  const ruleDisease = rule.disease ? normalize(rule.disease) : '';
  if (!ruleDisease) return true;
  if (!patientDisease) return true;
  return ruleDisease === patientDisease || ruleDisease.includes(patientDisease) || patientDisease.includes(ruleDisease);
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

/** 各 scope 的可匹配目标文本（DISEASE / SYNDROME 用已形成的临床判断；SYMPTOM 用已过滤的当前现症）。 */
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
  // SYMPTOM（默认）：当前 + present 的患者症状事实（CF_xxx）。
  return eligibleSymptomFacts(workspace).map((f) => ({ text: f.value, ref: f.id }));
}

/**
 * 纯函数：确定性匹配（normalization + trigger 内部同义词 alias + 症状资格 + 病名 scope）。
 * 不读磁盘、不改 workspace；便于单元测试与注入自定义规则。
 */
export function matchModificationEvidence(
  workspace: ClinicalWorkspace,
  rules: ModificationRule[],
  topK = 3,
): ModificationEvidenceResult {
  const candidates: ModificationEvidenceCandidate[] = [];
  const patientDisease = currentDisease(workspace);

  for (const r of rules) {
    if (r.action !== 'ADD') continue;
    if (!ruleDiseaseMatches(r, patientDisease)) continue;
    const scope = r.scope ?? 'SYMPTOM';
    const trigger = r.trigger ?? '';
    if (!trigger) continue;
    const groups = triggerGroups(trigger);
    const targets = patientTargets(workspace, scope);
    const normalizedTargets = targets.map((t) => ({ ...t, n: normalize(t.text) }));

    // 任一 OR group 内全部 AND token 命中即算命中。
    const matchedRefs = new Set<string>();
    for (const group of groups) {
      if (group.length === 0) continue;
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

/** 从磁盘加载规则并执行确定性匹配（保持既有调用签名不变）。 */
export function searchModificationEvidence(workspace: ClinicalWorkspace, topK = 3): ModificationEvidenceResult {
  return matchModificationEvidence(workspace, loadRules(), topK);
}

/**
 * H15.6 加减证据闭环（Runtime 完成义务，非模型自觉）。
 * 基础方已选后，确定性扫描全部 ADD 规则，形成 FOUND / SEARCHED_NONE / NOT_APPLICABLE 状态。
 * 状态只表达「是否查过、是否命中」，不表达「是否采用」。
 */
export function computeModificationEvidenceClosure(
  workspace: ClinicalWorkspace,
  baseCandidateRef: string | undefined,
): ModificationEvidenceClosure {
  const parentSourceId = baseCandidateRef ? baseCandidateRef.split('::')[0] : undefined;
  if (!baseCandidateRef || !parentSourceId) {
    return {
      status: 'NOT_APPLICABLE',
      matchedRuleRefs: [],
      evaluatedPatientEvidenceRefs: eligibleSymptomFacts(workspace).map((f) => f.id),
      version: 0,
    };
  }

  // 用足够大的 topK 收集全部命中规则（不因 topK 截断而漏报 matched rule refs）。
  const result = matchModificationEvidence(workspace, loadRules(), Number.MAX_SAFE_INTEGER);
  const matchedRuleRefs = result.candidates.map((c) => c.modificationEvidenceRef).filter(Boolean);

  return {
    status: result.result === 'FOUND' ? 'FOUND' : 'SEARCHED_NONE',
    baseCandidateRef,
    parentSourceId,
    matchedRuleRefs,
    evaluatedPatientEvidenceRefs: eligibleSymptomFacts(workspace).map((f) => f.id),
    version: 0,
  };
}
