import type { DateStr } from '../garmin/endpoints';

/**
 * Split a range response into per-day items, keyed by the local calendar date
 * Garmin puts on each item. Shapes are from the OpenAPI spec; anything else
 * throws so the sync records an error instead of silently storing nothing.
 */
export type DailyDataType = 'daily-summaries' | 'sleep-summaries' | 'hrv-daily' | 'body-battery' | 'weight-range';

export const DAILY_DATA_TYPES: DailyDataType[] = ['daily-summaries', 'sleep-summaries', 'hrv-daily', 'body-battery', 'weight-range'];

export interface DayItem {
  date: DateStr;
  item: unknown;
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

function byKey(list: unknown, key: string, type: string): DayItem[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error(`${type}: expected an array, got ${typeof list}`);
  const out: DayItem[] = [];
  for (const it of list) {
    const d = (it as Record<string, unknown> | null)?.[key];
    if (isDate(d)) out.push({ date: d.slice(0, 10), item: it });
  }
  return out;
}

export function splitByDay(type: DailyDataType, body: unknown): DayItem[] {
  if (body == null) return []; // 204 / empty
  const o = body as Record<string, unknown>;
  switch (type) {
    case 'daily-summaries':
      return byKey(Array.isArray(body) ? body : o.data, 'calendarDate', type);
    case 'sleep-summaries':
      return byKey(body, 'calendarDate', type);
    case 'hrv-daily':
      return byKey(Array.isArray(body) ? body : o.hrvSummaries, 'calendarDate', type);
    case 'body-battery':
      return byKey(body, 'date', type);
    case 'weight-range':
      return byKey(Array.isArray(body) ? body : o.dailyWeightSummaries, 'summaryDate', type);
  }
}
