import type { DB } from '../db';
import { nowIso } from '../db/util';
import { addDays } from '../util/dates';
import { clock, pace, weekdayShort } from '../../shared/format';
import type { ActivityDetail } from '../../shared/api';
import { TEMPLATE_VERSION, activityText, dailyText, type ActivityFacts, type DailyFacts, type ZoneKey } from './template';

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

/** "fastest 5.0 km run in 8 weeks (previous best 4:58 /km)" when it is. */
function comparisons(db: DB, d: Omit<ActivityDetail, 'summary'>): string[] {
  if (!d.distanceM || d.distanceM < 400) return [];
  const isRun = d.sport === 'run';
  const isSwim = d.sport === 'swim' && !d.isOpenWater;
  if (!isRun && !isSwim) return [];
  const col = isRun ? 'avg_pace_s_per_km' : 'swim_pace_s_per_100m';
  const mine = isRun ? d.avgPaceSPerKm : d.swimPaceSPer100m;
  if (!mine) return [];
  const others = db
    .prepare(`SELECT ${col} p FROM activities WHERE id <> ? AND sport = ? AND ${col} IS NOT NULL AND local_date BETWEEN ? AND ? AND distance_m BETWEEN ? AND ?`)
    .all(d.id, d.sport, addDays(d.date, -56), d.date, d.distanceM * 0.85, d.distanceM * 1.15) as Array<{ p: number }>;
  if (others.length < 2) return [];
  const best = Math.min(...others.map((o) => o.p));
  if (mine >= best) return [];
  const what = isRun ? `${(d.distanceM / 1000).toFixed(1)} km run` : `${Math.round(d.distanceM)} m swim`;
  return [`your fastest ${what} in 8 weeks (previous best ${pace(best)} ${isRun ? '/km' : '/100 m'})`];
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
    verdict: r?.verdict ?? null,
    why: r ? ((JSON.parse(r.factors_json) as { summary?: string }).summary ?? null) : null,
    today: today.map((s) => ({ title: s.title, duration_min: Math.round(s.duration_min), is_key: !!s.is_key, sport: s.sport })),
  };
  if (race) facts.next_race = { name: race.name, days: Math.round((Date.parse(race.date) - Date.parse(date)) / 86_400_000) };
  return facts;
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
