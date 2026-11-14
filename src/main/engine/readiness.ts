import { ACWR, READINESS } from './constants';

/**
 * Daily readiness verdict (coaching-engine.md §3). Every factor carries a
 * one-line reason the UI can show. Conservative when data is missing.
 */

export type Verdict = 'go' | 'easy' | 'rest';
export type FactorStatus = 'ok' | 'amber' | 'red' | 'missing';
export type FactorKey = 'hrv' | 'resting_hr' | 'sleep' | 'body_battery' | 'acwr' | 'yesterday_load';

export interface Factor {
  key: FactorKey;
  status: FactorStatus;
  value: number | null;
  reason: string;
}

export interface ReadinessResult {
  verdict: Verdict;
  factors: Factor[];
  /** Short headline reason for the verdict. */
  summary: string;
}

export interface DayHealth {
  date: string;
  restingHr: number | null;
  hrvLastNight: number | null;
  /** Garmin's "low" line (lowUpper); preferred over the balanced-band floor. */
  hrvLow?: number | null;
  hrvBaselineLow: number | null;
  sleepSeconds: number | null;
  sleepScore: number | null;
  bodyBatteryWake: number | null;
}

export interface ReadinessInput {
  today: DayHealth;
  /** Previous days, most recent first (yesterday at index 0). At least 7 for the RHR baseline. */
  previous: DayHealth[];
  /** ACWR through yesterday (null while building baseline). */
  acwr: number | null;
  yesterdayLoad: number | null;
  /** Mean load of the training days (load > 0) in the 28 days before today; null if too few. */
  typicalDayLoad28: number | null;
}

const R = READINESS;

function hrvFactor(today: DayHealth, previous: DayHealth[]): Factor {
  const v = today.hrvLastNight;
  const low = lowLine(today);
  if (v == null) return { key: 'hrv', status: 'missing', value: null, reason: 'No HRV reading from last night.' };
  if (low == null) return { key: 'hrv', status: 'missing', value: v, reason: 'Garmin is still building your HRV baseline.' };
  if (v >= low) return { key: 'hrv', status: 'ok', value: v, reason: `HRV ${v} ms is within your normal range.` };
  let run = 1;
  for (const d of previous) {
    const l = lowLine(d);
    if (d.hrvLastNight != null && l != null && d.hrvLastNight < l) run++;
    else break;
  }
  if (run >= R.hrv.redConsecutiveDays) {
    return { key: 'hrv', status: 'red', value: v, reason: `HRV has been below your normal range for ${run} nights in a row.` };
  }
  return { key: 'hrv', status: 'amber', value: v, reason: `HRV ${v} ms is below your normal range (${low}+).` };
}

/** Below this a night counts as low HRV: Garmin's lowUpper, else the balanced-band floor. */
function lowLine(d: DayHealth): number | null {
  return d.hrvLow ?? d.hrvBaselineLow;
}

function restingHrFactor(today: DayHealth, previous: DayHealth[]): Factor {
  const v = today.restingHr;
  if (v == null) return { key: 'resting_hr', status: 'missing', value: null, reason: 'No resting heart rate for today.' };
  const base = previous.slice(0, 7).map((d) => d.restingHr).filter((x): x is number => x != null);
  if (base.length < R.restingHr.minBaselineDays) {
    return { key: 'resting_hr', status: 'missing', value: v, reason: 'Not enough recent days to compare resting heart rate.' };
  }
  const mean = base.reduce((s, x) => s + x, 0) / base.length;
  const delta = v - mean;
  const d = Math.round(delta);
  if (delta >= R.restingHr.redDelta) return { key: 'resting_hr', status: 'red', value: v, reason: `Resting HR ${v} is ${d} bpm above your 7-day average.` };
  if (delta >= R.restingHr.amberDelta) return { key: 'resting_hr', status: 'amber', value: v, reason: `Resting HR ${v} is ${d} bpm above your 7-day average.` };
  return { key: 'resting_hr', status: 'ok', value: v, reason: `Resting HR ${v} is normal for you.` };
}

function sleepFactor(today: DayHealth): Factor {
  const { sleepSeconds: s, sleepScore: score } = today;
  if (s == null && score == null) return { key: 'sleep', status: 'missing', value: null, reason: 'No sleep recorded last night.' };
  const h = s != null ? s / 3600 : null;
  const hTxt = h != null ? `${Math.floor(h)}h${String(Math.round((h % 1) * 60)).padStart(2, '0')}` : null;
  const desc = [hTxt, score != null ? `score ${score}` : null].filter(Boolean).join(', ');
  if ((h != null && h < R.sleep.redHours) || (score != null && score < R.sleep.redScore)) {
    return { key: 'sleep', status: 'red', value: score ?? h, reason: `Very short or poor sleep (${desc}).` };
  }
  if ((h != null && h < R.sleep.amberHours) || (score != null && score < R.sleep.amberScore)) {
    return { key: 'sleep', status: 'amber', value: score ?? h, reason: `Sleep was on the short or light side (${desc}).` };
  }
  return { key: 'sleep', status: 'ok', value: score ?? h, reason: `Slept well (${desc}).` };
}

function bodyBatteryFactor(today: DayHealth): Factor {
  const v = today.bodyBatteryWake;
  if (v == null) return { key: 'body_battery', status: 'missing', value: null, reason: 'No Body Battery reading at wake-up.' };
  if (v < R.bodyBattery.red) return { key: 'body_battery', status: 'red', value: v, reason: `Body Battery only ${v} at wake-up.` };
  if (v < R.bodyBattery.amber) return { key: 'body_battery', status: 'amber', value: v, reason: `Body Battery ${v} at wake-up is lower than ideal.` };
  return { key: 'body_battery', status: 'ok', value: v, reason: `Body Battery ${v} at wake-up.` };
}

function acwrFactor(acwr: number | null): Factor {
  if (acwr == null) return { key: 'acwr', status: 'missing', value: null, reason: 'Still building a 4-week training baseline.' };
  const v = Math.round(acwr * 100) / 100;
  if (acwr > R.acwr.red) return { key: 'acwr', status: 'red', value: v, reason: `Load ratio ${v.toFixed(2)}: this week is much harder than you're used to.` };
  if (acwr > R.acwr.amber) return { key: 'acwr', status: 'amber', value: v, reason: `Load ratio ${v.toFixed(2)}: this week is ramping up quickly.` };
  if (acwr < ACWR.bands.detraining) {
    return { key: 'acwr', status: 'ok', value: v, reason: `Load ratio ${v.toFixed(2)}: you've trained less than usual lately, so you're fresh.` };
  }
  return { key: 'acwr', status: 'ok', value: v, reason: `Load ratio ${v.toFixed(2)} is in a safe range.` };
}

function yesterdayFactor(y: number | null, avg: number | null): Factor {
  if (y == null || avg == null || avg < R.yesterdayLoad.minTypicalLoad) {
    return { key: 'yesterday_load', status: 'missing', value: y, reason: 'Not enough history to judge yesterday’s load.' };
  }
  const ratio = y / avg;
  const r = Math.round(ratio * 10) / 10;
  if (ratio > R.yesterdayLoad.redRatio) return { key: 'yesterday_load', status: 'red', value: y, reason: `Yesterday was a very big day (${r}× a usual training day).` };
  if (ratio > R.yesterdayLoad.amberRatio) return { key: 'yesterday_load', status: 'amber', value: y, reason: `Yesterday was a big day (${r}× a usual training day).` };
  return { key: 'yesterday_load', status: 'ok', value: y, reason: y === 0 ? 'Yesterday was a rest day.' : 'Yesterday’s load was normal for you.' };
}

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const factors: Factor[] = [
    hrvFactor(input.today, input.previous),
    restingHrFactor(input.today, input.previous),
    sleepFactor(input.today),
    bodyBatteryFactor(input.today),
    acwrFactor(input.acwr),
    yesterdayFactor(input.yesterdayLoad, input.typicalDayLoad28),
  ];
  const red = factors.filter((f) => f.status === 'red');
  const amber = factors.filter((f) => f.status === 'amber');
  const amberKeys = new Set(amber.map((f) => f.key as string));
  let amberCount = amber.length;
  for (const [a, b] of R.correlatedAmber) if (amberKeys.has(a) && amberKeys.has(b)) amberCount--;
  const missing = factors.filter((f) => f.status === 'missing');

  if (red.length) return { verdict: 'rest', factors, summary: red[0]!.reason };
  if (amberCount >= R.amberForEasy) {
    return { verdict: 'easy', factors, summary: `Take it easy: ${amber.map((f) => f.reason.replace(/\.$/, '')).join('; ')}.` };
  }
  if (missing.length >= R.maxMissing) return { verdict: 'easy', factors, summary: 'Not enough data today — keep it easy.' };
  return { verdict: 'go', factors, summary: amber.length ? `Good to go. Watch: ${amber[0]!.reason}` : 'Good to go.' };
}
