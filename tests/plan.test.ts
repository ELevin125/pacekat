import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE,
  PLAN,
  computeAcwr,
  generateBlock,
  generateWeek,
  isDeloadWeek,
  phaseOn,
  pickSession,
  readinessSuggestion,
  resolveMissedKey,
  toPlanSession,
  session,
  validateWeek,
  weekStartOf,
  type HistoryInput,
  type PlanSession,
  type Race,
  type StoredSession,
  type WeekInput,
  type WeekPlan,
} from '../src/main/engine';
import { addDays } from '../src/main/util/dates';

const MON = '2026-11-16'; // a Monday

/** Steady history: `daily` load on 6 days a week for `days` days before `firstDay`. */
function history(firstDay: string, daily = 55, days = 60): HistoryInput {
  const series = computeAcwr(Array.from({ length: days }, (_, i) => ({ date: addDays(firstDay, -days + i), load: i % 7 === 4 ? 0 : (daily * 7) / 6 })));
  return { lastPoint: series.at(-1)!, prevWeekLoad: daily * 7, historyDays: days };
}

const input = (over: Partial<WeekInput> = {}): WeekInput => ({ weekStart: MON, template: DEFAULT_TEMPLATE, races: [], history: history(MON), ...over });
const keyDates = (w: WeekPlan) => [...new Set(w.sessions.filter((s) => s.isKey).map((s) => s.date))].sort();
const capLoad = (w: WeekPlan) => w.sessions.filter((s) => s.sessionKey !== 'race').reduce((a, s) => a + s.estLoad, 0);
const on = (w: WeekPlan, i: number) => w.sessions.filter((s) => s.date === addDays(w.weekStart, i));
const raceA = (date: string, type: Race['type'] = 'sprint_tri'): Race => ({ id: 1, name: 'Sprint tri', date, type, priority: 'A' });

function expectSafeWeek(w: WeekPlan, maxKeys: number = PLAN.maxKeys) {
  const keys = keyDates(w);
  expect(keys.length).toBeLessThanOrEqual(maxKeys);
  for (const d of keys) expect(keys).not.toContain(addDays(d, 1));
  if (w.cap != null) expect(capLoad(w)).toBeLessThanOrEqual(w.cap * 1.01 + 1);
  // Commutes are fixed: Mon + Wed, 40 min, never key.
  for (const i of [0, 2]) {
    const c = on(w, i).find((s) => s.sessionKey === 'commute_ride');
    if (c) expect(c).toMatchObject({ durationMin: 40, isKey: false, fixed: true });
  }
}

describe('phases', () => {
  it('counts back from the next A race', () => {
    const races = [raceA('2027-03-07')];
    expect(phaseOn('2026-11-16', races)).toBe('base'); // 16 weeks out
    expect(phaseOn('2026-12-14', races)).toBe('build'); // 12 weeks out
    expect(phaseOn('2027-02-07', races)).toBe('peak'); // 4 weeks out
    expect(phaseOn('2027-02-28', races)).toBe('taper'); // 7 days out
    expect(phaseOn('2027-03-07', races)).toBe('taper'); // race day
    expect(phaseOn('2027-03-10', races)).toBe('recovery');
    expect(phaseOn('2027-03-20', races)).toBe('maintain');
  });
  it('ignores A races beyond 24 weeks and B/C races', () => {
    expect(phaseOn('2026-11-16', [raceA('2027-06-30')])).toBe('maintain');
    expect(phaseOn('2026-11-16', [{ ...raceA('2026-12-20'), priority: 'B' }])).toBe('maintain');
  });
  it('scales phases by race type', () => {
    expect(phaseOn('2027-02-15', [raceA('2027-03-07', 'marathon')])).toBe('taper'); // 20 days: marathon taper is 21
  });
  it('puts every 4th week as a recovery week', () => {
    const weeks = Array.from({ length: 12 }, (_, i) => addDays(MON, i * 7));
    expect(weeks.filter((w) => isDeloadWeek(w, [])).length).toBe(3);
    const race = [raceA(addDays(MON, 12 * 7 + 6))];
    const deloads = weeks.filter((w) => isDeloadWeek(w, race));
    expect(deloads.length).toBeGreaterThanOrEqual(2);
    for (const d of deloads) expect(['base', 'build']).toContain(phaseOn(d, race));
  });
  it('weekStartOf finds the Monday', () => {
    expect(weekStartOf('2026-11-22')).toBe(MON);
    expect(weekStartOf(MON)).toBe(MON);
  });
});

describe('session choice', () => {
  it('honours the Saturday choices', () => {
    for (const phase of ['base', 'build', 'peak', 'maintain'] as const) {
      for (const v of ['A', 'B'] as const) {
        expect(pickSession('sat_main', phase, v, { satIsKey: false, choices: ['mtb'] })).not.toMatch(/parkrun/);
        expect(pickSession('sat_main', phase, v, { satIsKey: false, choices: ['parkrun'] })).not.toMatch(/mtb/);
      }
    }
  });
  it('keeps Sunday easy after a hard Saturday', () => {
    for (const phase of ['base', 'build', 'peak', 'maintain'] as const) {
      expect(session(pickSession('sun_run', phase, 'A', { satIsKey: true })).isKey).toBe(false);
    }
  });
  it('plans open water only when available', () => {
    expect(pickSession('swim_endurance', 'peak', 'A', { satIsKey: false })).toBe('swim_endurance');
    expect(pickSession('swim_endurance', 'peak', 'A', { satIsKey: false, openWater: true })).toBe('swim_open_water');
  });
});

describe('scenario: no race (maintain mode)', () => {
  const w = generateWeek(input());
  it('follows the baseline week template', () => {
    expect(w.mode).toBe('maintain');
    expect(on(w, 0).map((s) => s.sessionKey)).toEqual(['commute_ride']);
    expect(on(w, 1).map((s) => s.sport)).toEqual(['strength', 'swim']);
    expect(on(w, 2).map((s) => s.sessionKey)).toEqual(['commute_ride']);
    expect(on(w, 3).map((s) => s.sport)).toEqual(['strength']);
    expect(on(w, 4).map((s) => s.sessionKey)).toEqual(['rest']);
    expect(on(w, 5)).toHaveLength(2);
    expect(on(w, 6)).toHaveLength(1);
  });
  it('is safe', () => expectSafeWeek(w));
  it('ramps at most 5 % in maintain mode', () => {
    expect(w.cap).toBeLessThanOrEqual(Math.round(Math.max(55 * 7, w.cap!) * 1.05));
  });
  it('alternates Saturday between MTB and parkrun', () => {
    const next = generateWeek(input({ weekStart: addDays(MON, 7), history: history(addDays(MON, 7)) }));
    expect(new Set([on(w, 5)[0]!.sessionKey, on(next, 5)[0]!.sessionKey])).toEqual(new Set(['mtb_endurance', 'parkrun_tempo']));
  });
});

describe('scenario: first week of data', () => {
  const w = generateWeek(input({ history: { lastPoint: null, prevWeekLoad: null, historyDays: 4 } }));
  it('plans conservatively', () => {
    expect(w.mode).toBe('baseline');
    expect(w.cap).toBeNull();
    expect(keyDates(w).length).toBeLessThanOrEqual(PLAN.baselineMaxKeys);
    for (const s of w.sessions.filter((x) => !x.fixed && x.sessionKey !== 'rest')) expect(s.durationMin).toBe(session(s.sessionKey).durationMin[0]);
    expect(w.notes.join(' ')).toMatch(/baseline/);
  });
  it('starts mid-week when asked', () => {
    const mid = generateWeek(input({ firstDay: addDays(MON, 3), history: { lastPoint: null, prevWeekLoad: null, historyDays: 0 } }));
    expect(mid.sessions.every((s) => s.date >= addDays(MON, 3))).toBe(true);
  });
});

describe('scenario: race in 3 weeks', () => {
  const raceDay = addDays(MON, 3 * 7 + 6); // Sunday, 3 weeks out
  const block = generateBlock(input({ races: [raceA(raceDay)] }), 5);
  it('goes peak → taper → race → recovery', () => {
    expect(block.map((w) => w.phase)).toEqual(['peak', 'peak', 'peak', 'taper', 'recovery']);
    const raceWeek = block[3]!;
    expect(raceWeek.sessions.find((s) => s.date === raceDay)).toMatchObject({ sessionKey: 'race', isKey: true, raceId: 1 });
    expect(on(raceWeek, 5).every((s) => !s.isKey)).toBe(true); // no hard day before the race
  });
  it('plans race-specific work in peak weeks', () => {
    const keys = block.slice(0, 3).flatMap((w) => w.sessions.filter((s) => s.isKey).map((s) => s.sessionKey));
    expect(keys).toEqual(expect.arrayContaining(['swim_race_pace']));
    expect(keys.some((k) => k === 'brick_race_sim' || k === 'parkrun_race')).toBe(true);
  });
  it('drops training volume by roughly half in the taper (race excluded)', () => {
    const normal = capLoad(block[0]!);
    const taper = capLoad(block[3]!);
    expect(taper / normal).toBeGreaterThan(0.4);
    expect(taper / normal).toBeLessThan(0.7);
  });
  it('keeps the week after the race easy', () => {
    expect(block[4]!.sessions.every((s) => !s.isKey && ['rest', 'z1', 'z2'].includes(s.intensity))).toBe(true);
  });
  it('is safe every week', () => block.forEach((w) => expectSafeWeek(w)));
});

describe('scenario: 8-week block toward an A race', () => {
  const block = generateBlock(input({ races: [raceA(addDays(MON, 13 * 7 + 6))] }), 8);
  it('has recovery weeks with ~30 % less load', () => {
    const deloads = block.filter((w) => w.deload);
    expect(deloads.length).toBe(2);
    for (const d of deloads) {
      const i = block.indexOf(d);
      expect(capLoad(d) / capLoad(block[i - 1]!)).toBeLessThan(0.85);
    }
  });
  it('never ramps more than 10 % over the reference', () => block.forEach((w) => expectSafeWeek(w)));
  it('never shortens parkrun below a real 5 km', () => {
    for (const s of block.flatMap((w) => w.sessions).filter((x) => x.sessionKey.startsWith('parkrun'))) {
      expect(s.durationMin).toBeGreaterThanOrEqual(session(s.sessionKey).durationMin[0]);
    }
  });
  it('introduces bricks in build', () => {
    expect(block.some((w) => w.sessions.some((s) => s.sessionKey === 'brick_build'))).toBe(true);
  });
});

describe('Sunday rule', () => {
  it('drops the Sunday run when the load ratio would get too high', () => {
    // Very little training for weeks, then two weeks at 60/day: the ratio is ~1.5 going in, and even a
    // minimum-duration week can't bring it under 1.3 by Sunday → Sunday's run goes.
    const series = computeAcwr([...Array.from({ length: 46 }, (_, i) => ({ date: addDays(MON, -60 + i), load: 5 })), ...Array.from({ length: 14 }, (_, i) => ({ date: addDays(MON, -14 + i), load: 60 }))]);
    const w = generateWeek(input({ history: { lastPoint: series.at(-1)!, prevWeekLoad: 420, historyDays: 60 } }));
    expect(on(w, 6)[0]).toMatchObject({ sessionKey: 'rest' });
    expect(w.notes.join(' ')).toMatch(/Sunday is a rest day because the load ratio/);
    expect(w.notes.join(' ')).toMatch(/Sessions shortened: recent load is high/);
  });

  it('shortens sessions first and keeps Sunday when that is enough', () => {
    const series = computeAcwr([...Array.from({ length: 46 }, (_, i) => ({ date: addDays(MON, -60 + i), load: 20 })), ...Array.from({ length: 14 }, (_, i) => ({ date: addDays(MON, -14 + i), load: 70 }))]);
    const w = generateWeek(input({ history: { lastPoint: series.at(-1)!, prevWeekLoad: 490, historyDays: 60 } }));
    expect(on(w, 6)[0]!.sport).toBe('run');
    expect(w.notes.join(' ')).not.toMatch(/step up/);
  });
});

describe('scenario: back after a break', () => {
  // Five weeks of light training, then two weeks off.
  const series = computeAcwr([
    ...Array.from({ length: 40 }, (_, i) => ({ date: addDays(MON, -54 + i), load: 15 })),
    ...Array.from({ length: 14 }, (_, i) => ({ date: addDays(MON, -14 + i), load: 0 })),
  ]);
  const block = generateBlock(input({ history: { lastPoint: series.at(-1)!, prevWeekLoad: 0, historyDays: 54 } }), 6);
  it('eases back in: lighter week, one hard session, a clear note', () => {
    const w = block[0]!;
    expect(keyDates(w).length).toBeLessThanOrEqual(1);
    expect(w.notes.join(' ')).toMatch(/Easing back in/);
    expectSafeWeek(w, 1);
  });
  it('builds back up week on week instead of stalling', () => {
    const loads = block.map((w) => w.plannedLoad);
    expect(loads.at(-1)!).toBeGreaterThan(loads[0]! * 1.2);
    for (let i = 1; i < loads.length; i++) expect(loads[i]!).toBeLessThanOrEqual(loads[i - 1]! * 1.1 + 15);
  });
});

describe('B and C races', () => {
  it('mini-tapers 3 days before a B race and keeps 2 days after easy', () => {
    const bDay = addDays(MON, 5); // Saturday
    const w = generateWeek(input({ races: [{ id: 2, name: '10k', date: bDay, type: '10k', priority: 'B' }] }));
    for (const s of w.sessions.filter((x) => x.date >= addDays(bDay, -3) && x.date < bDay && !x.fixed && x.sessionKey !== 'rest')) {
      expect(s.isKey).toBe(false);
      expect(s.notes.join(' ')).toMatch(/Mini-taper/);
    }
    expect(on(w, 6).every((s) => !s.isKey)).toBe(true);
  });
  it('treats a C race as that day’s hard session', () => {
    const cDay = addDays(MON, 5);
    const w = generateWeek(input({ races: [{ id: 3, name: 'parkrun PB attempt', date: cDay, type: '5k', priority: 'C' }] }));
    expect(on(w, 5)).toHaveLength(1);
    expect(on(w, 5)[0]).toMatchObject({ sessionKey: 'race', isKey: true });
    expectSafeWeek(w);
  });
});

describe('validators', () => {
  const s = (date: string, isKey: boolean, estLoad = 50): { date: string; isKey: boolean; estLoad: number; sessionKey: string; title: string } => ({ date, isKey, estLoad, sessionKey: 'x', title: 'x' });
  const ctx = { weekStart: MON, fromDate: MON, lastPoint: history(MON).lastPoint, rampRef: 385, weekLoadSoFar: 0, mode: 'race' as const };
  it('warns about back-to-back hard days and too many keys', () => {
    const w = validateWeek([s(MON, true), s(addDays(MON, 1), true), s(addDays(MON, 3), true), s(addDays(MON, 5), true)], ctx);
    expect(w.map((x) => x.code)).toEqual(expect.arrayContaining(['key_back_to_back', 'too_many_keys']));
  });
  it('warns about ramp and load ratio, never throws', () => {
    const w = validateWeek(Array.from({ length: 7 }, (_, i) => s(addDays(MON, i), false, 150)), ctx);
    expect(w.map((x) => x.code)).toEqual(expect.arrayContaining(['ramp', 'acwr_high']));
  });
  it('is quiet for a normal week', () => {
    expect(validateWeek([s(MON, false), s(addDays(MON, 1), true), s(addDays(MON, 5), true)], ctx)).toEqual([]);
  });
});

/* ---------- adaptation ---------- */

let nextId = 1;
const stored = (key: string, date: string, status: StoredSession['status'] = 'planned', duration?: number): StoredSession => {
  const def = session(key);
  return { ...toPlanSession(def, date, 0, duration ?? def.durationMin[0]), id: nextId++, status };
};

describe('scenario: bad sleep before a key day', () => {
  const day = addDays(MON, 5);
  const week = [stored('parkrun_tempo', day), stored('swim_endurance', day), stored('commute_ride', MON)];
  it('suggests the easy version of the key session when readiness says easy', () => {
    const sug = readinessSuggestion(day, 'easy', 'Short sleep.', week)!;
    expect(sug.kind).toBe('readiness_easy');
    expect(sug.changes).toHaveLength(1);
    expect(sug.changes[0]!.after).toMatchObject({ sessionKey: 'parkrun_easy', isKey: false });
  });
  it('suggests rest for every non-fixed session when readiness says rest', () => {
    const sug = readinessSuggestion(day, 'rest', 'Very short sleep.', week)!;
    expect(sug.changes.map((c) => c.after.sessionKey)).toEqual(['rest', 'rest']);
  });
  it('suggests nothing on a go day or when nothing applies', () => {
    expect(readinessSuggestion(day, 'go', '', week)).toBeNull();
    expect(readinessSuggestion(MON, 'easy', '', week)).toBeNull(); // commute only
  });
});

describe('scenario: missed Thursday', () => {
  const thu = addDays(MON, 3);
  const fri = addDays(MON, 4);
  const week = (): StoredSession[] => [
    stored('commute_ride', MON, 'done'),
    stored('swim_technique', addDays(MON, 1), 'done'),
    stored('commute_ride', addDays(MON, 2), 'done'),
    stored('run_intervals', thu, 'missed'),
    stored('rest', fri),
    stored('mtb_endurance', addDays(MON, 5)),
    stored('run_long_easy', addDays(MON, 6)),
  ];

  it('moves the missed key session to a safe day (rest day preferred)', () => {
    const w = week();
    const res = resolveMissedKey(w[3]!, w, fri, history(fri).lastPoint);
    expect(res).toMatchObject({ kind: 'move', toDate: fri, replaceIds: [] });
    expect(res.reason).toMatch(/Moved Thursday's run intervals to Friday/);
  });

  it('never creates back-to-back hard days', () => {
    const w = week().map((s) => (s.date === addDays(MON, 5) ? { ...stored('parkrun_tempo', s.date), id: s.id } : s));
    // Friday is next to Saturday's parkrun tempo; Sunday too → nothing fits.
    const res = resolveMissedKey(w[3]!, w, fri, history(fri).lastPoint);
    expect(res.kind).toBe('drop');
    expect(res.reason).toMatch(/Dropped/);
  });

  it('skips commute days and replaces an easy session rather than stacking', () => {
    const w = week().map((s) => (s.date === fri ? { ...stored('swim_easy', fri), id: s.id } : s));
    const res = resolveMissedKey(w[3]!, w, fri, history(fri).lastPoint);
    expect(res.kind).toBe('move');
    if (res.kind === 'move') {
      expect(res.replaceIds.length).toBe(1);
      expect([fri, addDays(MON, 5), addDays(MON, 6)]).toContain(res.toDate);
    }
  });

  it('drops it when the load ratio would get too high', () => {
    const hot = computeAcwr([...Array.from({ length: 50 }, (_, i) => ({ date: addDays(fri, -60 + i), load: 20 })), ...Array.from({ length: 10 }, (_, i) => ({ date: addDays(fri, -10 + i), load: 120 }))]).at(-1)!;
    const w = week();
    expect(resolveMissedKey(w[3]!, w, fri, hot).kind).toBe('drop');
  });
});

describe('generated sessions', () => {
  it('carry purpose, structure and targets from the library', () => {
    const w = generateWeek(input());
    for (const s of w.sessions.filter((x) => x.sessionKey !== 'rest')) {
      expect(s.purpose.length).toBeGreaterThan(10);
      expect(s.structure.main.length).toBeGreaterThan(5);
      expect(s.estLoad).toBeGreaterThan(0);
    }
  });
  it('are deterministic', () => {
    expect(generateWeek(input())).toEqual(generateWeek(input()));
  });
  it('library entries are valid', () => {
    const w: PlanSession[] = generateBlock(input({ races: [raceA(addDays(MON, 20 * 7))] }), 20).flatMap((x) => x.sessions);
    expect(w.length).toBeGreaterThan(100);
  });
});
