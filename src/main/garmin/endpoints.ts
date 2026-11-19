/**
 * Garmin Connect Personal API endpoint catalogue.
 *
 * Source of truth: the OpenAPI spec embedded in
 * https://developer.garmin.com/gc-developer-program/personal/swagger-docs/
 * (spec version 1.0.0, checked 2026-11-14). Range limits below are the ones the
 * spec states in each endpoint's description; where it states none we pick a
 * conservative chunk size and mark it `limitDocumented: false`.
 *
 * Every endpoint is a GET. No IO in this file.
 */

export const GARMIN_API_BASE = 'https://personal.connectapi.garmin.com';
export const GARMIN_TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

export type DateStr = string; // YYYY-MM-DD, athlete-local calendar day

export interface RequestSpec {
  path: string;
  query?: Record<string, string | number | boolean>;
}

/** Endpoint fetched once per date range, chunked to `maxDays`. */
export interface RangeEndpoint {
  kind: 'range';
  name: string;
  maxDays: number;
  limitDocumented: boolean;
  build: (from: DateStr, to: DateStr) => RequestSpec;
}

/** Endpoint fetched once per calendar day. */
export interface DailyEndpoint {
  kind: 'daily';
  name: string;
  build: (date: DateStr) => RequestSpec;
}

/** Endpoint with no date parameter. */
export interface StaticEndpoint {
  kind: 'static';
  name: string;
  build: () => RequestSpec;
}

export type Endpoint = RangeEndpoint | DailyEndpoint | StaticEndpoint;

export const rangeEndpoints: RangeEndpoint[] = [
  {
    kind: 'range', name: 'daily-summaries', maxDays: 366, limitDocumented: true,
    build: (from, to) => ({ path: '/usersummary-service/v2/dailysummaries', query: { startDate: from, endDate: to } }),
  },
  {
    kind: 'range', name: 'sleep-summaries', maxDays: 31, limitDocumented: true,
    build: (from, to) => ({ path: '/sleep-service/sleep/dailySleepSummariesByDate', query: { startDate: from, endDate: to } }),
  },
  {
    kind: 'range', name: 'hrv-daily', maxDays: 28, limitDocumented: false,
    build: (from, to) => ({ path: `/hrv-service/hrv/daily/${from}/${to}` }),
  },
  {
    kind: 'range', name: 'body-battery', maxDays: 31, limitDocumented: true,
    build: (from, to) => ({ path: '/wellness-service/wellness/bodyBattery/reports/daily', query: { startDate: from, endDate: to } }),
  },
  {
    kind: 'range', name: 'steps', maxDays: 28, limitDocumented: true,
    build: (from, to) => ({ path: `/usersummary-service/stats/steps/daily/${from}/${to}` }),
  },
  {
    kind: 'range', name: 'stress', maxDays: 28, limitDocumented: true,
    build: (from, to) => ({ path: `/usersummary-service/stats/stress/daily/${from}/${to}` }),
  },
  {
    kind: 'range', name: 'hydration', maxDays: 31, limitDocumented: true,
    build: (from, to) => ({ path: `/usersummary-service/stats/hydration/daily/${from}/${to}` }),
  },
  {
    kind: 'range', name: 'weight-range', maxDays: 31, limitDocumented: false,
    build: (from, to) => ({ path: `/weight-service/weight/range/${from}/${to}`, query: { includeAll: true } }),
  },
  {
    kind: 'range', name: 'wellness-activities', maxDays: 31, limitDocumented: false,
    build: (from, to) => ({ path: `/wellnessactivity-service/activity/summary/range/${from}/${to}` }),
  },
];

export const dailyEndpoints: DailyEndpoint[] = [
  { kind: 'daily', name: 'hrv-day', build: (d) => ({ path: `/hrv-service/hrv/${d}` }) },
  { kind: 'daily', name: 'sleep-day', build: (d) => ({ path: '/sleep-service/sleep/dailySleep', query: { date: d } }) },
  { kind: 'daily', name: 'user-summary-day', build: (d) => ({ path: '/usersummary-service/usersummary/daily', query: { calendarDate: d } }) },
  { kind: 'daily', name: 'heart-rate-day', build: (d) => ({ path: '/wellness-service/wellness/dailyHeartRate', query: { date: d } }) },
  { kind: 'daily', name: 'spo2-day', build: (d) => ({ path: `/wellness-service/wellness/daily/spo2acclimation/${d}` }) },
];

export const staticEndpoints: StaticEndpoint[] = [
  { kind: 'static', name: 'user-settings', build: () => ({ path: '/userprofile-service/userprofile/settings' }) },
  { kind: 'static', name: 'hr-zones', build: () => ({ path: '/biometric-service/heartRateZones/v2', query: { generateDefaults: false } }) },
];

/** Fitness Age is "latest as of date", so one call for today is enough. */
export const fitnessAge = (d: DateStr): RequestSpec => ({ path: `/fitnessage-service/fitnessage/v2/${d}` });

/**
 * Endpoints in the spec we deliberately do NOT call: unrelated to training
 * (local and private: don't request data the app doesn't use).
 *   - /nutrition-service/food/logs/{date}
 *   - /goal-service/goal/user/effective/weightgoal/{startDate}/{endDate}
 *   - /periodichealth-service/menstrualcycle/*
 *   - /weight-service/weight/all/{startDate}/{endDate}  (weight-range covers it)
 */

export const activities = {
  /** Paged list. Dates are inclusive, by the activity's local start date. */
  search: (from: DateStr, to: DateStr, start: number, limit: number): RequestSpec => ({
    path: '/activitylist-service/activities/search/activities',
    query: { startDate: from, endDate: to, start, limit, sortOrder: 'asc' },
  }),
  detail: (id: number | string): RequestSpec => ({ path: `/activity-service/activity/${id}` }),
  workouts: (id: number | string): RequestSpec => ({ path: `/activity-service/activity/${id}/workouts` }),
  /** Original upload file, served as application/x-zip-compressed. */
  file: (id: number | string): RequestSpec => ({ path: `/download-service/files/activity/${id}` }),
  pageSize: 99,
};
