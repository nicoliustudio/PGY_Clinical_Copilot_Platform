import type { CapabilityDescriptor } from '../contracts/capability.js';
import type { ClinicalRequestIR, OutcomeCommitment } from './types.js';

/**
 * Control Plane V2.1.2 — Deterministic Semantic Validator。
 *
 * 职责：Request IR 建立之后，用**声明式语义本体**（manifest metadata）验证
 * 「required 里的治疗形式是否真的被用户点名的形式证明」，而不是被更宽的家族项顶替。
 *
 * 核心原则（不可放宽）：
 *
 *   family relation ≠ exact satisfaction
 *
 * 例：某具体技法声明属于某个更大的治疗方式家族，并不意味着用户点名该技法时可以用家族项替代它。
 * 没有被 registry 作为独立 term 提供、又没有声明 alias 的指名形式，必须 fail-closed 到 unresolved。
 *
 * 本模块是完全确定性的纯函数：
 * - 只做 identity / 声明关系匹配（字面、声明别名、声明家族），不做模糊匹配、近义推断或 embedding；
 * - 不认识任何具体业务词（针灸/膏方/拔罐/方剂…全部来自 manifest 数据）；
 * - 不新增 EffectId、不新增 scheduler 分支。
 */

export type SemanticRelationV21 = 'EXACT' | 'ALIAS' | 'SUBTYPE' | 'FAMILY' | 'UNKNOWN';

export interface MentionResolutionV21 {
  mention: string;
  relation: SemanticRelationV21;
  /** 该 mention 解析到的 registry term（FAMILY 时为更宽的家族项）。 */
  term?: string;
}

export interface SemanticOntologyV21 {
  /** registry 提供的全部 term（enabled capabilities 的 provides 并集）。 */
  provides: Set<string>;
  /** 声明别名 → term。 */
  aliases: Map<string, string>;
  /** 声明为某家族成员、但未作为独立 term 提供的更具体形式 → 家族 term。 */
  declaredSubtypes: Map<string, string>;
}

export interface MentionRequestV21 {
  name: string;
  commitment: OutcomeCommitment;
}

export interface SemanticValidationV21 {
  /** 校验后的 IR（家族顶替项与按承诺等级处置的不可表示形式已归位）。 */
  ir: ClinicalRequestIR;
  resolutions: MentionResolutionV21[];
  /** 被拒绝的「家族顶替」记录（用于 trace / 审计）。 */
  rejected: Array<{ term: string; mention: string; relation: SemanticRelationV21 }>;
  /** REQUIRED 且不可表示 → 阻断主任务的形式（UNSUPPORTED_OUTCOME 义务）。 */
  unresolved: string[];
  /** V2.1.3：PREFERRED 且不可表示 → 非阻断 shortfall（只报告，不产生义务）。 */
  preferredShortfalls: string[];
}

export function buildSemanticOntology(capabilities: CapabilityDescriptor[]): SemanticOntologyV21 {
  const provides = new Set<string>();
  const aliases = new Map<string, string>();
  const declaredSubtypes = new Map<string, string>();
  for (const capability of capabilities) {
    if (capability.enabled === false) continue;
    for (const term of capability.provides) provides.add(term);
  }
  for (const capability of capabilities) {
    if (capability.enabled === false) continue;
    for (const declared of capability.semanticOntology?.terms ?? []) {
      for (const alias of declared.aliases ?? []) {
        const key = alias.trim();
        if (key) aliases.set(key, declared.term);
      }
      for (const subtype of declared.subtypes ?? []) {
        const key = subtype.trim();
        // 同一形式被某个 capability 作为独立 term 提供时，它就是 EXACT（provides 优先），
        // 因此这里只登记「仅以家族成员身份出现」的形式。
        if (key && !provides.has(key)) declaredSubtypes.set(key, declared.term);
      }
    }
  }
  return { provides, aliases, declaredSubtypes };
}

/**
 * Deterministic surface normalization. A display-form string such as `膏方（以膏代煎）` must be
 * reducible to its pure form name (`膏方`) so it can resolve through registry aliases. This is
 * lexical normalization of the witness span, NOT alias enumeration and NOT semantic inference:
 * only parenthetical glosses and whitespace are removed.
 */
function normalizeSurface(value: string): string {
  return value
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function resolveMention(ontology: SemanticOntologyV21, mention: string): MentionResolutionV21 {
  const key = mention.trim();
  if (key === '') return { mention: key, relation: 'UNKNOWN' };
  if (ontology.provides.has(key)) {
    return {
      mention: key,
      relation: ontology.declaredSubtypes.has(key) ? 'SUBTYPE' : 'EXACT',
      term: key,
    };
  }
  const alias = ontology.aliases.get(key);
  if (alias !== undefined) {
    return ontology.provides.has(alias)
      ? { mention: key, relation: 'ALIAS', term: alias }
      : { mention: key, relation: 'UNKNOWN' };
  }
  const family = ontology.declaredSubtypes.get(key);
  if (family !== undefined) return { mention: key, relation: 'FAMILY', term: family };

  // Deterministic normalization fallback: a display-form surface (with parenthetical gloss) still
  // resolves to the same canonical identity as its pure form name.
  const normalized = normalizeSurface(key);
  if (normalized !== '' && normalized !== key) {
    if (ontology.provides.has(normalized)) {
      return { mention: key, relation: 'EXACT', term: normalized };
    }
    const normalizedAlias = ontology.aliases.get(normalized);
    if (normalizedAlias !== undefined) {
      return ontology.provides.has(normalizedAlias)
        ? { mention: key, relation: 'ALIAS', term: normalizedAlias }
        : { mention: key, relation: 'UNKNOWN' };
    }
    const normalizedFamily = ontology.declaredSubtypes.get(normalized);
    if (normalizedFamily !== undefined) return { mention: key, relation: 'FAMILY', term: normalizedFamily };
  }
  return { mention: key, relation: 'UNKNOWN' };
}

/**
 * 校验 Request IR 的语义健全性：
 * 1) required 中的 registry 治疗 term 必须被某个 mention 以 EXACT / ALIAS / SUBTYPE 证明；
 * 2) 只能被 FAMILY / UNKNOWN 解释的指名形式按**承诺等级**归位（fail-closed，不得吸附到家族项）：
 *    - REQUIRED   → unresolved（阻断主任务）
 *    - PREFERRED  → unresolvedPreferred（非阻断 shortfall）
 *    - ALLOWED    → 静默丢弃（既不阻断也不产生义务）
 *    - EXCLUDED   → 静默丢弃（明确不要的形式永不产生 delivery obligation）
 * 3) baseline outcome（composition policy 提供，不是用户点名）不参与该证明。
 *
 * 若编译器没有给出 mentions（空数组），则没有可反驳的证据 —— 此时不改变 required，
 * 避免把「编译器未提供证词」误判为「用户指名被顶替」。
 */
export function validateRequestSemantics(
  ir: ClinicalRequestIR,
  capabilities: CapabilityDescriptor[],
  baselineOutcomes: string[],
): SemanticValidationV21 {
  const ontology = buildSemanticOntology(capabilities);
  const mentions: MentionRequestV21[] = ir.outcomes.mentions ?? [];
  const resolutions = mentions.map((mention) => resolveMention(ontology, mention.name));
  const commitmentOf = (name: string): OutcomeCommitment =>
    mentions.find((mention) => mention.name === name)?.commitment ?? 'REQUIRED';

  if (mentions.length === 0) {
    const unresolved = [...new Set(ir.outcomes.unresolved ?? [])].sort();
    return {
      ir, resolutions, rejected: [], unresolved,
      preferredShortfalls: [...new Set(ir.outcomes.unresolvedPreferred ?? [])].sort(),
    };
  }

  const excluded = new Set(ir.outcomes.excluded);
  const unresolved: string[] = [...(ir.outcomes.unresolved ?? [])];
  const preferredShortfalls: string[] = [...(ir.outcomes.unresolvedPreferred ?? [])];
  const rejected: SemanticValidationV21['rejected'] = [];

  const proves = (term: string): MentionResolutionV21 | undefined =>
    resolutions.find((r) =>
      r.term === term && (r.relation === 'EXACT' || r.relation === 'ALIAS' || r.relation === 'SUBTYPE'));

  const required = ir.outcomes.required.filter((term) => {
    if (baselineOutcomes.includes(term)) return true;
    if (!ontology.provides.has(term)) return true;
    if (proves(term)) return true;
    // Only a FAMILY relation is a genuine "broader family standing in for a specific form" rejection.
    // A registry term with no FAMILY mention pointing at it is itself a canonical identity; a
    // display-form mention failing to prove it is a witness-normalization problem, not family
    // substitution. A canonical identity must never be demoted to unresolved just because its
    // surface witness did not exact-match — otherwise `modality:gaofang` gets wrongly reported as
    // "not represented in registry" while it exists.
    const familyMention = resolutions.find((r) => r.term === term && r.relation === 'FAMILY');
    if (!familyMention) return true;
    rejected.push({ term, mention: familyMention.mention, relation: 'FAMILY' });
    return false;
  });

  const handled = new Set<string>();
  for (const resolution of resolutions) {
    if (resolution.relation === 'EXACT' || resolution.relation === 'ALIAS' || resolution.relation === 'SUBTYPE') continue;
    if (excluded.has(resolution.mention)) continue;
    const commitment = commitmentOf(resolution.mention);
    if (commitment === 'ALLOWED' || commitment === 'EXCLUDED') continue;
    handled.add(resolution.mention);
    if (commitment === 'PREFERRED') preferredShortfalls.push(resolution.mention);
    else unresolved.push(resolution.mention);
  }

  // required 中的 registry term 被更宽家族项顶替、且没有任何精确证词时，按该形式自身的承诺等级归位。
  for (const rejection of rejected) {
    if (handled.has(rejection.mention) || excluded.has(rejection.mention)) continue;
    handled.add(rejection.mention);
    if (commitmentOf(rejection.mention) === 'PREFERRED') preferredShortfalls.push(rejection.mention);
    else unresolved.push(rejection.mention);
  }

  return {
    ir: {
      ...ir,
      outcomes: {
        ...ir.outcomes,
        required,
        unresolved: [...new Set(unresolved)].sort(),
        unresolvedPreferred: [...new Set(preferredShortfalls)].sort(),
      },
    },
    resolutions,
    rejected,
    unresolved: [...new Set(unresolved)].sort(),
    preferredShortfalls: [...new Set(preferredShortfalls)].sort(),
  };
}
