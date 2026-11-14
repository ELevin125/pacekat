import { ACWR } from '../constants';
import { projectAcwr, type DailyLoadPoint } from '../acwr';
import { weekdayOf } from '../commute';
import { addDays, daysBetween, eachDay } from '../../util/dates';
import { LIBRARY, easyVersion, estimateLoad, restSession, session, toPlanSession } from './library';
import { RACE_TYPES, isDeloadWeek, nextARace, phaseOn, weekIndex } from './phases';
import type { Phase, PlanMode, PlanSession, Race, Role, SessionDef, TemplateSlot, WeekPlan } from './types';

/**
 * Weekly plan generation (coaching-engine.md §5). Pure: template + races +
 * load history in, a week of sessions with reasons out.
 */

export const PLAN = {
  maxKeys: 3,
  /** While building a baseline (< 28 days of history) keep it to one hard session. */
  baselineMaxKeys: 1,
  rampFactor: 1.1,
  maintainRampFactor: 1.05,
  deloadShare: 0.7,
  /** Easing back in after a break: the cap never drops below this share of the minimum-duration week. */
  returnFloorShare: 0.6,
  /** Where in each session's duration range a normal week starts (0 = min, 1 = max). */
  normalFill: 0.5,
  /** Lowest fill when fitting under the cap: −0.5 = half the minimum duration. */
  minFill: -0.5,
  minDurationMin: 10,
  sundayAcwrMax: 1.3,
  bRaceTaperDays: 3,
  bRaceEasyDaysAfter: 2,
  bRaceShare: 0.6,
} as const;

export interface HistoryInput {
  /** ACWR point for the day before the first planned day (null = no history). */
  lastPoint: DailyLoadPoint | null;
  /** Actual load of the previous Mon–Sun week. */
  prevWeekLoad: number | null;
  historyDays: number;
  /** Actual load already done this week before `firstDay` (mid-week planning). */
  weekLoadSoFar?: number;
}

export interface WeekInput {
  weekStart: string;
  /** First date to plan (defaults to weekStart); earlier days are left empty. */
  firstDay?: string;
  template: TemplateSlot[];
  races: Race[];
  history: HistoryInput;
  openWater?: boolean;
  /** Dates the engine must not plan (e.g. the athlete already set them manually). */
  skipDates?: string[];
}

export const DEFAULT_TEMPLATE: TemplateSlot[] = [
  { weekday: 0, slot: 0, role: 'commute' },
  { weekday: 1, slot: 0, role: 'strength_upper' },
  { weekday: 1, slot: 1, role: 'swim_quality' },
  { weekday: 2, slot: 0, role: 'commute' },
  { weekday: 3, slot: 0, role: 'strength_lower' },
  { weekday: 4, slot: 0, role: 'recovery' },
  { weekday: 5, slot: 0, role: 'sat_main', choices: ['mtb', 'parkrun'] },
  { weekday: 5, slot: 1, role: 'swim_endurance' },
  { weekday: 6, slot: 0, role: 'sun_run' },
];

type Variant = 'A' | 'B';

const BY_PHASE: Partial<Record<Role, Record<Phase, string>>> = {
  strength_upper: { base: 'strength_upper', build: 'strength_upper', maintain: 'strength_upper', peak: 'strength_upper_maint', taper: 'mobility', recovery: 'mobility' },
  strength_lower: { base: 'strength_lower', build: 'strength_lower', maintain: 'strength_lower', peak: 'strength_lower_maint', taper: 'mobility', recovery: 'mobility' },
  swim_quality: { base: 'swim_technique', maintain: 'swim_technique', build: 'swim_css_intervals', peak: 'swim_race_pace', taper: 'swim_short_sharp', recovery: 'swim_easy' },
};

/** Pick the library session for a template role on a given day. */
export function pickSession(role: Role, phase: Phase, variant: Variant, opts: { satIsKey: boolean; choices?: string[]; openWater?: boolean }): string {
  switch (role) {
    case 'commute':
      return 'commute_ride';
    case 'rest':
    case 'recovery':
      return 'rest';
    case 'strength_upper':
    case 'strength_lower':
    case 'swim_quality':
      return BY_PHASE[role]![phase];
    case 'swim_endurance':
      if (phase === 'taper' || phase === 'recovery') return 'swim_easy';
      if (opts.openWater && (phase === 'peak' || (phase === 'build' && variant === 'B'))) return 'swim_open_water';
      return 'swim_endurance';
    case 'sat_main': {
      const choices = opts.choices?.length ? opts.choices : ['mtb', 'parkrun'];
      const mtb = choices.includes('mtb');
      const parkrun = choices.includes('parkrun');
      const useParkrun = parkrun && (variant === 'B' || !mtb);
      switch (phase) {
        case 'base':
        case 'maintain':
          return useParkrun ? 'parkrun_tempo' : mtb ? 'mtb_endurance' : 'ride_endurance';
        case 'build':
          return useParkrun ? 'parkrun_tempo' : 'brick_build';
        case 'peak':
          return useParkrun ? 'parkrun_race' : 'brick_race_sim';
        case 'taper':
          return 'brick_short';
        case 'recovery':
          return parkrun ? 'parkrun_easy' : 'ride_easy';
      }
      break;
    }
    case 'sun_run':
      switch (phase) {
        case 'base':
        case 'maintain':
          return opts.satIsKey ? 'run_long_easy' : 'run_long';
        case 'build':
          return opts.satIsKey ? 'run_long_easy' : 'run_intervals';
        case 'peak':
          return opts.satIsKey ? 'run_easy' : 'run_race_pace';
        case 'taper':
          return 'run_strides_short';
        case 'recovery':
          return 'rest';
      }
  }
  return 'rest';
}

function raceSession(race: Race, date: string): PlanSession {
  const cfg = RACE_TYPES[race.type];
  const def: SessionDef = {
    key: 'race',
    sport: cfg.sport,
    title: `${race.name} (${race.priority} race)`,
    intensity: 'race',
    durationMin: [cfg.raceMin, cfg.raceMin],
    purpose: race.priority === 'A' ? 'Race day — everything has built to this.' : race.priority === 'B' ? 'A tune-up race: race it, learn from it.' : 'A training race: counts as the hard session of the day.',
    structure: { warmup: 'Your usual race warm-up', main: `${cfg.label}: pace it evenly, fuel early`, cooldown: 'Easy cool-down, then eat' },
    targets: {},
    phases: [],
    isKey: true,
  };
  return { ...toPlanSession(def, date, 0, cfg.raceMin, [`${race.priority} race.`]), raceId: race.id };
}

/** Duration at fill `t`: 0 = min, 1 = max, negative = below min (deload/ramp limits). */
function durationAt(def: SessionDef, t: number): number {
  const [lo, hi] = def.durationMin;
  if (hi === 0) return 0;
  if (def.noShorten && t < 0) t = 0;
  const d = t >= 0 ? lo + t * (hi - lo) : lo * (1 + t);
  return Math.max(PLAN.minDurationMin, Math.round(d / 5) * 5);
}

const scalable = (s: PlanSession) => !s.fixed && s.sessionKey !== 'race' && s.sessionKey !== 'rest' && LIBRARY.has(s.sessionKey);

/**
 * Set durations at fill `t`. Days in `minDays` (taper, post-race recovery) stay
 * at the library minimum: those sessions are short by design, so the taper's
 * volume drop comes from the session choice, not from squeezing.
 */
function applyFill(sessions: PlanSession[], t: number, minDays: ReadonlySet<string> = new Set()): PlanSession[] {
  return sessions.map((s) => {
    if (!scalable(s) || s.notes.some((n) => n.startsWith('Mini-taper') || n.startsWith('Easy after'))) return s;
    const def = session(s.sessionKey);
    const d = durationAt(def, minDays.has(s.date) ? 0 : t);
    return { ...s, durationMin: d, estLoad: estimateLoad(s.intensity, d) };
  });
}

const totalLoad = (sessions: PlanSession[]) => Math.round(sessions.reduce((sum, s) => sum + s.estLoad, 0) * 10) / 10;
/** Load the ramp cap applies to: races are what they are and never squeeze the rest of the week. */
const capLoad = (sessions: PlanSession[]) => totalLoad(sessions.filter((s) => s.sessionKey !== 'race'));

function dailyLoads(sessions: PlanSession[], days: string[]) {
  return days.map((date) => ({ date, load: sessions.filter((s) => s.date === date).reduce((sum, s) => sum + s.estLoad, 0) }));
}

/** Never two key days in a row; at most `maxKeys` per week. Races always stay key. */
export function enforceKeyRules(sessions: PlanSession[], maxKeys: number): PlanSession[] {
  let out = [...sessions];
  const keyDates = () => [...new Set(out.filter((s) => s.isKey).map((s) => s.date))].sort();
  const downgrade = (date: string, note: string) => {
    out = out.map((s) => (s.date === date && s.isKey && s.sessionKey !== 'race' ? easyVersion(s, 0.7, note) : s));
  };

  for (const d of keyDates()) {
    const prev = addDays(d, -1);
    if (!out.some((s) => s.date === prev && s.isKey)) continue;
    const todayIsRace = out.some((s) => s.date === d && s.sessionKey === 'race');
    if (todayIsRace) downgrade(prev, 'Made easy: the next day is a race.');
    else downgrade(d, 'Made easy: never two hard days in a row.');
  }
  let keys = keyDates();
  while (keys.length > maxKeys) {
    const victim = [...keys].reverse().find((d) => !out.some((s) => s.date === d && s.sessionKey === 'race'));
    if (!victim) break;
    downgrade(victim, `Made easy: at most ${maxKeys} hard ${maxKeys === 1 ? 'session' : 'sessions'} this week.`);
    keys = keyDates();
  }
  return out;
}

export function generateWeek(input: WeekInput): WeekPlan {
  const { weekStart, races, history } = input;
  const firstDay = input.firstDay && input.firstDay > weekStart ? input.firstDay : weekStart;
  const sunday = addDays(weekStart, 6);
  const days = eachDay(firstDay, sunday);
  const skip = new Set(input.skipDates ?? []);
  const variant: Variant = ((weekIndex(weekStart) % 2) + 2) % 2 === 0 ? 'A' : 'B';
  const phase = phaseOn(weekStart, races);
  const baseline = history.historyDays < ACWR.minHistoryDays;
  const mode: PlanMode = baseline ? 'baseline' : phase === 'maintain' ? 'maintain' : 'race';
  let deload = !baseline && isDeloadWeek(weekStart, races);
  const notes: string[] = [];

  // 1. Fill the template.
  let sessions: PlanSession[] = [];
  let satIsKey = false;
  for (const date of days) {
    if (skip.has(date)) continue;
    const race = races.find((r) => r.date === date);
    if (race) {
      sessions.push(raceSession(race, date));
      continue;
    }
    const dayPhase = phaseOn(date, races);
    const slots = input.template.filter((t) => t.weekday === weekdayOf(date)).sort((a, b) => a.slot - b.slot);
    for (const slot of slots) {
      const key = pickSession(slot.role, dayPhase, variant, { satIsKey, choices: slot.choices, openWater: input.openWater });
      const def = session(key);
      if (slot.role === 'sat_main') satIsKey = def.isKey;
      if (key === 'rest' && sessions.some((s) => s.date === date)) continue;
      sessions.push(toPlanSession(def, date, slot.slot, durationAt(def, PLAN.normalFill), slot.role === 'sun_run' && key.startsWith('run_long') && satIsKey ? ['Long and easy: Saturday was the hard day.'] : []));
    }
    if (!sessions.some((s) => s.date === date)) sessions.push(restSession(date, 0));
  }

  // 2. B and C races: mini-taper before a B race, easy days after.
  for (const r of races.filter((x) => x.priority === 'B')) {
    sessions = sessions.map((s) => {
      if (s.fixed || s.sessionKey === 'race' || s.sessionKey === 'rest') return s;
      const before = daysBetween(s.date, r.date);
      const after = daysBetween(r.date, s.date);
      if (before >= 1 && before <= PLAN.bRaceTaperDays) return easyVersion(s, PLAN.bRaceShare, `Mini-taper for ${r.name}.`);
      if (after >= 1 && after <= PLAN.bRaceEasyDaysAfter) return easyVersion(s, PLAN.bRaceShare, `Easy after ${r.name}.`);
      return s;
    });
  }

  // 3. Hard/easy rules.
  sessions = enforceKeyRules(sessions, baseline ? PLAN.baselineMaxKeys : PLAN.maxKeys);

  // 4. Ramp cap (coaching-engine.md §5) and deload.
  const factor = mode === 'maintain' ? PLAN.maintainRampFactor : PLAN.rampFactor;
  const chronicWeek = history.lastPoint ? history.lastPoint.chronic * 7 : 0;
  const rampRef = Math.max(history.prevWeekLoad ?? 0, baseline ? 0 : chronicWeek);
  const minDays = new Set(days.filter((d) => ['taper', 'recovery'].includes(phaseOn(d, races))));
  const taperWeek = days.some((d) => phaseOn(d, races) === 'taper');
  const recoveryWeek = phase === 'recovery';
  let cap: number | null = rampRef > 0 ? rampRef * factor : null;
  if (cap != null && deload) cap = Math.min(cap, rampRef * PLAN.deloadShare);
  // Days before firstDay this week already happened: their actual load counts against the cap.
  const doneSoFar = firstDay > weekStart ? (history.weekLoadSoFar ?? 0) : 0;
  /** Highest fill allowed: no growth in deload weeks. */
  let topFill = deload ? 0 : 1;

  // Easing back in (after a break, illness, holiday): if even a squeezed week can't fit the ramp cap,
  // floor the cap at a share of the minimum-duration week, allow one hard session, and (below) leave
  // out lower-priority sessions. Without the floor, +10 % a week from almost nothing takes months.
  const returning =
    !baseline && cap != null && !taperWeek && !recoveryWeek && capLoad(applyFill(sessions, PLAN.minFill, minDays)) + doneSoFar > cap;
  if (returning) {
    // The whole return is a reduced phase: no extra deload, +10 % a week even in maintain mode.
    deload = false;
    topFill = 1;
    cap = Math.max(rampRef * PLAN.rampFactor, PLAN.returnFloorShare * capLoad(applyFill(sessions, 0, minDays)) + doneSoFar);
    sessions = enforceKeyRules(sessions, PLAN.baselineMaxKeys);
  }


  /** Highest projected load ratio over the planned days (null without enough history). */
  const maxAcwr = (list: PlanSession[]): number | null => {
    // After a break the chronic load is near zero, so any training reads as a spike: the ramp cap governs then.
    if (!history.lastPoint || returning) return null;
    const proj = projectAcwr(history.lastPoint, dailyLoads(list, days));
    return proj.reduce<number | null>((m, p) => (p.acwr == null ? m : Math.max(m ?? 0, p.acwr)), null);
  };
  /** A fill is acceptable if it respects the ramp cap and keeps the load ratio ≤ 1.3 all week. */
  const acceptable = (list: PlanSession[]) => {
    if (cap != null && capLoad(list) + doneSoFar > cap) return false;
    const a = maxAcwr(list);
    return a == null || a <= PLAN.sundayAcwrMax;
  };

  const fit = (list: PlanSession[]): { list: PlanSession[]; t: number } => {
    if (baseline) return { list: applyFill(list, 0, minDays), t: 0 };
    const top = cap == null ? Math.min(topFill, PLAN.normalFill) : topFill;
    let lo: number = PLAN.minFill;
    let hi: number = top;
    if (acceptable(applyFill(list, hi, minDays))) return { list: applyFill(list, hi, minDays), t: hi };
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (acceptable(applyFill(list, mid, minDays))) lo = mid;
      else hi = mid;
    }
    return { list: applyFill(list, lo, minDays), t: lo };
  };

  let fitted = fit(sessions);
  sessions = fitted.list;

  // 5. Sunday rule: only plan Sunday's run if the week's load and ACWR allow it.
  const sundayRun = sessions.find((s) => s.date === sunday && s.sport === 'run' && s.sessionKey !== 'race');
  if (sundayRun) {
    const overCap = cap != null && capLoad(sessions) + doneSoFar > cap;
    const peak = maxAcwr(sessions);
    if (overCap || (peak != null && peak > PLAN.sundayAcwrMax)) {
      const why = overCap ? 'the week is already at its load limit' : `the load ratio would reach ${peak!.toFixed(2)}`;
      sessions = sessions.map((s) => (s === sundayRun ? restSession(sunday, s.slot, `Sunday run dropped: ${why}.`) : s));
      fitted = fit(sessions);
      sessions = fitted.list;
      notes.push(`Sunday is a rest day because ${why}.`);
    }
  }

  // 6. Still over the cap: leave out lower-priority sessions (second session of a day first, then the biggest).
  const leftOut: string[] = [];
  if (cap != null) {
    const isMulti = (s: PlanSession) => sessions.filter((x) => x.date === s.date && x.sessionKey !== 'rest').length > 1;
    while (capLoad(sessions) + doneSoFar > cap * 1.01) {
      const candidates = sessions.filter((s) => scalable(s) && !s.isKey);
      if (!candidates.length) break;
      candidates.sort((a, b) => Number(isMulti(b)) - Number(isMulti(a)) || b.estLoad - a.estLoad);
      const victim = candidates[0]!;
      leftOut.push(victim.title.toLowerCase());
      sessions = sessions.filter((s) => s !== victim);
      if (!sessions.some((s) => s.date === victim.date)) sessions.push(restSession(victim.date, victim.slot, 'Left out while easing back in.'));
    }
  }

  const plannedLoad = totalLoad(sessions);
  if (cap != null && capLoad(sessions) + doneSoFar > cap * 1.01) notes.push(`Even at minimum durations this week is ${Math.round(((capLoad(sessions) + doneSoFar) / cap - 1) * 100)} % over the ramp limit.`);
  if (baseline) notes.push('Building a baseline: minimum durations and one hard session until there are 4 weeks of history.');
  if (taperWeek) notes.push('Taper: volume down by roughly half, with short race-pace efforts to stay sharp.');
  else if (recoveryWeek) notes.push('Recovery week after the race: easy sessions only.');
  else if (deload) notes.push('Recovery week (3:1 loading): about 30 % less load.');
  else if (returning) {
    notes.push(
      `Easing back in: recent training is low, so this week is lighter${leftOut.length ? ` and leaves out ${leftOut.join(', ')}` : ''}. It builds back up over the next few weeks.`,
    );
  } else if (cap != null && fitted.t < PLAN.normalFill - 0.05) {
    const a = history.lastPoint?.acwr;
    notes.push(
      a != null && a > PLAN.sundayAcwrMax
        ? `Sessions shortened: recent load is high (ratio ${a.toFixed(2)}), so this week brings it back into the safe range.`
        : 'Sessions shortened to keep this week within a safe ramp from recent training.',
    );
  }
  else if (cap != null && fitted.t > PLAN.normalFill + 0.05 && capLoad(sessions) + doneSoFar > (history.prevWeekLoad ?? 0)) {
    notes.push('Sessions a little longer than usual: recent training supports a small step up.');
  }

  const race = nextARace(weekStart, races);
  const nextAny = races.filter((r) => r.date >= weekStart).sort((a, b) => a.date.localeCompare(b.date))[0];
  const shown = race ?? nextAny ?? null;

  return {
    weekStart,
    phase,
    mode,
    deload,
    cap: cap == null ? null : Math.round(cap),
    plannedLoad,
    sessions: sessions.sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot),
    notes,
    nextRace: shown ? { name: shown.name, date: shown.date, priority: shown.priority, daysOut: daysBetween(weekStart, shown.date) } : null,
  };
}

/**
 * Plan several weeks ahead, assuming each planned week is done as planned
 * (for previews and the 4-week review).
 */
export function generateBlock(first: WeekInput, weeks: number): WeekPlan[] {
  const out: WeekPlan[] = [];
  let history = first.history;
  let input = first;
  for (let i = 0; i < weeks; i++) {
    const plan = generateWeek({ ...input, history });
    out.push(plan);
    const days = eachDay(input.firstDay && input.firstDay > input.weekStart ? input.firstDay : input.weekStart, addDays(input.weekStart, 6));
    const proj = history.lastPoint
      ? projectAcwr(history.lastPoint, dailyLoads(plan.sessions, days))
      : [];
    const next = addDays(input.weekStart, 7);
    history = {
      lastPoint: proj.at(-1) ?? history.lastPoint,
      prevWeekLoad: plan.plannedLoad,
      historyDays: history.historyDays + days.length,
      weekLoadSoFar: 0,
    };
    input = { ...first, weekStart: next, firstDay: undefined, skipDates: undefined };
  }
  return out;
}
