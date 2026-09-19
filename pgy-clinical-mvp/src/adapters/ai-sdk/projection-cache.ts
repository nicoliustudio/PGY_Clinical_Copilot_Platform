import type { ClinicalStrategy } from '../../contracts/clinical-strategy.js';
import type { ClinicalWorkspace, DecisionState } from '../../contracts/workspace.js';
import { buildDecisionState } from '../../platform/workspace/decision-state-projection.js';

/**
 * H10 Projection Reuse —— 基于 workspace version 的 deterministic projection cache。
 *
 * - Workspace version 未变化 → 复用缓存的 DecisionState，不重新计算。
 * - Workspace version 变化 → 必须重新 projection（禁止复用 stale 状态）。
 *
 * 每个 run 持有独立实例（不跨 run 共享），cache key 即 workspace version；
 * strategy 在单 run 内冻结，故无需 strategyVersion 维度。
 */
export interface ProjectionCacheMetrics {
  projectionWithStateChange: number;
  projectionWithoutStateChange: number;
  projectionReuseCount: number;
}

export class ProjectionCache {
  private lastVersion: number | undefined;
  private cached: DecisionState | undefined;
  private withStateChange = 0;
  private withoutStateChange = 0;
  private reuseCount = 0;

  getDecisionState(
    version: number,
    workspace: ClinicalWorkspace,
    strategy: ClinicalStrategy,
  ): { decisionState: DecisionState; reused: boolean } {
    if (this.lastVersion === version && this.cached) {
      this.withoutStateChange += 1;
      this.reuseCount += 1;
      return { decisionState: this.cached, reused: true };
    }
    this.withStateChange += 1;
    this.cached = buildDecisionState(workspace, strategy);
    this.lastVersion = version;
    return { decisionState: this.cached, reused: false };
  }

  metrics(): ProjectionCacheMetrics {
    return {
      projectionWithStateChange: this.withStateChange,
      projectionWithoutStateChange: this.withoutStateChange,
      projectionReuseCount: this.reuseCount,
    };
  }
}
