import type { DateStr } from './endpoints';

/** Pure calendar-date helpers on YYYY-MM-DD strings (no timezone maths). */

export function toDateStr(d: Date): DateStr {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parse(d: DateStr): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date: ${d}`);
  return new Date(`${d}T00:00:00Z`);
}

export function addDays(d: DateStr, n: number): DateStr {
  const x = parse(d);
  x.setUTCDate(x.getUTCDate() + n);
  return toDateStr(x);
}

export function daysBetween(from: DateStr, to: DateStr): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
}

/** Today as a local calendar date in `timeZone` (default: system zone). */
export function localToday(timeZone?: string, now = new Date()): DateStr {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Split inclusive [from, to] into inclusive chunks of at most `maxDays` days. */
export function chunkRange(from: DateStr, to: DateStr, maxDays: number): Array<[DateStr, DateStr]> {
  if (maxDays < 1) throw new Error('maxDays must be >= 1');
  const out: Array<[DateStr, DateStr]> = [];
  let start = from;
  while (daysBetween(start, to) >= 0) {
    const end = daysBetween(addDays(start, maxDays - 1), to) >= 0 ? addDays(start, maxDays - 1) : to;
    out.push([start, end]);
    start = addDays(end, 1);
  }
  return out;
}

export function eachDay(from: DateStr, to: DateStr): DateStr[] {
  const out: DateStr[] = [];
  for (let d = from; daysBetween(d, to) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}
