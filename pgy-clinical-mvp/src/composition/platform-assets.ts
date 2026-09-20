import type { RuntimeToolDescriptor } from '../contracts/tool.js';
import { config } from '../config.js';

/** Diagnostic Pattern Set Spike：仅当实验开关 ON 时暴露该知识查询能力。 */
const EXPERIMENTAL_TOOLS: RuntimeToolDescriptor[] = config.experiment.diagnosticPatternSet
  ? [{ id: 'knowledge.get_diagnostic_patterns', description: '读取某规范病种下全部 P1 规范证候诊断记录（证型/症状/舌脉/治法，不含方剂）', risk: 'low' }]
  : [];

/** Existing Standards Runtime：接通 release 中已存在的国标诊断/证候标准知识。 */
const STANDARD_RUNTIME_TOOLS: RuntimeToolDescriptor[] = config.experiment.standardRuntime
  ? [
      { id: 'knowledge.get_disease_standard', description: '读取《中医病证诊断疗效标准2024》某病名的定义/诊断依据/证候分类', risk: 'low' },
      { id: 'knowledge.get_syndrome_standard', description: '读取 GB/T 16751.2 证候本体的标准定义/病机/主症/舌脉', risk: 'low' },
    ]
  : [];

export const PLATFORM_TOOLS: RuntimeToolDescriptor[] = [
  { id: 'knowledge.search', description: '检索当前 scope 的临床知识证据', risk: 'low' },
  { id: 'knowledge.get_source', description: '读取一个完整知识来源', risk: 'low' },
  { id: 'knowledge.search_cards', description: '在当前激活的 Runtime Catalog scope 中检索轻量知识卡片', risk: 'low' },
  { id: 'knowledge.get_asset', description: '按 asset_id 精确获取一条 Runtime Catalog 完整资产详情', risk: 'low' },
  { id: 'formula.search_normative', description: '检索当前 scope 的 P1 规范方', risk: 'low', treatmentSpecific: true },
  { id: 'formula.search_candidates', description: '两阶段方剂检索第一阶段：召回少量基础方候选卡', risk: 'low', treatmentSpecific: true },
  { id: 'formula.get_evidence', description: '两阶段方剂检索第二阶段：展开完整方剂证据', risk: 'low', treatmentSpecific: true },
  { id: 'formula.validate', description: '验证 source/formula/composition 同源绑定', risk: 'low' },
  { id: 'workspace.focus_candidates', description: '选择进入 Deliberation Frontier 的候选', risk: 'low' },
  { id: 'workspace.record_candidate_assessment', description: '记录 candidate × hypothesis 的候选评估', risk: 'low' },
  { id: 'workspace.record_candidate_exclusion', description: '记录 candidate 被有意排除的原因', risk: 'low' },
  { id: 'workspace.record_deliberation', description: '批量提交 focus + assessment + exclusion', risk: 'low' },
  { id: 'workspace.consider_hypotheses', description: '显式认领 patient-level hypothesis（leading/alternative）', risk: 'low' },
  ...EXPERIMENTAL_TOOLS,
  ...STANDARD_RUNTIME_TOOLS,
];
export const BASELINE_TOOL_IDS: string[] = PLATFORM_TOOLS.map((t) => t.id);
export const CLASSIC_BASELINE_TOOL_IDS: string[] = BASELINE_TOOL_IDS.filter((id) => id !== 'knowledge.get_source');
export const BASELINE_KNOWLEDGE_SCOPES: string[] = ['general'];

/** 平台级 baseline skills：不依赖任何业务 capability，随 harness.baseline 注入。 */
export const BASELINE_SKILL_IDS: string[] = ['tcm-clinical-cognition'];
