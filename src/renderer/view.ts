import type { PlanSessionView, ReadinessDay, ReadinessFactor, TimelineView } from '../shared/api';
import { daysBetween } from '../shared/format';

/**
 * Pure view-model helpers for the pages (tested in tests/view.test.ts).
 * No React, no window access.
 */

export const VERDICT_WORD: Record<ReadinessDay['verdict'], string> = { go: 'Go', easy: 'Keep it easy', rest: 'Rest' };

const FACTOR_PHRASE: Record<string, { amber: string; red: string }> = {
  hrv: { amber: 'HRV is under your normal range', red: 'HRV has been low for several nights' },
  resting_hr: { amber: 'resting HR is up', red: 'resting HR is well up' },
  sleep: { amber: 'sleep was short or light', red: 'sleep was very short or poor' },
  body_battery: { amber: 'Body Battery is low', red: 'Body Battery is very low' },
  acwr: { amber: 'your load is ramping quickly', red: 'your load has jumped a lot' },
  yesterday_load: { amber: 'yesterday was bigger than a usual day', red: 'yesterday was a very big day' },
};

export const FACTOR_LABEL: Record<string, string> = {
  hrv: 'HRV',
  resting_hr: 'Resting HR',
  sleep: 'Sleep',
  body_battery: 'Body Battery',
  acwr: 'Load ratio',
  yesterday_load: 'Yesterday',
};

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One plain sentence for the readiness hero, built from the factor statuses. */
export function readinessSentence(day: ReadinessDay): string {
  const flagged = day.factors.filter((f) => f.status === 'amber' || f.status === 'red');
  const missing = day.factors.filter((f) => f.status === 'missing').length;
  if (day.verdict === 'easy' && !flagged.length && missing >= 3) return "Not enough data from last night, so keep today easy to be safe.";
  if (!flagged.length) return missing ? 'Everything we can see looks normal.' : 'Everything looks normal.';
  const phrases = flagged.map((f) => FACTOR_PHRASE[f.key]?.[f.status as 'amber' | 'red'] ?? f.reason.replace(/\.$/, ''));
  const rest = day.factors.length - flagged.length - missing;
  const tail = rest > 0 ? ' Everything else looks fine.' : '';
  if (day.verdict === 'go') return `Good to go, but ${joinAnd(phrases)}.${tail}`;
  return `${cap(joinAnd(phrases))}.${tail}`;
}

/** The number shown on a factor row. */
export function factorValue(f: ReadinessFactor): string {
  if (f.status === 'missing' && f.value == null) return '—';
  if (f.key === 'yesterday_load') {
    const m = /(\d+(?:\.\d+)?)×/.exec(f.reason);
    if (m) return `${m[1]}×`;
    return f.value != null ? String(Math.round(f.value)) : '—';
  }
  if (f.key === 'acwr') return f.value != null ? f.value.toFixed(2) : '—';
  if (f.key === 'sleep' && f.value != null && f.value < 24) return `${f.value.toFixed(1)} h`;
  return f.value != null ? String(Math.round(f.value)) : '—';
}

export type PillState = 'done' | 'planned' | 'missed' | 'rest' | 'skipped';

/** How a planned session shows in the week strip. */
export function pillState(s: PlanSessionView): PillState {
  if (s.sport === 'rest') return 'rest';
  if (s.status === 'done' || s.status === 'partial') return 'done';
  if (s.status === 'missed') return 'missed';
  if (s.status === 'skipped' || s.status === 'moved') return 'skipped';
  return 'planned';
}

/** Sessions that count for a day (moved-away and skipped ones don't). */
export const activeSessions = (sessions: PlanSessionView[]) => sessions.filter((s) => s.status !== 'moved' && s.status !== 'skipped');

/** Today's main session (key first) and the rest. */
export function todaysSessions(sessions: PlanSessionView[], today: string): { main: PlanSessionView | null; later: PlanSessionView[] } {
  const list = activeSessions(sessions).filter((s) => s.date === today && s.sport !== 'rest');
  const main = list.find((s) => s.isKey) ?? list[0] ?? null;
  return { main, later: list.filter((s) => s !== main) };
}

export interface PhaseBar {
  phase: string;
  days: number;
  state: 'past' | 'now' | 'future';
}

/** Phase segments from the start of the timeline up to a race, for the race tile. */
export function phaseBars(t: TimelineView, raceDate: string): PhaseBar[] {
  const out: PhaseBar[] = [];
  for (const s of t.segments) {
    if (s.from > raceDate) break;
    const to = s.to > raceDate ? raceDate : s.to;
    const days = daysBetween(s.from, to) + 1;
    if (s.phase === 'recovery' || s.phase === 'maintain') continue;
    const state: PhaseBar['state'] = to < t.today ? 'past' : s.from <= t.today ? 'now' : 'future';
    const last = out.at(-1);
    if (last && last.phase === s.phase) last.days += days;
    else out.push({ phase: s.phase, days, state });
  }
  return out;
}

/** Week totals by sport: seconds this week vs last week (for the Week page bars). */
export function sportTotals(
  thisWeek: Array<{ sport: string; durationMin: number | null; distanceKm: number | null; isCommute: boolean }>,
  lastWeek: Array<{ sport: string; durationMin: number | null }>,
  planned: PlanSessionView[],
): Array<{ sport: string; minutes: number; lastMinutes: number; plannedMinutes: number; distanceKm: number }> {
  const sports = ['swim', 'bike', 'run', 'strength', 'other'];
  return sports
    .map((sport) => ({
      sport,
      minutes: Math.round(thisWeek.filter((a) => a.sport === sport).reduce((s, a) => s + (a.durationMin ?? 0), 0)),
      lastMinutes: Math.round(lastWeek.filter((a) => a.sport === sport).reduce((s, a) => s + (a.durationMin ?? 0), 0)),
      plannedMinutes: Math.round(activeSessions(planned).filter((p) => p.sport === sport).reduce((s, p) => s + p.durationMin, 0)),
      distanceKm: thisWeek.filter((a) => a.sport === sport).reduce((s, a) => s + (a.distanceKm ?? 0), 0),
    }))
    .filter((r) => r.minutes || r.lastMinutes || r.plannedMinutes);
}

/** "5 of 9 sessions done · 4 h 50 of 7 h 30" */
export function weekProgress(sessions: PlanSessionView[], doneMinutes: number): { done: number; total: number; plannedMinutes: number; doneMinutes: number } {
  const list = activeSessions(sessions).filter((s) => s.sport !== 'rest');
  return {
    done: list.filter((s) => s.status === 'done' || s.status === 'partial').length,
    total: list.length,
    plannedMinutes: list.reduce((a, s) => a + s.durationMin, 0),
    doneMinutes,
  };
}
