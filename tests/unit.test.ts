import { describe, expect, it, vi } from 'vitest';
import { addDays, chunkRange, eachDay, localToday } from '../src/main/garmin/dates';
import { GarminAuthError, GarminClient, parseTokenResponse } from '../src/main/garmin/client';
import { extractActivityFiles, isFitBytes } from '../src/main/garmin/activity-file';
import { mapActivitySummary, sportFamily } from '../src/main/sync/activities';
import { splitByDay } from '../src/main/sync/split';
import { bodyBatteryAtWake, deriveDay } from '../src/main/sync/derive';
import { parseFitFacts } from '../src/main/sync/fit';
import { migrate, migrations } from '../src/main/db';
import { normaliseGarminKey, SecretStore, type Cipher } from '../src/main/secrets';
import { makeFit, openDbForTest, zipOf } from './helpers';

describe('dates', () => {
  it('chunks inclusive ranges to the max length', () => {
    expect(chunkRange('2026-01-01', '2026-01-10', 4)).toEqual([
      ['2026-01-01', '2026-01-04'],
      ['2026-01-05', '2026-01-08'],
      ['2026-01-09', '2026-01-10'],
    ]);
    expect(chunkRange('2026-01-01', '2026-01-01', 28)).toEqual([['2026-01-01', '2026-01-01']]);
    expect(chunkRange('2026-01-02', '2026-01-01', 28)).toEqual([]);
  });
  it('covers 90 days in 31-day chunks without gaps', () => {
    const to = '2026-11-14';
    const from = addDays(to, -89);
    const chunks = chunkRange(from, to, 31);
    expect(chunks.length).toBe(3);
    expect(chunks.flatMap(([a, b]) => eachDay(a, b))).toEqual(eachDay(from, to));
  });
  it('crosses month and leap-year boundaries', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('computes local today in a time zone', () => {
    // 23:30 UTC is already the next day in Johannesburg (UTC+2).
    expect(localToday('Africa/Johannesburg', new Date('2026-11-14T23:30:00Z'))).toBe('2026-11-15');
  });
});

describe('token response parsing', () => {
  it('reads OAuth2 JSON', () => {
    const t = parseTokenResponse('{"access_token":"abc","expires_in":3600}');
    expect(t.accessToken).toBe('abc');
    expect(t.expiresAt - Date.now()).toBeGreaterThan(3500_000);
    expect(t.expiresAt - Date.now()).toBeLessThanOrEqual(3600_000);
  });
  it('reads camelCase + absolute expiry', () => {
    const at = Date.now() + 10_000;
    expect(parseTokenResponse(JSON.stringify({ accessToken: 'x', expiresAt: at })).expiresAt).toBe(at);
  });
  it('accepts a bare token string and reports shape without values', () => {
    const shape = vi.fn();
    expect(parseTokenResponse('rawtoken', shape).accessToken).toBe('rawtoken');
    parseTokenResponse('{"access_token":"secret","expires_in":1}', shape);
    expect(JSON.stringify(shape.mock.calls)).not.toContain('secret');
  });
  it('rejects JSON without a token', () => {
    expect(() => parseTokenResponse('{"foo":1}')).toThrow(GarminAuthError);
  });
});

describe('GarminClient', () => {
  const mkFetch = (handler: (url: string, init: RequestInit) => Response) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const tokenRes = () => new Response(JSON.stringify({ access_token: 'T', expires_in: 86400 }), { status: 200 });

  it('exchanges the key with ApiKey header, then uses Bearer', async () => {
    const f = mkFetch((url, init) => {
      if (url.endsWith('/token')) {
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).Authorization).toBe('ApiKey GCDC_k');
        expect((init.headers as Record<string, string>).Accept).toBe('*/*'); // JSON-only Accept → 406 from Garmin
        return tokenRes();
      }
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer T');
      return new Response('[1,2]', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const c = new GarminClient({ apiKey: 'GCDC_k', baseUrl: 'http://x', fetchImpl: f as typeof fetch, minIntervalMs: 0 });
    const r = await c.get({ path: '/a', query: { d: '2026-01-01' } });
    expect(r.ok && r.json).toEqual([1, 2]);
    expect(String(f.mock.calls[1]![0])).toBe('http://x/a?d=2026-01-01');
  });

  it('retries 429 and re-authenticates once on 401', async () => {
    let n = 0;
    let tokens = 0;
    const f = mkFetch((url) => {
      if (url.endsWith('/token')) {
        tokens++;
        return tokenRes();
      }
      n++;
      if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      if (n === 2) return new Response('', { status: 401 });
      return new Response('{"ok":true}', { status: 200 });
    });
    const c = new GarminClient({ apiKey: 'GCDC_k', baseUrl: 'http://x', fetchImpl: f as typeof fetch, minIntervalMs: 0 });
    const r = await c.get({ path: '/a' });
    expect(r.ok).toBe(true);
    expect(tokens).toBe(2);
  });

  it('reuses a cached token from the store', async () => {
    const f = mkFetch(() => new Response('null', { status: 200 }));
    const c = new GarminClient({
      apiKey: 'GCDC_k', baseUrl: 'http://x', fetchImpl: f as typeof fetch, minIntervalMs: 0,
      tokenStore: { load: () => ({ accessToken: 'cached', expiresAt: Date.now() + 5 * 3600_000 }), save: () => {} },
    });
    await c.get({ path: '/a' });
    expect(f.mock.calls.every(([u]) => !String(u).endsWith('/token'))).toBe(true);
  });

  it('turns a rejected key into GarminAuthError', async () => {
    const f = mkFetch(() => new Response('', { status: 401 }));
    const c = new GarminClient({ apiKey: 'GCDC_k', baseUrl: 'http://x', fetchImpl: f as typeof fetch, minIntervalMs: 0 });
    await expect(c.ensureToken()).rejects.toBeInstanceOf(GarminAuthError);
  });

  it('returns null for 204 No Content', async () => {
    const f = mkFetch((url) => (url.endsWith('/token') ? tokenRes() : new Response(null, { status: 204 })));
    const c = new GarminClient({ apiKey: 'GCDC_k', baseUrl: 'http://x', fetchImpl: f as typeof fetch, minIntervalMs: 0 });
    const r = await c.get({ path: '/hrv' });
    expect(r.ok && r.json).toBeNull();
  });
});

describe('activity files', () => {
  it('unzips the original FIT', () => {
    const fit = makeFit('running');
    const files = extractActivityFiles(zipOf('123_ACTIVITY.fit', fit), '123');
    expect(files).toHaveLength(1);
    expect(files[0]!.ext).toBe('fit');
    expect(isFitBytes(files[0]!.bytes)).toBe(true);
  });
  it('accepts a bare FIT', () => {
    expect(extractActivityFiles(makeFit('running'), '9')[0]!.name).toBe('9.fit');
  });
  it('extracts FIT facts', () => {
    const f = parseFitFacts(makeFit('cycling', { seconds: 30, power: true, vo2: 51 }));
    expect(f.status).toBe('ok');
    expect(f.extras).toMatchObject({ fit_sport: 'cycling', fit_records: 30, fit_hr_samples: 30, fit_has_power: 1, fit_vo2max: 51 });
  });
  it('reports garbage as an error', () => {
    expect(parseFitFacts(new Uint8Array([1, 2, 3])).status).toBe('error');
  });
});

describe('activity mapping', () => {
  it('maps sport families', () => {
    expect(sportFamily('lap_swimming')).toBe('swim');
    expect(sportFamily('open_water_swimming')).toBe('swim');
    expect(sportFamily('mountain_biking')).toBe('bike');
    expect(sportFamily('road_biking')).toBe('bike');
    expect(sportFamily('indoor_cycling')).toBe('bike');
    expect(sportFamily('trail_running')).toBe('run');
    expect(sportFamily('strength_training')).toBe('strength');
    expect(sportFamily('yoga')).toBe('other');
  });
  it('maps a run summary', () => {
    const r = mapActivitySummary(
      {
        activityId: 42, activityName: 'Parkrun', activityType: { typeKey: 'running' },
        startTimeGMT: '2026-11-14 06:00:00', startTimeLocal: '2026-11-14 08:00:00',
        duration: 1471, distance: 5000, averageSpeed: 5000 / 1471, averageHR: 168.4,
        averageRunningCadenceInStepsPerMinute: 172, vO2MaxValue: 52, activityTrainingLoad: 140.2,
      },
      'Africa/Johannesburg',
    )!;
    expect(r).toMatchObject({ garmin_activity_id: '42', sport: 'run', local_date: '2026-11-14', start_utc: '2026-11-14T06:00:00.000Z', avg_hr: 168, avg_cadence: 172, vo2max: 52 });
    expect(r.avg_pace_s_per_km).toBeCloseTo(294.2, 1);
  });
  it('maps pool length in centimetres with factor', () => {
    const r = mapActivitySummary(
      { activityId: 1, activityType: { typeKey: 'lap_swimming' }, startTimeLocal: '2026-11-11 06:00:00', poolLength: 2500, unitOfPoolLength: { factor: 100 }, averageSpeed: 0.8 },
      'UTC',
    )!;
    expect(r.pool_length_m).toBe(25);
    expect(r.swim_pace_s_per_100m).toBe(125);
  });
  it('falls back to UTC start for local date', () => {
    const r = mapActivitySummary({ activityId: 1, activityType: { typeKey: 'running' }, startTimeGMT: '2026-11-14 23:30:00' }, 'Africa/Johannesburg')!;
    expect(r.local_date).toBe('2026-11-15');
  });
  it('rejects summaries without id or date', () => {
    expect(mapActivitySummary({ activityType: { typeKey: 'running' } }, 'UTC')).toBeNull();
    expect(mapActivitySummary({ activityId: 1 }, 'UTC')).toBeNull();
  });
});

describe('splitting range responses', () => {
  it('splits each documented shape', () => {
    expect(splitByDay('daily-summaries', { data: [{ calendarDate: '2026-11-01' }, { calendarDate: '2026-11-02' }] }).map((x) => x.date)).toEqual(['2026-11-01', '2026-11-02']);
    expect(splitByDay('sleep-summaries', [{ calendarDate: '2026-11-01' }])).toHaveLength(1);
    expect(splitByDay('hrv-daily', { hrvSummaries: [{ calendarDate: '2026-11-01' }] })).toHaveLength(1);
    expect(splitByDay('body-battery', [{ date: '2026-11-01' }])).toHaveLength(1);
    expect(splitByDay('weight-range', { dailyWeightSummaries: [{ summaryDate: '2026-11-01' }] })).toHaveLength(1);
    expect(splitByDay('hrv-daily', null)).toEqual([]);
  });
  it('throws on an unexpected shape', () => {
    expect(() => splitByDay('sleep-summaries', { nope: 1 })).toThrow();
  });
});

describe('deriving daily health', () => {
  const wake = Date.parse('2026-11-14T04:30:00Z');
  const bb = {
    bodyBatteryValueDescriptorDTOList: [
      { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: 'timestamp' },
      { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: 'bodyBatteryStatus' },
      { bodyBatteryValueDescriptorIndex: 2, bodyBatteryValueDescriptorKey: 'bodyBatteryLevel' },
    ],
    bodyBatteryValuesArray: [
      [wake - 600_000, 'X', 70],
      [wake + 120_000, 'X', 78],
      [wake + 3600_000, 'X', 75],
    ],
  };
  const sleep = { sleepEndTimestampGMT: '2026-11-14T04:30:00.0', sleepTimeSeconds: 26000, sleepScores: { overall: { value: 81 } } };

  it('finds Body Battery at wake using descriptor columns', () => {
    expect(bodyBatteryAtWake(bb, sleep)).toBe(78);
    expect(bodyBatteryAtWake(bb, null)).toBeNull();
  });

  it('maps all sources into one row', () => {
    const d = deriveDay('2026-11-14', {
      'daily-summaries': {
        heartRate: { restingValue: 48 }, bodyBattery: { minValue: 20, maxValue: 90 }, stress: { avgLevel: 31 },
        respiration: { avgValue: 14 }, pulseOx: { avgValue: 96 }, movement: { steps: { value: 9000 } },
      },
      'sleep-summaries': sleep,
      'hrv-daily': { lastNightAvg: 62, weeklyAvg: 58, baseline: { lowUpper: 45, balancedLow: 50, balancedUpper: 66 }, status: 'BALANCED' },
      'body-battery': bb,
      'weight-range': { latestWeight: { weight: 78.4 } },
    });
    expect(d).toMatchObject({
      resting_hr: 48, hrv_last_night_ms: 62, hrv_weekly_avg_ms: 58, hrv_baseline_low_ms: 50, hrv_baseline_high_ms: 66,
      hrv_status: 'BALANCED', sleep_seconds: 26000, sleep_score: 81, body_battery_wake: 78, body_battery_min: 20,
      body_battery_max: 90, stress_avg: 31, respiration_avg: 14, spo2_avg: 96, steps: 9000, weight_kg: 78.4,
    });
  });

  it('converts grams to kg defensively', () => {
    expect(deriveDay('2026-11-14', { 'weight-range': { allWeightMetrics: [{ weight: 78400 }] } }).weight_kg).toBe(78.4);
  });

  it('leaves missing data as null', () => {
    const d = deriveDay('2026-11-14', {});
    expect(Object.entries(d).filter(([k, v]) => k !== 'local_date' && v !== null)).toEqual([]);
  });
});

describe('database', () => {
  it('applies migrations once', () => {
    const db = openDbForTest();
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.at(-1)!.version);
    expect(migrate(db)).toBe(0);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['activities', 'daily_health', 'raw_daily', 'sync_state', 'secrets', 'planned_sessions']));
  });
});

describe('secrets', () => {
  const fakeCipher = (available = true): Cipher => ({
    isAvailable: () => available,
    encrypt: (s) => Buffer.from([...Buffer.from(s)].reverse()),
    decrypt: (b) => Buffer.from([...b].reverse()).toString(),
  });

  it('stores values encrypted', () => {
    const db = openDbForTest();
    const s = new SecretStore(db, fakeCipher());
    s.set('k', 'GCDC_secret');
    expect(s.get('k')).toBe('GCDC_secret');
    const raw = (db.prepare('SELECT value FROM secrets').get() as { value: Buffer }).value;
    expect(raw.toString()).not.toContain('GCDC_secret');
  });
  it('refuses to store without OS encryption', () => {
    expect(() => new SecretStore(openDbForTest(), fakeCipher(false)).set('k', 'v')).toThrow(/encryption/);
  });
  it('round-trips the token cache', () => {
    const store = new SecretStore(openDbForTest(), fakeCipher()).tokenStore();
    expect(store.load()).toBeNull();
    store.save({ accessToken: 'a', expiresAt: 1 });
    expect(store.load()).toEqual({ accessToken: 'a', expiresAt: 1 });
  });
  it('validates pasted keys', () => {
    expect(normaliseGarminKey('  GCDC_abc \n')).toEqual({ ok: true, key: 'GCDC_abc' });
    expect(normaliseGarminKey('ApiKey GCDC_abc')).toEqual({ ok: true, key: 'GCDC_abc' });
    expect(normaliseGarminKey('abc').ok).toBe(false);
    expect(normaliseGarminKey('').ok).toBe(false);
    expect(normaliseGarminKey('GCDC_a b').ok).toBe(false);
  });
});
