import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type {
  ClinicalWorkspace,
  ModificationEvidenceCandidate,
  ModificationEvidenceClosure,
  ModificationMedication,
} from '../contracts/workspace.js';

/**
 * H15.6 Minimal ADD Modification Evidence（安全 + 闭环）
 *
 * 只做一件事：基础方已选后，从 medication_rules.json（action=ADD）做确定性
 * normalization + alias（trigger 内部同义词）匹配，返回少量候选加减证据。
 *
 * 强制边界：
 * - 只读资产，不做 rule engine、不做 runtime LLM matcher、不做 embedding threshold。
 * - 药名与剂量是同一个事实的两半，必须成对解析（ModificationMedication）；
 *   严禁投影成「药名一串 + 剂量一串」两条平行列表（那会让配对信息在进入交付前就永久丢失）。
 * - 患者证据 ref 只放真实证据（CF_xxx / P1:…）；命中的临床判断 artifact 另行记录，
 *   不冒充患者事实，也不因缺患者证据而伪造。
 * - 本模块只发现 curated ADD rule evidence；是否形成 durable patient-specific modification
 *   由 Kernel 的 formula.select transaction 在完成 canonical selection 时确定性物化，LLM 无直接写权。
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
  result: 'FOUND' | 'NONE' | 'UNAVAILABLE';
  candidates: ModificationEvidenceCandidate[];
  reason?: string;
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

/** 条目边界：标点与空白。不对「药名+剂量」的书写格式做枚举，任何分隔都只是条目边界。 */
const ITEM_SEPARATOR = /[、，,；;。：:\s]+/;
/** 「整条只是一个剂量」的形态：数字（可带小数）+ 至多两个汉字单位。 */
const DOSE_ONLY = /^\d+(?:\.\d+)?\p{Script=Han}{0,2}$/u;

/**
 * 把一条条目切成「药名 + 剂量」。剂量是条目内紧随药名的第一个数字段起的部分，
 * 因此「石打穿15」「蒲公英15克」「生军（后下）6克」都得到同一形态的结果，
 * 无需对剂量写法/单位做枚举。数字开头的药名（如「821消瘤片」）整条视为药名。
 */
function splitHerbDose(token: string): { herb: string; dose?: string } | null {
  const matched = /^(\D*?)(\d.*)$/.exec(token);
  if (!matched) return { herb: token };
  const herb = matched[1].trim();
  const dose = matched[2].trim();
  if (!herb) return DOSE_ONLY.test(dose) ? null : { herb: token };
  return { herb, dose };
}

/**
 * 解析一条加减用药文本为「药名 + 剂量」配对列表。
 * 药名与其剂量永不分离：条目内成对产出，被空白拆开的两段（`石打穿 15`）也在此重新配对。
 */
export function parseMedications(text: string): ModificationMedication[] {
  const items: ModificationMedication[] = [];
  for (const token of String(text).split(ITEM_SEPARATOR).map((x) => x.trim()).filter(Boolean)) {
    const split = splitHerbDose(token);
    if (!split) {
      // 独立的剂量段：并入上一条药名，而不是自成一条「药」。
      const previous = items[items.length - 1];
      if (previous && previous.dose === undefined) previous.dose = token;
      continue;
    }
    items.push(split.dose === undefined ? { herb: split.herb } : { herb: split.herb, dose: split.dose });
  }
  return items;
}

/** 规范文本投影：逐味「药名+剂量」相邻，永不产生「药名一串 剂量一串」。 */
export function renderMedicationList(medications: readonly ModificationMedication[]): string {
  return medications
    .map((item) => `${item.herb}${item.dose ? ` ${item.dose}` : ''}`.trim())
    .filter(Boolean)
    .join('、');
}

/**
 * 匹配目标：被匹配的文本 + 它的两类来源。
 * `patientRefs` 是支撑该文本的真实证据；`assessmentRef` 是被命中的临床判断 artifact。
 * 两者分开记录——artifact 名称绝不能冒充患者事实（否则审计会溯源不到病例原文）。
 */
interface MatchTarget {
  text: string;
  patientRefs: readonly string[];
  assessmentRef: string;
}

/** 各 scope 的可匹配目标文本（DISEASE / SYNDROME 用已形成的临床判断；SYMPTOM 用已过滤的当前现症）。 */
function patientTargets(workspace: ClinicalWorkspace, scope: string): MatchTarget[] {
  if (scope === 'DISEASE') {
    const assessment = workspace.clinicalDecisionSpine.diseaseAssessment;
    if (!assessment?.statement) return [];
    return [{ text: assessment.statement, patientRefs: assessment.evidenceRefs ?? [], assessmentRef: 'diseaseAssessment' }];
  }
  if (scope === 'SYNDROME') {
    const pa = workspace.patternAssessment;
    const out: MatchTarget[] = [];
    const push = (claim: { statement?: string; hypothesisRef?: string; supportingEvidenceRefs?: string[] } | undefined, fallbackRef: string): void => {
      if (!claim?.statement) return;
      out.push({
        text: claim.statement,
        patientRefs: claim.supportingEvidenceRefs ?? [],
        assessmentRef: claim.hypothesisRef ?? fallbackRef,
      });
    };
    push(pa?.primary, 'pattern:primary');
    for (const secondary of pa?.secondary ?? []) push(secondary, 'pattern:secondary');
    push(pa?.currentDominantMechanism, 'pattern:dominant');
    return out;
  }
  // SYMPTOM（默认）：当前 + present 的患者症状事实本身就是患者证据（CF_xxx）。
  return eligibleSymptomFacts(workspace).map((f) => ({ text: f.value, patientRefs: [f.id], assessmentRef: '' }));
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
    const matchedPatientRefs = new Set<string>();
    const matchedAssessmentRefs = new Set<string>();
    for (const group of groups) {
      if (group.length === 0) continue;
      const groupAll = group.every((tok) => normalizedTargets.some((t) => t.n.includes(tok)));
      if (!groupAll) continue;
      for (const t of normalizedTargets) {
        if (!group.some((tok) => t.n.includes(tok))) continue;
        for (const ref of t.patientRefs) matchedPatientRefs.add(ref);
        if (t.assessmentRef) matchedAssessmentRefs.add(t.assessmentRef);
      }
    }

    if (matchedPatientRefs.size === 0 && matchedAssessmentRefs.size === 0) continue;
    candidates.push({
      modificationEvidenceRef: r.id ?? '',
      trigger,
      matchedPatientEvidenceRefs: [...matchedPatientRefs],
      matchedAssessmentRefs: [...matchedAssessmentRefs],
      medications: parseMedications(r.medication ?? ''),
      sourceRef: r.source ?? '',
    });
    if (candidates.length >= topK) break;
  }

  return candidates.length > 0 ? { result: 'FOUND', candidates } : { result: 'NONE', candidates: [] };
}

/**
 * Availability-aware deterministic rule scan.
 * Missing rule storage is UNKNOWN/UNAVAILABLE, never equivalent to "searched and no matching rule".
 */
export function searchModificationEvidence(workspace: ClinicalWorkspace, topK = 3): ModificationEvidenceResult {
  const p = join(config.kb.releaseDir, 'medication_rules.json');
  if (!existsSync(p)) {
    return { result: 'UNAVAILABLE', candidates: [], reason: `modification rule store unavailable: ${p}` };
  }
  return matchModificationEvidence(workspace, loadRules(), topK);
}

/**
 * H15.6 加减证据闭环（Runtime 完成义务，非模型自觉）。
 * 基础方已选后，确定性扫描全部 ADD 规则，形成 FOUND / SEARCHED_NONE / UNAVAILABLE / NOT_APPLICABLE。
 * 状态只表达「是否真的查过、规则库是否可用、是否命中」；UNAVAILABLE 绝不能冒充 SEARCHED_NONE。
 * Durable patient-specific plan 由 formula.select transaction 从同一次规则扫描结果物化。
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
  const result = searchModificationEvidence(workspace, Number.MAX_SAFE_INTEGER);
  const matchedRuleRefs = result.candidates.map((c) => c.modificationEvidenceRef).filter(Boolean);

  return {
    status: result.result === 'UNAVAILABLE' ? 'UNAVAILABLE' : result.result === 'FOUND' ? 'FOUND' : 'SEARCHED_NONE',
    baseCandidateRef,
    parentSourceId,
    matchedRuleRefs,
    evaluatedPatientEvidenceRefs: eligibleSymptomFacts(workspace).map((f) => f.id),
    version: 0,
  };
}
