import { randomUUID } from 'node:crypto';
import type { CandidateHandle } from '../../contracts/commit.js';

export interface CandidateTruth {
  kind: string;
  canonicalKey: string;
  sourceId?: string;
  productId?: string;
  /** Agent/候选携带的组成，供 commit 阶段做 canonical composition binding 校验（可空：card 级候选无组成）。 */
  composition?: string;
  provenanceKind: 'CANONICAL_SOURCE' | 'CASE_DERIVED' | 'MODEL_DERIVED';
}

/**
 * Agent-facing identity registry.
 *
 * Agent 只能持有 Kernel 签发的 opaque handle（cand_<uuid>）；内部 canonical key
 * （可能是 <sourceId>::<formulaId> 复合键）只能由 Kernel 保存与解析。
 * Agent 通过字符串拼接重建 canonical identity 不可能取得 authority。
 */
export class CandidateHandleRegistry {
  private readonly records = new Map<CandidateHandle, Readonly<CandidateTruth>>();

  issue(truth: CandidateTruth): CandidateHandle {
    const handle = `cand_${randomUUID()}` as CandidateHandle;
    this.records.set(handle, Object.freeze({ ...truth }));
    return handle;
  }

  resolve(handle: CandidateHandle): Readonly<CandidateTruth> | undefined {
    return this.records.get(handle);
  }

  has(handle: CandidateHandle): boolean {
    return this.records.has(handle);
  }
}
