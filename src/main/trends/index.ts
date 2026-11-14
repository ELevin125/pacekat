import type { DB } from '../db';
import { addDays } from '../util/dates';
import { weekStartOf } from '../engine';
import { sensors } from '../settings';
import type { TrendsData } from '../../shared/api';
import { aggregateTrends, type TrendActivity, type TrendDay } from './aggregate';

/** Load the rows for the Trends page and aggregate them by week. */
export function getTrends(db: DB, weeks: number, today: string): TrendsData {
  const currentWeek = weekStartOf(today);
  const from = addDays(currentWeek, -7 * (weeks - 1));
  const s = sensors(db);

  const acts = db
    .prepare(
      `SELECT local_date, sport, duration_s, moving_s, distance_m, avg_hr, avg_cadence, load, is_commute, is_open_water,
              swim_pace_s_per_100m, swolf, vo2max, raw_json
       FROM activities WHERE local_date BETWEEN ? AND ?`,
    )
    .all(from, today) as Array<Record<string, unknown>>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const activities: TrendActivity[] = acts.map((a) => {
    const row: TrendActivity = {
      date: String(a.local_date),
      sport: String(a.sport),
      durationS: num(a.duration_s),
      movingS: num(a.moving_s),
      distanceM: num(a.distance_m),
      avgHr: num(a.avg_hr),
      avgCadence: num(a.avg_cadence),
      load: num(a.load),
      isCommute: a.is_commute === 1,
      isOpenWater: a.is_open_water === 1,
      swimPaceSPer100m: num(a.swim_pace_s_per_100m),
      swolf: num(a.swolf),
      vo2max: num(a.vo2max),
    };
    if (s.runningDynamics && a.sport === 'run') {
      try {
        const raw = JSON.parse(String(a.raw_json)) as Record<string, unknown>;
        row.gctMs = num(raw.avgGroundContactTime);
        row.vertOscCm = num(raw.avgVerticalOscillation);
        const stride = num(raw.avgStrideLength);
        row.strideM = stride == null ? null : stride > 10 ? stride / 100 : stride; // Garmin reports cm
      } catch {
        /* raw payload unreadable: skip dynamics for this run */
      }
    }
    return row;
  });

  const days = db
    .prepare(
      `SELECT d.local_date date, m.load, m.acwr, d.hrv_last_night_ms hrv, d.hrv_baseline_low_ms hrvLow, d.hrv_baseline_high_ms hrvHigh, d.resting_hr rhr
       FROM daily_health d LEFT JOIN daily_metrics m ON m.local_date = d.local_date
       WHERE d.local_date BETWEEN ? AND ?
       UNION
       SELECT m.local_date, m.load, m.acwr, NULL, NULL, NULL, NULL FROM daily_metrics m
       WHERE m.local_date BETWEEN ? AND ? AND m.local_date NOT IN (SELECT local_date FROM daily_health)
       ORDER BY date`,
    )
    .all(from, today, from, today) as TrendDay[];

  const z2 = db.prepare(`SELECT min_bpm, max_bpm FROM hr_zones WHERE sport = 'DEFAULT' AND zone = 2`).get() as { min_bpm: number; max_bpm: number } | undefined;
  const refHr = z2 ? Math.round((z2.min_bpm + z2.max_bpm) / 2 / 5) * 5 : 140;
  const triathlonFocus = !!db.prepare(`SELECT 1 FROM races WHERE date >= ? AND type IN ('sprint_tri', 'olympic_tri')`).get(today);

  return aggregateTrends({ activities, days, weeks, currentWeek, zone2Max: z2?.max_bpm ?? null, refHr, triathlonFocus, runningDynamics: s.runningDynamics });
}
