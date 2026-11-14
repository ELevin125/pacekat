import type { DB } from '../db';
import { nowIso } from '../db/util';
import { getSetting } from '../db/settings';
import { addDays, daysBetween, eachDay } from '../util/dates';
import {
  DEFAULT_TEMPLATE,
  LIBRARY,
  RACE_TYPES,
  generateBlock,
  generateWeek,
  matchPlanned,
  projectAcwr,
  readinessSuggestion,
  resolveMissedKey,
  restSession,
  toPlanSession,
  validateWeek,
  weekStartOf,
  type DailyLoadPoint,
  type HistoryInput,
  type PlanSession,
  type Race,
  type Role,
  type SessionStatus,
  type StoredSession,
  type TemplateSlot,
  type WeekPlan,
} from '../engine';
import type {
  LibraryItem,
  PlanChangeView,
  PlanEditResult,
  PlanSessionView,
  PlanWarning,
  PlanWeekView,
  RaceView,
  Result,
  SuggestionView,
} from '../../shared/api';

/**
 * The plan engine's persistence and orchestration. The engine decides; this
 * file stores the result, applies edits and writes the "why did my plan
 * change?" log (plan_changes).
 */

interface SessionRow {
  id: number;
  local_date: string;
  slot: number;
  sport: string;
  session_key: string | null;
  title: string;
  duration_min: number | null;
  intensity: string | null;
  targets_json: string | null;
  purpose: string | null;
  is_key: number;
  status: SessionStatus;
  matched_activity_id: number | null;
  source: 'engine' | 'manual';
  est_load: number;
  structure_json: string | null;
  notes_json: string | null;
  fixed: number;
  race_id: number | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

function rowToStored(r: SessionRow): StoredSession {
  return {
    id: r.id,
    status: r.status,
    date: r.local_date,
    slot: r.slot,
    sport: r.sport as PlanSession['sport'],
    sessionKey: r.session_key ?? 'custom',
    title: r.title,
    durationMin: r.duration_min ?? 0,
    intensity: (r.intensity ?? 'z2') as PlanSession['intensity'],
    isKey: !!r.is_key,
    fixed: !!r.fixed,
    purpose: r.purpose ?? '',
    structure: parse(r.structure_json, { main: '' }),
    targets: parse(r.targets_json, {}),
    estLoad: r.est_load,
    notes: parse(r.notes_json, [] as string[]),
    ...(r.race_id != null ? { raceId: r.race_id } : {}),
  };
}

function toView(s: StoredSession, extra: { source: 'engine' | 'manual'; matchedActivityId: number | null }): PlanSessionView {
  return {
    id: s.id,
    date: s.date,
    slot: s.slot,
    sport: s.sport,
    sessionKey: s.sessionKey,
    title: s.title,
    durationMin: s.durationMin,
    intensity: s.intensity,
    isKey: s.isKey,
    fixed: s.fixed,
    purpose: s.purpose || null,
    structure: s.structure,
    targets: s.targets,
    estLoad: s.estLoad,
    notes: s.notes,
    status: s.status,
    source: extra.source,
    matchedActivityId: extra.matchedActivityId,
  };
}

const ACTIVE = (s: { status: SessionStatus }) => s.status !== 'skipped' && s.status !== 'moved';

export class PlanService {
  constructor(private readonly db: DB) {}

  /* ---------------- template, races, settings ---------------- */

  template(): TemplateSlot[] {
    let rows = this.db.prepare('SELECT weekday, slot, default_kind, options_json FROM week_template ORDER BY weekday, slot').all() as Array<{
      weekday: number;
      slot: number;
      default_kind: string;
      options_json: string | null;
    }>;
    if (!rows.length) {
      const ins = this.db.prepare('INSERT INTO week_template (weekday, slot, default_kind, options_json) VALUES (?, ?, ?, ?)');
      this.db.transaction(() => {
        for (const t of DEFAULT_TEMPLATE) ins.run(t.weekday, t.slot, t.role, t.choices ? JSON.stringify({ choices: t.choices }) : null);
      })();
      rows = DEFAULT_TEMPLATE.map((t) => ({ weekday: t.weekday, slot: t.slot, default_kind: t.role, options_json: t.choices ? JSON.stringify({ choices: t.choices }) : null }));
    }
    return rows.map((r) => {
      const opts = parse<{ choices?: string[] }>(r.options_json, {});
      return { weekday: r.weekday, slot: r.slot, role: r.default_kind as Role, ...(opts.choices ? { choices: opts.choices } : {}) };
    });
  }

  races(): Race[] {
    return (this.db.prepare('SELECT id, name, date, type, priority FROM races ORDER BY date').all() as Race[]).map((r) => ({ ...r }));
  }

  raceViews(): RaceView[] {
    return this.db.prepare('SELECT id, name, date, type, priority, notes FROM races ORDER BY date').all() as RaceView[];
  }

  saveRace(input: { id?: number; name: string; date: string; type: string; priority: string; notes?: string | null }, today: string): Result {
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, message: 'Give the race a name.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) return { ok: false, message: 'Pick a date.' };
    if (!(input.type in RACE_TYPES)) return { ok: false, message: 'Pick a race type.' };
    if (!['A', 'B', 'C'].includes(input.priority)) return { ok: false, message: 'Priority must be A, B or C.' };
    const notes = input.notes?.trim() || null;
    if (input.id) {
      const r = this.db.prepare('UPDATE races SET name = ?, date = ?, type = ?, priority = ?, notes = ? WHERE id = ?').run(name, input.date, input.type, input.priority, notes, input.id);
      if (!r.changes) return { ok: false, message: 'Unknown race.' };
    } else {
      this.db.prepare('INSERT INTO races (name, date, type, priority, notes) VALUES (?, ?, ?, ?, ?)').run(name, input.date, input.type, input.priority, notes);
    }
    this.regenerate(today, `${input.id ? 'Updated' : 'Added'} race "${name}" (${input.priority}, ${input.date}).`);
    return { ok: true, message: `Saved ${name}. This week's plan was updated.` };
  }

  removeRace(id: number, today: string): Result {
    const race = this.db.prepare('SELECT name FROM races WHERE id = ?').get(id) as { name: string } | undefined;
    if (!race) return { ok: false, message: 'Unknown race.' };
    this.db.prepare('DELETE FROM races WHERE id = ?').run(id);
    this.regenerate(today, `Removed race "${race.name}".`);
    return { ok: true, message: `Removed ${race.name}. This week's plan was updated.` };
  }

  library(): LibraryItem[] {
    return [...LIBRARY.values()]
      .filter((s) => !s.fixed)
      .map((s) => ({ key: s.key, title: s.title, sport: s.sport, intensity: s.intensity, isKey: s.isKey, durationMin: s.durationMin }));
  }

  /* ---------------- history from daily_metrics ---------------- */

  private pointAt(date: string): DailyLoadPoint | null {
    const r = this.db.prepare('SELECT local_date, load, acute, chronic, acwr, band FROM daily_metrics WHERE local_date = ?').get(date) as
      | { local_date: string; load: number; acute: number; chronic: number; acwr: number | null; band: DailyLoadPoint['band'] }
      | undefined;
    if (!r) return null;
    const historyDays = (this.db.prepare('SELECT COUNT(*) n FROM daily_metrics WHERE local_date <= ?').get(date) as { n: number }).n;
    return { date: r.local_date, load: r.load, acute: r.acute, chronic: r.chronic, acwr: r.acwr, band: r.band, historyDays };
  }

  private loadBetween(from: string, to: string): number | null {
    const r = this.db.prepare('SELECT COUNT(*) n, SUM(load) s FROM daily_metrics WHERE local_date BETWEEN ? AND ?').get(from, to) as { n: number; s: number | null };
    return r.n ? (r.s ?? 0) : null;
  }

  history(weekStart: string, firstDay: string): HistoryInput {
    const lastPoint = this.pointAt(addDays(firstDay, -1));
    return {
      lastPoint,
      prevWeekLoad: this.loadBetween(addDays(weekStart, -7), addDays(weekStart, -1)),
      historyDays: lastPoint?.historyDays ?? 0,
      weekLoadSoFar: firstDay > weekStart ? (this.loadBetween(weekStart, addDays(firstDay, -1)) ?? 0) : 0,
    };
  }

  private rampRef(weekStart: string): number | null {
    const prev = this.loadBetween(addDays(weekStart, -7), addDays(weekStart, -1));
    const p = this.pointAt(addDays(weekStart, -1));
    const chronic = p && p.historyDays >= 28 ? p.chronic * 7 : 0;
    const ref = Math.max(prev ?? 0, chronic);
    return ref > 0 ? ref : null;
  }

  /* ---------------- sessions ---------------- */

  private rows(from: string, to: string): SessionRow[] {
    return this.db.prepare('SELECT * FROM planned_sessions WHERE local_date BETWEEN ? AND ? ORDER BY local_date, slot, id').all(from, to) as SessionRow[];
  }

  weekSessions(weekStart: string): StoredSession[] {
    return this.rows(weekStart, addDays(weekStart, 6)).map(rowToStored);
  }

  private insert(s: PlanSession, source: 'engine' | 'manual', status: SessionStatus = 'planned'): number {
    const r = this.db
      .prepare(
        `INSERT INTO planned_sessions (local_date, slot, sport, session_key, title, duration_min, intensity, targets_json, purpose, is_key, status, source, est_load, structure_json, notes_json, fixed, race_id)
         VALUES (@date, @slot, @sport, @sessionKey, @title, @durationMin, @intensity, @targets, @purpose, @isKey, @status, @source, @estLoad, @structure, @notes, @fixed, @raceId)`,
      )
      .run({
        date: s.date,
        slot: s.slot,
        sport: s.sport,
        sessionKey: s.sessionKey,
        title: s.title,
        durationMin: s.durationMin,
        intensity: s.intensity,
        targets: JSON.stringify(s.targets),
        purpose: s.purpose,
        isKey: s.isKey ? 1 : 0,
        status,
        source,
        estLoad: s.estLoad,
        structure: JSON.stringify(s.structure),
        notes: JSON.stringify(s.notes),
        fixed: s.fixed ? 1 : 0,
        raceId: s.raceId ?? null,
      });
    return Number(r.lastInsertRowid);
  }

  /** Overwrite a session's content (keeps id, date and slot). */
  private replaceContent(id: number, s: PlanSession, source: 'engine' | 'manual'): void {
    this.db
      .prepare(
        `UPDATE planned_sessions SET sport = @sport, session_key = @sessionKey, title = @title, duration_min = @durationMin, intensity = @intensity,
           targets_json = @targets, purpose = @purpose, is_key = @isKey, est_load = @estLoad, structure_json = @structure, notes_json = @notes,
           fixed = @fixed, source = @source, status = 'planned', matched_activity_id = NULL WHERE id = @id`,
      )
      .run({
        id,
        sport: s.sport,
        sessionKey: s.sessionKey,
        title: s.title,
        durationMin: s.durationMin,
        intensity: s.intensity,
        targets: JSON.stringify(s.targets),
        purpose: s.purpose,
        isKey: s.isKey ? 1 : 0,
        estLoad: s.estLoad,
        structure: JSON.stringify(s.structure),
        notes: JSON.stringify(s.notes),
        fixed: s.fixed ? 1 : 0,
        source,
      });
  }

  private setStatus(id: number, status: SessionStatus, note?: string): void {
    if (note) {
      const r = this.db.prepare('SELECT notes_json FROM planned_sessions WHERE id = ?').get(id) as { notes_json: string | null };
      const notes = [...parse<string[]>(r.notes_json, []), note];
      this.db.prepare('UPDATE planned_sessions SET status = ?, notes_json = ? WHERE id = ?').run(status, JSON.stringify(notes), id);
    } else {
      this.db.prepare('UPDATE planned_sessions SET status = ? WHERE id = ?').run(status, id);
    }
  }

  private log(kind: string, date: string, reason: string, actor: 'engine' | 'user', sessionId: number | null = null, before?: unknown, after?: unknown): void {
    this.db
      .prepare('INSERT INTO plan_changes (created_at, local_date, kind, reason, before_json, after_json, actor, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nowIso(), date, kind, reason, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), actor, sessionId);
  }

  private saveWeekMeta(plan: WeekPlan): void {
    this.db
      .prepare(
        `INSERT INTO plan_weeks (week_start, phase, mode, deload, cap, planned_load, notes_json, next_race_json, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (week_start) DO UPDATE SET phase = excluded.phase, mode = excluded.mode, deload = excluded.deload, cap = excluded.cap,
           planned_load = excluded.planned_load, notes_json = excluded.notes_json, next_race_json = excluded.next_race_json, generated_at = excluded.generated_at`,
      )
      .run(plan.weekStart, plan.phase, plan.mode, plan.deload ? 1 : 0, plan.cap, plan.plannedLoad, JSON.stringify(plan.notes), JSON.stringify(plan.nextRace), nowIso());
  }

  private openWater(): boolean {
    return !!getSetting<boolean>(this.db, 'open_water', false);
  }

  /* ---------------- generation ---------------- */

  /** Plan the current week if it hasn't been. Mid-week first runs start today. */
  ensureWeek(today: string): void {
    const ws = weekStartOf(today);
    if (this.db.prepare('SELECT 1 FROM plan_weeks WHERE week_start = ?').get(ws)) return;
    const prevPlanned = !!this.db.prepare('SELECT 1 FROM plan_weeks WHERE week_start = ?').get(addDays(ws, -7));
    const firstDay = prevPlanned ? ws : today;
    const existing = new Set(this.rows(firstDay, addDays(ws, 6)).map((r) => r.local_date));
    const plan = generateWeek({
      weekStart: ws,
      firstDay,
      template: this.template(),
      races: this.races(),
      history: this.history(ws, firstDay),
      openWater: this.openWater(),
      skipDates: [...existing],
    });
    this.db.transaction(() => {
      for (const s of plan.sessions) this.insert(s, 'engine');
      this.saveWeekMeta(plan);
      this.log('week_generated', ws, `Planned the week (${plan.phase}${plan.deload ? ', recovery week' : ''}). ${plan.notes.join(' ')}`.trim(), 'engine');
    })();
  }

  /** Re-plan the rest of this week (from today) after a race or template change. Manual and finished sessions stay. */
  regenerate(today: string, reason: string): void {
    const ws = weekStartOf(today);
    if (!this.db.prepare('SELECT 1 FROM plan_weeks WHERE week_start = ?').get(ws)) {
      this.ensureWeek(today);
      this.log('regenerated', today, reason, 'user');
      return;
    }
    const sunday = addDays(ws, 6);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM planned_sessions WHERE source = 'engine' AND status = 'planned' AND local_date BETWEEN ? AND ?`).run(today, sunday);
      const keep = new Set(this.rows(today, sunday).map((r) => r.local_date));
      const plan = generateWeek({
        weekStart: ws,
        firstDay: today,
        template: this.template(),
        races: this.races(),
        history: this.history(ws, today),
        openWater: this.openWater(),
        skipDates: [...keep],
      });
      for (const s of plan.sessions) this.insert(s, 'engine');
      this.saveWeekMeta({ ...plan, plannedLoad: this.weekSessions(ws).filter(ACTIVE).reduce((a, s) => a + s.estLoad, 0) });
      this.log('regenerated', today, `${reason} Re-planned from ${today}.`, 'user');
    })();
  }

  /* ---------------- after every sync / metrics recompute ---------------- */

  /** Match activities to sessions for a week. Never touches skipped/moved sessions. */
  matchWeek(weekStart: string, today: string): void {
    const sessions = this.rows(weekStart, addDays(weekStart, 6)).filter((r) => r.status !== 'skipped' && r.status !== 'moved' && r.sport !== 'rest');
    if (!sessions.length) return;
    const acts = this.db
      .prepare(`SELECT id, local_date, sport, duration_s FROM activities WHERE local_date BETWEEN ? AND ?`)
      .all(weekStart, addDays(weekStart, 6)) as Array<{ id: number; local_date: string; sport: string; duration_s: number | null }>;
    const { matches } = matchPlanned(
      sessions.map((s) => ({ id: s.id, localDate: s.local_date, sport: s.sport as 'run', durationMin: s.duration_min, status: s.status })),
      acts.map((a) => ({ id: a.id, localDate: a.local_date, sport: a.sport as 'run', durationS: a.duration_s ?? 0 })),
      today,
    );
    const upd = this.db.prepare('UPDATE planned_sessions SET status = ?, matched_activity_id = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const m of matches) upd.run(m.status, m.activityId, m.plannedId);
    })();
  }

  /** Move or drop missed key sessions this week (coaching-engine.md §7.2). */
  handleMissedKeys(today: string): void {
    const ws = weekStartOf(today);
    for (;;) {
      const week = this.weekSessions(ws);
      const handled = new Set(
        (this.db.prepare(`SELECT session_id FROM plan_changes WHERE kind IN ('missed_moved', 'missed_dropped') AND session_id IS NOT NULL`).all() as Array<{ session_id: number }>).map(
          (r) => r.session_id,
        ),
      );
      const missed = week.find((s) => s.status === 'missed' && s.isKey && s.sessionKey !== 'race' && !handled.has(s.id));
      if (!missed) return;
      const res = resolveMissedKey(missed, week, today, this.pointAt(addDays(today, -1)));
      this.db.transaction(() => {
        if (res.kind === 'drop') {
          this.log('missed_dropped', missed.date, res.reason, 'engine', missed.id);
          return;
        }
        for (const id of res.replaceIds) this.setStatus(id, 'skipped', 'Made room for a moved hard session.');
        const slot = Math.max(-1, ...week.filter((s) => s.date === res.toDate).map((s) => s.slot)) + 1;
        const copy: PlanSession = { ...missed, date: res.toDate, slot, notes: [...missed.notes, res.reason] };
        const newId = this.insert(copy, 'engine');
        this.setStatus(missed.id, 'moved');
        this.log('missed_moved', res.toDate, res.reason, 'engine', missed.id, { date: missed.date }, { date: res.toDate, id: newId });
      })();
    }
  }

  /** Offer (never apply) a readiness-based change for today. */
  suggestForToday(today: string): void {
    const r = this.db.prepare('SELECT verdict, factors_json FROM readiness WHERE local_date = ?').get(today) as { verdict: 'go' | 'easy' | 'rest'; factors_json: string } | undefined;
    if (!r || r.verdict === 'go') return;
    const why = parse<{ summary?: string }>(r.factors_json, {}).summary ?? '';
    const sug = readinessSuggestion(today, r.verdict, why, this.weekSessions(weekStartOf(today)));
    if (!sug) return;
    this.db
      .prepare(`INSERT OR IGNORE INTO plan_suggestions (local_date, kind, reason, changes_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(today, sug.kind, sug.reason, JSON.stringify(sug.changes), nowIso());
  }

  /** Run after every sync and every metrics recompute. */
  afterMetrics(today: string): void {
    this.ensureWeek(today);
    const ws = weekStartOf(today);
    this.matchWeek(addDays(ws, -7), today);
    this.matchWeek(ws, today);
    this.handleMissedKeys(today);
    this.suggestForToday(today);
  }

  /* ---------------- views ---------------- */

  private validate(weekStart: string, today: string): PlanWarning[] {
    const fromDate = today > weekStart ? today : weekStart;
    if (fromDate > addDays(weekStart, 6)) return [];
    const active = this.weekSessions(weekStart).filter(ACTIVE);
    const meta = this.db.prepare('SELECT mode FROM plan_weeks WHERE week_start = ?').get(weekStart) as { mode: WeekPlan['mode'] } | undefined;
    return validateWeek(
      active.map((s) => ({ ...s, estLoad: s.date >= fromDate && s.status === 'planned' ? s.estLoad : 0 })),
      {
        weekStart,
        fromDate,
        lastPoint: this.pointAt(addDays(fromDate, -1)),
        rampRef: this.rampRef(weekStart),
        weekLoadSoFar: fromDate > weekStart ? (this.loadBetween(weekStart, addDays(fromDate, -1)) ?? 0) : 0,
        mode: meta?.mode ?? 'maintain',
      },
    );
  }

  private changes(weekStart: string): PlanChangeView[] {
    return (
      this.db
        .prepare('SELECT created_at, local_date, kind, reason, actor, session_id FROM plan_changes WHERE local_date BETWEEN ? AND ? ORDER BY id DESC LIMIT 50')
        .all(weekStart, addDays(weekStart, 6)) as Array<{ created_at: string; local_date: string; kind: string; reason: string; actor: 'engine' | 'user'; session_id: number | null }>
    ).map((r) => ({ createdAt: r.created_at, date: r.local_date, kind: r.kind, reason: r.reason, actor: r.actor, sessionId: r.session_id }));
  }

  private pendingSuggestion(today: string): SuggestionView | null {
    const r = this.db.prepare(`SELECT * FROM plan_suggestions WHERE local_date = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(today) as
      | { id: number; local_date: string; kind: string; reason: string; changes_json: string }
      | undefined;
    if (!r) return null;
    const changes = parse<Array<{ sessionId: number; after: PlanSession }>>(r.changes_json, []);
    const titles = new Map(this.rows(today, today).map((s) => [s.id, s.title]));
    return {
      id: r.id,
      date: r.local_date,
      kind: r.kind,
      reason: r.reason,
      changes: changes.map((c) => ({ sessionId: c.sessionId, before: titles.get(c.sessionId) ?? '?', after: c.after.durationMin ? `${c.after.title} (${c.after.durationMin} min)` : c.after.title })),
    };
  }

  weekView(weekStart: string, today: string): PlanWeekView {
    const current = weekStartOf(today);
    if (weekStart > current) {
      const weeksAhead = Math.round(daysBetween(current, weekStart) / 7);
      return this.previewWeeks(today, weeksAhead)[weeksAhead - 1]!;
    }
    const meta = this.db.prepare('SELECT * FROM plan_weeks WHERE week_start = ?').get(weekStart) as
      | { phase: string; mode: string; deload: number; cap: number | null; planned_load: number; notes_json: string; next_race_json: string | null }
      | undefined;
    const rows = this.rows(weekStart, addDays(weekStart, 6));
    const sessions = rows.map((r) => toView(rowToStored(r), { source: r.source, matchedActivityId: r.matched_activity_id }));
    return {
      weekStart,
      phase: meta?.phase ?? '—',
      mode: meta?.mode ?? '—',
      deload: !!meta?.deload,
      cap: meta?.cap ?? null,
      plannedLoad: Math.round(sessions.filter(ACTIVE).reduce((a, s) => a + s.estLoad, 0)),
      notes: parse(meta?.notes_json ?? null, [] as string[]),
      nextRace: parse(meta?.next_race_json ?? null, null),
      preview: false,
      sessions,
      warnings: weekStart === current ? this.validate(weekStart, today) : [],
      changes: this.changes(weekStart),
      suggestion: weekStart === current ? this.pendingSuggestion(today) : null,
    };
  }

  /** Weeks after the current one, assuming the rest of this week goes as planned. */
  previewWeeks(today: string, weeks: number): PlanWeekView[] {
    if (weeks < 1) return [];
    const ws = weekStartOf(today);
    const sunday = addDays(ws, 6);
    const remaining = this.weekSessions(ws).filter((s) => ACTIVE(s) && s.status === 'planned' && s.date >= today);
    const last = this.pointAt(addDays(today, -1));
    const days = eachDay(today, sunday).map((date) => ({ date, load: remaining.filter((s) => s.date === date).reduce((a, s) => a + s.estLoad, 0) }));
    const proj = last ? projectAcwr(last, days) : [];
    const thisWeek = (this.loadBetween(ws, addDays(today, -1)) ?? 0) + days.reduce((a, d) => a + d.load, 0);
    const block = generateBlock(
      {
        weekStart: addDays(ws, 7),
        template: this.template(),
        races: this.races(),
        history: { lastPoint: proj.at(-1) ?? last, prevWeekLoad: thisWeek, historyDays: (last?.historyDays ?? 0) + days.length },
        openWater: this.openWater(),
      },
      weeks,
    );
    return block.map((w) => ({
      weekStart: w.weekStart,
      phase: w.phase,
      mode: w.mode,
      deload: w.deload,
      cap: w.cap,
      plannedLoad: Math.round(w.plannedLoad),
      notes: w.notes,
      nextRace: w.nextRace,
      preview: true,
      sessions: w.sessions.map((s, i) => toView({ ...s, id: -(i + 1), status: 'planned' }, { source: 'engine', matchedActivityId: null })),
      warnings: [],
      changes: [],
      suggestion: null,
    }));
  }

  /* ---------------- manual edits (the athlete is the boss: apply, then warn) ---------------- */

  private get(id: number): StoredSession | null {
    const r = this.db.prepare('SELECT * FROM planned_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return r ? rowToStored(r) : null;
  }

  private edited(weekDate: string, today: string, message: string): PlanEditResult {
    return { ok: true, message, warnings: this.validate(weekStartOf(weekDate), today) };
  }

  swap(a: number, b: number, today: string): PlanEditResult {
    const x = this.get(a);
    const y = this.get(b);
    if (!x || !y) return { ok: false, message: 'Unknown session.', warnings: [] };
    this.db.transaction(() => {
      const upd = this.db.prepare('UPDATE planned_sessions SET local_date = ?, slot = ?, source = ? WHERE id = ?');
      upd.run(y.date, y.slot, 'manual', x.id);
      upd.run(x.date, x.slot, 'manual', y.id);
      this.log('swap', x.date, `Swapped ${x.title} (${x.date}) with ${y.title} (${y.date}).`, 'user', x.id, { a: x.date, b: y.date }, { a: y.date, b: x.date });
    })();
    return this.edited(x.date, today, `Swapped ${x.title} and ${y.title}.`);
  }

  move(id: number, date: string, today: string): PlanEditResult {
    const s = this.get(id);
    if (!s) return { ok: false, message: 'Unknown session.', warnings: [] };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'Pick a day.', warnings: [] };
    const slot = (this.db.prepare('SELECT COALESCE(MAX(slot), -1) + 1 AS s FROM planned_sessions WHERE local_date = ?').get(date) as { s: number }).s;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE planned_sessions SET local_date = ?, slot = ?, source = 'manual', status = 'planned', matched_activity_id = NULL WHERE id = ?`).run(date, slot, id);
      this.log('move', date, `Moved ${s.title} from ${s.date} to ${date}.`, 'user', id, { date: s.date }, { date });
    })();
    return this.edited(date, today, `Moved ${s.title}.`);
  }

  skip(id: number, today: string): PlanEditResult {
    const s = this.get(id);
    if (!s) return { ok: false, message: 'Unknown session.', warnings: [] };
    this.db.transaction(() => {
      this.setStatus(id, 'skipped');
      this.log('skip', s.date, `Skipped ${s.title}.`, 'user', id);
    })();
    return this.edited(s.date, today, `Skipped ${s.title}.`);
  }

  unskip(id: number, today: string): PlanEditResult {
    const s = this.get(id);
    if (!s) return { ok: false, message: 'Unknown session.', warnings: [] };
    this.db.transaction(() => {
      this.setStatus(id, 'planned');
      this.log('unskip', s.date, `Put ${s.title} back in the plan.`, 'user', id);
    })();
    this.matchWeek(weekStartOf(s.date), today);
    return this.edited(s.date, today, `${s.title} is back in the plan.`);
  }

  makeRest(date: string, today: string): PlanEditResult {
    const day = this.rows(date, date).map(rowToStored).filter((s) => ACTIVE(s) && !s.fixed && s.sessionKey !== 'rest');
    this.db.transaction(() => {
      for (const s of day) this.setStatus(s.id, 'skipped', 'Rest day instead.');
      if (!this.rows(date, date).some((r) => r.session_key === 'rest' && ACTIVE(r))) this.insert(restSession(date, 99, 'Rest day (your choice).'), 'manual');
      this.log('make_rest', date, `Made ${date} a rest day${day.length ? ` (skipped ${day.map((s) => s.title).join(', ')})` : ''}.`, 'user');
    })();
    return this.edited(date, today, 'Rest day set.');
  }

  change(id: number, sessionKey: string, today: string): PlanEditResult {
    const s = this.get(id);
    const def = LIBRARY.get(sessionKey);
    if (!s || !def) return { ok: false, message: 'Unknown session.', warnings: [] };
    const [lo, hi] = def.durationMin;
    const duration = Math.min(hi, Math.max(lo, s.durationMin || Math.round((lo + hi) / 2)));
    const next = toPlanSession(def, s.date, s.slot, duration, ['Changed by you.']);
    this.db.transaction(() => {
      this.replaceContent(id, next, 'manual');
      this.log('change', s.date, `Changed ${s.title} to ${def.title}.`, 'user', id, { key: s.sessionKey }, { key: def.key });
    })();
    this.matchWeek(weekStartOf(s.date), today);
    return this.edited(s.date, today, `Changed to ${def.title}.`);
  }

  acceptSuggestion(id: number, today: string): PlanEditResult {
    const r = this.db.prepare(`SELECT * FROM plan_suggestions WHERE id = ? AND status = 'pending'`).get(id) as { local_date: string; reason: string; changes_json: string } | undefined;
    if (!r) return { ok: false, message: 'That suggestion is no longer open.', warnings: [] };
    const changes = parse<Array<{ sessionId: number; after: PlanSession }>>(r.changes_json, []);
    this.db.transaction(() => {
      for (const c of changes) {
        const before = this.get(c.sessionId);
        if (!before || before.status !== 'planned') continue;
        this.replaceContent(c.sessionId, c.after, 'engine');
        this.log('suggestion_accepted', r.local_date, `${r.reason} → ${before.title} became ${c.after.title}.`, 'user', c.sessionId, { key: before.sessionKey }, { key: c.after.sessionKey });
      }
      this.db.prepare(`UPDATE plan_suggestions SET status = 'accepted', resolved_at = ? WHERE id = ?`).run(nowIso(), id);
    })();
    return this.edited(r.local_date, today, 'Plan adjusted for today.');
  }

  dismissSuggestion(id: number): Result {
    const r = this.db.prepare(`UPDATE plan_suggestions SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), id);
    return r.changes ? { ok: true, message: 'Kept the plan as it was.' } : { ok: false, message: 'That suggestion is no longer open.' };
  }
}
