import type { CommitRecord } from '../../contracts/commit.js';

export interface ReasoningSummary {
  disease?: unknown;
  syndrome?: unknown;
  treatmentText?: string;
  missingInformation?: readonly string[];
}

export interface ProjectedDelivery {
  commit_id: string;
  outcome: string;
  semantic_identity: string;
  provider_id: string;
  delivery_status: string;
  execution_clearance: string;
  provenance: CommitRecord['provenance'];
  source_bundle?: CommitRecord['sourceBundle'];
  product: CommitRecord['product'];
}

/**
 * Final projection never fabricates a product.
 * 没有 committed product 就没有 product；兼容视图只能从 committed records 派生。
 */
export function projectClinicalResult(
  summary: ReasoningSummary,
  records: readonly CommitRecord[],
) {
  return {
    mode: 'clinical' as const,
    status: 'COMPLETED' as const,
    disease: summary.disease,
    syndrome: summary.syndrome,
    treatment: summary.treatmentText,
    deliveries: records.map((record): ProjectedDelivery => ({
      commit_id: record.commitId,
      outcome: record.outcome,
      semantic_identity: record.semanticIdentity,
      provider_id: record.providerId,
      delivery_status: record.deliveryStatus,
      execution_clearance: record.executionClearance,
      provenance: record.provenance,
      ...(record.sourceBundle ? { source_bundle: record.sourceBundle } : {}),
      product: record.product,
    })),
    missing_information: [...(summary.missingInformation ?? [])],
  };
}
