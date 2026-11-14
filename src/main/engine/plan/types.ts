import type { Sport } from '../load';

export type Intensity = 'rest' | 'z1' | 'z2' | 'tempo' | 'threshold' | 'vo2' | 'race';
export type Phase = 'base' | 'build' | 'peak' | 'taper' | 'recovery' | 'maintain';
export type PlanSport = Sport | 'rest';
export type RaceType = 'sprint_tri' | 'olympic_tri' | '5k' | '10k' | 'half_marathon' | 'marathon' | 'gran_fondo' | 'mtb' | 'other';
export type Priority = 'A' | 'B' | 'C';
export type SessionStatus = 'planned' | 'done' | 'partial' | 'missed' | 'skipped' | 'moved';

export interface SessionDef {
  key: string;
  sport: PlanSport;
  title: string;
  intensity: Intensity;
  durationMin: [number, number];
  purpose: string;
  structure: { warmup?: string; main: string; cooldown?: string };
  targets: Record<string, string>;
  phases: Phase[];
  isKey: boolean;
  /** Same-sport easier session to use when downgrading. */
  easyVariant?: string;
  /** Fixed sessions (commutes) are never moved, upgraded or resized by the engine. */
  fixed?: boolean;
  /** Fixed-distance events (parkrun = 5 km): never shortened below the minimum duration. */
  noShorten?: boolean;
  /** Only planned when the athlete has access (e.g. open water). */
  needs?: 'openWater';
}

export interface Race {
  id: number;
  name: string;
  date: string;
  type: RaceType;
  priority: Priority;
}

/** Template roles: what a slot is for. The engine picks the session per phase. */
export type Role = 'commute' | 'strength_upper' | 'strength_lower' | 'swim_quality' | 'swim_endurance' | 'recovery' | 'sat_main' | 'sun_run' | 'rest';

export interface TemplateSlot {
  weekday: number; // 0 = Monday
  slot: number;
  role: Role;
  /** sat_main: which options the athlete likes ('mtb', 'parkrun'). */
  choices?: string[];
}

export interface PlanSession {
  date: string;
  slot: number;
  sport: PlanSport;
  sessionKey: string;
  title: string;
  durationMin: number;
  intensity: Intensity;
  isKey: boolean;
  fixed: boolean;
  purpose: string;
  structure: SessionDef['structure'];
  targets: Record<string, string>;
  /** Estimated load in TRIMP units. */
  estLoad: number;
  /** Why the engine chose or changed this session. */
  notes: string[];
  raceId?: number;
}

export type PlanMode = 'race' | 'maintain' | 'baseline';

export interface WeekPlan {
  weekStart: string;
  phase: Phase;
  mode: PlanMode;
  deload: boolean;
  /** Weekly load cap from the ramp rule; null when there's no history to ramp from. */
  cap: number | null;
  plannedLoad: number;
  sessions: PlanSession[];
  notes: string[];
  nextRace: { name: string; date: string; priority: Priority; daysOut: number } | null;
}

export interface Warning {
  code: 'key_back_to_back' | 'acwr_high' | 'ramp' | 'too_many_keys';
  message: string;
  dates: string[];
}
