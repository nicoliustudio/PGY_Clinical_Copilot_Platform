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


/** Generic source text-list normalization. It preserves authored strings and never infers semantics. */
export function normalizeSourceTextList(...values: unknown[]): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (text && !out.includes(text)) out.push(text);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    for (const key of ['text', 'statement', 'instruction', 'raw']) {
      const candidate = obj[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        const text = candidate.trim();
        if (!out.includes(text)) out.push(text);
        return;
      }
    }
  };
  for (const value of values) push(value);
  return out;
}

export interface NormalizedSequenceStep {
  order: number;
  instruction: string;
  stage?: string;
  condition?: string;
  transition?: string;
}

/**
 * Normalize an already-structured sequence field. Strings become ordered source instructions;
 * objects preserve explicit stage/condition/transition keys. This never parses composition prose.
 */
export function normalizeSourceSequence(value: unknown): NormalizedSequenceStep[] {
  const items = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const out: NormalizedSequenceStep[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const instruction = item.trim();
      if (instruction) out.push({ order: out.length + 1, instruction });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const instruction = [obj.instruction, obj.text, obj.statement]
      .find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
    if (!instruction) continue;
    const order = typeof obj.order === 'number' && Number.isFinite(obj.order) ? obj.order : out.length + 1;
    const optional = (key: string) => typeof obj[key] === 'string' && (obj[key] as string).trim() ? (obj[key] as string).trim() : undefined;
    out.push({
      order,
      instruction: instruction.trim(),
      ...(optional('stage') ? { stage: optional('stage') } : {}),
      ...(optional('condition') ? { condition: optional('condition') } : {}),
      ...(optional('transition') ? { transition: optional('transition') } : {}),
    });
  }
  return out.sort((a, b) => a.order - b.order);
}
