import { describe, expect, it } from 'vitest';
import {
  ACWR,
  LOAD,
  activityLoad,
  avgHrTrimp,
  calibrateK,
  computeAcwr,
  computeReadiness,
  detectCommute,
  hrReserve,
  hrTrimp,
  matchPlanned,
  projectAcwr,
  weekdayOf,
  type DayHealth,
  type HrSample,
  type LoadContext,
} from '../src/main/engine';

const ctx: LoadContext = { hrRest: 50, hrMax: 190, k: 0.3, swimHrStorage: false };

/** n samples every `every` seconds at a fixed HR. */
const steady = (hr: number, minutes: number, every = 1): HrSample[] =>
  Array.from({ length: Math.floor((minutes * 60) / every) + 1 }, (_, i) => ({ t: i * every * 1000, hr }));

describe('load', () => {
  it('clamps heart-rate reserve', () => {
    expect(hrReserve(40, 50, 190)).toBe(0);
    expect(hrReserve(200, 50, 190)).toBe(1);
    expect(hrReserve(120, 50, 190)).toBeCloseTo(0.5);
  });

  it('matches the Banister formula for a steady hour', () => {
    // HRr 0.5 → 0.5 × 0.64 × e^0.96 per minute.
    const expected = 60 * 0.5 * 0.64 * Math.exp(1.92 * 0.5);
    expect(hrTrimp(steady(120, 60), 50, 190)).toBeCloseTo(expected, 1);
    expect(avgHrTrimp(60, 120, 50, 190)).toBeCloseTo(expected, 6);
  });

  it('gives the same TRIMP for smart recording (6 s) as per-second', () => {
    expect(hrTrimp(steady(140, 45, 6), 50, 190)).toBeCloseTo(hrTrimp(steady(140, 45, 1), 50, 190), 1);
  });

  it('caps gaps so a paused activity does not gain load', () => {
    const paused = [...steady(140, 10), ...steady(140, 10).map((s) => ({ ...s, t: s.t + 40 * 60_000 }))];
    // The 40-minute gap counts as at most the 30 s cap, not 40 minutes.
    const cappedGap = steady(140, 20 + LOAD.maxSampleGapS / 60);
    expect(hrTrimp(paused, 50, 190)).toBeCloseTo(hrTrimp(cappedGap, 50, 190), 1);
  });

  it('uses per-sample HR when coverage is good, else average HR', () => {
    const full = activityLoad({ sport: 'run', isOpenWater: false, durationS: 1800, hrSamples: steady(150, 30), avgHr: 150 }, ctx);
    expect(full.method).toBe('hr_trimp');
    const sparse = activityLoad({ sport: 'run', isOpenWater: false, durationS: 1800, hrSamples: steady(150, 5), avgHr: 150 }, ctx);
    expect(sparse.method).toBe('avg_hr_trimp');
  });

  it('uses RPE for pool swims (wrist HR unreliable) and flags a missing RPE', () => {
    const noRpe = activityLoad({ sport: 'swim', isOpenWater: false, durationS: 1200, avgHr: 130 }, ctx);
    expect(noRpe).toMatchObject({ method: 'srpe_estimate', needsRpe: true });
    expect(noRpe.load).toBeCloseTo(20 * LOAD.placeholderRpe * 0.3);
    const withRpe = activityLoad({ sport: 'swim', isOpenWater: false, durationS: 1200, avgHr: 130, rpe: 7 }, ctx);
    expect(withRpe).toMatchObject({ method: 'srpe', needsRpe: false });
    expect(withRpe.load).toBeCloseTo(20 * 7 * 0.3);
  });

  it('trusts pool HR when the strap stores swim HR, and open water uses HR', () => {
    expect(activityLoad({ sport: 'swim', isOpenWater: false, durationS: 1200, avgHr: 130 }, { ...ctx, swimHrStorage: true }).method).toBe('avg_hr_trimp');
    expect(activityLoad({ sport: 'swim', isOpenWater: true, durationS: 1200, avgHr: 130 }, ctx).method).toBe('avg_hr_trimp');
  });

  it('takes the higher of HR and effort for strength', () => {
    const low = activityLoad({ sport: 'strength', isOpenWater: false, durationS: 3600, avgHr: 95, rpe: 7 }, ctx);
    expect(low.method).toBe('strength_max');
    expect(low.load).toBeCloseTo(60 * 7 * 0.3);
    const high = activityLoad({ sport: 'strength', isOpenWater: false, durationS: 3600, avgHr: 170, rpe: 3 }, ctx);
    expect(high.method).toBe('avg_hr_trimp');
    expect(activityLoad({ sport: 'strength', isOpenWater: false, durationS: 3600, avgHr: 95 }, ctx).needsRpe).toBe(true);
  });

  it('prefers moving time over elapsed time', () => {
    const a = activityLoad({ sport: 'other', isOpenWater: false, durationS: 3600, movingS: 1800, avgHr: 120 }, ctx);
    expect(a.load).toBeCloseTo(avgHrTrimp(30, 120, 50, 190));
  });

  it('falls back to RPE without HR', () => {
    expect(activityLoad({ sport: 'run', isOpenWater: false, durationS: 1800 }, ctx)).toMatchObject({ method: 'srpe_estimate', needsRpe: true });
  });

  it('calibrates k only with enough sessions, clamped', () => {
    expect(calibrateK([{ trimp: 50, srpe: 100 }])).toEqual({ k: LOAD.defaultK, samples: 1, calibrated: false });
    const pairs = Array.from({ length: 11 }, (_, i) => ({ trimp: 40 + i, srpe: 100 }));
    expect(calibrateK(pairs)).toEqual({ k: 0.45, samples: 11, calibrated: true });
    expect(calibrateK(Array.from({ length: 10 }, () => ({ trimp: 500, srpe: 100 }))).k).toBe(LOAD.kMax);
  });
});

describe('ACWR', () => {
  const days = (loads: number[]) => loads.map((load, i) => ({ date: `d${String(i).padStart(3, '0')}`, load }));

  it('is null while building a baseline', () => {
    const s = computeAcwr(days(Array(ACWR.minHistoryDays - 1).fill(50)));
    expect(s.at(-1)!.acwr).toBeNull();
    expect(s.at(-1)!.band).toBe('building');
  });

  it('settles near 1 with steady load', () => {
    const s = computeAcwr(days(Array(200).fill(60)));
    expect(s.at(-1)!.acwr).toBeCloseTo(1, 2);
    expect(s.at(-1)!.band).toBe('sweet_spot');
  });

  it('rises above 1.5 after a sudden spike', () => {
    const s = computeAcwr(days([...Array(60).fill(40), ...Array(7).fill(160)]));
    expect(s.at(-1)!.acwr!).toBeGreaterThan(1.5);
    expect(s.at(-1)!.band).toBe('high_risk');
  });

  it('projection continues the series identically', () => {
    const loads = [...Array(40).fill(50), 120, 0, 80];
    const full = computeAcwr(days(loads));
    const head = computeAcwr(days(loads.slice(0, 40)));
    const proj = projectAcwr(head.at(-1)!, days(loads).slice(40));
    expect(proj.at(-1)!.acwr).toBeCloseTo(full.at(-1)!.acwr!, 10);
  });
});

describe('readiness', () => {
  const good = (date = 'd'): DayHealth => ({ date, restingHr: 50, hrvLastNight: 90, hrvLow: 80, hrvBaselineLow: 84, sleepSeconds: 8 * 3600, sleepScore: 80, bodyBatteryWake: 75 });
  const prev = (n = 7, over: Partial<DayHealth> = {}) => Array.from({ length: n }, (_, i) => ({ ...good(`p${i}`), ...over }));
  const base = { previous: prev(), acwr: 1.0, yesterdayLoad: 60, typicalDayLoad28: 60 };

  it('goes on a normal morning', () => {
    const r = computeReadiness({ ...base, today: good() });
    expect(r.verdict).toBe('go');
    expect(r.factors.every((f) => f.status === 'ok')).toBe(true);
    expect(r.factors.map((f) => f.key)).toEqual(['hrv', 'resting_hr', 'sleep', 'body_battery', 'acwr', 'yesterday_load']);
  });

  it('any red → rest, with that reason', () => {
    const r = computeReadiness({ ...base, today: { ...good(), sleepSeconds: 4.5 * 3600 } });
    expect(r.verdict).toBe('rest');
    expect(r.summary).toMatch(/sleep/i);
    expect(computeReadiness({ ...base, acwr: 1.6, today: good() }).verdict).toBe('rest');
    expect(computeReadiness({ ...base, yesterdayLoad: 200, today: good() }).verdict).toBe('rest');
    expect(computeReadiness({ ...base, today: { ...good(), restingHr: 58 } }).verdict).toBe('rest');
  });

  it('two independent ambers → easy', () => {
    const r = computeReadiness({ ...base, acwr: 1.4, today: { ...good(), sleepScore: 55 } });
    expect(r.verdict).toBe('easy');
    expect(r.summary).toMatch(/^Take it easy:/);
  });

  it('HRV + Body Battery amber together count once (same underlying signal)', () => {
    const r = computeReadiness({ ...base, today: { ...good(), hrvLastNight: 75, bodyBatteryWake: 40 } });
    expect(r.factors.filter((f) => f.status === 'amber').map((f) => f.key)).toEqual(['hrv', 'body_battery']);
    expect(r.verdict).toBe('go');
    expect(r.summary).toMatch(/^Good to go\. Watch:/);
    // …but a third, independent amber tips it to easy.
    expect(computeReadiness({ ...base, today: { ...good(), hrvLastNight: 75, bodyBatteryWake: 40, sleepScore: 55 } }).verdict).toBe('easy');
  });

  it("uses Garmin's low line for HRV, falling back to the balanced floor", () => {
    // 82 is under the balanced floor (84) but above Garmin's low line (80) → fine.
    expect(computeReadiness({ ...base, today: { ...good(), hrvLastNight: 82 } }).factors[0]!.status).toBe('ok');
    expect(computeReadiness({ ...base, today: { ...good(), hrvLastNight: 82, hrvLow: null } }).factors[0]!.status).toBe('amber');
  });

  it('HRV low 3 nights running → red', () => {
    const low = { hrvLastNight: 70 };
    const r = computeReadiness({ ...base, previous: [{ ...good('p0'), ...low }, { ...good('p1'), ...low }, ...prev(5)], today: { ...good(), ...low } });
    expect(r.factors[0]).toMatchObject({ status: 'red' });
    expect(r.verdict).toBe('rest');
    const twoNights = computeReadiness({ ...base, previous: [{ ...good('p0'), ...low }, ...prev(6)], today: { ...good(), ...low } });
    expect(twoNights.factors[0]!.status).toBe('amber');
  });

  it('resting HR compares to the 7-day mean', () => {
    const r = (rhr: number) => computeReadiness({ ...base, today: { ...good(), restingHr: rhr } }).factors[1]!.status;
    expect(r(54)).toBe('ok');
    expect(r(55)).toBe('amber');
    expect(r(58)).toBe('red');
    expect(computeReadiness({ ...base, previous: prev(2), today: good() }).factors[1]!.status).toBe('missing');
  });

  it('missing data → easy, conservatively', () => {
    const empty: DayHealth = { date: 'd', restingHr: null, hrvLastNight: null, hrvBaselineLow: null, sleepSeconds: null, sleepScore: null, bodyBatteryWake: null };
    const r = computeReadiness({ ...base, today: empty });
    expect(r.verdict).toBe('easy');
    expect(r.summary).toMatch(/Not enough data/);
  });

  it('describes a very low load ratio as fresh, not as risk', () => {
    const f = computeReadiness({ ...base, acwr: 0.3, today: good() }).factors[4]!;
    expect(f.status).toBe('ok');
    expect(f.reason).toMatch(/less than usual/);
  });

  it('skips the yesterday rule without a meaningful average', () => {
    const r = computeReadiness({ ...base, yesterdayLoad: 100, typicalDayLoad28: 2, today: good() });
    expect(r.factors[5]!.status).toBe('missing');
  });
});

describe('commute detection', () => {
  it('weekday maps Monday to 0', () => {
    expect(weekdayOf('2026-11-16')).toBe(0); // Monday
    expect(weekdayOf('2026-11-15')).toBe(6); // Sunday
  });
  const ride = { sport: 'bike', localDate: '2026-11-16', distanceM: 12_000, avgHr: 120 };
  it('flags an easy weekday ride of commute length', () => {
    expect(detectCommute(ride, 136).isCommute).toBe(true);
  });
  it('rejects weekends, long rides, hard efforts and non-rides', () => {
    expect(detectCommute({ ...ride, localDate: '2026-11-15' }, 136).isCommute).toBe(false);
    expect(detectCommute({ ...ride, distanceM: 30_000 }, 136).isCommute).toBe(false);
    expect(detectCommute({ ...ride, avgHr: 150 }, 136).isCommute).toBe(false);
    expect(detectCommute({ ...ride, sport: 'run' }, 136).isCommute).toBe(false);
    expect(detectCommute(ride, null).isCommute).toBe(false);
  });
});

describe('planned vs done', () => {
  const p = (id: number, sport: 'run' | 'bike' | 'swim' | 'rest', durationMin: number, localDate = '2026-11-12', status: 'planned' | 'skipped' = 'planned') => ({ id, localDate, sport, durationMin, status });
  const a = (id: number, sport: 'run' | 'bike' | 'swim', durationS: number, localDate = '2026-11-12') => ({ id, localDate, sport, durationS });

  it('matches by date + sport and grades by duration', () => {
    const { matches, extras } = matchPlanned([p(1, 'run', 40), p(2, 'bike', 60)], [a(10, 'run', 2400), a(11, 'bike', 1500), a(12, 'swim', 1200)], '2026-11-14');
    expect(matches).toEqual(
      expect.arrayContaining([
        { plannedId: 1, status: 'done', activityId: 10 },
        { plannedId: 2, status: 'partial', activityId: 11 },
      ]),
    );
    expect(extras).toEqual([12]);
  });

  it('picks the closest duration when several match', () => {
    const { matches } = matchPlanned([p(1, 'run', 30)], [a(10, 'run', 600), a(11, 'run', 1750)], '2026-11-14');
    expect(matches[0]).toEqual({ plannedId: 1, status: 'done', activityId: 11 });
  });

  it('marks past unmatched sessions missed, future ones planned', () => {
    const { matches } = matchPlanned([p(1, 'run', 30, '2026-11-10'), p(2, 'run', 30, '2026-11-20')], [], '2026-11-14');
    expect(matches.map((m) => m.status)).toEqual(['missed', 'planned']);
  });

  it('keeps user statuses and ignores rest days', () => {
    const { matches, extras } = matchPlanned([p(1, 'run', 30, '2026-11-12', 'skipped'), p(2, 'rest', 0)], [a(10, 'run', 1800)], '2026-11-14');
    expect(matches.map((m) => m.status)).toEqual(['skipped', 'planned']);
    expect(extras).toEqual([10]);
  });

  it('does not let one activity satisfy two sessions', () => {
    const { matches } = matchPlanned([p(1, 'run', 30), p(2, 'run', 30)], [a(10, 'run', 1800)], '2026-11-14');
    expect(matches.filter((m) => m.activityId === 10)).toHaveLength(1);
  });
});
