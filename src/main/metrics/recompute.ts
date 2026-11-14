import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { nowIso } from '../db/util';
import type { MetricsSummary } from '../../shared/api';

export type { MetricsSummary };
import { getSetting, setSetting } from '../db/settings';
import { addDays, eachDay } from '../garmin/dates';
import { hrSamplesFromFit } from '../fit/hr';
import {
  LOAD,
  READINESS,
  activityLoad,
  calibrateK,
  computeAcwr,
  computeReadiness,
  detectCommute,
  type DayHealth,
  type HrSample,
  type LoadResult,
  type Sport,
} from '../engine';

/**
 * Glue between the database and the pure engine: per-activity load and
 * commute flags, daily load + ACWR, and readiness verdicts. Idempotent: safe
 * to run after every sync and every manual edit.
 */

export interface Sensors {
  chestStrap: boolean;
  runningDynamics: boolean;
  swimHrStorage: boolean;
  bikePower: boolean;
}
export const DEFAULT_SENSORS: Sensors = { chestStrap: false, runningDynamics: false, swimHrStorage: false, bikePower: false };

interface ActRow {
  id: number;
  local_date: string;
  sport: Sport;
  is_open_water: number;
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  rpe: number | null;
  is_commute: number;
  commute_source: string | null;
  fit_path: string | null;
}

export function resolveHrMax(db: DB): { hrMax: number; source: MetricsSummary['hrMaxSource'] } {
  const setting = getSetting<number | null>(db, 'max_hr', null);
  if (typeof setting === 'number' && setting > 100) return { hrMax: setting, source: 'setting' };
  const zones = garminZonesRaw(db);
  const g = zones?.maxHeartRateUsed;
  if (typeof g === 'number' && g > 100) return { hrMax: g, source: 'garmin' };
  return { hrMax: LOAD.fallbackHrMax, source: 'fallback' };
}

function garminZonesRaw(db: DB): Record<string, unknown> | null {
  const row = db.prepare(`SELECT raw_json FROM raw_static WHERE data_type = 'hr-zones'`).get() as { raw_json: string } | undefined;
  if (!row) return null;
  try {
    const list = JSON.parse(row.raw_json) as Array<Record<string, unknown>>;
    return list.find((z) => z.sport === 'DEFAULT') ?? list[0] ?? null;
  } catch {
    return null;
  }
}

function zone2Upper(db: DB): number | null {
  const r = db
    .prepare(`SELECT max_bpm FROM hr_zones WHERE zone = 2 AND sport IN ('CYCLING', 'DEFAULT') ORDER BY CASE sport WHEN 'CYCLING' THEN 0 ELSE 1 END LIMIT 1`)
    .get() as { max_bpm: number } | undefined;
  return r?.max_bpm ?? null;
}

export function recomputeMetrics(db: DB, fitDir: string, today: string): MetricsSummary {
  const { hrMax, source: hrMaxSource } = resolveHrMax(db);
  const sensors = { ...DEFAULT_SENSORS, ...getSetting<Partial<Sensors>>(db, 'sensors', {}) };
  const garminRest = garminZonesRaw(db)?.restingHeartRateUsed;
  const fallbackRest = typeof garminRest === 'number' && garminRest > 30 ? garminRest : LOAD.fallbackHrRest;

  // Resting HR by day for the 7-day mean.
  const rhr = new Map(
    (db.prepare('SELECT local_date, resting_hr FROM daily_health WHERE resting_hr IS NOT NULL').all() as Array<{ local_date: string; resting_hr: number }>).map((r) => [r.local_date, r.resting_hr]),
  );
  const hrRestOn = (date: string): number => {
    const vals: number[] = [];
    for (let i = 0; i < LOAD.restHrWindowDays; i++) {
      const v = rhr.get(addDays(date, -i));
      if (v != null) vals.push(v);
    }
    return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : fallbackRest;
  };

  const acts = db
    .prepare('SELECT id, local_date, sport, is_open_water, duration_s, moving_s, distance_m, avg_hr, rpe, is_commute, commute_source, fit_path FROM activities ORDER BY local_date')
    .all() as ActRow[];

  const samplesFor = (a: ActRow): HrSample[] => {
    if (!a.fit_path) return [];
    const p = join(fitDir, a.fit_path);
    if (!existsSync(p)) return [];
    return hrSamplesFromFit(new Uint8Array(readFileSync(p)));
  };

  // Pass 1: HR TRIMP for every activity (needed to calibrate k).
  const prepared = acts.map((a) => {
    const input = {
      sport: a.sport,
      isOpenWater: !!a.is_open_water,
      durationS: a.duration_s ?? 0,
      movingS: a.moving_s,
      avgHr: a.avg_hr,
      hrSamples: samplesFor(a),
      rpe: a.rpe,
    };
    const ctx = { hrRest: hrRestOn(a.local_date), hrMax, k: LOAD.defaultK, swimHrStorage: sensors.swimHrStorage };
    return { a, input, ctx, first: activityLoad(input, ctx) };
  });

  const kFrom = addDays(today, -LOAD.kWindowDays);
  const pairs = prepared
    .filter(({ a, first }) => a.rpe != null && a.local_date >= kFrom && first.trimp != null && !(a.sport === 'swim' && !a.is_open_water && !sensors.swimHrStorage))
    .map(({ a, input, first }) => ({ trimp: first.trimp!, srpe: (Math.max(input.movingS ?? 0, 0) > 0 ? input.movingS! : input.durationS) / 60 * a.rpe! }));
  const k = calibrateK(pairs);

  // Pass 2: final loads with calibrated k, commute flags.
  const z2 = zone2Upper(db);
  const updLoad = db.prepare('UPDATE activities SET load = ?, load_method = ?, is_commute = ?, commute_source = ? WHERE id = ?');
  const putExtra = db.prepare(
    `INSERT INTO activity_extras (activity_id, key, value) VALUES (?, ?, ?) ON CONFLICT (activity_id, key) DO UPDATE SET value = excluded.value`,
  );
  const delExtra = db.prepare('DELETE FROM activity_extras WHERE activity_id = ? AND key = ?');
  let needsRpe = 0;
  const loads = new Map<string, number>();

  db.transaction(() => {
    for (const { a, input, ctx } of prepared) {
      const res: LoadResult = activityLoad(input, { ...ctx, k: k.k });
      if (res.needsRpe) needsRpe++;
      loads.set(a.local_date, (loads.get(a.local_date) ?? 0) + res.load);

      let isCommute = a.is_commute;
      let source = a.commute_source;
      if (source !== 'manual') {
        const c = detectCommute({ sport: a.sport, localDate: a.local_date, distanceM: a.distance_m, avgHr: a.avg_hr }, z2);
        isCommute = c.isCommute ? 1 : 0;
        source = c.isCommute ? 'auto' : null;
      }
      updLoad.run(Math.round(res.load * 10) / 10, res.method, isCommute, source, a.id);
      if (res.trimp != null) putExtra.run(a.id, 'hr_trimp', String(Math.round(res.trimp * 10) / 10));
      else delExtra.run(a.id, 'hr_trimp');
      putExtra.run(a.id, 'needs_rpe', res.needsRpe ? '1' : '0');
      putExtra.run(a.id, 'load_reasons', JSON.stringify(res.reasons));
    }
  })();

  // Daily load + ACWR from the first day of any history.
  const firstHealth = (db.prepare('SELECT MIN(local_date) d FROM daily_health WHERE resting_hr IS NOT NULL OR sleep_seconds IS NOT NULL OR hrv_last_night_ms IS NOT NULL').get() as { d: string | null }).d;
  const firstAct = acts[0]?.local_date ?? null;
  const historyStart = [firstHealth, firstAct].filter((x): x is string => !!x).sort()[0] ?? null;

  if (historyStart && historyStart <= today) {
    const series = computeAcwr(eachDay(historyStart, today).map((date) => ({ date, load: loads.get(date) ?? 0 })));
    const byDate = new Map(series.map((p) => [p.date, p]));
    const now = nowIso();
    const putDaily = db.prepare(
      `INSERT INTO daily_metrics (local_date, load, acute, chronic, acwr, band, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (local_date) DO UPDATE SET load = excluded.load, acute = excluded.acute, chronic = excluded.chronic,
         acwr = excluded.acwr, band = excluded.band, computed_at = excluded.computed_at`,
    );

    const healthRows = db.prepare('SELECT * FROM daily_health').all() as Array<Record<string, number | string | null>>;
    const health = new Map(
      healthRows.map((r): [string, DayHealth] => [
        String(r.local_date),
        {
          date: String(r.local_date),
          restingHr: r.resting_hr as number | null,
          hrvLastNight: r.hrv_last_night_ms as number | null,
          hrvLow: r.hrv_low_ms as number | null,
          hrvBaselineLow: r.hrv_baseline_low_ms as number | null,
          sleepSeconds: r.sleep_seconds as number | null,
          sleepScore: r.sleep_score as number | null,
          bodyBatteryWake: r.body_battery_wake as number | null,
        },
      ]),
    );
    const empty = (date: string): DayHealth => ({ date, restingHr: null, hrvLastNight: null, hrvBaselineLow: null, sleepSeconds: null, sleepScore: null, bodyBatteryWake: null });
    const putReadiness = db.prepare(
      `INSERT INTO readiness (local_date, verdict, factors_json, computed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (local_date) DO UPDATE SET verdict = excluded.verdict, factors_json = excluded.factors_json, computed_at = excluded.computed_at`,
    );

    db.transaction(() => {
      db.prepare('DELETE FROM daily_metrics WHERE local_date < ?').run(historyStart);
      for (const p of series) putDaily.run(p.date, p.load, p.acute, p.chronic, p.acwr, p.band, now);

      for (const date of eachDay(historyStart, today)) {
        const y = byDate.get(addDays(date, -1));
        const prior28 = eachDay(addDays(date, -28), addDays(date, -1)).map((d) => byDate.get(d)).filter((x) => !!x);
        const trainingDays = prior28.filter((x) => x!.load > 0);
        const typical28 =
          prior28.length >= 28 && trainingDays.length >= READINESS.yesterdayLoad.minTrainingDays
            ? trainingDays.reduce((s, x) => s + x!.load, 0) / trainingDays.length
            : null;
        const previous = Array.from({ length: 7 }, (_, i) => health.get(addDays(date, -(i + 1))) ?? empty(addDays(date, -(i + 1))));
        const r = computeReadiness({
          today: health.get(date) ?? empty(date),
          previous,
          acwr: y?.acwr ?? null,
          yesterdayLoad: y ? y.load : null,
          typicalDayLoad28: typical28,
        });
        putReadiness.run(date, r.verdict, JSON.stringify({ summary: r.summary, factors: r.factors, acwr: y?.acwr ?? null }), now);
      }
    })();
  }

  setSetting(db, 'load_k', { k: k.k, calibrated: k.calibrated, samples: k.samples });
  return {
    hrMax,
    hrMaxSource,
    k: k.k,
    kCalibrated: k.calibrated,
    kSamples: k.samples,
    historyStart,
    activities: acts.length,
    needsRpe,
  };
}
