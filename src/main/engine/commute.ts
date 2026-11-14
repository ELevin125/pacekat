import { COMMUTE } from './constants';

/**
 * Commute detection (coaching-engine.md §6): cycling, Mon–Fri, 4–15 km,
 * average HR at or below the top of zone 2. Manual flags always win; the
 * caller only applies this when the user hasn't set it.
 */

export interface CommuteInput {
  sport: string;
  localDate: string; // YYYY-MM-DD
  distanceM: number | null;
  avgHr: number | null;
}

/** 0 = Monday … 6 = Sunday, from a calendar date (no timezone involved). */
export function weekdayOf(localDate: string): number {
  const d = new Date(`${localDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return (d + 6) % 7;
}

export function detectCommute(a: CommuteInput, zone2UpperBpm: number | null): { isCommute: boolean; reason: string } {
  if (a.sport !== 'bike') return { isCommute: false, reason: 'Not a ride.' };
  if (weekdayOf(a.localDate) > 4) return { isCommute: false, reason: 'Weekend ride.' };
  const km = (a.distanceM ?? 0) / 1000;
  if (km < COMMUTE.minKm || km > COMMUTE.maxKm) return { isCommute: false, reason: `${km.toFixed(1)} km is outside the commute range.` };
  if (zone2UpperBpm == null || a.avgHr == null) return { isCommute: false, reason: 'No heart rate or zones to judge effort.' };
  if (a.avgHr > zone2UpperBpm) return { isCommute: false, reason: `Average HR ${a.avgHr} is above zone ${COMMUTE.maxZone}.` };
  return { isCommute: true, reason: `Weekday ride of ${km.toFixed(1)} km at easy effort.` };
}
