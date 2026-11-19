import type { DB } from '../db';
import { nowIso } from '../db/util';
import { addDays } from '../util/dates';
import { clock, dayMonth, hoursMinutes, pace, weekdayShort } from '../../shared/format';
import { weekStartOf } from '../engine';
import type { ActivityDetail } from '../../shared/api';
import { TEMPLATE_VERSION, activityText, dailyText, type ActivityFacts, type DailyFacts, type WeekRecap, type ZoneKey } from './template';

/**
 * Builds facts objects from the database and returns cached summary text.
 * Text is regenerated only when the facts change (docs/ai-summary.md).
 */

export interface SummaryResult {
  text: string;
  source: 'llm' | 'template';
}

const KM = (m: number | null) => (m != null ? Math.round(m / 10) / 100 : undefined);

/** Typical training-day load over the 28 days before `date` (days with load only). */
function typicalDayLoad(db: DB, date: string): number | null {
  const r = db
    .prepare('SELECT AVG(load) a, COUNT(*) n FROM daily_metrics WHERE load > 0 AND local_date BETWEEN ? AND ?')
    .get(addDays(date, -28), addDays(date, -1)) as { a: number | null; n: number };
  return r.n >= 4 ? r.a : null;
}

export function loadCategory(load: number | null, typical: number | null): ActivityFacts['load']['this_session'] {
  const l = load ?? 0;
  if (typical && typical > 0) {
    const r = l / typical;
    return r < 0.6 ? 'light' : r < 1.2 ? 'moderate' : r < 2 ? 'hard' : 'very hard';
  }
  return l < 40 ? 'light' : l < 90 ? 'moderate' : l < 150 ? 'hard' : 'very hard';
}

type Detail = Omit<ActivityDetail, 'summary'>;

/**
 * Comparisons worth a sentence, most interesting first:
 *  1. fastest over this distance in 8 weeks (runs, pool swims, commutes)
 *  2. vs the last time at about this distance: faster/slower, or same pace at a lower/higher heart rate
 *  3. longest of this sport in 12 weeks
 */
export function comparisons(db: DB, d: Detail): string[] {
  const out: string[] = [];
  if (!d.distanceM || d.distanceM < 400) return out;
  const secs = d.movingS ?? d.durationS;
  const isRun = d.sport === 'run';
  const isSwim = d.sport === 'swim' && !d.isOpenWater;
  const isRide = d.sport === 'bike';

  // Pace in "seconds per unit" (lower is better) so runs, swims and rides compare the same way.
  type Row = { p: number | null; hr: number | null; date: string; dist: number };
  const mine: number | null = isRun ? d.avgPaceSPerKm : isSwim ? d.swimPaceSPer100m : isRide && secs ? (secs / d.distanceM) * 1000 : null;
  const paceSql = isRun ? 'avg_pace_s_per_km' : isSwim ? 'swim_pace_s_per_100m' : '(COALESCE(moving_s, duration_s) * 1000.0 / distance_m)';
  const commuteOnly = isRide ? (d.isCommute ? 'AND is_commute = 1' : 'AND is_commute = 0') : '';
  const similar = mine
    ? (db
        .prepare(
          `SELECT ${paceSql} p, avg_hr hr, local_date date, distance_m dist FROM activities
           WHERE id <> ? AND sport = ? AND distance_m BETWEEN ? AND ? AND local_date BETWEEN ? AND ? ${commuteOnly}
             AND (local_date < ? OR (local_date = ? AND COALESCE(start_utc, '') < ?))
           ORDER BY local_date DESC, start_utc DESC`,
        )
        .all(d.id, d.sport, d.distanceM * 0.85, d.distanceM * 1.15, addDays(d.date, -56), d.date, d.date, d.date, d.startUtc ?? '') as Row[]).filter((r) => r.p != null && r.p > 0)
    : [];

  const unit = isRun ? '/km' : isSwim ? '/100 m' : '';
  const label = isRun ? `${(d.distanceM / 1000).toFixed(1)} km run` : isSwim ? `${Math.round(d.distanceM)} m swim` : d.isCommute ? 'commute' : 'ride of this length';
  if (mine && similar.length >= 2) {
    const best = Math.min(...similar.map((r) => r.p!));
    if (mine < best) {
      out.push(isRide ? `your quickest ${label} in 8 weeks` : `your fastest ${label} in 8 weeks (previous best ${pace(best)} ${unit})`);
    }
  }

  const last = similar.find((r) => r.date >= addDays(d.date, -42));
  if (mine && last && !out.length) {
    const when = dayMonth(last.date);
    if (isRide) {
      const kmh = (p: number) => 3600 / p;
      const diff = Math.round((kmh(mine) - kmh(last.p!)) * 10) / 10;
      if (Math.abs(diff) >= 0.5) out.push(`${Math.abs(diff).toFixed(1)} km/h ${diff > 0 ? 'quicker' : 'slower'} than last time (${when})`);
    } else {
      const diff = Math.round(last.p! - mine);
      const threshold = isRun ? 3 : 2;
      if (Math.abs(diff) >= threshold) out.push(`${Math.abs(diff)} s${unit} ${diff > 0 ? 'faster' : 'slower'} than last time (${when})`);
      else if (d.avgHr && last.hr && Math.abs(d.avgHr - last.hr) >= 3) {
        const hd = d.avgHr - last.hr;
        out.push(`same pace as last time (${when}) with heart rate ${Math.abs(hd)} bpm ${hd < 0 ? 'lower' : 'higher'}`);
      }
    }
  }

  if (isRun || isSwim || isRide) {
    const longest = db
      .prepare(`SELECT MAX(distance_m) m, COUNT(*) n FROM activities WHERE id <> ? AND sport = ? AND local_date BETWEEN ? AND ? ${isRide ? 'AND is_commute = 0' : ''}`)
      .get(d.id, d.sport, addDays(d.date, -84), d.date) as { m: number | null; n: number };
    if (!d.isCommute && longest.n >= 3 && longest.m != null && d.distanceM > longest.m * 1.02) {
      out.push(`your longest ${isRun ? 'run' : isSwim ? 'swim' : 'ride'} in 12 weeks`);
    }
  }
  return out;
}

/** Which session of this sport this is in its Monday–Sunday week (1-based). */
function streakCount(db: DB, d: Detail): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) n FROM activities WHERE sport = ? AND is_commute = 0 AND local_date BETWEEN ? AND ?
       AND (local_date < ? OR (local_date = ? AND (COALESCE(start_utc, '') < ? OR id = ?)))`,
    )
    .get(d.sport, weekStartOf(d.date), d.date, d.date, d.date, d.startUtc ?? '', d.id) as { n: number };
  return r.n;
}

function nextSession(db: DB, after: string): string | undefined {
  const r = db
    .prepare(`SELECT local_date, title FROM planned_sessions WHERE local_date > ? AND local_date <= ? AND status = 'planned' AND sport <> 'rest' ORDER BY local_date, slot LIMIT 1`)
    .get(after, addDays(after, 3)) as { local_date: string; title: string } | undefined;
  if (!r) return undefined;
  return `${r.local_date === addDays(after, 1) ? 'tomorrow' : weekdayShort(r.local_date)}, ${r.title.toLowerCase()}`;
}

export function activityFacts(db: DB, d: Omit<ActivityDetail, 'summary'>): ActivityFacts {
  const secs = d.movingS ?? d.durationS ?? 0;
  const zoneTotal = d.zones?.reduce((a, z) => a + z.seconds, 0) ?? 0;
  const facts: ActivityFacts = {
    kind: 'activity',
    seed: d.id,
    sport: d.sport,
    title: d.name ?? d.subSport ?? d.sport,
    duration: clock(secs),
    comparisons: comparisons(db, d),
    load: { this_session: loadCategory(d.load, typicalDayLoad(db, d.date)) },
  };
  const km = KM(d.distanceM);
  if (km) facts.distance_km = km;
  if (d.sport === 'run' && d.avgPaceSPerKm) facts.avg_pace = `${pace(d.avgPaceSPerKm)} /km`;
  if (d.sport === 'swim' && d.swimPaceSPer100m) facts.swim_pace = `${pace(d.swimPaceSPer100m)} /100 m`;
  if (d.avgHr) facts.avg_hr = d.avgHr;
  if (d.zones && zoneTotal > 0) facts.zone_share = Object.fromEntries(d.zones.map((z) => [`z${z.zone}` as ZoneKey, Math.round((z.seconds / zoneTotal) * 100) / 100]));
  if (d.planned && (d.planned.status === 'done' || d.planned.status === 'partial')) facts.planned = { title: d.planned.title, status: d.planned.status };
  if (d.isCommute) facts.is_commute = true;
  const streak = d.isCommute ? 0 : streakCount(db, d);
  if (streak >= 2) facts.streak = streak;
  const next = nextSession(db, d.date);
  if (next) facts.next = next;
  return facts;
}

export function dailyFacts(db: DB, date: string): DailyFacts {
  const r = db.prepare('SELECT verdict, factors_json FROM readiness WHERE local_date = ?').get(date) as { verdict: DailyFacts['verdict']; factors_json: string } | undefined;
  const today = db
    .prepare(`SELECT title, duration_min, is_key, sport FROM planned_sessions WHERE local_date = ? AND status IN ('planned', 'done', 'partial') AND sport <> 'rest' ORDER BY is_key DESC, slot`)
    .all(date) as Array<{ title: string; duration_min: number; is_key: number; sport: string }>;
  const race = db.prepare('SELECT name, date FROM races WHERE date >= ? ORDER BY date LIMIT 1').get(date) as { name: string; date: string } | undefined;
  const facts: DailyFacts = {
    kind: 'daily',
    seed: Number(date.replace(/-/g, '')),
    verdict: r?.verdict ?? null,
    why: r ? ((JSON.parse(r.factors_json) as { summary?: string }).summary ?? null) : null,
    today: today.map((s) => ({ title: s.title, duration_min: Math.round(s.duration_min), is_key: !!s.is_key, sport: s.sport })),
  };
  if (race) facts.next_race = { name: race.name, days: Math.round((Date.parse(race.date) - Date.parse(date)) / 86_400_000) };
  if (weekStartOf(date) === date) {
    const recap = weekRecap(db, date);
    if (recap) facts.last_week = recap;
  }
  return facts;
}

/** Monday recap of the previous Monday–Sunday week; null when there was nothing to recap. */
export function weekRecap(db: DB, monday: string): WeekRecap | null {
  const from = addDays(monday, -7);
  const to = addDays(monday, -1);
  const plan = db
    .prepare(
      `SELECT SUM(CASE WHEN status IN ('done', 'partial') THEN 1 ELSE 0 END) done, COUNT(*) total FROM planned_sessions
       WHERE local_date BETWEEN ? AND ? AND sport <> 'rest' AND status NOT IN ('moved', 'skipped')`,
    )
    .get(from, to) as { done: number | null; total: number };
  const acts = db.prepare('SELECT COUNT(*) n, SUM(COALESCE(moving_s, duration_s)) s FROM activities WHERE local_date BETWEEN ? AND ?').get(from, to) as { n: number; s: number | null };
  if (!plan.total && !acts.n) return null;
  const load = (a: string, b: string) => (db.prepare('SELECT SUM(load) s, COUNT(*) n FROM daily_metrics WHERE local_date BETWEEN ? AND ?').get(a, b) as { s: number | null; n: number });
  const last = load(from, to);
  const before = load(addDays(from, -7), addDays(from, -1));
  const change = last.n && before.n && (before.s ?? 0) > 0 ? Math.round((((last.s ?? 0) - before.s!) / before.s!) * 100) : null;
  const meta = db.prepare('SELECT phase, mode, deload, notes_json FROM plan_weeks WHERE week_start = ?').get(monday) as
    | { phase: string; mode: string; deload: number; notes_json: string }
    | undefined;
  return {
    sessions_done: plan.total ? (plan.done ?? 0) : acts.n,
    sessions_planned: plan.total,
    hours: hoursMinutes(acts.s ?? 0, { alwaysHours: true }),
    load_change_pct: change,
    focus: meta ? weekFocus(meta) : null,
  };
}

function weekFocus(m: { phase: string; mode: string; deload: number; notes_json: string }): string | null {
  const notes = m.notes_json;
  if (m.phase === 'taper') return 'a taper week: less volume, a few short sharp efforts';
  if (m.phase === 'recovery') return 'an easy week after the race';
  if (m.deload) return 'a recovery week, about 30 % lighter';
  if (notes.includes('Easing back in')) return 'still about easing back in after the break';
  if (m.mode === 'baseline') return 'still about building a baseline with short sessions';
  if (m.phase === 'build') return 'a build week: the hard sessions get more specific';
  if (m.phase === 'peak') return 'a peak week: race-pace work, volume holds';
  if (m.phase === 'base') return 'a base week: steady aerobic work and technique';
  return null;
}

function cached(db: DB, kind: 'activity' | 'daily', ref: string, facts: unknown, render: () => string): SummaryResult {
  // The template version is part of the key: new wording rewrites cached text (M6 adds the model name here).
  const factsJson = JSON.stringify({ template: TEMPLATE_VERSION, facts });
  const row = db.prepare('SELECT text, source, facts_json FROM summaries WHERE kind = ? AND ref = ?').get(kind, ref) as
    | { text: string; source: SummaryResult['source']; facts_json: string }
    | undefined;
  if (row && row.facts_json === factsJson) return { text: row.text, source: row.source };
  const text = render();
  db.prepare(
    `INSERT INTO summaries (kind, ref, text, source, model, facts_json, created_at) VALUES (?, ?, ?, 'template', NULL, ?, ?)
     ON CONFLICT (kind, ref) DO UPDATE SET text = excluded.text, source = excluded.source, model = NULL, facts_json = excluded.facts_json, created_at = excluded.created_at`,
  ).run(kind, ref, text, factsJson, nowIso());
  return { text, source: 'template' };
}

export function activitySummary(db: DB, d: Omit<ActivityDetail, 'summary'>): SummaryResult {
  const facts = activityFacts(db, d);
  return cached(db, 'activity', String(d.id), facts, () => activityText(facts));
}

export function dailySummary(db: DB, date: string): SummaryResult {
  const facts = dailyFacts(db, date);
  return cached(db, 'daily', date, facts, () => dailyText(facts));
}
