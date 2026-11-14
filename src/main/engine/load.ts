import { LOAD } from './constants';

/**
 * Training load on one HR-based scale for every sport (coaching-engine.md §1).
 * Pure functions: inputs in, results out, no IO.
 */

export interface HrSample {
  /** Epoch ms. */
  t: number;
  hr: number;
}

export type Sport = 'swim' | 'bike' | 'run' | 'strength' | 'other';
export type LoadMethod = 'hr_trimp' | 'avg_hr_trimp' | 'srpe' | 'srpe_estimate' | 'strength_max';

export interface LoadInput {
  sport: Sport;
  isOpenWater: boolean;
  durationS: number;
  movingS?: number | null;
  avgHr?: number | null;
  /** Per-sample HR from the FIT file, if any. */
  hrSamples?: HrSample[] | null;
  rpe?: number | null;
}

export interface LoadContext {
  hrRest: number;
  hrMax: number;
  /** sRPE → TRIMP conversion factor. */
  k: number;
  /** HRM 600 stores swim HR → trust it for pool swims. */
  swimHrStorage: boolean;
}

export interface LoadResult {
  load: number;
  method: LoadMethod;
  /** HR TRIMP when computable (also used to calibrate k). */
  trimp: number | null;
  /** True when an RPE would improve (or is required for) this load. */
  needsRpe: boolean;
  reasons: string[];
}

/** Heart-rate reserve fraction, clamped to [0, 1]. */
export function hrReserve(hr: number, hrRest: number, hrMax: number): number {
  if (hrMax <= hrRest) return 0;
  return Math.min(1, Math.max(0, (hr - hrRest) / (hrMax - hrRest)));
}

const weight = (hrr: number) => hrr * LOAD.trimpA * Math.exp(LOAD.trimpB * hrr);

/**
 * Banister TRIMP from irregular samples: each sample's HR counts for the time
 * until the next sample, capped at `maxSampleGapS` so pauses don't add load.
 */
export function hrTrimp(samples: HrSample[], hrRest: number, hrMax: number, maxGapS: number = LOAD.maxSampleGapS): number {
  let total = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!;
    const dtS = Math.min((samples[i + 1]!.t - a.t) / 1000, maxGapS);
    if (dtS <= 0) continue;
    total += (dtS / 60) * weight(hrReserve(a.hr, hrRest, hrMax));
  }
  return total;
}

/** Seconds of the activity covered by HR samples (same gap cap). */
export function hrCoverageS(samples: HrSample[], maxGapS: number = LOAD.maxSampleGapS): number {
  let s = 0;
  for (let i = 0; i < samples.length - 1; i++) s += Math.max(0, Math.min((samples[i + 1]!.t - samples[i]!.t) / 1000, maxGapS));
  return s;
}

export function avgHrTrimp(durationMin: number, avgHr: number, hrRest: number, hrMax: number): number {
  return durationMin * weight(hrReserve(avgHr, hrRest, hrMax));
}

export const srpe = (durationMin: number, rpe: number) => durationMin * rpe;

/** k = median(TRIMP / sRPE) over sessions with both; default until enough samples. */
export function calibrateK(pairs: Array<{ trimp: number; srpe: number }>): { k: number; samples: number; calibrated: boolean } {
  const ratios = pairs.filter((p) => p.srpe > 0 && p.trimp > 0).map((p) => p.trimp / p.srpe).sort((a, b) => a - b);
  if (ratios.length < LOAD.minKSamples) return { k: LOAD.defaultK, samples: ratios.length, calibrated: false };
  const mid = ratios.length >> 1;
  const median = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return { k: Math.min(LOAD.kMax, Math.max(LOAD.kMin, median)), samples: ratios.length, calibrated: true };
}

/** Load for one activity, choosing the method by the rules in coaching-engine.md §1. */
export function activityLoad(a: LoadInput, ctx: LoadContext): LoadResult {
  const durationMin = Math.max(0, (a.movingS && a.movingS > 0 ? a.movingS : a.durationS) / 60);
  const reasons: string[] = [];
  const hasRpe = typeof a.rpe === 'number' && a.rpe >= 1 && a.rpe <= 10;
  const rpeLoad = (rpe: number) => srpe(durationMin, rpe) * ctx.k;

  // HR TRIMP if we have enough samples, else from average HR.
  let trimp: number | null = null;
  let trimpMethod: LoadMethod | null = null;
  const samples = a.hrSamples ?? [];
  if (samples.length > 1 && hrCoverageS(samples) >= LOAD.minHrCoverage * durationMin * 60) {
    trimp = hrTrimp(samples, ctx.hrRest, ctx.hrMax);
    trimpMethod = 'hr_trimp';
  } else if (a.avgHr && a.avgHr > 0) {
    trimp = avgHrTrimp(durationMin, a.avgHr, ctx.hrRest, ctx.hrMax);
    trimpMethod = 'avg_hr_trimp';
  }

  const poolSwim = a.sport === 'swim' && !a.isOpenWater;
  if (poolSwim && !ctx.swimHrStorage) {
    reasons.push('Wrist HR is unreliable in the pool, so swim load uses effort (RPE).');
    if (hasRpe) return { load: rpeLoad(a.rpe!), method: 'srpe', trimp, needsRpe: false, reasons };
    reasons.push(`No RPE yet — assuming ${LOAD.placeholderRpe}/10 until you enter one.`);
    return { load: rpeLoad(LOAD.placeholderRpe), method: 'srpe_estimate', trimp, needsRpe: true, reasons };
  }

  if (a.sport === 'strength') {
    reasons.push('Heart rate under-counts lifting, so strength load is the higher of HR and effort.');
    const effort = rpeLoad(hasRpe ? a.rpe! : LOAD.placeholderRpe);
    if (!hasRpe) reasons.push(`No RPE yet — assuming ${LOAD.placeholderRpe}/10 until you enter one.`);
    if (trimp != null && trimp >= effort) return { load: trimp, method: trimpMethod!, trimp, needsRpe: !hasRpe, reasons };
    return { load: effort, method: hasRpe ? 'strength_max' : 'srpe_estimate', trimp, needsRpe: !hasRpe, reasons };
  }

  if (trimp != null) return { load: trimp, method: trimpMethod!, trimp, needsRpe: false, reasons };

  reasons.push('No heart-rate data, so load uses effort (RPE).');
  if (hasRpe) return { load: rpeLoad(a.rpe!), method: 'srpe', trimp: null, needsRpe: false, reasons };
  reasons.push(`No RPE yet — assuming ${LOAD.placeholderRpe}/10 until you enter one.`);
  return { load: rpeLoad(LOAD.placeholderRpe), method: 'srpe_estimate', trimp: null, needsRpe: true, reasons };
}
