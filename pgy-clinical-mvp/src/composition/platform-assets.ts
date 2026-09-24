import type { RuntimeToolDescriptor } from '../contracts/tool.js';
import { config } from '../config.js';

/** Diagnostic Pattern Set Spike：仅当实验开关 ON 时暴露该知识查询能力。 */
const EXPERIMENTAL_TOOLS: RuntimeToolDescriptor[] = config.experiment.diagnosticPatternSet
  ? [{ id: 'knowledge.get_diagnostic_patterns', description: '读取某规范病种下全部 P1 规范证候诊断记录（证型/症状/舌脉/治法，不含方剂）', risk: 'low', effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:diagnostic-evidence' } }] }]
  : [];

/** Existing Standards Runtime：接通 release 中已存在的国标诊断/证候标准知识。 */
const STANDARD_RUNTIME_TOOLS: RuntimeToolDescriptor[] = config.experiment.standardRuntime
  ? [
      { id: 'knowledge.get_disease_standard', description: '读取《中医病证诊断疗效标准2024》某病名的定义/诊断依据/证候分类', risk: 'low', effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:diagnostic-evidence' } }] },
      { id: 'knowledge.get_syndrome_standard', description: '读取 GB/T 16751.2 证候本体的标准定义/病机/主症/舌脉', risk: 'low', effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:diagnostic-evidence' } }] },
    ]
  : [];

export const PLATFORM_TOOLS: RuntimeToolDescriptor[] = [
  { id: 'knowledge.search', description: '检索当前 scope 的临床知识证据', risk: 'low', effects: ['evidence:diagnostic-read', 'evidence:targeted-search'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:diagnostic-evidence' } }, { op: 'retrieve', target: { type: 'artifact:evidence-gap' } }] },
  { id: 'knowledge.get_source', description: '读取一个完整知识来源', risk: 'low', effects: ['evidence:diagnostic-read', 'evidence:targeted-search'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:diagnostic-evidence' } }, { op: 'retrieve', target: { type: 'artifact:evidence-gap' } }] },
  { id: 'knowledge.search_cards', description: '在当前激活的 Runtime Catalog scope 中检索轻量知识卡片', risk: 'low', effects: ['evidence:discover-treatment'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:treatment-evidence' } }] },
  { id: 'knowledge.get_asset', description: '按 asset_id 精确获取一条 Runtime Catalog 完整资产详情', risk: 'low', effects: ['evidence:hydrate-treatment'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:treatment-evidence' } }] },
  { id: 'formula.search_normative', description: '检索当前 scope 的 P1 规范方', risk: 'low', treatmentSpecific: true, effects: ['formula:discover'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:formula-evidence' } }] },
  { id: 'formula.search_candidates', description: '两阶段方剂检索第一阶段：召回少量基础方候选卡', risk: 'low', treatmentSpecific: true, effects: ['formula:discover'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:formula-evidence' } }] },
  { id: 'formula.get_evidence', description: '两阶段方剂检索第二阶段：展开完整方剂证据', risk: 'low', treatmentSpecific: true, effects: ['formula:hydrate'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:formula-evidence' } }] },
  { id: 'formula.get_modification_evidence', description: '基础方已选后检索随证 ADD 加味证据（ADVISORY）', risk: 'low', treatmentSpecific: true, effects: ['formula:hydrate'], effectPatternsV21: [{ op: 'retrieve', target: { type: 'artifact:formula-evidence' } }] },
  { id: 'formula.validate', description: '验证 source/formula/composition 同源绑定', risk: 'low', effects: ['formula:validate'], effectPatternsV21: [{ op: 'validate', target: { type: 'artifact:formula-evidence' } }] },
  { id: 'delivery.adopt', description: '显式扩展 effective delivery contract；只创建义务，不产生产品或 DELIVERED', risk: 'low', effects: ['delivery:adopt-contract'] },
  { id: 'delivery.commit', description: '将当前 exact outcome 的 PREPARED 交付提交到 Kernel CommitLedger；只有成功 CommitRecord 才算 DELIVERED', risk: 'low', effects: ['delivery:kernel-commit'], effectPatternsV21: [{ op: 'commit', target: { type: 'artifact:treatment-delivery' } }] },
  // V2.1.1: durable clinical mutations also participate in the effect surface.
  // Fine-grained payload legality is checked again inside workspace.record_deliberation, so a broad
  // multi-artifact mutation tool cannot write a future artifact merely because one commit effect is runnable.
  //
  // V2.1.2: the fine-grained deliberation mutations are governed too, so the progression
  // discovery → frontier → hydration → assessment → selection is driven by the obligation graph
  // instead of the model's free choice. They declare exactly the same structural effects as
  // workspace.record_deliberation (which is the same durable mutation, batched).
  { id: 'workspace.focus_candidates', description: '选择进入 Deliberation Frontier 的候选', risk: 'low', effects: ['state:write-formula-selection'], effectPatternsV21: [
    { op: 'commit', target: { type: 'artifact:formula-evidence' } },
  ] },
  { id: 'workspace.record_candidate_assessment', description: '记录 candidate × hypothesis 的候选评估', risk: 'low', effects: ['state:write-formula-selection'], effectPatternsV21: [
    { op: 'commit', target: { type: 'artifact:formula-selection' } },
  ] },
  { id: 'workspace.record_candidate_exclusion', description: '记录 candidate 被有意排除的原因', risk: 'low', effects: ['state:write-formula-selection'], effectPatternsV21: [
    { op: 'commit', target: { type: 'artifact:formula-selection' } },
  ] },
  { id: 'workspace.record_deliberation', description: '批量提交 reasoning / prepared delivery draft（非权威交付）', risk: 'low', effects: ['state:write-clinical-core', 'state:write-formula-selection', 'state:write-treatment-delivery'], effectPatternsV21: [
    { op: 'commit', target: { type: 'artifact:clinical-core' } },
    { op: 'commit', target: { type: 'artifact:formula-selection' } },
    { op: 'commit', target: { type: 'artifact:treatment-draft' } },
  ] },
  { id: 'workspace.consider_hypotheses', description: '显式认领 patient-level hypothesis（leading/alternative）', risk: 'low', effects: ['state:write-clinical-core'], effectPatternsV21: [{ op: 'commit', target: { type: 'artifact:clinical-core' } }] },
  ...EXPERIMENTAL_TOOLS,
  ...STANDARD_RUNTIME_TOOLS,
];
export const BASELINE_TOOL_IDS: string[] = PLATFORM_TOOLS.map((t) => t.id)
  // H15.2.10：formula.search_normative 不再是基础临床的 Agent-visible primary search entry。
  // 统一由 formula.search_candidates（applicable P1 → P2 fallback）承担；
  // search_normative 保留为 gaofang 能力（膏方基础方 P1 检索）专用工具。
  .filter((id) => id !== 'formula.search_normative');
export const CLASSIC_BASELINE_TOOL_IDS: string[] = BASELINE_TOOL_IDS.filter((id) => id !== 'knowledge.get_source' && id !== 'delivery.commit' && id !== 'delivery.adopt');
export const BASELINE_KNOWLEDGE_SCOPES: string[] = ['general'];

/** 平台级 baseline skills：不依赖任何业务 capability，随 harness.baseline 注入。 */
export const BASELINE_SKILL_IDS: string[] = ['tcm-clinical-cognition'];
