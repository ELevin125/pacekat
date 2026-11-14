import type { DB } from '../db';
import { getSetting, setSetting } from '../db/settings';
import { addDays } from '../util/dates';
import { DEFAULT_SENSORS, resolveHrMax } from '../metrics/recompute';
import { GARMIN_KEY, type SecretStore } from '../secrets';
import type { Nudge, Result, Sensors, SettingsPatch, SettingsView } from '../../shared/api';

/**
 * Settings page data (docs/ui.md "Races & Settings"). Values the athlete
 * types always win over Garmin's; clearing one goes back to Garmin.
 */

export function sensors(db: DB): Sensors {
  return { ...DEFAULT_SENSORS, ...getSetting<Partial<Sensors>>(db, 'sensors', {}) };
}

function garminZoneRaw(db: DB): Record<string, unknown> | null {
  const row = db.prepare(`SELECT raw_json FROM raw_static WHERE data_type = 'hr-zones'`).get() as { raw_json: string } | undefined;
  if (!row) return null;
  try {
    const list = JSON.parse(row.raw_json) as Array<Record<string, unknown>>;
    return list.find((z) => z.sport === 'DEFAULT') ?? list[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * "We're seeing X on your recent activities — turn on Y?" (coaching-engine.md §8).
 * Based on what the FIT files contain in the last 30 days.
 */
export function nudges(db: DB, today: string): Nudge[] {
  const on = sensors(db);
  const dismissed = new Set(getSetting<string[]>(db, 'nudges_dismissed', []));
  const count = (sport: string | null, key: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) n FROM activities a JOIN activity_extras e ON e.activity_id = a.id
           WHERE a.local_date >= ? AND e.key = ? AND CAST(e.value AS INTEGER) > 0 ${sport ? 'AND a.sport = ?' : ''}`,
        )
        .get(...[addDays(today, -30), key, ...(sport ? [sport] : [])]) as { n: number }
    ).n;
  const out: Nudge[] = [];
  const add = (key: keyof Sensors, n: number, what: string) => {
    if (!on[key] && !dismissed.has(key) && n >= 2) out.push({ key, message: `We're seeing ${what} on your last ${n} ${n === 1 ? 'activity' : 'activities'}. Turn this on?` });
  };
  add('swimHrStorage', count('swim', 'fit_hr_samples'), 'heart rate in your swims');
  add('runningDynamics', count('run', 'fit_running_dynamics'), 'running dynamics');
  add('bikePower', count('bike', 'fit_has_power'), 'power data');
  add('chestStrap', count(null, 'fit_hrv_messages'), 'beat-to-beat data from a chest strap');
  return out;
}

export function settingsView(db: DB, secrets: SecretStore, today: string): SettingsView {
  const hr = resolveHrMax(db);
  const g = garminZoneRaw(db)?.maxHeartRateUsed;
  const rest = db
    .prepare('SELECT AVG(resting_hr) a FROM daily_health WHERE resting_hr IS NOT NULL AND local_date BETWEEN ? AND ?')
    .get(addDays(today, -6), today) as { a: number | null };
  const key = secrets.get(GARMIN_KEY);
  const first = db
    .prepare(
      `SELECT MIN(d) d FROM (SELECT MIN(local_date) d FROM daily_health WHERE resting_hr IS NOT NULL OR sleep_seconds IS NOT NULL UNION ALL SELECT MIN(local_date) FROM activities)`,
    )
    .get() as { d: string | null };
  return {
    maxHr: { value: hr.hrMax, source: hr.source, garmin: typeof g === 'number' ? g : null },
    restHr: rest.a == null ? null : Math.round(rest.a),
    runThresholdSPerKm: getSetting<number | null>(db, 'run_threshold_s_per_km', null),
    swimCssSPer100m: getSetting<number | null>(db, 'swim_css_s_per_100m', null),
    ftpW: getSetting<number | null>(db, 'ftp_w', null),
    sensors: sensors(db),
    nudges: nudges(db, today),
    openWater: getSetting<boolean>(db, 'open_water', false),
    zones: (db.prepare('SELECT zone, min_bpm, max_bpm, source FROM hr_zones WHERE sport = ? ORDER BY zone').all('DEFAULT') as Array<{ zone: number; min_bpm: number; max_bpm: number; source: string }>).map(
      (z) => ({ zone: z.zone, minBpm: z.min_bpm, maxBpm: z.max_bpm, source: z.source }),
    ),
    garmin: {
      hasKey: !!key || secrets.has(GARMIN_KEY),
      keyHint: key ? `${key.slice(0, 5)}••••••••${key.slice(-4)}` : null,
      lastOkAt: getSetting<string | null>(db, 'garmin_last_ok_at', null),
      lastError: getSetting<string | null>(db, 'garmin_last_error', null),
      lastSyncAt: getSetting<string | null>(db, 'last_sync_finished_at', null),
      historyStart: first.d,
      newActivitiesLastSync: getSetting<number | null>(db, 'last_sync_new_activities', null),
    },
    aiAvailable: false,
  };
}

const inRange = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Returns whether metrics need a recompute (max HR and sensors change load). */
export function applySettings(db: DB, patch: SettingsPatch): Result & { recompute: boolean } {
  let recompute = false;
  const numeric: Array<[keyof SettingsPatch, string, number, number, string]> = [
    ['maxHr', 'max_hr', 120, 230, 'Max HR should be between 120 and 230 bpm.'],
    ['runThresholdSPerKm', 'run_threshold_s_per_km', 150, 600, 'Threshold pace should be between 2:30 and 10:00 /km.'],
    ['swimCssSPer100m', 'swim_css_s_per_100m', 50, 240, 'CSS should be between 0:50 and 4:00 /100 m.'],
    ['ftpW', 'ftp_w', 50, 600, 'FTP should be between 50 and 600 W.'],
  ];
  for (const [field, key, lo, hi, msg] of numeric) {
    if (!(field in patch)) continue;
    const v = patch[field];
    if (v !== null && !inRange(v, lo, hi)) return { ok: false, message: msg, recompute: false };
    setSetting(db, key, v === null ? null : Math.round(v as number));
    if (field === 'maxHr') recompute = true;
  }
  if (patch.sensors) {
    const next = { ...sensors(db) };
    for (const k of Object.keys(DEFAULT_SENSORS) as Array<keyof Sensors>) if (typeof patch.sensors[k] === 'boolean') next[k] = patch.sensors[k]!;
    setSetting(db, 'sensors', next);
    recompute = true;
  }
  if (typeof patch.openWater === 'boolean') setSetting(db, 'open_water', patch.openWater);
  if (patch.dismissNudge) setSetting(db, 'nudges_dismissed', [...new Set([...getSetting<string[]>(db, 'nudges_dismissed', []), patch.dismissNudge])]);
  return { ok: true, message: 'Saved.', recompute };
}

/** Manual zones win over Garmin's. `null` goes back to Garmin's zones. */
export function setZones(db: DB, zones: Array<{ zone: number; minBpm: number; maxBpm: number }> | null): Result {
  if (zones === null) {
    db.prepare(`DELETE FROM hr_zones WHERE source = 'manual'`).run();
    const g = garminZoneRaw(db);
    const floors = g ? [g.zone1Floor, g.zone2Floor, g.zone3Floor, g.zone4Floor, g.zone5Floor] : [];
    const max = g?.maxHeartRateUsed;
    if (floors.every((f) => typeof f === 'number') && typeof max === 'number') {
      const ins = db.prepare(`INSERT OR REPLACE INTO hr_zones (sport, zone, min_bpm, max_bpm, source) VALUES ('DEFAULT', ?, ?, ?, 'garmin')`);
      floors.forEach((f, i) => ins.run(i + 1, f, i < 4 ? (floors[i + 1] as number) - 1 : max));
    }
    return { ok: true, message: "Back to Garmin's zones." };
  }
  const sorted = [...zones].sort((a, b) => a.zone - b.zone);
  if (sorted.length !== 5 || sorted.some((z, i) => z.zone !== i + 1)) return { ok: false, message: 'Give all five zones.' };
  for (let i = 0; i < 5; i++) {
    const z = sorted[i]!;
    if (!inRange(z.minBpm, 40, 230) || !inRange(z.maxBpm, 40, 240) || z.minBpm > z.maxBpm) return { ok: false, message: `Zone ${z.zone} needs a start below its end.` };
    if (i > 0 && z.minBpm <= sorted[i - 1]!.minBpm) return { ok: false, message: 'Each zone has to start above the one before it.' };
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO hr_zones (sport, zone, min_bpm, max_bpm, source) VALUES ('DEFAULT', ?, ?, ?, 'manual')`);
  db.transaction(() => sorted.forEach((z) => ins.run(z.zone, Math.round(z.minBpm), Math.round(z.maxBpm))))();
  return { ok: true, message: 'Zones saved.' };
}
