/**
 * Expected tool-contract failures are data, not exceptions.
 *
 * A deterministic validator knows exactly why an Agent action is illegal. That information must
 * survive the tool boundary so the Agent can repair the offending field without deleting unrelated
 * already-formed facts. Unexpected programmer/runtime failures may still throw.
 */
export type ToolFailureCode =
  | 'INVALID_SEMANTIC_IDENTITY'
  | 'UNKNOWN_CANDIDATE_REF'
  | 'UNKNOWN_HYPOTHESIS_REF'
  | 'INVALID_EVIDENCE_REF'
  | 'ILLEGAL_MUTATION_PHASE'
  | 'PRODUCT_OUTCOME_NOT_ADOPTED'
  | 'OUTCOME_EXCLUDED'
  | 'EXCLUSIVE_CONTRACT_VIOLATION'
  | 'UNSUPPORTED_OUTCOME'
  | 'AMBIGUOUS_PROVIDER'
  | 'DELIVERY_NOT_RUNNABLE'
  | 'MISSING_REQUIRED_FIELDS'
  | 'NO_PROVIDER'
  | 'UNKNOWN_HANDLE'
  | 'IDENTITY_MISMATCH'
  | 'SOURCE_BINDING_MISMATCH'
  | 'CANONICAL_HYDRATION_FAILED'
  | 'SAFETY_BLOCKED'
  | 'CONTROL_PLANE_UNAVAILABLE'
  | 'VALIDATION_FAILED';

export interface ToolFailureDetail {
  code: ToolFailureCode | string;
  message: string;
  path?: string;
  received?: unknown;
  expected?: unknown;
  outcome?: string;
  artifact?: string;
  reason?: string;
  allowedNextActions?: string[];
  details?: unknown;
}

export interface ToolFailureOutput {
  ok: false;
  error: ToolFailureDetail;
}

export function toolFailure(
  code: ToolFailureDetail['code'],
  message: string,
  detail: Omit<ToolFailureDetail, 'code' | 'message'> = {},
): ToolFailureOutput {
  return { ok: false, error: { code, message, ...detail } };
}

export function isToolFailureOutput(value: unknown): value is ToolFailureOutput {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== false || !record.error || typeof record.error !== 'object') return false;
  const error = record.error as Record<string, unknown>;
  return typeof error.code === 'string' && typeof error.message === 'string';
}

/** Throw only inside adapter validators; the Agent tool wrapper converts this to ToolFailureOutput. */
export class ToolContractError extends Error {
  readonly failure: ToolFailureOutput;

  constructor(failure: ToolFailureOutput) {
    super(failure.error.message);
    this.name = 'ToolContractError';
    this.failure = failure;
  }
}

export function toolContractError(
  code: ToolFailureDetail['code'],
  message: string,
  detail: Omit<ToolFailureDetail, 'code' | 'message'> = {},
): ToolContractError {
  return new ToolContractError(toolFailure(code, message, detail));
}

/** JSON-safe representation for genuinely unexpected exceptions in trace/audit surfaces. */
export function serializeToolError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    } catch {
      return { message: String(error) };
    }
  }
  return { message: String(error) };
}
