/**
 * Pure source-shape normalization helpers.
 *
 * These functions intentionally have no config/model/runtime dependencies so source fidelity can
 * be verified deterministically and independently from the embedding/index pipeline.
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function modificationText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  for (const key of ['text', 'statement', 'rule', 'raw']) {
    const candidate = obj[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const trigger = str(obj.trigger).trim();
  const medication = str(obj.medication).trim();
  const dose = str(obj.dose).trim();
  const action = str(obj.action).trim();
  const rhs = [medication, dose].filter(Boolean).join('');
  if (trigger && rhs) return `${trigger}：${action || '加减'}${rhs}`;
  if (trigger) return trigger;
  if (rhs) return `${action || '加减'}${rhs}`;
  return '';
}

/** Preserve source-authored modification statements without model rewriting or semantic inference. */
export function normalizeSourceModificationList(...values: unknown[]): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const text = modificationText(value);
    if (text && !out.includes(text)) out.push(text);
  };
  for (const value of values) push(value);
  return out;
}
