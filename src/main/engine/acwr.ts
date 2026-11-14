import { ACWR } from './constants';

/**
 * Acute:chronic workload ratio from daily load sums (coaching-engine.md §2).
 * EWMA with λ = 2/(N+1); rest days count as 0.
 */

export type AcwrBand = 'building' | 'detraining' | 'sweet_spot' | 'caution' | 'high_risk';

export interface DailyLoadPoint {
  date: string;
  load: number;
  acute: number;
  chronic: number;
  /** null until `minHistoryDays` of history exist. */
  acwr: number | null;
  band: AcwrBand;
  historyDays: number;
}

const lambda = (n: number) => 2 / (n + 1);

export function acwrBand(acwr: number | null): AcwrBand {
  if (acwr == null) return 'building';
  const b = ACWR.bands;
  if (acwr < b.detraining) return 'detraining';
  if (acwr <= b.sweetSpotMax) return 'sweet_spot';
  if (acwr <= b.cautionMax) return 'caution';
  return 'high_risk';
}

/**
 * `days` must be consecutive calendar days in order, starting at the first
 * day of history (first day with any data), with 0 for rest days.
 */
export function computeAcwr(days: Array<{ date: string; load: number }>): DailyLoadPoint[] {
  const la = lambda(ACWR.acuteDays);
  const lc = lambda(ACWR.chronicDays);
  let acute = 0;
  let chronic = 0;
  return days.map((d, i) => {
    acute = la * d.load + (1 - la) * acute;
    chronic = lc * d.load + (1 - lc) * chronic;
    const historyDays = i + 1;
    const acwr = historyDays >= ACWR.minHistoryDays && chronic > 1e-6 ? acute / chronic : null;
    return { date: d.date, load: d.load, acute, chronic, acwr, band: acwrBand(acwr), historyDays };
  });
}

/**
 * Evaluate proposed future loads before applying them: continue the EWMA from
 * the last known point through `future` (consecutive days) and return the
 * projected points.
 */
export function projectAcwr(last: DailyLoadPoint, future: Array<{ date: string; load: number }>): DailyLoadPoint[] {
  const la = lambda(ACWR.acuteDays);
  const lc = lambda(ACWR.chronicDays);
  let { acute, chronic, historyDays } = last;
  return future.map((d) => {
    acute = la * d.load + (1 - la) * acute;
    chronic = lc * d.load + (1 - lc) * chronic;
    historyDays++;
    const acwr = historyDays >= ACWR.minHistoryDays && chronic > 1e-6 ? acute / chronic : null;
    return { date: d.date, load: d.load, acute, chronic, acwr, band: acwrBand(acwr), historyDays };
  });
}
