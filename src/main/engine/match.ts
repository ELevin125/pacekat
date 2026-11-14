import { MATCH } from './constants';
import type { Sport } from './load';

/**
 * Planned vs done (coaching-engine.md §6). Match by local date + sport family;
 * with several candidates, the closest duration wins. Each activity matches at
 * most one session. Used by the plan engine from M3.
 */

export type PlanStatus = 'planned' | 'done' | 'partial' | 'missed' | 'skipped' | 'moved';

export interface PlannedLike {
  id: number;
  localDate: string;
  sport: Sport | 'rest';
  durationMin: number | null;
  /** User-set statuses (skipped/moved) are kept as-is. */
  status: PlanStatus;
}

export interface ActivityLike {
  id: number;
  localDate: string;
  sport: Sport;
  durationS: number;
}

export interface MatchResult {
  plannedId: number;
  status: PlanStatus;
  activityId: number | null;
}

export function matchPlanned(planned: PlannedLike[], activities: ActivityLike[], today: string): { matches: MatchResult[]; extras: number[] } {
  const used = new Set<number>();
  const matches: MatchResult[] = [];

  // Longest sessions first so a long planned session isn't robbed by a short one on the same day.
  const order = [...planned].sort((a, b) => a.localDate.localeCompare(b.localDate) || (b.durationMin ?? 0) - (a.durationMin ?? 0));
  for (const p of order) {
    if (p.status === 'skipped' || p.status === 'moved' || p.sport === 'rest') {
      matches.push({ plannedId: p.id, status: p.status, activityId: null });
      continue;
    }
    const target = (p.durationMin ?? 0) * 60;
    const candidates = activities.filter((a) => !used.has(a.id) && a.localDate === p.localDate && a.sport === p.sport);
    const best = candidates.sort((a, b) => Math.abs(a.durationS - target) - Math.abs(b.durationS - target))[0];
    if (best) {
      used.add(best.id);
      const share = target > 0 ? best.durationS / target : 1;
      const status: PlanStatus = share >= MATCH.doneShare ? 'done' : share >= MATCH.partialShare ? 'partial' : p.localDate < today ? 'missed' : 'planned';
      matches.push({ plannedId: p.id, status, activityId: status === 'done' || status === 'partial' ? best.id : null });
      if (status !== 'done' && status !== 'partial') used.delete(best.id);
    } else {
      matches.push({ plannedId: p.id, status: p.localDate < today ? 'missed' : 'planned', activityId: null });
    }
  }
  const extras = activities.filter((a) => !used.has(a.id)).map((a) => a.id);
  return { matches, extras };
}
