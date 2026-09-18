import type { AgentResult } from '../contracts/result.js';
import { matchDisease, matchFormula, matchSyndrome, type GoldLabel } from '../eval/metrics.js';

/**
 * H2.6C0 Evidence/Gold Audit —— 仅存在于 Eval 层，绝不进入 Clinical Runtime。
 * 目标不是把 gold 当唯一真理，而是对「Agent 解释 vs Gold 参考」做分层诊断。
 */
export type AuditClassification =
  | 'GOLD_MATCH'
  | 'DEFENSIBLE_ALTERNATIVE'
  | 'DECISION_ERROR'
  | 'EVIDENCE_GAP'
  | 'GOLD_EVIDENCE_TENSION'
  | 'KNOWLEDGE_MISMATCH'
  | 'UNSUPPORTED_REASONING'
  | 'UNRESOLVED';

export interface ClinicalAudit {
  classification: AuditClassification;
  exactMatch: { disease: boolean; syndrome: boolean; formula: boolean };
  summary: string;
}

function hasEvidence(result: Extract<AgentResult, { mode: 'clinical' }>): boolean {
  return (
    result.disease.evidence_refs.length > 0 ||
    result.syndrome.evidence_refs.length > 0 ||
    result.formula.evidence_refs.length > 0
  );
}

/**
 * 分类优先级（从强到弱）：
 * 1. 非临床输出 → UNRESOLVED（不参与病证方 gold 对比）
 * 2. 病证方全命中 → GOLD_MATCH
 * 3. 方剂权威被 BLOCKED → DECISION_ERROR
 * 4. 无任何 evidence 支撑 → UNSUPPORTED_REASONING
 * 5. 病证命中、方剂未命中：NORMATIVE 冲突 → GOLD_EVIDENCE_TENSION；无方剂证据 → EVIDENCE_GAP；否则 → DEFENSIBLE_ALTERNATIVE
 * 6. 病命中、证未命中 → KNOWLEDGE_MISMATCH（辨证体系/来源差异）
 * 7. 病未命中 → DECISION_ERROR
 * 8. 其余 → UNRESOLVED
 */
export function classifyAudit(result: AgentResult, gold: GoldLabel): ClinicalAudit {
  if (result.mode !== 'clinical') {
    return {
      classification: 'UNRESOLVED',
      exactMatch: { disease: false, syndrome: false, formula: false },
      summary: `Agent 输出为 ${result.mode}（非 clinical），不参与病证方 gold 对比。`,
    };
  }

  const disease = matchDisease(result.disease.name, gold);
  const syndrome = matchSyndrome(result.syndrome.name, gold);
  const formula = matchFormula(result.formula.source_id, gold);
  const exactMatch = { disease, syndrome, formula };

  if (disease && syndrome && formula) {
    return { classification: 'GOLD_MATCH', exactMatch, summary: '病名、辨证、方剂均与 gold 参考一致。' };
  }

  if (result.formula.authority === 'BLOCKED') {
    return {
      classification: 'DECISION_ERROR',
      exactMatch,
      summary: '方剂权威被 Authority Kernel 判定为 BLOCKED，无法形成可采纳的规范处方。',
    };
  }

  if (!hasEvidence(result)) {
    return {
      classification: 'UNSUPPORTED_REASONING',
      exactMatch,
      summary: '病/证/方均未引用 workspace evidence，属于无证据支撑的推理。',
    };
  }

  if (disease && syndrome && !formula) {
    if (result.formula.authority === 'NORMATIVE') {
      return {
        classification: 'GOLD_EVIDENCE_TENSION',
        exactMatch,
        summary: '病证命中，但 Agent 选择了与 gold 不同的规范方，二者均可能有依据，属于 gold/evidence 冲突。',
      };
    }
    if (result.formula.evidence_refs.length === 0) {
      return {
        classification: 'EVIDENCE_GAP',
        exactMatch,
        summary: '病证命中，但方剂无证据支撑且未命中 gold，属于证据缺口。',
      };
    }
    return {
      classification: 'DEFENSIBLE_ALTERNATIVE',
      exactMatch,
      summary: '病证命中，方剂未命中 gold，可能是可辩护的替代方。',
    };
  }

  if (disease && !syndrome) {
    return {
      classification: 'KNOWLEDGE_MISMATCH',
      exactMatch,
      summary: '病名命中但辨证未命中，可能是辨证体系或知识来源与 gold 不同。',
    };
  }

  if (!disease) {
    return {
      classification: 'DECISION_ERROR',
      exactMatch,
      summary: '病名未命中 gold 参考。',
    };
  }

  return { classification: 'UNRESOLVED', exactMatch, summary: '未能明确归类，保留为未决。' };
}
