import type { RuntimeToolDescriptor } from '../contracts/tool.js';

export const PLATFORM_TOOLS: RuntimeToolDescriptor[] = [
  { id: 'knowledge.search', description: '检索当前 scope 的临床知识证据', risk: 'low' },
  { id: 'knowledge.get_source', description: '读取一个完整知识来源', risk: 'low' },
  { id: 'formula.search_normative', description: '检索当前 scope 的 P1 规范方', risk: 'low' },
  { id: 'formula.validate', description: '验证 source/formula/composition 同源绑定', risk: 'low' },
  { id: 'workspace.focus_candidates', description: '选择进入 Deliberation Frontier 的候选', risk: 'low' },
  { id: 'workspace.record_candidate_assessment', description: '记录 candidate × hypothesis 的候选评估', risk: 'low' },
  { id: 'workspace.record_candidate_exclusion', description: '记录 candidate 被有意排除的原因', risk: 'low' },
  { id: 'workspace.record_deliberation', description: '批量提交 focus + assessment + exclusion', risk: 'low' },
  { id: 'workspace.consider_hypotheses', description: '显式认领 patient-level hypothesis（leading/alternative）', risk: 'low' },
];
export const BASELINE_TOOL_IDS: string[] = PLATFORM_TOOLS.map((t) => t.id);
export const CLASSIC_BASELINE_TOOL_IDS: string[] = BASELINE_TOOL_IDS.filter((id) => id !== 'knowledge.get_source');
export const BASELINE_KNOWLEDGE_SCOPES: string[] = ['general'];

/** 平台级 baseline skills：不依赖任何业务 capability，随 harness.baseline 注入。 */
export const BASELINE_SKILL_IDS: string[] = ['tcm-clinical-cognition'];
