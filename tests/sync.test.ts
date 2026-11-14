import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GarminAuthError, GarminNetworkError } from '../src/main/garmin/client';
import { addDays, eachDay } from '../src/main/garmin/dates';
import { BACKFILL_DAYS, SyncService } from '../src/main/sync';
import type { DB } from '../src/main/db';
import { bytes, FakeGarmin, json, makeFit, openDbForTest, zipOf } from './helpers';

const TZ = 'Africa/Johannesburg';
const NOW = new Date('2026-11-14T08:00:00Z'); // 10:00 local
const TODAY = '2026-11-14';

function qDates(spec: { path: string; query?: Record<string, unknown> }): [string, string] {
  if (spec.query?.startDate) return [String(spec.query.startDate), String(spec.query.endDate)];
  const m = /(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(spec.path)!;
  return [m[1]!, m[2]!];
}

function fakeGarmin(opts: { activities?: Array<Record<string, unknown>>; files?: Record<string, Uint8Array | 404> } = {}) {
  const acts = opts.activities ?? [];
  return new FakeGarmin([
    [/userprofile/, () => json({ displayName: 'athlete', timeZone: TZ })],
    [/heartRateZones/, () => json([{ sport: 'DEFAULT', zone1Floor: 100, zone2Floor: 120, zone3Floor: 140, zone4Floor: 160, zone5Floor: 175, maxHeartRateUsed: 190 }])],
    [/dailysummaries/, (s) => json({ data: eachDay(...qDates(s)).map((d) => ({ calendarDate: d, heartRate: { restingValue: 50 } })) })],
    [/dailySleepSummariesByDate/, (s) => json(eachDay(...qDates(s)).map((d) => ({ calendarDate: d, sleepTimeSeconds: 27000 })))],
    [/hrv\/daily/, (s) => json({ hrvSummaries: eachDay(...qDates(s)).map((d) => ({ calendarDate: d, lastNightAvg: 60 })) })],
    [/bodyBattery/, () => json([])],
    [/weight\/range/, () => json({ dailyWeightSummaries: [] })],
    [
      /search\/activities/,
      (s) => {
        const [from, to] = qDates(s);
        const start = Number(s.query?.start ?? 0);
        return json(start > 0 ? [] : acts.filter((a) => String(a.startTimeLocal).slice(0, 10) >= from && String(a.startTimeLocal).slice(0, 10) <= to));
      },
    ],
    [/\/activity-service\/activity\/\d+$/, (s) => json({ activityId: s.path.split('/').pop(), splitSummaries: [] })],
    [
      /download-service/,
      (s) => {
        const id = s.path.split('/').pop()!;
        const f = opts.files?.[id];
        if (f === 404) return json({}, 404);
        return bytes(zipOf(`${id}_ACTIVITY.fit`, f ?? makeFit('running')));
      },
    ],
  ]);
}

const run1 = { activityId: 1001, activityName: 'Easy run', activityType: { typeKey: 'running' }, startTimeLocal: '2026-11-12 06:00:00', startTimeGMT: '2026-11-12 04:00:00', duration: 1800, averageHR: 140 };
const ride1 = { activityId: 1002, activityName: 'Commute', activityType: { typeKey: 'cycling' }, startTimeLocal: '2026-11-13 07:00:00', startTimeGMT: '2026-11-13 05:00:00', duration: 1500 };

describe('SyncService', () => {
  let db: DB;
  let fitDir: string;

  beforeEach(() => {
    db = openDbForTest();
    fitDir = mkdtempSync(join(tmpdir(), 'pacekat-fit-'));
  });
  afterEach(() => rmSync(fitDir, { recursive: true, force: true }));

  const service = (g: FakeGarmin) => new SyncService({ db, client: g, fitDir, timeZone: TZ, now: () => NOW });

  it('backfills 90 days on first run, chunked to range limits', async () => {
    const g = fakeGarmin({ activities: [run1, ride1], files: { '1002': makeFit('cycling', { power: true }) } });
    const r = await service(g).run();

    expect(r.ok).toBe(true);
    expect(r.from).toBe(addDays(TODAY, -(BACKFILL_DAYS - 1)));
    expect(r.newActivities).toBe(2);

    // Sleep is limited to 31 days → 3 chunks for 90 days; daily summaries (1 year) → 1.
    expect(g.callsTo(/dailySleepSummariesByDate/)).toHaveLength(3);
    expect(g.callsTo(/dailysummaries/)).toHaveLength(1);
    expect(g.callsTo(/hrv\/daily/)).toHaveLength(4); // 28-day chunks

    const dh = db.prepare('SELECT COUNT(*) n, MIN(local_date) a, MAX(local_date) b FROM daily_health').get() as { n: number; a: string; b: string };
    expect(dh).toEqual({ n: 90, a: r.from, b: TODAY });
    expect(db.prepare('SELECT resting_hr, sleep_seconds, hrv_last_night_ms FROM daily_health WHERE local_date = ?').get(TODAY)).toEqual({
      resting_hr: 50, sleep_seconds: 27000, hrv_last_night_ms: 60,
    });

    const acts = db.prepare('SELECT garmin_activity_id, sport, fit_path, fit_status, detail_json IS NOT NULL AS has_detail FROM activities ORDER BY garmin_activity_id').all();
    expect(acts).toEqual([
      { garmin_activity_id: '1001', sport: 'run', fit_path: '1001.fit', fit_status: 'ok', has_detail: 1 },
      { garmin_activity_id: '1002', sport: 'bike', fit_path: '1002.fit', fit_status: 'ok', has_detail: 1 },
    ]);
    expect(existsSync(join(fitDir, '1001.fit'))).toBe(true);
    const power = db.prepare(`SELECT value FROM activity_extras e JOIN activities a ON a.id = e.activity_id WHERE a.garmin_activity_id = '1002' AND key = 'fit_has_power'`).get();
    expect(power).toEqual({ value: '1' });

    expect(db.prepare('SELECT zone, min_bpm, max_bpm FROM hr_zones ORDER BY zone').all()).toEqual([
      { zone: 1, min_bpm: 100, max_bpm: 119 },
      { zone: 2, min_bpm: 120, max_bpm: 139 },
      { zone: 3, min_bpm: 140, max_bpm: 159 },
      { zone: 4, min_bpm: 160, max_bpm: 174 },
      { zone: 5, min_bpm: 175, max_bpm: 190 },
    ]);

    const states = Object.fromEntries((db.prepare('SELECT data_type, last_synced_date FROM sync_state').all() as Array<{ data_type: string; last_synced_date: string }>).map((s) => [s.data_type, s.last_synced_date]));
    expect(states).toMatchObject({ 'daily-summaries': TODAY, 'sleep-summaries': TODAY, activities: TODAY, 'hr-zones': TODAY });
  });

  it('syncs incrementally from last synced day minus 2, without re-downloading files', async () => {
    await service(fakeGarmin({ activities: [run1] })).run();
    db.prepare(`UPDATE activities SET rpe = 6, is_commute = 1, commute_source = 'manual'`).run();

    const g2 = fakeGarmin({ activities: [run1, ride1] });
    const r = await service(g2).run();
    expect(r.from).toBe(addDays(TODAY, -2));
    expect(g2.callsTo(/dailySleepSummariesByDate/)).toHaveLength(1);
    expect(g2.callsTo(/dailySleepSummariesByDate/)[0]!.query).toMatchObject({ startDate: '2026-11-12', endDate: TODAY });
    // Only the new activity is downloaded.
    expect(g2.callsTo(/download-service/).map((c) => c.path.split('/').pop())).toEqual(['1002']);
    // User-entered fields survive the summary update.
    expect(db.prepare(`SELECT rpe, is_commute, commute_source FROM activities WHERE garmin_activity_id = '1001'`).get()).toEqual({ rpe: 6, is_commute: 1, commute_source: 'manual' });
  });

  it('full re-sync goes back 90 days again', async () => {
    await service(fakeGarmin()).run();
    const g = fakeGarmin();
    const r = await service(g).run({ full: true });
    expect(r.from).toBe(addDays(TODAY, -(BACKFILL_DAYS - 1)));
    expect(g.callsTo(/dailySleepSummariesByDate/)).toHaveLength(3);
  });

  it('records a failing endpoint, keeps going, and retries the gap next time', async () => {
    const g = fakeGarmin({ activities: [run1] });
    const routes = (g as unknown as { routes: Array<[RegExp, unknown]> }).routes;
    routes.unshift([/dailySleepSummariesByDate/, () => json({ err: 'boom' }, 500)]);
    const r = await service(g).run();

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('sleep-summaries'))).toBe(true);
    const sleepState = db.prepare(`SELECT last_synced_date, last_error FROM sync_state WHERE data_type = 'sleep-summaries'`).get() as { last_synced_date: string | null; last_error: string };
    expect(sleepState.last_synced_date).toBeNull();
    expect(sleepState.last_error).toMatch(/HTTP 500/);
    // Other data still synced.
    expect((db.prepare('SELECT COUNT(*) n FROM activities').get() as { n: number }).n).toBe(1);
    expect(db.prepare(`SELECT last_synced_date FROM sync_state WHERE data_type = 'hrv-daily'`).get()).toEqual({ last_synced_date: TODAY });

    // Next run backfills sleep from scratch, other types incrementally.
    const g2 = fakeGarmin({ activities: [run1] });
    await service(g2).run();
    expect(g2.callsTo(/dailySleepSummariesByDate/)).toHaveLength(3);
    expect(g2.callsTo(/hrv\/daily/)).toHaveLength(1);
  });

  it('marks activities without a downloadable file as missing and does not retry them', async () => {
    await service(fakeGarmin({ activities: [run1], files: { '1001': 404 } })).run();
    expect(db.prepare(`SELECT fit_path, fit_status FROM activities`).get()).toEqual({ fit_path: null, fit_status: 'missing' });
    const g2 = fakeGarmin({ activities: [run1] });
    await service(g2).run();
    expect(g2.callsTo(/download-service/)).toHaveLength(0);
  });

  it('retries files that errored', async () => {
    const g = fakeGarmin({ activities: [run1] });
    (g as unknown as { routes: Array<[RegExp, unknown]> }).routes.unshift([/download-service/, () => json({}, 503)]);
    const r = await service(g).run();
    expect(r.ok).toBe(false);
    expect(db.prepare(`SELECT fit_status FROM activities`).get()).toEqual({ fit_status: 'error' });

    const g2 = fakeGarmin({ activities: [run1] });
    await service(g2).run();
    expect(g2.callsTo(/download-service/)).toHaveLength(1);
    expect(db.prepare(`SELECT fit_status FROM activities`).get()).toEqual({ fit_status: 'ok' });
  });

  it('stores non-FIT uploads without failing', async () => {
    const g = fakeGarmin({ activities: [run1] });
    (g as unknown as { routes: Array<[RegExp, unknown]> }).routes.unshift([/download-service/, () => bytes(zipOf('x.gpx', new TextEncoder().encode('<gpx/>')))]);
    const r = await service(g).run();
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT fit_path, fit_status FROM activities`).get()).toEqual({ fit_path: null, fit_status: 'not_fit' });
    expect(existsSync(join(fitDir, '1001.gpx'))).toBe(true);
  });

  it('reports activities it cannot map instead of dropping them silently', async () => {
    const r = await service(fakeGarmin({ activities: [run1, { activityType: { typeKey: 'running' }, startTimeLocal: '2026-11-13 07:00:00' }] })).run();
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['activities (activity ?): skipped: missing id or start time']);
    expect((db.prepare('SELECT COUNT(*) n FROM activities').get() as { n: number }).n).toBe(1);
  });

  it('stops cleanly on an auth failure', async () => {
    const g = fakeGarmin();
    g.tokenError = new GarminAuthError('Token exchange failed: HTTP 401 (key invalid, expired or revoked?)', 401);
    const r = await service(g).run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
    expect(g.calls).toHaveLength(0);
  });

  it('stops at the first network failure instead of trying every endpoint', async () => {
    const g = fakeGarmin();
    (g as unknown as { routes: Array<[RegExp, unknown]> }).routes.unshift([
      /./,
      () => {
        throw new GarminNetworkError("Couldn't reach Garmin (ENOTFOUND).");
      },
    ]);
    const r = await service(g).run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Couldn't reach Garmin/);
    expect(g.calls).toHaveLength(1);
  });

  it('refuses to run twice at once', async () => {
    const s = service(fakeGarmin());
    const [a, b] = await Promise.all([s.run(), s.run()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)!.message).toMatch(/already running/);
  });

  it('keeps manual HR zones', async () => {
    db.prepare(`INSERT INTO hr_zones VALUES ('DEFAULT', 2, 118, 135, 'manual')`).run();
    await service(fakeGarmin()).run();
    expect(db.prepare(`SELECT min_bpm, max_bpm, source FROM hr_zones WHERE zone = 2`).get()).toEqual({ min_bpm: 118, max_bpm: 135, source: 'manual' });
  });
});
