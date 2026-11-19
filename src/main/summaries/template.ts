/**
 * Template summaries (docs/ai-summary.md). The engine builds a facts object;
 * these functions turn it into 2–4 plain sentences. Pure and deterministic.
 * The M6 local LLM will take the same facts and fall back to these.
 */

/** Bump when the wording below changes, so cached summaries are rewritten. */
export const TEMPLATE_VERSION = 2;

export type ZoneKey = 'z1' | 'z2' | 'z3' | 'z4' | 'z5';

export interface ActivityFacts {
  kind: 'activity';
  sport: string; // swim | bike | run | strength | other
  title: string;
  duration: string; // "31:12" or "1:04:10"
  distance_km?: number;
  avg_pace?: string; // "4:54 /km"
  swim_pace?: string; // "1:57 /100 m"
  avg_hr?: number;
  /** Share of time per zone, 0–1. */
  zone_share?: Partial<Record<ZoneKey, number>>;
  planned?: { title: string; status: 'done' | 'partial' };
  is_commute?: boolean;
  comparisons: string[];
  load: { this_session: 'light' | 'moderate' | 'hard' | 'very hard' };
  next?: string;
}

export interface DailyFacts {
  kind: 'daily';
  verdict: 'go' | 'easy' | 'rest' | null;
  /** The readiness engine's one-line summary. */
  why: string | null;
  today: Array<{ title: string; duration_min: number; is_key: boolean; sport: string }>;
  phase?: string;
  next_race?: { name: string; days: number };
}

const ZONE_ORDER: ZoneKey[] = ['z1', 'z2', 'z3', 'z4', 'z5'];

/** Dominant zone, or the two adjacent zones that together hold most of the time. */
export function zoneDescription(share: Partial<Record<ZoneKey, number>>): { text: string; effort: 'easy' | 'steady' | 'hard' } | null {
  const vals = ZONE_ORDER.map((z) => share[z] ?? 0);
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const norm = vals.map((v) => v / total);
  const top = norm.indexOf(Math.max(...norm));
  let text: string;
  if (norm[top]! >= 0.5) text = `mostly in zone ${top + 1}`;
  else {
    const pair = top > 0 && norm[top - 1]! >= (norm[top + 1] ?? 0) ? [top - 1, top] : [top, Math.min(4, top + 1)];
    text = `mostly in zones ${pair[0]! + 1}–${pair[1]! + 1}`;
  }
  const hardShare = norm[3]! + norm[4]!;
  const easyShare = norm[0]! + norm[1]!;
  const effort = hardShare >= 0.3 ? 'hard' : easyShare >= 0.6 ? 'easy' : 'steady';
  return { text, effort };
}

const EFFORT_SENTENCE: Record<'easy' | 'steady' | 'hard', string> = {
  easy: 'so it counts as an easy session',
  steady: 'so it counts as a steady session',
  hard: 'so it counts as a hard session',
};

const LOAD_SENTENCE: Record<ActivityFacts['load']['this_session'], string> = {
  light: 'A light session for your load.',
  moderate: 'A moderate session for your load.',
  hard: 'A hard session for your load.',
  'very hard': 'A very big session for your load.',
};

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function activityText(f: ActivityFacts): string {
  const parts: string[] = [];
  const dist = f.distance_km != null && f.distance_km > 0 ? (f.sport === 'swim' ? `${Math.round(f.distance_km * 1000).toLocaleString('en-US').replace(/,/g, ' ')} m` : `${f.distance_km.toFixed(1)} km`) : null;
  const pace = f.sport === 'swim' ? f.swim_pace : f.sport === 'run' ? f.avg_pace : undefined;

  // 1. What was done.
  const what = [dist ? `${dist} in ${f.duration}` : f.duration, pace ? `at ${pace}` : null].filter(Boolean).join(' ');
  parts.push(`${f.is_commute ? 'Commute' : f.title} done: ${what}.`);

  // 2. How hard, from zones (or load when there's no HR).
  const zones = f.zone_share ? zoneDescription(f.zone_share) : null;
  if (zones) parts.push(`${capitalise(zones.text)}, ${EFFORT_SENTENCE[zones.effort]}.`);
  else parts.push(LOAD_SENTENCE[f.load.this_session]);

  // 3. Against the plan.
  if (f.planned?.status === 'done') parts.push(`That ticks off ${f.planned.title.toLowerCase()}.`);
  else if (f.planned?.status === 'partial') parts.push(`Shorter than the planned ${f.planned.title.toLowerCase()}, but it counts.`);
  else if (!f.is_commute) parts.push('An extra session, not on the plan.');

  // 4. One comparison, then what's next.
  if (f.comparisons[0]) parts.push(`${capitalise(f.comparisons[0])}.`);
  if (f.next && parts.length < 4) parts.push(`Next: ${f.next}.`);
  return parts.slice(0, 4).join(' ');
}

export function dailyText(f: DailyFacts): string {
  const parts: string[] = [];
  const key = f.today.find((s) => s.is_key);
  const main = key ?? f.today[0];

  const noData = !!f.why && /^Not enough data/.test(f.why);
  if (f.verdict === 'easy' && noData) parts.push("There isn't enough data from last night, so keep today easy to be safe.");
  else if (f.verdict === 'go') parts.push('You look recovered and good to go.');
  else if (f.verdict === 'easy') parts.push(`You're a little under-recovered${f.why ? `: ${lowerFirst(stripTakeEasy(f.why))}` : '.'}`);
  else if (f.verdict === 'rest') parts.push(`Your body is asking for rest${f.why ? `: ${lowerFirst(f.why)}` : '.'}`);
  else parts.push('No readiness data yet today; sync your watch for a verdict.');
  if (!/[.!?]$/.test(parts[0]!)) parts[0] += '.';

  if (!main) parts.push('Nothing planned today, so enjoy the rest.');
  else {
    const later = f.today.filter((s) => s !== main);
    const laterText = later.length ? `, then ${later.map((s) => s.title.toLowerCase()).join(' and ')}` : '';
    const advice =
      f.verdict === 'rest' ? 'If you do move, keep it short and very easy'
      : f.verdict === 'easy' && main.is_key ? 'Keep the effort conversational and save the hard work for another day'
      : main.is_key ? 'Make the hard parts count'
      : 'Keep it relaxed';
    parts.push(`Today is ${main.title.toLowerCase()} (${main.duration_min} min)${laterText}. ${advice}.`);
  }
  if (f.next_race && f.next_race.days <= 14) parts.push(`${f.next_race.name} is in ${f.next_race.days} ${f.next_race.days === 1 ? 'day' : 'days'}.`);
  return parts.join(' ');
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) && !/^(HRV|Body Battery|Resting HR)/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** The readiness engine phrases "easy" days as "Take it easy: …"; drop that prefix inside the brief. */
function stripTakeEasy(s: string): string {
  return s.replace(/^Take it easy:\s*/, '');
}
