import type { CaseFact, TemporalRole } from '../contracts/workspace.js';
import type { FactCandidate } from './understanding.js';

/**
 * Closed-world temporal normalization for explicit calendar dates only.
 * This parser does NOT infer clinical meaning from disease/symptom keywords. Its sole authority is
 * temporal consistency: an explicitly dated past event cannot remain `current` merely because an
 * LLM emitted that role. Open-world relative expressions are preserved for downstream reasoning.
 */
function explicitCalendarDate(text: string): string | undefined {
  const iso = /(?:^|\D)(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\D|$)/.exec(text);
  const zh = /(?:^|\D)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日?/.exec(text);
  const m = iso ?? zh;
  if (!m) return undefined;
  const y = Number(m[1]); const month = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, month - 1, d));
  if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function calendarDay(iso: string): number | undefined {
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) ? undefined : Math.floor(dt.getTime() / 86_400_000);
}

export function normalizeTemporalRole(
  reported: TemporalRole | undefined,
  eventTime: string | undefined,
  observedAt: Date,
): { temporalRole?: TemporalRole; reportedTemporalRole?: TemporalRole } {
  if (!eventTime) return { temporalRole: reported };
  const eventDay = calendarDay(eventTime);
  const observedDay = Math.floor(Date.UTC(observedAt.getUTCFullYear(), observedAt.getUTCMonth(), observedAt.getUTCDate()) / 86_400_000);
  if (eventDay === undefined) return { temporalRole: reported };
  // Preserve semantic phase roles. They already carry stronger information than current/historical.
  if (reported === 'post_treatment' || reported === 'baseline') return { temporalRole: reported };
  if (eventDay < observedDay && (reported === 'current' || reported === 'uncertain_time' || reported === undefined)) {
    return { temporalRole: 'historical', reportedTemporalRole: reported };
  }
  if (eventDay > observedDay) {
    return { temporalRole: 'uncertain_time', reportedTemporalRole: reported };
  }
  return { temporalRole: reported ?? 'current' };
}

export function normalizeCaseFacts(facts: FactCandidate[], observedAt = new Date()): CaseFact[] {
  const observedAtIso = observedAt.toISOString();
  return facts.map((fact, i) => {
    const sourceText = [fact.source, fact.value].filter((x): x is string => typeof x === 'string').join(' ');
    // Treat model-provided eventTime as evidence, not authority: canonicalize it with the same
    // closed-world calendar parser used for source text. Invalid/free-form values are not promoted.
    const eventTime = (fact.eventTime ? explicitCalendarDate(fact.eventTime) : undefined) ?? explicitCalendarDate(sourceText);
    const normalized = normalizeTemporalRole(fact.temporalRole, eventTime, observedAt);
    return {
      id: `CF_${String(i + 1).padStart(3, '0')}`,
      kind: fact.kind,
      value: fact.value,
      source: fact.source,
      evidenceKind: 'patient',
      temporalRole: normalized.temporalRole,
      polarity: fact.polarity,
      observedAt: observedAtIso,
      eventTime,
      relativeTimeExpression: fact.relativeTimeExpression,
      ...(normalized.reportedTemporalRole !== undefined && normalized.reportedTemporalRole !== normalized.temporalRole
        ? { reportedTemporalRole: normalized.reportedTemporalRole }
        : {}),
    };
  });
}
