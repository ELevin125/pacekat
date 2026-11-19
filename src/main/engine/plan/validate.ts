import { projectAcwr, type DailyLoadPoint } from '../acwr';
import { addDays, eachDay } from '../../util/dates';
import { PLAN } from './generate';
import type { PlanMode, Warning } from './types';

/**
 * Plan validators (coaching-engine.md §7.3). They warn, never block: the
 * athlete is the boss.
 */

export interface ActiveSession {
  date: string;
  isKey: boolean;
  estLoad: number;
  sessionKey: string;
  title: string;
}

export interface ValidateContext {
  weekStart: string;
  /** First day whose load is still planned (earlier days are history). */
  fromDate: string;
  /** ACWR point for the day before `fromDate`; null without history. */
  lastPoint: DailyLoadPoint | null;
  /** Ramp reference: max(previous week's actual, 7 × chronic). */
  rampRef: number | null;
  /** Actual load this week before `fromDate`. */
  weekLoadSoFar: number;
  mode: PlanMode;
  /** The cap the engine planned this week with (floored when easing back in after a break). */
  planCap?: number | null;
}

const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const dayName = (date: string) => DAY[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;

export function validateWeek(sessions: ActiveSession[], ctx: ValidateContext): Warning[] {
  const warnings: Warning[] = [];
  const sunday = addDays(ctx.weekStart, 6);
  const keyDates = [...new Set(sessions.filter((s) => s.isKey).map((s) => s.date))].sort();

  for (const d of keyDates) {
    const next = addDays(d, 1);
    if (keyDates.includes(next)) {
      warnings.push({ code: 'key_back_to_back', message: `Two hard days in a row: ${dayName(d)} and ${dayName(next)}.`, dates: [d, next] });
    }
  }
  if (keyDates.length > PLAN.maxKeys) {
    warnings.push({ code: 'too_many_keys', message: `${keyDates.length} hard days this week; ${PLAN.maxKeys} is the most that's safe to recover from.`, dates: keyDates });
  }

  const factor = ctx.mode === 'maintain' ? PLAN.maintainRampFactor : PLAN.rampFactor;
  const rampCap = ctx.rampRef && ctx.rampRef > 0 ? ctx.rampRef * factor : null;
  // Easing back in: the engine raised the cap above the ramp on purpose, and the load ratio
  // is meaningless with a near-zero baseline, so judge the week the way it was planned.
  const easingBack = ctx.planCap != null && rampCap != null && ctx.planCap > rampCap * 1.01;

  if (ctx.lastPoint && ctx.fromDate <= sunday && !easingBack) {
    const days = eachDay(ctx.fromDate, sunday).map((date) => ({ date, load: sessions.filter((s) => s.date === date).reduce((a, s) => a + s.estLoad, 0) }));
    const proj = projectAcwr(ctx.lastPoint, days);
    const high = proj.filter((p) => p.acwr != null && p.acwr > PLAN.sundayAcwrMax);
    if (high.length) {
      const peak = Math.max(...high.map((p) => p.acwr!));
      warnings.push({ code: 'acwr_high', message: `The load ratio would reach ${peak.toFixed(2)} (safe is up to ${PLAN.sundayAcwrMax}).`, dates: high.map((p) => p.date) });
    }
  }

  if (rampCap != null) {
    const planned = sessions.filter((s) => s.date >= ctx.fromDate && s.sessionKey !== 'race').reduce((a, s) => a + s.estLoad, 0) + ctx.weekLoadSoFar;
    const cap = easingBack ? ctx.planCap! : rampCap;
    if (planned > cap * 1.01) {
      warnings.push({
        code: 'ramp',
        message: easingBack
          ? `This week's load is ${Math.round((planned / cap - 1) * 100)} % above the easing-back-in limit.`
          : `This week's load is ${Math.round((planned / ctx.rampRef! - 1) * 100)} % above your recent training (limit ${Math.round((factor - 1) * 100)} %).`,
        dates: [],
      });
    }
  }
  return warnings;
}
