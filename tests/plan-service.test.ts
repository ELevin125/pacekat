import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/main/db';
import { addDays, eachDay } from '../src/main/util/dates';
import { computeAcwr } from '../src/main/engine';
import { PlanService } from '../src/main/plan/service';
import { openDbForTest } from './helpers';

const MON = '2026-11-16';

/** 60 days of steady daily_metrics before `until` (exclusive). */
function seedHistory(db: DB, until: string, daily = 55) {
  const days = eachDay(addDays(until, -60), addDays(until, -1)).map((date, i) => ({ date, load: i % 7 === 4 ? 0 : (daily * 7) / 6 }));
  const st = db.prepare(`INSERT OR REPLACE INTO daily_metrics VALUES (?, ?, ?, ?, ?, ?, 'x')`);
  for (const p of computeAcwr(days)) st.run(p.date, p.load, p.acute, p.chronic, p.acwr, p.band);
}

const sessions = (db: DB, from = MON, to = addDays(MON, 6)) =>
  db.prepare('SELECT id, local_date d, session_key k, status, is_key, source, matched_activity_id m FROM planned_sessions WHERE local_date BETWEEN ? AND ? ORDER BY local_date, slot, id').all(from, to) as Array<{
    id: number;
    d: string;
    k: string;
    status: string;
    is_key: number;
    source: string;
    m: number | null;
  }>;

const changes = (db: DB) => db.prepare('SELECT kind, reason, actor, session_id FROM plan_changes ORDER BY id').all() as Array<{ kind: string; reason: string; actor: string; session_id: number | null }>;

function addActivity(db: DB, date: string, sport: string, durationS: number) {
  db.prepare(`INSERT INTO activities (garmin_activity_id, local_date, sport, duration_s, raw_json, updated_at) VALUES (?, ?, ?, ?, '{}', 'x')`).run(`${date}-${sport}-${Math.random()}`, date, sport, durationS);
}

describe('PlanService', () => {
  let db: DB;
  let plan: PlanService;
  beforeEach(() => {
    db = openDbForTest();
    plan = new PlanService(db);
  });

  it('seeds the default week template', () => {
    expect(plan.template()).toHaveLength(9);
    expect((db.prepare('SELECT COUNT(*) n FROM week_template').get() as { n: number }).n).toBe(9);
  });

  it('plans the current week once; a mid-week first run starts today', () => {
    const thu = addDays(MON, 3);
    seedHistory(db, thu);
    plan.ensureWeek(thu);
    const first = sessions(db);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((s) => s.d >= thu)).toBe(true);
    plan.ensureWeek(addDays(MON, 4));
    expect(sessions(db)).toEqual(first);
    expect(changes(db).map((c) => c.kind)).toEqual(['week_generated']);
  });

  it('plans the full week from Monday when last week was planned', () => {
    seedHistory(db, addDays(MON, 7));
    plan.ensureWeek(MON);
    plan.ensureWeek(addDays(MON, 9)); // Wednesday of the next week
    expect(sessions(db, addDays(MON, 7), addDays(MON, 13))[0]!.d).toBe(addDays(MON, 7));
  });

  it('matches activities to sessions and marks missed days', () => {
    seedHistory(db, MON);
    plan.ensureWeek(MON);
    addActivity(db, MON, 'bike', 40 * 60); // Monday commute done
    plan.matchWeek(MON, addDays(MON, 3)); // Thursday
    const s = sessions(db);
    expect(s.find((x) => x.d === MON)).toMatchObject({ k: 'commute_ride', status: 'done' });
    expect(s.find((x) => x.d === MON)!.m).not.toBeNull();
    expect(s.filter((x) => x.d === addDays(MON, 1)).every((x) => x.status === 'missed')).toBe(true);
    expect(s.filter((x) => x.d > addDays(MON, 3) && x.k !== 'rest').every((x) => x.status === 'planned')).toBe(true);
  });

  it('scenario: missed key session is moved (or dropped) and logged once', () => {
    seedHistory(db, MON);
    // A week with a key on Thursday, nothing hard Fri–Sun.
    db.prepare(`INSERT INTO plan_weeks VALUES (?, 'maintain', 'maintain', 0, 400, 300, '[]', NULL, 'x')`).run(MON);
    const ins = db.prepare(`INSERT INTO planned_sessions (local_date, slot, sport, session_key, title, duration_min, intensity, is_key, status, source, est_load, notes_json, fixed) VALUES (?, 0, ?, ?, ?, ?, ?, ?, 'planned', 'engine', ?, '[]', ?)`);
    ins.run(addDays(MON, 3), 'run', 'run_intervals', 'Run intervals', 40, 'vo2', 1, 80, 0);
    ins.run(addDays(MON, 4), 'rest', 'rest', 'Rest day', 0, 'rest', 0, 0, 0);
    ins.run(addDays(MON, 5), 'bike', 'mtb_endurance', 'MTB trail ride', 90, 'z2', 0, 100, 0);
    ins.run(addDays(MON, 6), 'run', 'run_long_easy', 'Long easy run', 60, 'z2', 0, 70, 0);

    const fri = addDays(MON, 4);
    plan.afterMetrics(fri);
    const s = sessions(db);
    const original = s.find((x) => x.k === 'run_intervals' && x.d === addDays(MON, 3))!;
    expect(original.status).toBe('moved');
    expect(s.find((x) => x.k === 'run_intervals' && x.d === fri)).toMatchObject({ status: 'planned', is_key: 1 });
    const log = changes(db).filter((c) => c.kind === 'missed_moved');
    expect(log).toHaveLength(1);
    expect(log[0]!.reason).toMatch(/Moved Thursday's run intervals to Friday/);

    plan.afterMetrics(fri); // idempotent
    expect(changes(db).filter((c) => c.kind.startsWith('missed_'))).toHaveLength(1);
  });

  it('offers a readiness suggestion once; accept applies it, dismiss keeps the plan', () => {
    seedHistory(db, MON);
    plan.ensureWeek(MON);
    const sat = addDays(MON, 5);
    const key = sessions(db).find((x) => x.d === sat && x.is_key);
    // Force a key session on Saturday to make the scenario explicit.
    if (!key) db.prepare(`UPDATE planned_sessions SET is_key = 1, session_key = 'parkrun_tempo', title = 'parkrun (tempo)' WHERE local_date = ? AND slot = 0`).run(sat);
    db.prepare(`INSERT INTO readiness VALUES (?, 'easy', ?, 'x')`).run(sat, JSON.stringify({ summary: 'Short sleep.', factors: [], acwr: 1 }));
    plan.suggestForToday(sat);
    plan.suggestForToday(sat);
    const view = plan.weekView(MON, sat);
    expect(view.suggestion).not.toBeNull();
    expect(view.suggestion!.reason).toMatch(/keep it easy/);
    expect((db.prepare('SELECT COUNT(*) n FROM plan_suggestions').get() as { n: number }).n).toBe(1);

    const res = plan.acceptSuggestion(view.suggestion!.id, sat);
    expect(res.ok).toBe(true);
    expect(sessions(db).filter((x) => x.d === sat).every((x) => !x.is_key)).toBe(true);
    expect(changes(db).some((c) => c.kind === 'suggestion_accepted' && c.actor === 'user')).toBe(true);
    expect(plan.weekView(MON, sat).suggestion).toBeNull();
    expect(plan.dismissSuggestion(view.suggestion!.id).ok).toBe(false);
  });

  it('applies manual edits immediately, logs them and warns without blocking', () => {
    seedHistory(db, MON);
    plan.ensureWeek(MON);
    const s = sessions(db);
    const keyDay = s.find((x) => x.is_key)!;
    // Put another key session the day after an existing key day.
    const target = s.find((x) => x.d === addDays(keyDay.d, 1) && x.k !== 'rest' && x.k !== 'commute_ride') ?? s.find((x) => x.d === addDays(keyDay.d, 1))!;
    const res = plan.change(target.id, 'run_intervals', MON);
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.code)).toContain('key_back_to_back');
    expect(sessions(db).find((x) => x.id === target.id)).toMatchObject({ k: 'run_intervals', source: 'manual' });

    expect(plan.skip(target.id, MON).ok).toBe(true);
    expect(sessions(db).find((x) => x.id === target.id)!.status).toBe('skipped');
    expect(plan.unskip(target.id, MON).ok).toBe(true);

    const fri = addDays(MON, 4);
    const move = plan.move(target.id, fri, MON);
    expect(move.ok).toBe(true);
    expect(sessions(db).find((x) => x.id === target.id)!.d).toBe(fri);

    const two = sessions(db).filter((x) => x.k !== 'rest');
    expect(plan.swap(two[0]!.id, two[1]!.id, MON).ok).toBe(true);

    expect(plan.makeRest(addDays(MON, 6), MON).ok).toBe(true);
    expect(sessions(db, addDays(MON, 6), addDays(MON, 6)).filter((x) => x.status !== 'skipped').map((x) => x.k)).toEqual(['rest']);

    expect(changes(db).map((c) => c.kind)).toEqual(['week_generated', 'change', 'skip', 'unskip', 'move', 'swap', 'make_rest']);
    expect(changes(db).slice(1).every((c) => c.actor === 'user')).toBe(true);
  });

  it('re-plans the rest of the week when a race is added, keeping manual sessions', () => {
    seedHistory(db, MON);
    plan.ensureWeek(MON);
    const wed = addDays(MON, 2);
    const manual = sessions(db).find((x) => x.d === addDays(MON, 3))!;
    plan.change(manual.id, 'swim_easy', MON);
    const res = plan.saveRace({ name: 'Club 10k', date: addDays(MON, 5), type: '10k', priority: 'C' }, wed);
    expect(res.ok).toBe(true);
    const s = sessions(db);
    expect(s.find((x) => x.d === addDays(MON, 5) && x.k === 'race')).toBeTruthy();
    expect(s.find((x) => x.id === manual.id)).toMatchObject({ k: 'swim_easy', source: 'manual' });
    expect(changes(db).at(-1)).toMatchObject({ kind: 'regenerated', actor: 'user' });
    expect(changes(db).at(-1)!.reason).toMatch(/Added race "Club 10k"/);

    expect(plan.saveRace({ name: '', date: '2026-12-01', type: '10k', priority: 'A' }, wed).ok).toBe(false);
    expect(plan.saveRace({ name: 'x', date: '2026-12-01', type: 'triathlon', priority: 'A' }, wed).ok).toBe(false);
    const id = (db.prepare('SELECT id FROM races').get() as { id: number }).id;
    expect(plan.removeRace(id, wed).ok).toBe(true);
    expect(sessions(db).some((x) => x.k === 'race')).toBe(false);
  });

  it('previews future weeks without saving them', () => {
    seedHistory(db, MON);
    plan.ensureWeek(MON);
    const before = (db.prepare('SELECT COUNT(*) n FROM planned_sessions').get() as { n: number }).n;
    const next = plan.weekView(addDays(MON, 7), MON);
    expect(next.preview).toBe(true);
    expect(next.sessions.length).toBeGreaterThan(5);
    expect(next.sessions.every((s) => s.id < 0)).toBe(true);
    expect(plan.previewWeeks(MON, 3)).toHaveLength(3);
    expect((db.prepare('SELECT COUNT(*) n FROM planned_sessions').get() as { n: number }).n).toBe(before);
  });
});
