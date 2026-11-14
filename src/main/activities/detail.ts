import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { decodeFit } from '../fit/decode';
import { LOAD, type HrSample } from '../engine';
import type { ActivityDetail, ActivityLap, ZoneTime } from '../../shared/api';

/**
 * Activity detail for the drawer: summary numbers from the DB, laps / swim
 * intervals and time in HR zones from the FIT file (parsed on demand, cached
 * in activity_extras).
 */

interface Zone {
  zone: number;
  min: number;
  max: number;
}

export function hrZones(db: DB): Zone[] {
  return (db.prepare(`SELECT zone, min_bpm, max_bpm FROM hr_zones WHERE sport = 'DEFAULT' ORDER BY zone`).all() as Array<{ zone: number; min_bpm: number; max_bpm: number }>).map((z) => ({
    zone: z.zone,
    min: z.min_bpm,
    max: z.max_bpm,
  }));
}

/** Seconds per zone; time below Z1 counts as Z1, above Z5 as Z5. Gaps are capped like load. */
export function timeInZones(samples: HrSample[], zones: Zone[]): ZoneTime[] | null {
  if (samples.length < 2 || zones.length < 5) return null;
  const out = zones.map((z) => ({ zone: z.zone, minBpm: z.min, maxBpm: z.max, seconds: 0 }));
  for (let i = 0; i < samples.length - 1; i++) {
    const dt = Math.min((samples[i + 1]!.t - samples[i]!.t) / 1000, LOAD.maxSampleGapS);
    if (dt <= 0) continue;
    const hr = samples[i]!.hr;
    const idx = hr < zones[0]!.min ? 0 : Math.max(0, zones.findIndex((z, j) => hr >= z.min && (hr <= z.max || j === zones.length - 1)));
    out[idx]!.seconds += dt;
  }
  return out.map((z) => ({ ...z, seconds: Math.round(z.seconds) }));
}

interface FitDetail {
  zones: ZoneTime[] | null;
  laps: ActivityLap[];
}

export function parseFitDetail(bytes: Uint8Array, sport: string, zones: Zone[]): FitDetail {
  const d = decodeFit(bytes);
  if (!d.ok) return { zones: null, laps: [] };
  const records = (d.messages.recordMesgs ?? []) as Array<Record<string, unknown>>;
  const samples: HrSample[] = records
    .filter((r) => typeof r.heartRate === 'number' && r.timestamp instanceof Date)
    .map((r) => ({ t: (r.timestamp as Date).getTime(), hr: r.heartRate as number }));

  const laps: ActivityLap[] = [];
  let index = 0;
  for (const l of (d.messages.lapMesgs ?? []) as Array<Record<string, unknown>>) {
    const dist = typeof l.totalDistance === 'number' ? l.totalDistance : null;
    const time = typeof l.totalTimerTime === 'number' ? l.totalTimerTime : typeof l.totalElapsedTime === 'number' ? l.totalElapsedTime : null;
    if (time == null || time <= 0) continue;
    if (sport === 'swim' && (!dist || dist <= 0)) continue; // rest between swim intervals
    const speed = typeof l.enhancedAvgSpeed === 'number' ? l.enhancedAvgSpeed : typeof l.avgSpeed === 'number' ? l.avgSpeed : dist ? dist / time : null;
    index++;
    laps.push({
      index,
      distanceM: dist,
      durationS: Math.round(time),
      avgHr: typeof l.avgHeartRate === 'number' ? l.avgHeartRate : null,
      paceSPerKm: sport === 'run' && speed && speed > 0 ? 1000 / speed : null,
      speedKmh: sport === 'bike' && speed && speed > 0 ? speed * 3.6 : null,
      swimPaceSPer100m: sport === 'swim' && speed && speed > 0 ? 100 / speed : null,
      swolf: typeof l.avgSwolf === 'number' ? l.avgSwolf : null,
    });
  }
  return { zones: timeInZones(samples, zones), laps };
}

const DETAIL_KEY = 'detail_v1';

export function getActivityDetail(db: DB, fitDir: string, id: number): Omit<ActivityDetail, 'summary'> | null {
  const a = db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!a) return null;
  const extras = new Map(
    (db.prepare('SELECT key, value FROM activity_extras WHERE activity_id = ?').all(id) as Array<{ key: string; value: string }>).map((e) => [e.key, e.value]),
  );

  // FIT-derived parts, cached against fit_parsed_at.
  let fit: FitDetail = { zones: null, laps: [] };
  const stamp = String(a.fit_parsed_at ?? '');
  const cached = extras.get(DETAIL_KEY);
  if (cached) {
    try {
      const c = JSON.parse(cached) as FitDetail & { stamp: string };
      if (c.stamp === stamp) fit = c;
      else throw new Error('stale');
    } catch {
      fit = loadFit();
    }
  } else fit = loadFit();

  function loadFit(): FitDetail {
    const path = a!.fit_path ? join(fitDir, String(a!.fit_path)) : null;
    if (!path || !existsSync(path)) return { zones: null, laps: [] };
    const res = parseFitDetail(new Uint8Array(readFileSync(path)), String(a!.sport), hrZones(db));
    db.prepare(
      `INSERT INTO activity_extras (activity_id, key, value) VALUES (?, ?, ?) ON CONFLICT (activity_id, key) DO UPDATE SET value = excluded.value`,
    ).run(id, DETAIL_KEY, JSON.stringify({ ...res, stamp }));
    return res;
  }

  const planned = db
    .prepare('SELECT title, duration_min, intensity, targets_json, status, purpose FROM planned_sessions WHERE matched_activity_id = ? LIMIT 1')
    .get(id) as { title: string; duration_min: number; intensity: string; targets_json: string | null; status: string; purpose: string | null } | undefined;

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id,
    date: String(a.local_date),
    startUtc: (a.start_utc as string | null) ?? null,
    name: (a.name as string | null) ?? null,
    sport: String(a.sport),
    subSport: (a.sub_sport as string | null) ?? null,
    isOpenWater: a.is_open_water === 1,
    poolLengthM: num(a.pool_length_m),
    durationS: num(a.duration_s),
    movingS: num(a.moving_s),
    distanceM: num(a.distance_m),
    elevationGainM: num(a.elevation_gain_m),
    avgHr: num(a.avg_hr),
    maxHr: num(a.max_hr),
    avgPaceSPerKm: num(a.avg_pace_s_per_km),
    swimPaceSPer100m: num(a.swim_pace_s_per_100m),
    swolf: num(a.swolf),
    avgCadence: num(a.avg_cadence),
    avgPower: num(a.avg_power),
    load: num(a.load),
    loadMethod: (a.load_method as string | null) ?? null,
    loadReasons: extras.get('load_reasons') ? (JSON.parse(extras.get('load_reasons')!) as string[]) : [],
    needsRpe: extras.get('needs_rpe') === '1',
    rpe: num(a.rpe),
    isCommute: a.is_commute === 1,
    commuteSource: (a.commute_source as ActivityDetail['commuteSource']) ?? null,
    vo2max: num(a.vo2max),
    zones: fit.zones,
    laps: fit.laps,
    planned: planned
      ? {
          title: planned.title,
          durationMin: planned.duration_min,
          intensity: planned.intensity,
          targets: planned.targets_json ? (JSON.parse(planned.targets_json) as Record<string, string>) : {},
          status: planned.status,
          purpose: planned.purpose,
        }
      : null,
  };
}
