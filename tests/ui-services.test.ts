import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/main/db';
import { computeAcwr } from '../src/main/engine';
import { getActivityDetail, timeInZones } from '../src/main/activities/detail';
import { activitySummary, dailySummary, loadCategory } from '../src/main/summaries/service';
import { applySettings, nudges, setZones, settingsView } from '../src/main/settings';
import { getTrends } from '../src/main/trends';
import { PlanService } from '../src/main/plan/service';
import { SecretStore } from '../src/main/secrets';
import { addDays, eachDay } from '../src/main/util/dates';
import { makeFit, openDbForTest } from './helpers';

const TODAY = '2026-11-14';
const MON = '2026-11-09';

function seedZones(db: DB) {
  const ins = db.prepare(`INSERT INTO hr_zones VALUES ('DEFAULT', ?, ?, ?, 'garmin')`);
  [[1, 100, 119], [2, 120, 139], [3, 140, 159], [4, 160, 174], [5, 175, 190]].forEach(([z, a, b]) => ins.run(z, a, b));
  db.prepare(`INSERT INTO raw_static VALUES ('hr-zones', ?, 'x')`).run(
    JSON.stringify([{ sport: 'DEFAULT', zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 160, zone5Floor: 175, maxHeartRateUsed: 190, restingHeartRateUsed: 50 }]),
  );
}

function addActivity(db: DB, over: Record<string, unknown>): number {
  const row = { garmin_activity_id: String(Math.random()), name: 'Run', local_date: TODAY, start_utc: `${TODAY}T05:00:00.000Z`, sport: 'run', sub_sport: 'running', duration_s: 1800, distance_m: 5000, avg_hr: 140, avg_pace_s_per_km: 360, load: 50, raw_json: '{}', updated_at: 'x', ...over };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO activities (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(row).lastInsertRowid);
}

describe('activity detail', () => {
  let db: DB;
  let fitDir: string;
  beforeEach(() => {
    db = openDbForTest();
    fitDir = mkdtempSync(join(tmpdir(), 'pacekat-detail-'));
    seedZones(db);
  });
  afterEach(() => rmSync(fitDir, { recursive: true, force: true }));

  it('splits heart rate into zones with capped gaps', () => {
    const z = [{ zone: 1, min: 100, max: 119 }, { zone: 2, min: 120, max: 139 }, { zone: 3, min: 140, max: 159 }, { zone: 4, min: 160, max: 174 }, { zone: 5, min: 175, max: 190 }];
    const res = timeInZones([{ t: 0, hr: 90 }, { t: 10_000, hr: 125 }, { t: 20_000, hr: 200 }, { t: 3_600_000, hr: 150 }], z)!;
    expect(res.map((x) => x.seconds)).toEqual([10, 10, 0, 0, 30]);
  });

  it('reads laps and zones from the FIT file and caches them', () => {
    writeFileSync(join(fitDir, 'a.fit'), makeFit('running', { seconds: 600, laps: 3, hr: (i) => (i < 300 ? 130 : 150) }));
    const id = addActivity(db, { fit_path: 'a.fit', fit_parsed_at: 'p1', duration_s: 600 });
    const d = getActivityDetail(db, fitDir, id)!;
    expect(d.laps).toHaveLength(3);
    expect(d.laps[0]).toMatchObject({ index: 1, distanceM: 1000, durationS: 200, avgHr: 140 });
    expect(d.laps[0]!.paceSPerKm).toBeCloseTo(200, 0);
    expect(d.zones!.find((z) => z.zone === 2)!.seconds).toBe(300);
    expect(d.zones!.find((z) => z.zone === 3)!.seconds).toBe(299);
    // Cached: deleting the file doesn't lose the detail.
    rmSync(join(fitDir, 'a.fit'));
    expect(getActivityDetail(db, fitDir, id)!.laps).toHaveLength(3);
  });

  it('includes the matched planned session', () => {
    const id = addActivity(db, {});
    db.prepare(`INSERT INTO planned_sessions (local_date, slot, sport, session_key, title, duration_min, intensity, is_key, status, source, matched_activity_id) VALUES (?, 0, 'run', 'run_easy', 'Easy run', 30, 'z2', 0, 'done', 'engine', ?)`).run(TODAY, id);
    expect(getActivityDetail(db, fitDir, id)!.planned).toMatchObject({ title: 'Easy run', status: 'done' });
    expect(getActivityDetail(db, fitDir, 9999)).toBeNull();
  });
});

describe('summaries', () => {
  let db: DB;
  beforeEach(() => {
    db = openDbForTest();
    seedZones(db);
  });

  it('caches activity text and regenerates when the facts change', () => {
    const id = addActivity(db, { name: 'Saturday parkrun' });
    const d = getActivityDetail(db, '/nonexistent', id)!;
    const first = activitySummary(db, d);
    expect(first.source).toBe('template');
    expect(first.text).toMatch(/^Saturday parkrun done: 5\.0 km in 30:00 at 6:00 \/km\./);
    expect((db.prepare('SELECT COUNT(*) n FROM summaries').get() as { n: number }).n).toBe(1);
    db.prepare(`UPDATE summaries SET text = 'cached' WHERE kind = 'activity'`).run();
    expect(activitySummary(db, d).text).toBe('cached');
    expect(activitySummary(db, { ...d, distanceM: 5200 }).text).not.toBe('cached');
    // A wording change (new template version) also rewrites it.
    db.prepare(`UPDATE summaries SET text = 'cached', facts_json = replace(facts_json, '"template":', '"template_old":')`).run();
    expect(activitySummary(db, d).text).not.toBe('cached');
  });

  it('writes the daily brief from readiness and today’s plan', () => {
    db.prepare(`INSERT INTO readiness VALUES (?, 'go', ?, 'x')`).run(TODAY, JSON.stringify({ summary: 'Good to go.', factors: [], acwr: 1 }));
    db.prepare(`INSERT INTO planned_sessions (local_date, slot, sport, session_key, title, duration_min, intensity, is_key, status, source) VALUES (?, 0, 'run', 'parkrun_tempo', 'parkrun (tempo)', 40, 'tempo', 1, 'planned', 'engine')`).run(TODAY);
    expect(dailySummary(db, TODAY).text).toBe('You look recovered and good to go. Today is parkrun (tempo) (40 min). Make the hard parts count.');
  });

  it('grades session load against a typical training day', () => {
    expect(loadCategory(30, 60)).toBe('light');
    expect(loadCategory(60, 60)).toBe('moderate');
    expect(loadCategory(100, 60)).toBe('hard');
    expect(loadCategory(150, 60)).toBe('very hard');
    expect(loadCategory(100, null)).toBe('hard');
  });
});

describe('settings', () => {
  let db: DB;
  const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
  beforeEach(() => {
    db = openDbForTest();
    seedZones(db);
  });

  it('validates and stores overrides; max HR and sensors ask for a recompute', () => {
    expect(applySettings(db, { maxHr: 185 })).toMatchObject({ ok: true, recompute: true });
    expect(applySettings(db, { runThresholdSPerKm: 275, swimCssSPer100m: 108 })).toMatchObject({ ok: true, recompute: false });
    expect(applySettings(db, { maxHr: 300 }).ok).toBe(false);
    expect(applySettings(db, { swimCssSPer100m: 20 }).ok).toBe(false);
    expect(applySettings(db, { sensors: { chestStrap: true } })).toMatchObject({ ok: true, recompute: true });
    const v = settingsView(db, new SecretStore(db, cipher), TODAY);
    expect(v.maxHr).toEqual({ value: 185, source: 'setting', garmin: 190 });
    expect(v.runThresholdSPerKm).toBe(275);
    expect(v.sensors.chestStrap).toBe(true);
    expect(v.garmin.hasKey).toBe(false);
    applySettings(db, { maxHr: null });
    expect(settingsView(db, new SecretStore(db, cipher), TODAY).maxHr.source).toBe('garmin');
  });

  it('masks the Garmin key', () => {
    const secrets = new SecretStore(db, cipher);
    secrets.set('garmin_api_key', 'GCDC_abcdefghijklmnop1234');
    expect(settingsView(db, secrets, TODAY).garmin.keyHint).toBe('GCDC_••••••••1234');
  });

  it('saves manual zones and resets to Garmin', () => {
    const zones = [1, 2, 3, 4, 5].map((z) => ({ zone: z, minBpm: 95 + z * 18, maxBpm: 95 + (z + 1) * 18 - 1 }));
    expect(setZones(db, zones).ok).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) n FROM hr_zones WHERE source = 'manual'`).get() as { n: number }).n).toBe(5);
    expect(setZones(db, zones.slice(0, 4)).ok).toBe(false);
    expect(setZones(db, zones.map((z, i) => (i === 2 ? { ...z, minBpm: 100 } : z))).ok).toBe(false);
    expect(setZones(db, null).ok).toBe(true);
    expect(db.prepare(`SELECT min_bpm, max_bpm, source FROM hr_zones WHERE zone = 2`).get()).toEqual({ min_bpm: 120, max_bpm: 139, source: 'garmin' });
  });

  it('nudges a sensor when recent FIT files show it, until dismissed', () => {
    for (let i = 0; i < 3; i++) {
      const id = addActivity(db, { sport: 'swim', local_date: addDays(TODAY, -i) });
      db.prepare(`INSERT INTO activity_extras VALUES (?, 'fit_hr_samples', '900')`).run(id);
    }
    expect(nudges(db, TODAY).map((n) => n.key)).toEqual(['swimHrStorage']);
    applySettings(db, { dismissNudge: 'swimHrStorage' });
    expect(nudges(db, TODAY)).toEqual([]);
  });
});

describe('plan service additions', () => {
  let db: DB;
  let plan: PlanService;
  beforeEach(() => {
    db = openDbForTest();
    plan = new PlanService(db);
    const st = db.prepare(`INSERT INTO daily_metrics VALUES (?, ?, ?, ?, ?, ?, 'x')`);
    for (const p of computeAcwr(eachDay(addDays(MON, -60), addDays(MON, -1)).map((date, i) => ({ date, load: i % 7 === 4 ? 0 : 64 })))) st.run(p.date, p.load, p.acute, p.chronic, p.acwr, p.band);
    plan.ensureWeek(MON);
  });

  it('undoes an accepted readiness suggestion', () => {
    const sat = addDays(MON, 5);
    db.prepare(`UPDATE planned_sessions SET is_key = 1, session_key = 'parkrun_tempo', title = 'parkrun (tempo)' WHERE local_date = ? AND slot = 0`).run(sat);
    db.prepare(`INSERT INTO readiness VALUES (?, 'easy', ?, 'x')`).run(sat, JSON.stringify({ summary: 'Short sleep.', factors: [] }));
    plan.suggestForToday(sat);
    const sug = plan.weekView(MON, sat).suggestion!;
    plan.acceptSuggestion(sug.id, sat);
    expect(plan.acceptedToday(sat)!.changes[0]).toMatchObject({ before: 'parkrun (tempo)', after: 'parkrun (easy)' });
    const res = plan.undoSuggestion(sug.id, sat);
    expect(res.ok).toBe(true);
    expect(db.prepare(`SELECT title, is_key FROM planned_sessions WHERE local_date = ? AND slot = 0`).get(sat)).toEqual({ title: 'parkrun (tempo)', is_key: 1 });
    expect(plan.acceptedToday(sat)).toBeNull();
    expect(plan.undoSuggestion(sug.id, sat).ok).toBe(false);
  });

  it('builds a phase timeline around races', () => {
    db.prepare(`INSERT INTO races (name, date, type, priority) VALUES ('Sprint tri', '2027-01-24', 'sprint_tri', 'A')`).run();
    const t = plan.timeline(TODAY);
    expect(t.from).toBe(addDays(TODAY, -56));
    expect(t.to).toBe('2027-02-21');
    // 56 days back is already inside the 24-week window before the race, so it starts in base.
    expect(t.segments.map((s) => s.phase)).toEqual(['base', 'build', 'peak', 'taper', 'recovery', 'maintain']);
    expect(t.segments.reduce((a, s) => a + s.days, 0)).toBe(eachDay(t.from, t.to).length);
    expect(t.races).toHaveLength(1);
  });

  it('saves an edited week and re-plans the rest of this week', () => {
    const slots = plan.templateView().filter((s) => !(s.weekday === 3)); // drop Thursday strength
    slots.push({ weekday: 3, slot: 0, role: 'swim_endurance' });
    expect(plan.setTemplate(slots, addDays(MON, 2)).ok).toBe(true);
    expect(plan.templateView().filter((s) => s.weekday === 3).map((s) => s.role)).toEqual(['swim_endurance']);
    const thu = db.prepare(`SELECT sport FROM planned_sessions WHERE local_date = ? AND status = 'planned'`).all(addDays(MON, 3)) as Array<{ sport: string }>;
    expect(thu.map((x) => x.sport)).toEqual(['swim']);
    expect(plan.setTemplate([{ weekday: 9, slot: 0, role: 'nonsense' }], TODAY).ok).toBe(false);
  });
});

describe('trends query', () => {
  it('aggregates straight from the database', () => {
    const db = openDbForTest();
    seedZones(db);
    addActivity(db, { local_date: MON, avg_cadence: 166, avg_hr: 130 }); // easy: at or below zone 2 (139)
    db.prepare(`INSERT INTO daily_health (local_date, resting_hr, hrv_last_night_ms, hrv_baseline_low_ms, hrv_baseline_high_ms, derived_at) VALUES (?, 50, 60, 52, 70, 'x')`).run(MON);
    const t = getTrends(db, 4, TODAY);
    expect(t.weeks.at(-1)).toBe(MON);
    expect(t.load.run.at(-1)).toBe(50);
    expect(t.refHr).toBe(130);
    expect(t.hrvBand).toEqual([52, 70]);
    expect(t.cadence.at(-1)).toBe(166);
  });
});
