import type { DB } from '../db';
import { nowIso } from '../db/util';
import { getSetting, setSetting } from '../db/settings';

/**
 * Rebuild `daily_health` rows from `raw_daily`. Pure mapping from the raw
 * payloads (shapes per the OpenAPI spec), so fixing a mapping later only needs
 * a re-derive, not a re-fetch.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};

export interface DailyHealth {
  local_date: string;
  resting_hr: number | null;
  hrv_last_night_ms: number | null;
  hrv_weekly_avg_ms: number | null;
  hrv_low_ms: number | null;
  hrv_baseline_low_ms: number | null;
  hrv_baseline_high_ms: number | null;
  hrv_status: string | null;
  sleep_seconds: number | null;
  sleep_score: number | null;
  body_battery_wake: number | null;
  body_battery_min: number | null;
  body_battery_max: number | null;
  stress_avg: number | null;
  respiration_avg: number | null;
  spo2_avg: number | null;
  steps: number | null;
  weight_kg: number | null;
}

export function deriveDay(date: string, raw: Partial<Record<string, unknown>>): DailyHealth {
  const sum = obj(raw['daily-summaries']);
  const sleep = obj(raw['sleep-summaries']);
  const hrv = obj(raw['hrv-daily']);
  const bb = obj(raw['body-battery']);
  const weight = obj(raw['weight-range']);

  const baseline = obj(hrv?.baseline);
  const sleepScores = obj(sleep?.sleepScores);
  const overall = obj(sleepScores?.overall);

  return {
    local_date: date,
    resting_hr: int(obj(sum?.heartRate)?.restingValue),
    hrv_last_night_ms: int(hrv?.lastNightAvg),
    hrv_weekly_avg_ms: int(hrv?.weeklyAvg),
    hrv_low_ms: int(baseline?.lowUpper),
    // Garmin's "balanced" range is the personal baseline band.
    hrv_baseline_low_ms: int(baseline?.balancedLow),
    hrv_baseline_high_ms: int(baseline?.balancedUpper),
    hrv_status: typeof hrv?.status === 'string' ? hrv.status : null,
    sleep_seconds: int(sleep?.sleepTimeSeconds),
    sleep_score: int(overall?.value),
    body_battery_wake: bodyBatteryAtWake(bb, sleep),
    body_battery_min: int(obj(sum?.bodyBattery)?.minValue),
    body_battery_max: int(obj(sum?.bodyBattery)?.maxValue),
    stress_avg: int(obj(sum?.stress)?.avgLevel),
    respiration_avg: num(obj(sum?.respiration)?.avgValue),
    spo2_avg: num(obj(sum?.pulseOx)?.avgValue),
    steps: int(obj(obj(sum?.movement)?.steps)?.value),
    weight_kg: weightKg(weight),
  };
}

/** Epoch ms from a number (s or ms) or a GMT timestamp string. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string' && v.trim()) {
    const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * First Body Battery reading at or after the end of last night's sleep
 * (within 3 h). Column positions come from the response's descriptor list.
 */
export function bodyBatteryAtWake(bb: Obj | null, sleep: Obj | null): number | null {
  const wake = toMs(sleep?.sleepEndTimestampGMT);
  const rows = bb?.bodyBatteryValuesArray;
  if (wake == null || !Array.isArray(rows)) return null;

  let tsIdx = 0;
  let lvlIdx = 1;
  const descriptors = bb?.bodyBatteryValueDescriptorDTOList;
  if (Array.isArray(descriptors)) {
    for (const d of descriptors) {
      const o = obj(d);
      const idx = num(o?.bodyBatteryValueDescriptorIndex);
      const key = o?.bodyBatteryValueDescriptorKey;
      if (idx == null) continue;
      if (key === 'timestamp') tsIdx = idx;
      if (key === 'bodyBatteryLevel') lvlIdx = idx;
    }
  }

  let best: { t: number; v: number } | null = null;
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const t = toMs(r[tsIdx]);
    const v = num(r[lvlIdx]);
    if (t == null || v == null || t < wake || t - wake > 3 * 3600_000) continue;
    if (!best || t < best.t) best = { t, v };
  }
  return best ? Math.round(best.v) : null;
}

function weightKg(w: Obj | null): number | null {
  if (!w) return null;
  let v = num(obj(w.latestWeight)?.weight);
  if (v == null && Array.isArray(w.allWeightMetrics)) {
    const last = w.allWeightMetrics.map(obj).filter(Boolean).pop();
    v = num(last?.weight);
  }
  if (v == null) return null;
  // Spec says kg; older Garmin APIs used grams. Guard against that.
  return v > 1000 ? Math.round(v / 10) / 100 : v;
}

const DH_COLS: Array<keyof DailyHealth> = [
  'local_date', 'resting_hr', 'hrv_last_night_ms', 'hrv_weekly_avg_ms', 'hrv_low_ms', 'hrv_baseline_low_ms', 'hrv_baseline_high_ms',
  'hrv_status', 'sleep_seconds', 'sleep_score', 'body_battery_wake', 'body_battery_min', 'body_battery_max',
  'stress_avg', 'respiration_avg', 'spo2_avg', 'steps', 'weight_kg',
];

/**
 * Bump when the raw → daily_health mapping changes; on start-up every stored
 * day is re-derived from raw_daily (no re-fetch needed).
 *   2: hrv_low_ms (Garmin lowUpper)
 */
export const DERIVE_VERSION = 2;

export function ensureDerived(db: DB): number {
  if (getSetting<number>(db, 'derive_version', 0) >= DERIVE_VERSION) return 0;
  const dates = (db.prepare('SELECT DISTINCT local_date FROM raw_daily').all() as Array<{ local_date: string }>).map((r) => r.local_date);
  const n = deriveDailyHealth(db, dates);
  setSetting(db, 'derive_version', DERIVE_VERSION);
  return n;
}

export function deriveDailyHealth(db: DB, dates: Iterable<string>): number {
  const readRaw = db.prepare('SELECT data_type, raw_json FROM raw_daily WHERE local_date = ?');
  const upsert = db.prepare(
    `INSERT INTO daily_health (${DH_COLS.join(', ')}, derived_at) VALUES (${DH_COLS.map((c) => '@' + c).join(', ')}, @derived_at)
     ON CONFLICT (local_date) DO UPDATE SET ${DH_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}, derived_at = excluded.derived_at`,
  );
  let n = 0;
  db.transaction(() => {
    for (const date of dates) {
      const rows = readRaw.all(date) as Array<{ data_type: string; raw_json: string }>;
      if (!rows.length) continue;
      const raw: Record<string, unknown> = {};
      for (const r of rows) raw[r.data_type] = JSON.parse(r.raw_json);
      upsert.run({ ...deriveDay(date, raw), derived_at: nowIso() });
      n++;
    }
  })();
  return n;
}
