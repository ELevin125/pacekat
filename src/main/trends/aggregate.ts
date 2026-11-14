import { addDays } from '../util/dates';
import type { FocusHint, TrendSport, TrendsData } from '../../shared/api';

/**
 * Weekly trend series for the Trends page (coaching-engine.md §9). Pure:
 * rows in, series out. Weeks run Monday–Sunday; the current week is partial.
 */

export interface TrendActivity {
  date: string;
  sport: string;
  durationS: number | null;
  movingS: number | null;
  distanceM: number | null;
  avgHr: number | null;
  avgCadence: number | null;
  load: number | null;
  isCommute: boolean;
  isOpenWater: boolean;
  swimPaceSPer100m: number | null;
  swolf: number | null;
  vo2max: number | null;
  gctMs?: number | null;
  vertOscCm?: number | null;
  strideM?: number | null;
}

export interface TrendDay {
  date: string;
  load: number | null;
  acwr: number | null;
  hrv: number | null;
  hrvLow: number | null;
  hrvHigh: number | null;
  rhr: number | null;
}

export interface TrendInput {
  activities: TrendActivity[];
  days: TrendDay[];
  weeks: number;
  /** Monday of the current week. */
  currentWeek: string;
  /** Top of HR zone 2: an easy run is at or below it. */
  zone2Max: number | null;
  /** Reference HR for aerobic efficiency (pace at this HR). */
  refHr: number;
  triathlonFocus: boolean;
  runningDynamics: boolean;
}

const SPORTS: TrendSport[] = ['swim', 'bike', 'run', 'strength', 'other'];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

export function isEasyRun(a: TrendActivity, zone2Max: number | null, refHr: number): boolean {
  if (a.sport !== 'run' || !a.avgHr || !a.distanceM || !(a.movingS ?? a.durationS)) return false;
  if ((a.movingS ?? a.durationS)! < 15 * 60) return false;
  return a.avgHr <= (zone2Max ?? refHr + 10);
}

/** Pace (s/km) this run would have had at `refHr`, assuming speed ∝ heart rate (efficiency factor). */
export function paceAtHr(a: TrendActivity, refHr: number): number | null {
  const secs = a.movingS ?? a.durationS;
  if (!secs || !a.distanceM || !a.avgHr) return null;
  const paceSPerKm = secs / (a.distanceM / 1000);
  return paceSPerKm * (a.avgHr / refHr);
}

export function aggregateTrends(input: TrendInput): TrendsData {
  const weeks = Array.from({ length: input.weeks }, (_, i) => addDays(input.currentWeek, -7 * (input.weeks - 1 - i)));
  const inWeek = <T extends { date: string }>(rows: T[], ws: string) => rows.filter((r) => r.date >= ws && r.date <= addDays(ws, 6));

  const load = Object.fromEntries(SPORTS.map((s) => [s, [] as number[]])) as Record<TrendSport, number[]>;
  const time = Object.fromEntries(SPORTS.map((s) => [s, 0])) as Record<TrendSport, number>;
  const acwr: Array<number | null> = [];
  const hrv: Array<number | null> = [];
  const rhr: Array<number | null> = [];
  const swimPace: Array<number | null> = [];
  const swolf: Array<number | null> = [];
  const runEff: Array<number | null> = [];
  const cadence: Array<number | null> = [];
  const commuteSpeed: Array<number | null> = [];
  const commuteHr: Array<number | null> = [];
  const vo2: Array<number | null> = [];
  const gct: Array<number | null> = [];
  const vertOsc: Array<number | null> = [];
  const stride: Array<number | null> = [];

  for (const ws of weeks) {
    const acts = inWeek(input.activities, ws);
    const days = inWeek(input.days, ws);
    for (const s of SPORTS) {
      const mine = acts.filter((a) => (a.sport as TrendSport) === s || (s === 'other' && !SPORTS.includes(a.sport as TrendSport)));
      load[s].push(Math.round(mine.reduce((sum, a) => sum + (a.load ?? 0), 0)));
      time[s] += mine.reduce((sum, a) => sum + (a.movingS ?? a.durationS ?? 0), 0);
    }
    const lastAcwr = [...days].reverse().find((d) => d.acwr != null);
    acwr.push(r2(lastAcwr?.acwr ?? null));
    hrv.push(r1(mean(days.map((d) => d.hrv).filter((v): v is number => v != null))));
    rhr.push(r1(mean(days.map((d) => d.rhr).filter((v): v is number => v != null))));

    const pool = acts.filter((a) => a.sport === 'swim' && !a.isOpenWater && a.distanceM && (a.movingS ?? a.durationS));
    const poolDist = pool.reduce((s, a) => s + a.distanceM!, 0);
    const poolTime = pool.reduce((s, a) => s + (a.swimPaceSPer100m ? (a.swimPaceSPer100m * a.distanceM!) / 100 : (a.movingS ?? a.durationS)!), 0);
    swimPace.push(poolDist > 0 ? Math.round((poolTime / poolDist) * 100) : null);
    swolf.push(r1(mean(pool.map((a) => a.swolf).filter((v): v is number => v != null && v > 0))));

    const easy = acts.filter((a) => isEasyRun(a, input.zone2Max, input.refHr));
    const eff = easy.map((a) => paceAtHr(a, input.refHr)).filter((v): v is number => v != null);
    runEff.push(eff.length ? Math.round(mean(eff)!) : null);
    cadence.push(r1(mean(easy.map((a) => a.avgCadence).filter((v): v is number => v != null && v > 0))));

    const comm = acts.filter((a) => a.isCommute && a.distanceM && (a.movingS ?? a.durationS));
    const cd = comm.reduce((s, a) => s + a.distanceM!, 0);
    const ct = comm.reduce((s, a) => s + (a.movingS ?? a.durationS)!, 0);
    commuteSpeed.push(ct > 0 ? r1((cd / ct) * 3.6) : null);
    commuteHr.push(r1(mean(comm.map((a) => a.avgHr).filter((v): v is number => v != null))));

    const v = acts.map((a) => a.vo2max).filter((x): x is number => x != null);
    vo2.push(v.length ? Math.max(...v) : null);

    if (input.runningDynamics) {
      const runs = acts.filter((a) => a.sport === 'run');
      gct.push(r1(mean(runs.map((a) => a.gctMs).filter((x): x is number => x != null && x > 0))));
      vertOsc.push(r1(mean(runs.map((a) => a.vertOscCm).filter((x): x is number => x != null && x > 0))));
      stride.push(r2(mean(runs.map((a) => a.strideM).filter((x): x is number => x != null && x > 0))));
    }
  }

  const latest = <T>(xs: Array<T | null>): T | null => [...xs].reverse().find((x) => x != null) ?? null;
  const firstVal = <T>(xs: Array<T | null>): T | null => xs.find((x) => x != null) ?? null;
  const band = [...input.days].reverse().find((d) => d.hrvLow != null && d.hrvHigh != null);
  const vo2Now = latest(vo2);
  const vo2First = firstVal(vo2);

  const data: TrendsData = {
    weeks,
    load,
    acwr,
    acwrNow: latest(acwr),
    hrv,
    hrvBand: band ? [band.hrvLow!, band.hrvHigh!] : null,
    rhr,
    swimPace,
    swolf,
    runEff,
    refHr: input.refHr,
    cadence,
    commuteSpeed,
    commuteHr,
    vo2,
    vo2Now,
    vo2Change: vo2Now != null && vo2First != null ? vo2Now - vo2First : null,
    dynamics: input.runningDynamics ? { gct, vertOsc, stride } : null,
    timeShare: (() => {
      const total = SPORTS.reduce((s, k) => s + time[k], 0);
      return Object.fromEntries(SPORTS.map((k) => [k, total > 0 ? time[k] / total : 0])) as Record<TrendSport, number>;
    })(),
    focus: [],
  };
  data.focus = focusHints(data, input);
  return data;
}

/** 1–3 simple, honest hints (coaching-engine.md §9): watch items first, then what's going well. */
export function focusHints(d: TrendsData, input: TrendInput): FocusHint[] {
  const watch: FocusHint[] = [];
  const good: FocusHint[] = [];
  const pct = (x: number) => Math.round(x * 100);

  const trainedTime = Object.values(d.timeShare).some((v) => v > 0);
  if (input.triathlonFocus && trainedTime) {
    const swim = d.timeShare.swim;
    if (swim < 0.15) {
      watch.push({ kind: 'watch', title: 'Swim is your smallest slice', detail: `${pct(swim)} % of training time. For a triathlon, 15–20 % or more is a better balance; a longer Saturday swim is the easiest fix.`, action: 'week' });
    }
  }

  const recent = <T>(xs: Array<T | null>, n: number) => xs.slice(-n).filter((x): x is T => x != null);
  const cad = recent(d.cadence, 4);
  if (cad.length >= 2) {
    const c = Math.round(mean(cad)!);
    if (c < 160) watch.push({ kind: 'watch', title: 'Easy-run cadence is low', detail: `${c} spm on easy runs. Around 160+ spm usually means less over-striding; try slightly shorter, quicker steps.` });
    else good.push({ kind: 'good', title: 'Cadence is fine', detail: `Easy-run cadence averages ${c} spm, above the 160 spm guide.` });
  }

  const eff = d.runEff.filter((x): x is number => x != null);
  if (eff.length >= 4) {
    const first = mean(eff.slice(0, Math.ceil(eff.length / 3)))!;
    const last = mean(eff.slice(-Math.ceil(eff.length / 3)))!;
    const diff = Math.round(first - last);
    if (diff >= 5) good.push({ kind: 'good', title: 'Easy runs are getting faster', detail: `Pace at ${d.refHr} bpm improved by ${diff} s/km over this period. The aerobic base is working.` });
    else if (diff <= -10) watch.push({ kind: 'watch', title: 'Easy runs are slower at the same heart rate', detail: `Pace at ${d.refHr} bpm is ${-diff} s/km slower than earlier in this period. Fatigue, heat or illness can all do this.` });
  }

  if (d.acwrNow != null && d.acwrNow > 1.3) watch.push({ kind: 'watch', title: 'Load is ramping fast', detail: `Load ratio ${d.acwrNow.toFixed(2)}: recent weeks are well above what you're used to. The plan eases off automatically.` });
  const lowWeeks = recent(d.acwr, 3);
  if (lowWeeks.length >= 2 && lowWeeks.every((v) => v < 0.8)) {
    watch.push({ kind: 'watch', title: 'Training has dropped off', detail: 'Load ratio has been under 0.8 for a few weeks. The plan eases you back in rather than jumping straight back to full volume.' });
  }

  const hrvRecent = recent(d.hrv, 2);
  if (d.hrvBand && hrvRecent.length && mean(hrvRecent)! < d.hrvBand[0]) {
    watch.push({ kind: 'watch', title: 'HRV is below your normal range', detail: `Recent weekly HRV ${Math.round(mean(hrvRecent)!)} ms vs a normal range from ${d.hrvBand[0]} ms. Sleep and easy days help.` });
  }

  return [...watch, ...good].slice(0, 3);
}
