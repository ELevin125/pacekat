/**
 * Pure formatting helpers shared by the summaries (main) and the UI (renderer).
 * Metric units, 24-hour time, weeks start on Monday (docs/ui.md).
 */

/** 31:12, or 1:04:10 when an hour or longer. */
export function clock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** "45 min", "1 h 41", "0 h 48" style used in totals. */
export function hoursMinutes(seconds: number | null | undefined, opts: { alwaysHours?: boolean } = {}): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h && !opts.alwaysHours) return `${m} min`;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

/** Pace from seconds: "4:54". */
export function pace(secondsPerUnit: number | null | undefined): string {
  if (secondsPerUnit == null || !Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0) return '—';
  const s = Math.round(secondsPerUnit);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Parse "4:35" (or "275") into seconds; null if it doesn't look like a pace. */
export function parsePace(text: string): number | null {
  const t = text.trim();
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d{2,3}$/.test(t)) return Number(t);
  return null;
}

/** "1 600 m" / "10.3 km" (thin-space thousands like the mockup). */
export function distance(meters: number | null | undefined, sport?: string): string {
  if (meters == null || !Number.isFinite(meters) || meters <= 0) return '—';
  if (sport === 'swim' || meters < 1000) return `${groupThousands(Math.round(meters))} m`;
  return `${(meters / 1000).toFixed(meters >= 100_000 ? 0 : 1)} km`;
}

export function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const parseDate = (d: string) => new Date(`${d}T00:00:00Z`);

/** "Saturday 14 November" */
export function longDate(date: string): string {
  const d = parseDate(date);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Sat 14 Nov" */
export function shortDate(date: string): string {
  const d = parseDate(date);
  return `${WEEKDAYS[d.getUTCDay()]!.slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)}`;
}

/** "14 Nov" */
export function dayMonth(date: string): string {
  const d = parseDate(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)}`;
}

/** "9 – 15 November", "30 November – 6 December" */
export function weekRange(weekStart: string): string {
  const a = parseDate(weekStart);
  const b = new Date(a.getTime() + 6 * 86_400_000);
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`
    : `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
}

export function weekdayShort(date: string): string {
  return WEEKDAYS[parseDate(date).getUTCDay()]!.slice(0, 3);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

/** "today", "yesterday", "Thu 12 Nov" relative to `today`. */
export function relativeDay(date: string, today: string): string {
  const diff = daysBetween(date, today);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff === -1) return 'tomorrow';
  return shortDate(date);
}

/** Local 24-hour time from a UTC ISO string in the given zone: "17:40". */
export function localTime(isoUtc: string | null | undefined, timeZone?: string): string {
  if (!isoUtc) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(isoUtc));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const PHASE_LABEL: Record<string, string> = {
  base: 'Base',
  build: 'Build',
  peak: 'Peak',
  taper: 'Taper',
  recovery: 'Recovery',
  maintain: 'Maintain',
};

export const INTENSITY_LABEL: Record<string, string> = {
  rest: 'Rest',
  z1: 'Z1',
  z2: 'Z2',
  tempo: 'Z3',
  threshold: 'Z4',
  vo2: 'Z4–Z5',
  race: 'Race',
};

/**
 * Turn library targets into numbers when the athlete has set thresholds:
 * "Threshold + 10–15 s/km" with threshold 4:35 → "4:45–4:50 /km";
 * "CSS + 8–10 s/100 m" with CSS 1:48 → "1:56–1:58 /100 m". Anything else is returned as written.
 */
export function resolveTarget(text: string, t: { runThresholdSPerKm?: number | null; swimCssSPer100m?: number | null }): string {
  const run = /^Threshold(?:\s*([+−-])\s*(\d+)(?:–(\d+))?\s*s\/km)?$/.exec(text.trim());
  if (run && t.runThresholdSPerKm) {
    const sign = run[1] === '+' ? 1 : run[1] ? -1 : 0;
    const a = t.runThresholdSPerKm + sign * Number(run[2] ?? 0);
    const b = run[3] ? t.runThresholdSPerKm + sign * Number(run[3]) : null;
    return `${pace(a)}${b != null ? `–${pace(b)}` : ''} /km`;
  }
  const swim = /^CSS(?:\s*([+−-])\s*(\d+)(?:–(\d+))?\s*s\/100 m)?$/.exec(text.trim());
  if (swim && t.swimCssSPer100m) {
    const sign = swim[1] === '+' ? 1 : swim[1] ? -1 : 0;
    const a = t.swimCssSPer100m + sign * Number(swim[2] ?? 0);
    const b = swim[3] ? t.swimCssSPer100m + sign * Number(swim[3]) : null;
    return `${pace(a)}${b != null ? `–${pace(b)}` : ''} /100 m`;
  }
  return text;
}
