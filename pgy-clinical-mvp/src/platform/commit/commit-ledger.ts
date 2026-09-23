import { randomUUID } from 'node:crypto';
import type { CommitId, CommitRecord } from '../../contracts/commit.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Kernel-owned append-only authoritative delivery truth.
 * 下游只能读取/验证/投影，不能改写或删除已 commit 的记录。
 */
export class CommitLedger {
  private readonly records: CommitRecord[] = [];

  append(input: Omit<CommitRecord, 'commitId' | 'committedAt'>): CommitRecord {
    const record = deepFreeze({
      ...input,
      commitId: `commit_${randomUUID()}` as CommitId,
      committedAt: new Date().toISOString(),
    });
    this.records.push(record);
    return record;
  }

  all(): readonly CommitRecord[] {
    return this.records;
  }

  forOutcome(outcome: string): readonly CommitRecord[] {
    return this.records.filter((record) => record.outcome === outcome);
  }

  delivered(outcome: string): readonly CommitRecord[] {
    return this.forOutcome(outcome).filter((record) => record.deliveryStatus === 'DELIVERED');
  }
}
