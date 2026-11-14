import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/main/db';
import { addDays, eachDay } from '../src/main/util/dates';
import { recomputeMetrics } from '../src/main/metrics/recompute';
import { deriveDailyHealth, DERIVE_VERSION, ensureDerived } from '../src/main/sync/derive';
import { getSetting } from '../src/main/db/settings';
import { makeFit, openDbForTest } from './helpers';

const TODAY = '2026-11-14';

function addHealth(db: DB, from: string, to: string, over: Record<string, number | null> = {}) {
  const st = db.prepare(
    `INSERT OR REPLACE INTO daily_health (local_date, resting_hr, hrv_last_night_ms, hrv_low_ms, hrv_baseline_low_ms, sleep_seconds, sleep_score, body_battery_wake, derived_at)
     VALUES (@d, @rhr, @hrv, 80, 84, @sleep, @score, @bb, 'x')`,
  );
  for (const d of eachDay(from, to)) st.run({ d, rhr: 50, hrv: 90, sleep: 28800, score: 80, bb: 75, ...over });
}

let nextId = 1;
function addActivity(db: DB, a: Record<string, unknown>) {
  const row = {
    garmin_activity_id: String(nextId++),
    name: 'x',
    start_utc: `${a.local_date}T05:00:00.000Z`,
    sport: 'run',
    sub_sport: 'running',
    duration_s: 1800,
    moving_s: null,
    distance_m: 5000,
    avg_hr: 140,
    is_open_water: 0,
    rpe: null,
    fit_path: null,
    raw_json: '{}',
    updated_at: 'x',
    ...a,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO activities (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row);
  return (db.prepare('SELECT last_insert_rowid() id').get() as { id: number }).id;
}

describe('recomputeMetrics', () => {
  let db: DB;
  let fitDir: string;
  beforeEach(() => {
    db = openDbForTest();
    fitDir = mkdtempSync(join(tmpdir(), 'pacekat-metrics-'));
    db.prepare(`INSERT INTO raw_static VALUES ('hr-zones', ?, 'x')`).run(JSON.stringify([{ sport: 'DEFAULT', maxHeartRateUsed: 190, restingHeartRateUsed: 52 }]));
    db.prepare(`INSERT INTO hr_zones VALUES ('DEFAULT', 2, 115, 135, 'garmin')`).run();
  });
  afterEach(() => rmSync(fitDir, { recursive: true, force: true }));

  it('writes loads, daily metrics and readiness for the whole history', () => {
    addHealth(db, '2026-10-01', TODAY);
    for (const d of eachDay('2026-10-01', '2026-11-13')) if (d.endsWith('3') || d.endsWith('7')) addActivity(db, { local_date: d });
    const s = recomputeMetrics(db, fitDir, TODAY);

    expect(s).toMatchObject({ hrMax: 190, hrMaxSource: 'garmin', historyStart: '2026-10-01', kCalibrated: false });
    const loads = db.prepare('SELECT DISTINCT load_method m FROM activities').all();
    expect(loads).toEqual([{ m: 'avg_hr_trimp' }]);
    const days = eachDay('2026-10-01', TODAY).length;
    expect((db.prepare('SELECT COUNT(*) n FROM daily_metrics').get() as { n: number }).n).toBe(days);
    expect((db.prepare('SELECT COUNT(*) n FROM readiness').get() as { n: number }).n).toBe(days);
    // ACWR null in the first 27 days, set after.
    expect(db.prepare(`SELECT acwr FROM daily_metrics WHERE local_date = '2026-10-27'`).get()).toEqual({ acwr: null });
    expect((db.prepare(`SELECT acwr FROM daily_metrics WHERE local_date = ?`).get(TODAY) as { acwr: number }).acwr).toBeGreaterThan(0);
    expect(db.prepare('SELECT verdict FROM readiness WHERE local_date = ?').get(TODAY)).toEqual({ verdict: 'go' });
  });

  it('reads per-sample HR from the FIT file', () => {
    writeFileSync(join(fitDir, 'a.fit'), makeFit('running', { seconds: 600 }));
    addHealth(db, '2026-11-01', TODAY);
    const id = addActivity(db, { local_date: '2026-11-10', duration_s: 600, fit_path: 'a.fit' });
    recomputeMetrics(db, fitDir, TODAY);
    expect(db.prepare('SELECT load_method FROM activities WHERE id = ?').get(id)).toEqual({ load_method: 'hr_trimp' });
    const trimp = db.prepare(`SELECT value FROM activity_extras WHERE activity_id = ? AND key = 'hr_trimp'`).get(id) as { value: string };
    expect(Number(trimp.value)).toBeGreaterThan(0);
  });

  it('flags pool swims without RPE and recomputes when RPE is set', () => {
    addHealth(db, '2026-11-01', TODAY);
    const id = addActivity(db, { local_date: '2026-11-12', sport: 'swim', sub_sport: 'lap_swimming', duration_s: 1200 });
    expect(recomputeMetrics(db, fitDir, TODAY).needsRpe).toBe(1);
    expect(db.prepare('SELECT load_method FROM activities WHERE id = ?').get(id)).toEqual({ load_method: 'srpe_estimate' });
    db.prepare('UPDATE activities SET rpe = 8 WHERE id = ?').run(id);
    expect(recomputeMetrics(db, fitDir, TODAY).needsRpe).toBe(0);
    expect(db.prepare('SELECT load, load_method FROM activities WHERE id = ?').get(id)).toEqual({ load: 48, load_method: 'srpe' });
  });

  it('calibrates k from sessions with HR and RPE', () => {
    addHealth(db, '2026-10-01', TODAY);
    for (let i = 0; i < 10; i++) addActivity(db, { local_date: addDays(TODAY, -(i + 1)), rpe: 6 });
    const s = recomputeMetrics(db, fitDir, TODAY);
    expect(s.kCalibrated).toBe(true);
    expect(s.kSamples).toBe(10);
    expect(getSetting<{ k: number }>(db, 'load_k', { k: 0 }).k).toBeCloseTo(s.k);
  });

  it('auto-detects commutes but never overrides a manual flag', () => {
    addHealth(db, '2026-11-01', TODAY);
    const auto = addActivity(db, { local_date: '2026-11-11', sport: 'bike', sub_sport: 'cycling', distance_m: 12_000, avg_hr: 120 });
    const manual = addActivity(db, { local_date: '2026-11-12', sport: 'bike', sub_sport: 'cycling', distance_m: 12_000, avg_hr: 120, is_commute: 0, commute_source: 'manual' });
    recomputeMetrics(db, fitDir, TODAY);
    expect(db.prepare('SELECT is_commute, commute_source FROM activities WHERE id = ?').get(auto)).toEqual({ is_commute: 1, commute_source: 'auto' });
    expect(db.prepare('SELECT is_commute, commute_source FROM activities WHERE id = ?').get(manual)).toEqual({ is_commute: 0, commute_source: 'manual' });
  });

  it('prefers a max HR setting over Garmin', () => {
    db.prepare(`INSERT INTO settings VALUES ('max_hr', '185', 'x')`).run();
    expect(recomputeMetrics(db, fitDir, TODAY)).toMatchObject({ hrMax: 185, hrMaxSource: 'setting' });
  });

  it('handles an empty database', () => {
    expect(recomputeMetrics(db, fitDir, TODAY)).toMatchObject({ historyStart: null, activities: 0 });
  });
});

describe('re-deriving daily health', () => {
  it('rebuilds every stored day once per derive version', () => {
    const db = openDbForTest();
    db.prepare(`INSERT INTO raw_daily VALUES ('hrv-daily', '2026-11-13', ?, 'x')`).run(JSON.stringify({ lastNightAvg: 70, baseline: { lowUpper: 78, balancedLow: 82 } }));
    deriveDailyHealth(db, []); // nothing yet
    expect(ensureDerived(db)).toBe(1);
    expect(db.prepare('SELECT hrv_low_ms, hrv_baseline_low_ms FROM daily_health').get()).toEqual({ hrv_low_ms: 78, hrv_baseline_low_ms: 82 });
    expect(getSetting(db, 'derive_version', 0)).toBe(DERIVE_VERSION);
    expect(ensureDerived(db)).toBe(0);
  });
});
