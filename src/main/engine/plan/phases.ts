import { addDays, daysBetween } from '../../util/dates';
import type { Phase, Race, RaceType } from './types';

/**
 * Periodisation (coaching-engine.md §4). Phases count back from the next A
 * race within 24 weeks; without one the plan is in "maintain" mode.
 */

export interface RaceTypeConfig {
  label: string;
  buildWeeks: number;
  peakWeeks: number;
  taperDays: number;
  /** Rough race duration, for load estimates. */
  raceMin: number;
  sport: 'run' | 'bike' | 'other';
}

export const RACE_TYPES: Record<RaceType, RaceTypeConfig> = {
  sprint_tri: { label: 'Sprint triathlon', buildWeeks: 12, peakWeeks: 4, taperDays: 8, raceMin: 80, sport: 'other' },
  olympic_tri: { label: 'Olympic triathlon', buildWeeks: 12, peakWeeks: 4, taperDays: 10, raceMin: 150, sport: 'other' },
  '5k': { label: '5 km', buildWeeks: 8, peakWeeks: 3, taperDays: 5, raceMin: 25, sport: 'run' },
  '10k': { label: '10 km', buildWeeks: 10, peakWeeks: 3, taperDays: 7, raceMin: 50, sport: 'run' },
  half_marathon: { label: 'Half marathon', buildWeeks: 12, peakWeeks: 4, taperDays: 10, raceMin: 120, sport: 'run' },
  marathon: { label: 'Marathon', buildWeeks: 16, peakWeeks: 4, taperDays: 21, raceMin: 240, sport: 'run' },
  gran_fondo: { label: 'Gran fondo', buildWeeks: 12, peakWeeks: 4, taperDays: 7, raceMin: 300, sport: 'bike' },
  mtb: { label: 'MTB race', buildWeeks: 10, peakWeeks: 3, taperDays: 5, raceMin: 120, sport: 'bike' },
  other: { label: 'Other', buildWeeks: 10, peakWeeks: 3, taperDays: 5, raceMin: 90, sport: 'other' },
};

export const A_RACE_HORIZON_DAYS = 24 * 7;
export const RECOVERY_DAYS = 7;

/** The next A race on or after `date` within the horizon. */
export function nextARace(date: string, races: Race[]): Race | null {
  return (
    races
      .filter((r) => r.priority === 'A' && r.date >= date && daysBetween(date, r.date) <= A_RACE_HORIZON_DAYS)
      .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null
  );
}

export function phaseOn(date: string, races: Race[]): Phase {
  const justRaced = races.find((r) => r.priority === 'A' && r.date < date && daysBetween(r.date, date) <= RECOVERY_DAYS);
  if (justRaced) return 'recovery';
  const race = nextARace(date, races);
  if (!race) return 'maintain';
  const cfg = RACE_TYPES[race.type];
  const out = daysBetween(date, race.date);
  if (out <= cfg.taperDays) return 'taper';
  if (out <= cfg.peakWeeks * 7) return 'peak';
  if (out <= cfg.buildWeeks * 7) return 'build';
  return 'base';
}

/** Monday on/before a date. */
export function weekStartOf(date: string): string {
  const wd = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -wd);
}

/** Fixed anchor so week parity and deloads are stable across runs. */
const ANCHOR_MONDAY = '2026-01-05';

export function weekIndex(weekStart: string): number {
  return Math.floor(daysBetween(ANCHOR_MONDAY, weekStart) / 7);
}

/**
 * 3:1 loading: every 4th week is a recovery ("deload") week. With an A race
 * the count runs back from the race so deloads land before peak/taper;
 * otherwise it follows the fixed anchor.
 */
export function isDeloadWeek(weekStart: string, races: Race[]): boolean {
  const phase = phaseOn(weekStart, races);
  if (phase === 'peak' || phase === 'taper' || phase === 'recovery') return false;
  const race = nextARace(weekStart, races);
  if (race) {
    const weeksOut = Math.floor(daysBetween(weekStart, race.date) / 7);
    return weeksOut > 0 && weeksOut % 4 === 0;
  }
  return ((weekIndex(weekStart) % 4) + 4) % 4 === 3;
}
