/**
 * Every engine threshold in one place (docs/coaching-engine.md).
 * Initial values — tune against real data. Keep defaults conservative.
 */

export const LOAD = {
  /** Banister TRIMP weighting: HRr × A × e^(B × HRr). Male coefficients per the docs. */
  trimpA: 0.64,
  trimpB: 1.92,
  /** FIT "smart recording" logs every few seconds; gaps longer than this are pauses and are capped. */
  maxSampleGapS: 30,
  /** Need HR on at least this share of the activity's duration to trust the per-sample TRIMP. */
  minHrCoverage: 0.5,
  /** sRPE → TRIMP factor until calibrated (see coaching-engine.md §1 for the sanity check). */
  defaultK: 0.3,
  /** Sessions with both TRIMP and RPE needed before k is calibrated from data. */
  minKSamples: 10,
  kWindowDays: 60,
  /** Clamp calibrated k to a sane band so one odd session can't distort every swim and gym load. */
  kMin: 0.1,
  kMax: 1.0,
  /** RPE assumed when one is needed but not entered yet (load is flagged as an estimate). */
  placeholderRpe: 5,
  /** Fallbacks when neither settings nor Garmin give us values. */
  fallbackHrMax: 190,
  fallbackHrRest: 60,
  restHrWindowDays: 7,
} as const;

export const ACWR = {
  acuteDays: 7,
  chronicDays: 28,
  /** Days of history before ACWR is shown and used by rules. */
  minHistoryDays: 28,
  bands: { detraining: 0.8, sweetSpotMax: 1.3, cautionMax: 1.5 },
} as const;

export const READINESS = {
  restingHr: { amberDelta: 5, redDelta: 8, minBaselineDays: 3 },
  sleep: { amberHours: 6, redHours: 5, amberScore: 60, redScore: 45 },
  bodyBattery: { amber: 50, red: 30 },
  hrv: { redConsecutiveDays: 3 },
  acwr: { amber: 1.3, red: 1.5 },
  /** Yesterday vs a typical training day (mean of days with load in the last 28), so frequency doesn't matter. */
  yesterdayLoad: { amberRatio: 2, redRatio: 3, minTypicalLoad: 5, minTrainingDays: 4 },
  /**
   * Factor pairs driven by the same underlying signal: Body Battery's overnight
   * recharge is computed from HRV, so both amber counts as one amber.
   */
  correlatedAmber: [['hrv', 'body_battery']] as ReadonlyArray<readonly [string, string]>,
  /** This many missing inputs → "easy, not enough data today". */
  maxMissing: 3,
  /** Amber factors needed for "easy". */
  amberForEasy: 2,
} as const;

export const COMMUTE = {
  minKm: 4,
  maxKm: 15,
  /** Avg HR must be at or below the top of this zone. */
  maxZone: 2,
} as const;

export const MATCH = {
  /** ≥ this share of planned duration → done; ≥ partial → partial; else not matched as done. */
  doneShare: 0.8,
  partialShare: 0.3,
} as const;
