import type { ControlPlanePolicyV21 } from '../control-plane-v21/types.js';

/**
 * Product composition policy, intentionally outside the generic planner.
 * Product baseline for this TCM copilot: clinical assessment + source-supported herbal treatment.
 * Planner suppresses baseline modality outcomes when the user explicitly requires another modality
 * or explicitly excludes that baseline modality; the planner remains business-name agnostic.
 */
export const CONTROL_PLANE_V21_POLICY: ControlPlanePolicyV21 = {
  baselineOutcomes: ['outcome:clinical-assessment', 'modality:herbal-formula'],

  /**
   * V2.1.2：参数化完成要求。
   *
   * 「至少 N 个合格方」不是一个公式专用流程，而是一条 artifact 级 postcondition：
   * `count(eligible artifacts in <collection>) >= N`。N 只来自 Request IR，
   * 因此把 3 改成 5 不需要改 planner；新增另一种「需要 N 个合格产物」的交付只加一条声明。
   */
  completionRequirements: [
    {
      artifactType: 'artifact:formula-selection',
      collection: 'eligibleSourceFormulas',
      minimum: (ir) => (ir.outputPolicy.formulaCardinality.mode === 'AT_LEAST'
        ? ir.outputPolicy.formulaCardinality.count
        : undefined),
    },
  ],

  /**
   * V2.1.2：通用 provenance fallback。
   * KB 路径到达 typed insufficiency（这是 adapter 从 durable state 判定的）且 Request IR 的生成策略
   * 恰好等于 requiresPolicy 时，才产生 model-generation 义务；否则该 artifact 只能合法终止为
   * NOT_DELIVERABLE 并显式报告不足，不得假装满足。
   */
  generationFallback: {
    artifactTypes: ['artifact:formula-selection'],
    requiresPolicy: 'MODEL_ALLOWED',
    provenance: 'MODEL_GENERATED',
  },
};
