/**
 * Pure source-shape normalization helpers.
 *
 * These functions intentionally have no config/model/runtime dependencies so source fidelity can
 * be verified deterministically and independently from the embedding/index pipeline.
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const EMPTY_MODIFICATION_MARKERS = new Set(['none', 'null', 'nil', '无', '无加减', '暂无', '-']);

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


export interface InlineModificationSplit {
  composition: string;
  modifications: string[];
  presence: 'PRESENT' | 'KNOWN_EMPTY' | 'UNKNOWN';
}

/**
 * Split formula-local inline modification text from a complete raw composition.
 *
 * This is source normalization, not clinical inference: we only recognize an explicit `加减:` / `加减：`
 * delimiter that already exists in the source text. When a complete raw composition is available and no
 * inline delimiter exists, formula-local modification is KNOWN_EMPTY for that composition field. When the
 * raw field itself is unavailable, the state remains UNKNOWN.
 */
export function splitInlineFormulaModification(rawComposition: unknown): InlineModificationSplit {
  if (typeof rawComposition !== 'string') {
    return { composition: '', modifications: [], presence: 'UNKNOWN' };
  }
  const raw = rawComposition.trim();
  if (!raw) return { composition: '', modifications: [], presence: 'KNOWN_EMPTY' };

  const match = /(?:^|[。；;\n])\s*加减\s*[:：]\s*/.exec(raw);
  if (!match || match.index === undefined) {
    return { composition: raw.replace(/[。；;\s]+$/g, ''), modifications: [], presence: 'KNOWN_EMPTY' };
  }

  const delimiterStart = match.index;
  const delimiterEnd = delimiterStart + match[0].length;
  const composition = raw.slice(0, delimiterStart).replace(/[。；;\s]+$/g, '').trim();
  const modificationText = raw.slice(delimiterEnd).replace(/[。；;\s]+$/g, '').trim();
  const modifications = normalizeSourceModificationList(modificationText);
  return {
    composition,
    modifications,
    presence: modifications.length > 0 ? 'PRESENT' : 'KNOWN_EMPTY',
  };
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
    if (!text || EMPTY_MODIFICATION_MARKERS.has(text.toLowerCase())) return;
    if (!out.includes(text)) out.push(text);
  };
  for (const value of values) push(value);
  return out;
}
