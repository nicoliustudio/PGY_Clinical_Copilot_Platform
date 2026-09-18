import type {
  ClinicalWorkspace,
  HypothesisProjection,
  PromotionWorkItem,
  WorkspaceEventType,
} from '../../contracts/workspace.js';

export const HYPOTHESIS_EVENT_TYPES: WorkspaceEventType[] = [
  'hypothesis.presented',
  'hypothesis.supported',
  'hypothesis.challenged',
  'hypothesis.selected',
  'hypothesis.rejected',
  'hypothesis.promotion.requested',
  'hypothesis.promotion.resolved',
];

/**
 * 将 Agent 持有的 opaque promotionWorkItemRef 确定性解析为真实 PromotionWorkItem。
 * Agent 只负责“我要处理哪个 hypothesis”，Harness 负责“这个 hypothesis 的真实 identity 是什么”。
 * 传入不存在的 ref 会抛错，禁止 LLM 自行拼装 hypothesis id 数组。
 */
export function resolveWorkItemRef(
  workspace: ClinicalWorkspace,
  workItemRef: string | undefined,
): PromotionWorkItem | null {
  if (workItemRef === undefined || workItemRef === '') return null;
  const item = workspace.promotionState.workItems.find((w) => w.id === workItemRef);
  if (!item) throw new Error(`invalid promotionWorkItemRef: ${workItemRef}`);
  return item;
}

/** Agent-facing hypothesis coverage: leading + active alternatives + open promotion work items + information gaps. */
export function buildHypothesisProjection(workspace: ClinicalWorkspace): HypothesisProjection {
  const hypotheses = workspace.hypothesisState.hypotheses;
  const leading = hypotheses.find((h) => h.status === 'active') ?? hypotheses[0] ?? null;
  const alternatives = hypotheses.filter((h) => h !== leading && h.status !== 'rejected');
  const openWorkItems = workspace.promotionState.workItems.filter((w) => w.status === 'open');
  return {
    leading: leading ? { ...leading } : null,
    alternatives: alternatives.map((h) => ({ ...h })),
    informationGaps: workspace.informationGaps,
    promotionWorkItems: openWorkItems.map((w) => ({ ...w })),
  };
}
