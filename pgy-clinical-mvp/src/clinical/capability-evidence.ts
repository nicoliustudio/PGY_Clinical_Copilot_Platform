import type { ResolvedCapability } from '../contracts/capability.js';
import type {
  CapabilityEvidenceClosure,
  CapabilityEvidenceReceipt,
  ClinicalWorkspace,
} from '../contracts/workspace.js';

/**
 * H15.7/H15.8 Capability Evidence Obligation —— 通用治疗证据闭环（metadata 驱动，obligation-level）。
 *
 * 核心不变式：
 * - Capability Activated ≠ Evidence Acquired ≠ Completion Satisfied。
 * - 只有声明了 `evidenceObligations` 的 capability（治疗交付型）在激活后才产生 obligation；
 *   辅助推理能力不声明该字段 → 不产生 obligation。
 * - 一个 capability 可声明多个 obligation；readiness 按 obligation 粒度（capabilityEvidence:<capabilityId>:<obligationId>）分别验证。
 * - obligation 的 closure 必须来自真实 retrieval/hydration receipt，不由模型声明。
 * - NOT_APPLICABLE 为保留态：当前 Runtime 无合法 invalidation producer，本模块永不产出它（避免「没搜/没结果」被伪装成「不适用」）。
 * - Decision Authority 与 Evidence Closure 正交：取得证据 ≠ 获得处方权。
 */

/** readiness 使用的 obligation-level artifact key（capabilityEvidence:<capabilityId>:<obligationId>）。 */
export function evidenceArtifactKey(capabilityId: string, obligationId: string): string {
  return `capabilityEvidence:${capabilityId}:${obligationId}`;
}

/** 解析 obligation-level artifact key → { capabilityId, obligationId }。 */
export function parseEvidenceArtifactKey(artifact: string): { capabilityId: string; obligationId: string } | null {
  if (!artifact.startsWith('capabilityEvidence:')) return null;
  const rest = artifact.slice('capabilityEvidence:'.length);
  const idx = rest.lastIndexOf(':');
  if (idx <= 0) return null;
  return { capabilityId: rest.slice(0, idx), obligationId: rest.slice(idx + 1) };
}

/** 当前已激活且声明了证据义务的 capability → readiness 必须验证的 artifact keys（obligation 粒度）。 */
export function deriveRequiredEvidenceArtifacts(capabilities: ResolvedCapability[]): string[] {
  const keys: string[] = [];
  for (const c of capabilities) {
    for (const ob of c.evidenceObligations ?? []) {
      keys.push(evidenceArtifactKey(c.id, ob.id));
    }
  }
  return keys;
}

/** Runtime 拥有的 discovery receipt（确定性；discovery 工具执行后记录，按 scope + toolId 归组）。 */
export function recordSearchReceipt(
  workspace: ClinicalWorkspace,
  scopes: string[],
  cards: Array<{ activation_scope?: string | null; asset_id: string }>,
  toolId = 'knowledge.search_cards',
): void {
  const receipts = (workspace.capabilityEvidenceReceipts ??= {});
  // 确保所有 active scope 都有一个 discovery 记录（即使 0 结果，证明「搜过」）。
  for (const scope of scopes) {
    const r = (receipts[scope] ??= { scope, discoveryByTool: {}, hydrationByTool: {} });
    if (!r.discoveryByTool[toolId]) r.discoveryByTool[toolId] = [];
  }
  for (const card of cards) {
    const scope = card.activation_scope;
    if (!scope) continue;
    const r = (receipts[scope] ??= { scope, discoveryByTool: {}, hydrationByTool: {} });
    const bucket = (r.discoveryByTool[toolId] ??= []);
    if (!bucket.includes(card.asset_id)) bucket.push(card.asset_id);
  }
}

/** Runtime 拥有的 hydration receipt（确定性；hydration 工具成功后记录，按 scope + toolId 归组）。 */
export function recordHydrationReceipt(
  workspace: ClinicalWorkspace,
  assetId: string,
  scope: string,
  toolId = 'knowledge.get_asset',
): void {
  const receipts = (workspace.capabilityEvidenceReceipts ??= {});
  const r = (receipts[scope] ??= { scope, discoveryByTool: {}, hydrationByTool: {} });
  const bucket = (r.hydrationByTool[toolId] ??= []);
  if (!bucket.includes(assetId)) bucket.push(assetId);
}

/**
 * 由 receipt 投影 obligation-level closure（纯函数，terminal 状态）。
 * - 已水合 ≥1 资产 → EVIDENCE_ACQUIRED（hydration 是最强信号，隐含资产已发现）。
 * - discovery 已执行且 0 结果 → SEARCHED_NONE（真正的「搜了但无结果」）。
 * - 未搜索，或「已发现候选但未水合」→ 不产生 closure（readiness 视为未满足）。
 * - NOT_APPLICABLE 永不产出（保留态；无合法 invalidation producer）。
 *
 * 每个 obligation 独立投影；一个 capability 多个 obligation 得到多个 closure。
 */
export function deriveCapabilityEvidenceClosures(
  capabilities: ResolvedCapability[],
  receipts: Record<string, CapabilityEvidenceReceipt> | undefined,
): CapabilityEvidenceClosure[] {
  const out: CapabilityEvidenceClosure[] = [];
  for (const c of capabilities) {
    for (const obligation of c.evidenceObligations ?? []) {
      let discoveryExecuted = false;
      let returnedCount = 0;
      const hydrated = new Set<string>();

      for (const scope of c.knowledgeScopes ?? []) {
        const r = receipts?.[scope];
        if (!r) continue;
        for (const toolId of obligation.discoveryToolIds ?? []) {
          const assetIds = r.discoveryByTool[toolId];
          if (assetIds !== undefined) {
            discoveryExecuted = true;
            returnedCount += assetIds.length;
          }
        }
        for (const toolId of obligation.hydrationToolIds ?? []) {
          for (const id of r.hydrationByTool[toolId] ?? []) hydrated.add(id);
        }
      }

      if (hydrated.size > 0) {
        out.push({
          capabilityId: c.id,
          obligationId: obligation.id,
          status: 'EVIDENCE_ACQUIRED',
          assetRefs: [...hydrated],
          searched: true,
          retrievalSurface: obligation.discoveryToolIds.join(','),
        });
      } else if (discoveryExecuted && returnedCount === 0) {
        out.push({
          capabilityId: c.id,
          obligationId: obligation.id,
          status: 'SEARCHED_NONE',
          assetRefs: [],
          searched: true,
          retrievalSurface: obligation.discoveryToolIds.join(','),
          reason: 'searched but no qualified assets found',
        });
      }
      // 已发现候选但未水合 / 未搜索 → 不产生 closure（not ready）。
    }
  }
  return out;
}

/** readiness 判断：一个 required capabilityEvidence artifact 是否已有合法 terminal closure。 */
export function isEvidenceClosureTerminal(closure: CapabilityEvidenceClosure | undefined): boolean {
  return closure !== undefined
    && (closure.status === 'EVIDENCE_ACQUIRED' || closure.status === 'SEARCHED_NONE' || closure.status === 'NOT_APPLICABLE');
}
