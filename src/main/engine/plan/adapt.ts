import { projectAcwr, type DailyLoadPoint } from '../acwr';
import { addDays, eachDay } from '../../util/dates';
import { easyVersion, restSession } from './library';
import { PLAN } from './generate';
import { dayName } from './validate';
import type { PlanSession, SessionStatus } from './types';

/**
 * Adaptation rules (coaching-engine.md §7). Pure: they propose changes; the
 * plan service applies them and writes the plan_changes log.
 */

export type StoredSession = PlanSession & { id: number; status: SessionStatus };

const active = (s: StoredSession) => s.status !== 'skipped' && s.status !== 'moved';

/* ---------- 1. Readiness today: always a suggestion, never applied silently ---------- */

export interface SuggestionChange {
  sessionId: number;
  after: PlanSession;
}

export interface Suggestion {
  date: string;
  kind: 'readiness_rest' | 'readiness_easy';
  reason: string;
  changes: SuggestionChange[];
}

export function readinessSuggestion(date: string, verdict: 'go' | 'easy' | 'rest', why: string, sessions: StoredSession[]): Suggestion | null {
  const today = sessions.filter((s) => s.date === date && active(s) && s.status === 'planned' && !s.fixed && s.sessionKey !== 'rest' && s.sessionKey !== 'race');
  if (verdict === 'rest') {
    if (!today.length) return null;
    return {
      date,
      kind: 'readiness_rest',
      reason: `Readiness says rest: ${why}`,
      changes: today.map((s) => ({
        sessionId: s.id,
        after: restSession(date, s.slot, `Swapped for rest (readiness). If you want to move, keep it under 30 min and very easy.`),
      })),
    };
  }
  if (verdict === 'easy') {
    const keys = today.filter((s) => s.isKey);
    if (!keys.length) return null;
    return {
      date,
      kind: 'readiness_easy',
      reason: `Readiness says keep it easy: ${why}`,
      changes: keys.map((s) => ({ sessionId: s.id, after: easyVersion(s, 0.7, 'Made easy (readiness).') })),
    };
  }
  return null;
}

/* ---------- 2. Missed key session: move it if a safe slot exists, else drop ---------- */

export type MissedResolution =
  | { kind: 'move'; sessionId: number; toDate: string; replaceIds: number[]; acwr: number | null; reason: string }
  | { kind: 'drop'; sessionId: number; reason: string };

export function resolveMissedKey(missed: StoredSession, week: StoredSession[], today: string, lastPoint: DailyLoadPoint | null): MissedResolution {
  const sunday = addDays(missed.date, 6 - ((new Date(`${missed.date}T00:00:00Z`).getUTCDay() + 6) % 7));
  const others = week.filter((s) => s.id !== missed.id && active(s));
  const isKeyDay = (d: string) => others.some((s) => s.date === d && s.isKey);
  const label = `${dayName(missed.date)}'s ${missed.title.toLowerCase()}`;

  type Candidate = { date: string; replace: StoredSession[]; restDay: boolean; load: number; acwr: number | null };
  const candidates: Candidate[] = [];
  for (const d of today <= sunday ? eachDay(today, sunday) : []) {
    const day = others.filter((s) => s.date === d);
    if (day.some((s) => s.fixed)) continue; // commute days stay commute days
    if (day.some((s) => s.isKey || s.sessionKey === 'race')) continue; // never stack on a hard day
    if (day.some((s) => s.status === 'done' || s.status === 'partial')) continue; // already trained that day
    if (isKeyDay(addDays(d, -1)) || isKeyDay(addDays(d, 1))) continue; // no back-to-back hard days

    const replace = day.filter((s) => s.sessionKey !== 'rest');
    const loads = eachDay(today, sunday).map((date) => ({
      date,
      load:
        date === d
          ? missed.estLoad
          : others.filter((s) => s.date === date && s.status === 'planned').reduce((a, s) => a + s.estLoad, 0),
    }));
    const proj = lastPoint ? projectAcwr(lastPoint, loads) : [];
    const maxAcwr = proj.reduce<number | null>((m, p) => (p.acwr == null ? m : Math.max(m ?? 0, p.acwr)), null);
    if (maxAcwr != null && maxAcwr > PLAN.sundayAcwrMax) continue;
    candidates.push({ date: d, replace, restDay: replace.length === 0, load: replace.reduce((a, s) => a + s.estLoad, 0), acwr: maxAcwr });
  }

  // Prefer a rest day, then the lightest day, then the earliest.
  candidates.sort((a, b) => Number(b.restDay) - Number(a.restDay) || a.load - b.load || a.date.localeCompare(b.date));
  const best = candidates[0];
  if (!best) {
    return { kind: 'drop', sessionId: missed.id, reason: `Dropped ${label}: no day left this week where it fits without two hard days in a row or too big a jump in load.` };
  }
  const ratio = best.acwr != null ? ` and keeps your load ratio at ${best.acwr.toFixed(2)}` : '';
  const instead = best.replace.length ? ` (instead of ${best.replace.map((s) => s.title.toLowerCase()).join(' and ')})` : '';
  return {
    kind: 'move',
    sessionId: missed.id,
    toDate: best.date,
    replaceIds: best.replace.map((s) => s.id),
    acwr: best.acwr,
    reason: `Moved ${label} to ${dayName(best.date)}${instead} — you missed it, and ${dayName(best.date)} has room for it${ratio}.`,
  };
}
