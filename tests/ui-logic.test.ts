import { describe, expect, it } from 'vitest';
import { clock, distance, hoursMinutes, longDate, pace, parsePace, relativeDay, resolveTarget, shortDate, weekRange } from '../src/shared/format';
import { activityText, dailyText, recapText, zoneDescription, type ActivityFacts } from '../src/main/summaries/template';
import { aggregateTrends, isEasyRun, paceAtHr, type TrendActivity, type TrendInput } from '../src/main/trends/aggregate';
import { factorValue, phaseBars, pillState, readinessSentence, sportTotals, todaysSessions, weekProgress } from '../src/renderer/view';
import type { PlanSessionView, ReadinessDay, ReadinessFactor, TimelineView } from '../src/shared/api';
import { addDays } from '../src/main/util/dates';

describe('format', () => {
  it('formats clocks, durations and paces', () => {
    expect(clock(1872)).toBe('31:12');
    expect(clock(3850)).toBe('1:04:10');
    expect(clock(null)).toBe('—');
    expect(hoursMinutes(45 * 60)).toBe('45 min');
    expect(hoursMinutes(101 * 60)).toBe('1 h 41');
    expect(hoursMinutes(48 * 60, { alwaysHours: true })).toBe('0 h 48');
    expect(pace(294)).toBe('4:54');
    expect(pace(0)).toBe('—');
    expect(parsePace('4:35')).toBe(275);
    expect(parsePace('275')).toBe(275);
    expect(parsePace('4:75')).toBeNull();
    expect(parsePace('fast')).toBeNull();
  });
  it('formats distances by sport', () => {
    expect(distance(1600, 'swim')).toBe('1 600 m');
    expect(distance(10275, 'run')).toBe('10.3 km');
    expect(distance(800)).toBe('800 m');
    expect(distance(0)).toBe('—');
  });
  it('formats dates the mockup way', () => {
    expect(longDate('2026-11-14')).toBe('Saturday 14 November');
    expect(shortDate('2026-12-27')).toBe('Sun 27 Dec');
    expect(weekRange('2026-11-09')).toBe('9 – 15 November');
    expect(weekRange('2026-11-30')).toBe('30 November – 6 December');
    expect(relativeDay('2026-11-13', '2026-11-14')).toBe('yesterday');
    expect(relativeDay('2026-11-14', '2026-11-14')).toBe('today');
    expect(relativeDay('2026-11-10', '2026-11-14')).toBe('Tue 10 Nov');
  });
  it('turns library targets into numbers when thresholds are set', () => {
    expect(resolveTarget('Threshold + 10–15 s/km', { runThresholdSPerKm: 275 })).toBe('4:45–4:50 /km');
    expect(resolveTarget('CSS + 8–10 s/100 m', { swimCssSPer100m: 108 })).toBe('1:56–1:58 /100 m');
    expect(resolveTarget('CSS', { swimCssSPer100m: 108 })).toBe('1:48 /100 m');
    expect(resolveTarget('CSS − 2 s/100 m', { swimCssSPer100m: 108 })).toBe('1:46 /100 m');
    expect(resolveTarget('Race pace', { runThresholdSPerKm: 275 })).toBe('Race pace');
    expect(resolveTarget('Threshold + 10–15 s/km', {})).toBe('Threshold + 10–15 s/km');
  });
});

describe('template summaries', () => {
  const swim: ActivityFacts = {
    kind: 'activity',
    sport: 'swim',
    title: 'Easy swim',
    duration: '31:12',
    distance_km: 1.6,
    swim_pace: '1:57 /100 m',
    zone_share: { z1: 0.18, z2: 0.52, z3: 0.24, z4: 0.06, z5: 0 },
    planned: { title: 'Easy swim', status: 'done' },
    comparisons: [],
    load: { this_session: 'light' },
    next: 'tomorrow, rest day',
  };
  it('writes 2–4 sentences from facts only', () => {
    const t = activityText(swim);
    expect(t).toBe('Easy swim done: 1 600 m in 31:12 at 1:57 /100 m. Mostly in zone 2, so it counts as an easy session. That ticks off easy swim. Next: tomorrow, rest day.');
  });
  it('falls back to load when there is no heart rate, and flags extra sessions', () => {
    const t = activityText({ kind: 'activity', sport: 'strength', title: 'Strength', duration: '45:00', comparisons: [], load: { this_session: 'moderate' } });
    expect(t).toBe('Strength done: 45:00. A moderate session for your load. An extra session, not on the plan.');
  });
  it('mentions one comparison and commutes without "extra session"', () => {
    expect(activityText({ ...swim, comparisons: ['your fastest 1600 m swim in 8 weeks (previous best 2:01 /100 m)'], next: undefined })).toMatch(/Your fastest 1600 m swim/);
    expect(activityText({ kind: 'activity', sport: 'bike', title: 'Ride', duration: '40:00', distance_km: 12, is_commute: true, comparisons: [], load: { this_session: 'light' } })).not.toMatch(/extra/);
  });
  it('varies phrasing by seed, deterministically', () => {
    const texts = new Set(Array.from({ length: 30 }, (_, i) => activityText({ ...swim, seed: i })));
    expect(texts.size).toBeGreaterThan(3);
    expect(activityText({ ...swim, seed: 7 })).toBe(activityText({ ...swim, seed: 7 }));
    for (const t of texts) expect(t).toMatch(/1 600 m in 31:12 at 1:57 \/100 m/);
  });
  it('uses a streak when there is no comparison', () => {
    expect(activityText({ ...swim, planned: undefined, next: undefined, streak: 3 })).toMatch(/Your third swim this week\./);
    expect(activityText({ ...swim, streak: 3, comparisons: ['your longest swim in 12 weeks'] })).toMatch(/Your longest swim in 12 weeks\./);
  });
  it('writes the Monday recap', () => {
    expect(recapText({ sessions_done: 7, sessions_planned: 9, hours: '5 h 10', load_change_pct: 8, focus: 'a recovery week, about 30 % lighter' })).toBe(
      'Last week: 7 of 9 sessions, 5 h 10 of training, 8 % more load than the week before. This week is a recovery week, about 30 % lighter.',
    );
    expect(recapText({ sessions_done: 3, sessions_planned: 0, hours: '2 h 00', load_change_pct: 2, focus: null })).toBe('Last week: 3 sessions, 2 h 00 of training.');
  });

  it('describes zone mixes and effort', () => {
    expect(zoneDescription({ z2: 0.7, z3: 0.3 })).toEqual({ text: 'mostly in zone 2', effort: 'easy' });
    expect(zoneDescription({ z3: 0.35, z4: 0.4, z5: 0.25 })?.effort).toBe('hard');
    expect(zoneDescription({})).toBeNull();
  });
  it('writes the daily brief from the verdict and today’s plan', () => {
    expect(dailyText({ kind: 'daily', verdict: 'easy', why: 'Take it easy: HRV 41 ms is below your normal range (46+).', today: [{ title: 'parkrun (tempo)', duration_min: 40, is_key: true, sport: 'run' }, { title: 'Endurance swim', duration_min: 40, is_key: false, sport: 'swim' }] })).toBe(
      "You're a little under-recovered: HRV 41 ms is below your normal range (46+). Today is parkrun (tempo) (40 min), then endurance swim. Keep the effort conversational and save the hard work for another day.",
    );
    expect(dailyText({ kind: 'daily', verdict: 'go', why: 'Good to go.', today: [], next_race: { name: 'Sprint tri', days: 6 } })).toBe(
      'You look recovered and good to go. Nothing planned today, so enjoy the rest. Sprint tri is in 6 days.',
    );
    expect(dailyText({ kind: 'daily', verdict: null, why: null, today: [] })).toMatch(/No readiness data yet/);
    expect(dailyText({ kind: 'daily', verdict: 'easy', why: 'Not enough data today — keep it easy.', today: [] })).toBe(
      "There isn't enough data from last night, so keep today easy to be safe. Nothing planned today, so enjoy the rest.",
    );
  });
});

describe('trend aggregation', () => {
  const MON = '2026-11-09';
  const run = (date: string, over: Partial<TrendActivity> = {}): TrendActivity => ({
    date, sport: 'run', durationS: 1800, movingS: 1800, distanceM: 5400, avgHr: 140, avgCadence: 164, load: 40,
    isCommute: false, isOpenWater: false, swimPaceSPer100m: null, swolf: null, vo2max: null, ...over,
  });
  const base = (activities: TrendActivity[], over: Partial<TrendInput> = {}): TrendInput => ({
    activities, days: [], weeks: 4, currentWeek: MON, zone2Max: 145, refHr: 140, triathlonFocus: false, runningDynamics: false, ...over,
  });

  it('computes pace at a reference heart rate', () => {
    expect(paceAtHr(run(MON), 140)).toBeCloseTo(333.3, 0);
    expect(paceAtHr(run(MON, { avgHr: 150 }), 140)).toBeCloseTo(357.1, 0);
    expect(isEasyRun(run(MON, { avgHr: 160 }), 145, 140)).toBe(false);
    expect(isEasyRun(run(MON, { movingS: 600, durationS: 600 }), 145, 140)).toBe(false);
  });

  it('buckets into Monday weeks with the current week last', () => {
    const d = aggregateTrends(base([run(addDays(MON, -21)), run(addDays(MON, -1)), run(MON), { ...run(MON), sport: 'swim', load: 30, distanceM: 1500, swimPaceSPer100m: 120, swolf: 38 }]));
    expect(d.weeks).toEqual([addDays(MON, -21), addDays(MON, -14), addDays(MON, -7), MON]);
    expect(d.load.run).toEqual([40, 0, 40, 40]);
    expect(d.load.swim).toEqual([0, 0, 0, 30]);
    expect(d.swimPace).toEqual([null, null, null, 120]);
    expect(d.swolf.at(-1)).toBe(38);
    expect(d.runEff.filter((x) => x != null)).toHaveLength(3);
  });

  it('averages commutes and recovery data', () => {
    const commute = { ...run(MON), sport: 'bike', isCommute: true, distanceM: 12_000, movingS: 1800, avgHr: 128 };
    const d = aggregateTrends(base([commute], { days: [{ date: MON, load: 40, acwr: 1.1, hrv: 60, hrvLow: 50, hrvHigh: 70, rhr: 50 }, { date: addDays(MON, 1), load: 0, acwr: 1.05, hrv: 64, hrvLow: 50, hrvHigh: 70, rhr: 52 }] }));
    expect(d.commuteSpeed.at(-1)).toBe(24);
    expect(d.commuteHr.at(-1)).toBe(128);
    expect(d.hrv.at(-1)).toBe(62);
    expect(d.rhr.at(-1)).toBe(51);
    expect(d.acwr.at(-1)).toBe(1.05);
    expect(d.acwrNow).toBe(1.05);
    expect(d.hrvBand).toEqual([50, 70]);
  });

  it('flags a small swim share for triathletes and good cadence', () => {
    const acts = [0, 1, 2, 3].flatMap((w) => [run(addDays(MON, -7 * w)), run(addDays(MON, -7 * w + 2))]);
    const d = aggregateTrends(base(acts, { triathlonFocus: true }));
    expect(d.focus.map((f) => f.title)).toEqual(['Swim is your smallest slice', 'Cadence is fine']);
    expect(d.focus[0]!.action).toBe('week');
  });

  it('notices easy runs getting faster at the same heart rate', () => {
    const acts = [0, 1, 2, 3, 4, 5].map((w) => run(addDays(MON, -7 * (5 - w)), { movingS: 1800 - w * 40, durationS: 1800 - w * 40 }));
    const d = aggregateTrends(base(acts, { weeks: 6 }));
    expect(d.focus.some((f) => f.title === 'Easy runs are getting faster')).toBe(true);
  });

  it('includes running dynamics only when the sensor is on', () => {
    expect(aggregateTrends(base([run(MON, { gctMs: 250 })])).dynamics).toBeNull();
    expect(aggregateTrends(base([run(MON, { gctMs: 250 })], { runningDynamics: true })).dynamics!.gct.at(-1)).toBe(250);
  });
});

describe('view helpers', () => {
  const f = (key: string, status: ReadinessFactor['status'], value: number | null = 1, reason = ''): ReadinessFactor => ({ key, status, value, reason });
  const day = (verdict: ReadinessDay['verdict'], factors: ReadinessFactor[]): ReadinessDay => ({ date: '2026-11-14', verdict, summary: '', factors, acwr: null });

  it('writes the readiness sentence from factor statuses', () => {
    expect(readinessSentence(day('easy', [f('hrv', 'amber'), f('yesterday_load', 'amber'), f('sleep', 'ok'), f('acwr', 'ok')]))).toBe(
      'HRV is under your normal range and yesterday was bigger than a usual day. Everything else looks fine.',
    );
    expect(readinessSentence(day('go', [f('hrv', 'ok'), f('sleep', 'ok')]))).toBe('Everything looks normal.');
    expect(readinessSentence(day('go', [f('body_battery', 'amber'), f('sleep', 'ok')]))).toBe('Good to go, but Body Battery is low. Everything else looks fine.');
    expect(readinessSentence(day('easy', [f('hrv', 'missing'), f('sleep', 'missing'), f('acwr', 'missing'), f('rhr', 'ok')]))).toMatch(/Not enough data/);
  });

  it('formats factor values', () => {
    expect(factorValue(f('yesterday_load', 'amber', 120, 'Yesterday was a big day (1.6× a usual training day).'))).toBe('1.6×');
    expect(factorValue(f('acwr', 'ok', 1.123))).toBe('1.12');
    expect(factorValue(f('hrv', 'missing', null))).toBe('—');
    expect(factorValue(f('sleep', 'ok', 78))).toBe('78');
    expect(factorValue(f('sleep', 'ok', 7.4))).toBe('7.4 h');
  });

  const s = (id: number, date: string, over: Partial<PlanSessionView> = {}): PlanSessionView => ({
    id, date, slot: 0, sport: 'run', sessionKey: 'run_easy', title: 'Easy run', durationMin: 30, intensity: 'z2', isKey: false, fixed: false,
    purpose: null, structure: null, targets: {}, estLoad: 30, notes: [], status: 'planned', source: 'engine', matchedActivityId: null, ...over,
  });

  it('picks today’s main session (key first) and counts progress', () => {
    const list = [s(1, '2026-11-14', { sport: 'swim' }), s(2, '2026-11-14', { isKey: true }), s(3, '2026-11-14', { status: 'skipped' }), s(4, '2026-11-13', { status: 'done' })];
    const t = todaysSessions(list, '2026-11-14');
    expect(t.main?.id).toBe(2);
    expect(t.later.map((x) => x.id)).toEqual([1]);
    expect(weekProgress(list, 25)).toEqual({ done: 1, total: 3, plannedMinutes: 90, doneMinutes: 25 });
    expect(pillState(s(5, 'x', { status: 'partial' }))).toBe('done');
    expect(pillState(s(5, 'x', { sport: 'rest' }))).toBe('rest');
    expect(pillState(s(5, 'x', { status: 'moved' }))).toBe('skipped');
  });

  it('sums sport totals against last week and the plan', () => {
    const t = sportTotals(
      [{ sport: 'swim', durationMin: 31, distanceKm: 1.6, isCommute: false }],
      [{ sport: 'swim', durationMin: 25 }, { sport: 'bike', durationMin: 80 }],
      [s(1, 'x', { sport: 'run', durationMin: 40 })],
    );
    expect(t).toEqual([
      { sport: 'swim', minutes: 31, lastMinutes: 25, plannedMinutes: 0, distanceKm: 1.6 },
      { sport: 'bike', minutes: 0, lastMinutes: 80, plannedMinutes: 0, distanceKm: 0 },
      { sport: 'run', minutes: 0, lastMinutes: 0, plannedMinutes: 40, distanceKm: 0 },
    ]);
  });

  it('builds the race tile phase bars up to the race', () => {
    const t: TimelineView = {
      today: '2026-11-14',
      from: '2026-09-19',
      to: '2027-02-20',
      segments: [
        { phase: 'maintain', from: '2026-09-19', to: '2026-10-01', days: 13 },
        { phase: 'base', from: '2026-10-02', to: '2026-10-30', days: 29 },
        { phase: 'build', from: '2026-10-31', to: '2026-12-26', days: 57 },
        { phase: 'peak', from: '2026-12-27', to: '2027-01-15', days: 20 },
        { phase: 'taper', from: '2027-01-16', to: '2027-01-24', days: 9 },
        { phase: 'recovery', from: '2027-01-25', to: '2027-01-31', days: 7 },
      ],
      races: [],
    };
    expect(phaseBars(t, '2027-01-24')).toEqual([
      { phase: 'base', days: 29, state: 'past' },
      { phase: 'build', days: 57, state: 'now' },
      { phase: 'peak', days: 20, state: 'future' },
      { phase: 'taper', days: 9, state: 'future' },
    ]);
  });
});
