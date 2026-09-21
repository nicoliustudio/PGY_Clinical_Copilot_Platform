/**
 * Knowledge Manifest —— 运行时知识资产准入策略（manifest-driven + role-aware + fail-closed）。
 *
 * 与旧版白名单的区别：
 * - 每个资产显式声明 `knowledgeRole` / `sourceTier` / `prescriptionAuthority` / `runtime`。
 * - `knowledgeRole` 不决定处方权；`prescriptionAuthority` 单独判定。
 * - 未声明的资产默认不进入 runtime（fail-closed）。
 *
 * 这里的 layer 与 `KNOWLEDGE_CATALOG.json`（release 内）保持语义一致：
 * catalog 给出 layer id / source / assets，本 manifest 只补充「运行时如何解析这些文件」。
 * 业务层不在此处判断具体病种/证型。
 */

import type { KnowledgeRole, SourceTier } from './types.js';

export type LayerLoader = 'normative' | 'cases' | 'encounters' | 's1' | 'standard-2024';

export interface RuntimeLayer {
  /** 稳定来源身份（对应 catalog layer id）。 */
  sourceId: string;
  source: string;
  role: KnowledgeRole;
  sourceTier: SourceTier;
  prescriptionAuthority: boolean;
  /** 是否进入 vector index（false 表示仅 normalization / shadow / blocked）。 */
  runtime: boolean;
  /** 资产文件（相对 release dir）。 */
  assets: string[];
  loader: LayerLoader;
  /** 默认 scope（cases 会按 knowledge_domain 覆盖）。 */
  scope?: string;
}

/**
 * 处方权判定：只有 NORMATIVE_TREATMENT 角色可持有处方权。
 * 任何未明确授权的资产默认 false（fail-closed）。
 */
export function rolePrescriptionAuthority(role: KnowledgeRole): boolean {
  return role === 'NORMATIVE_TREATMENT';
}

/**
 * 允许进入 runtime 的 4 个知识角色。
 * 其余角色（shadow / safety / evaluation / ontology-normalization）一律不索引。
 */
export const RUNTIME_KNOWLEDGE_ROLES: readonly KnowledgeRole[] = [
  'DIAGNOSTIC_DIFFERENTIAL',
  'DIAGNOSTIC_STANDARD',
  'NORMATIVE_TREATMENT',
  'CLINICAL_CASE',
];

export function isRuntimeKnowledgeRole(role: string): role is KnowledgeRole {
  return (RUNTIME_KNOWLEDGE_ROLES as readonly string[]).includes(role);
}

/**
 * 运行时 layer 声明。
 *
 * P1（唯一 normative 处方权威）与 P2（观察性 fallback）保持 authority 不变；
 * S1 / 2024 标准为诊断辅助，无处方权；ontology 仅作 normalization，不索引；
 * V3.5 / tongue draft / evaluation 永不索引。
 */
export const knowledgeManifest: RuntimeLayer[] = [
  {
    sourceId: 'P1_GYN_MANUAL',
    source: '《中医妇科临床手册》',
    role: 'NORMATIVE_TREATMENT',
    sourceTier: 'P1',
    prescriptionAuthority: true,
    runtime: true,
    assets: ['normative.json'],
    loader: 'normative',
    scope: 'general',
  },
  {
    sourceId: 'P2_SHEN_CASE',
    source: '《沈仲理临证医集》',
    role: 'CLINICAL_CASE',
    sourceTier: 'P2',
    prescriptionAuthority: false,
    runtime: true,
    assets: ['cases.json', 'encounters.json'],
    loader: 'cases',
  },
  {
    sourceId: 'S1_SYMPTOM_DIFFERENTIAL',
    source: '《中医症状鉴别诊断学（第二版）》',
    role: 'DIAGNOSTIC_DIFFERENTIAL',
    sourceTier: 'AUX',
    prescriptionAuthority: false,
    runtime: true,
    assets: ['s1/symptom_anchor_docs.jsonl', 's1/syndrome_differentials.jsonl'],
    loader: 's1',
    scope: 'general',
  },
  {
    sourceId: 'AUX_TCM_DIAGNOSTIC_2024',
    source: '《中医病证诊断疗效标准（2024版）》',
    role: 'DIAGNOSTIC_STANDARD',
    sourceTier: 'AUX',
    prescriptionAuthority: false,
    runtime: true,
    assets: ['tcm_diagnostic_2024.json'],
    loader: 'standard-2024',
    scope: 'general',
  },
];

/**
 * 明确不进入 runtime index 的资产（blocked / shadow / evaluation-only）。
 * 仅用于 build 报告的观测，不参与检索。
 */
export const NON_RUNTIME_ASSETS = {
  blocked: ['standards/archive/blocked/tongue_DRAFT.jsonl'],
  shadow: [
    'knowledge/extensions/clinical_policy_v3/2026.09.11-v3.5-source-recompiled-final/',
  ],
  evaluation: ['gold.json', 'followup_gold.json', 'validation/', 'sources/evaluation/'],
} as const;
