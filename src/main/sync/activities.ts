/**
 * Map Garmin's SummarizedActivityDTO (activity search) to our `activities`
 * columns. Field names are from the OpenAPI spec; confirm units with the probe.
 */

export type SportFamily = 'swim' | 'bike' | 'run' | 'strength' | 'other';

export function sportFamily(typeKey: string | null | undefined): SportFamily {
  const k = (typeKey ?? '').toLowerCase();
  if (!k) return 'other';
  if (k.includes('swim')) return 'swim';
  if (k.includes('strength')) return 'strength';
  if (k.includes('run')) return 'run';
  if (k.includes('cycl') || k.includes('bik') || k.includes('ride') || k === 'bmx') return 'bike';
  return 'other';
}

export interface ActivityRow {
  garmin_activity_id: string;
  name: string | null;
  start_utc: string | null;
  local_date: string;
  sport: SportFamily;
  sub_sport: string | null;
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
  np_power: number | null;
  avg_cadence: number | null;
  avg_pace_s_per_km: number | null;
  swim_pace_s_per_100m: number | null;
  swolf: number | null;
  pool_length_m: number | null;
  is_open_water: number;
  garmin_training_load: number | null;
  vo2max: number | null;
  raw_json: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** "2026-11-10 05:00:00" (GMT) → "2026-11-10T05:00:00.000Z" */
export function gmtToIso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function localDateOf(isoUtc: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoUtc));
}

export function mapActivitySummary(a: Record<string, unknown>, timeZone: string): ActivityRow | null {
  const id = a.activityId;
  if (typeof id !== 'number' && typeof id !== 'string') return null;

  const typeKey = str((a.activityType as Record<string, unknown> | undefined)?.typeKey);
  const sport = sportFamily(typeKey);
  const startUtc = gmtToIso(a.startTimeGMT);
  const local = str(a.startTimeLocal)?.slice(0, 10) ?? (startUtc ? localDateOf(startUtc, timeZone) : null);
  if (!local) return null;

  const speed = num(a.averageSpeed); // m/s
  const cadence =
    sport === 'run' ? num(a.averageRunningCadenceInStepsPerMinute)
    : sport === 'bike' ? num(a.averageBikingCadenceInRevPerMinute)
    : sport === 'swim' ? num(a.averageSwimCadenceInStrokesPerMinute)
    : null;

  return {
    garmin_activity_id: String(id),
    name: str(a.activityName),
    start_utc: startUtc,
    local_date: local,
    sport,
    sub_sport: typeKey,
    duration_s: num(a.duration),
    moving_s: num(a.movingDuration),
    distance_m: num(a.distance),
    elevation_gain_m: num(a.elevationGain),
    avg_hr: roundOrNull(num(a.averageHR)),
    max_hr: roundOrNull(num(a.maxHR)),
    avg_power: num(a.avgPower),
    np_power: num(a.normPower),
    avg_cadence: cadence,
    avg_pace_s_per_km: sport === 'run' && speed && speed > 0 ? 1000 / speed : null,
    swim_pace_s_per_100m: sport === 'swim' && speed && speed > 0 ? 100 / speed : null,
    swolf: num(a.averageSwolf),
    pool_length_m: poolLengthMeters(a),
    is_open_water: typeKey === 'open_water_swimming' ? 1 : 0,
    garmin_training_load: num(a.activityTrainingLoad),
    vo2max: num(a.vO2MaxValue),
    raw_json: JSON.stringify(a),
  };
}

/**
 * Garmin has historically sent poolLength in centimetres alongside
 * `unitOfPoolLength.factor` (e.g. 2500 with factor 100 → 25 m). Handle both.
 */
function poolLengthMeters(a: Record<string, unknown>): number | null {
  const len = num(a.poolLength);
  if (len == null || len <= 0) return null;
  const factor = num((a.unitOfPoolLength as Record<string, unknown> | undefined)?.factor);
  if (factor && factor > 0) return len / factor;
  return len > 100 ? len / 100 : len;
}

function roundOrNull(v: number | null): number | null {
  return v == null ? null : Math.round(v);
}
