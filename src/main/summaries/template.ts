/**
 * Template summaries (docs/ai-summary.md). The engine builds a facts object;
 * these functions turn it into 2–4 plain sentences. Pure and deterministic:
 * phrasing varies by `seed` (activity id / date) so it doesn't read the same
 * every day, but the same facts always give the same text.
 */

/** Bump when the wording below changes, so cached summaries are rewritten. */
export const TEMPLATE_VERSION = 3;

export type ZoneKey = 'z1' | 'z2' | 'z3' | 'z4' | 'z5';

export interface ActivityFacts {
  kind: 'activity';
  /** Picks the phrasing variant; omitted → the first (canonical) phrasing. */
  seed?: number;
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
  /** Nth session of this sport this week (2+), e.g. 3 → "third swim this week". */
  streak?: number;
  /** Most interesting first: bests, then "vs last time". */
  comparisons: string[];
  load: { this_session: 'light' | 'moderate' | 'hard' | 'very hard' };
  next?: string;
}

export interface WeekRecap {
  sessions_done: number;
  sessions_planned: number;
  /** "5 h 10" */
  hours: string;
  /** Load vs the week before, in %; null when there's nothing to compare with. */
  load_change_pct: number | null;
  /** What this week is about, e.g. "a recovery week". */
  focus: string | null;
}

export interface DailyFacts {
  kind: 'daily';
  seed?: number;
  verdict: 'go' | 'easy' | 'rest' | null;
  /** The readiness engine's one-line summary. */
  why: string | null;
  today: Array<{ title: string; duration_min: number; is_key: boolean; sport: string }>;
  phase?: string;
  next_race?: { name: string; days: number };
  /** Mondays only: how last week went. */
  last_week?: WeekRecap;
}

/* ---------------- helpers ---------------- */

/** FNV-1a: stable small hash so variant choice is deterministic. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Choose a phrasing for one slot of the text. No seed → the first option. */
function pick<T>(seed: number | undefined, slot: string, options: T[]): T {
  if (seed == null) return options[0]!;
  return options[hash(`${seed}:${slot}`) % options.length]!;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const SPORT_NOUN: Record<string, [string, string]> = {
  swim: ['swim', 'swims'],
  bike: ['ride', 'rides'],
  run: ['run', 'runs'],
  strength: ['strength session', 'strength sessions'],
  other: ['session', 'sessions'],
};

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

const article = (w: string) => (/^[aeiou]/.test(w) ? 'an' : 'a');

/* ---------------- activity ---------------- */

export function activityText(f: ActivityFacts): string {
  const s = f.seed;
  const parts: string[] = [];
  const dist = f.distance_km != null && f.distance_km > 0 ? (f.sport === 'swim' ? `${Math.round(f.distance_km * 1000).toLocaleString('en-US').replace(/,/g, ' ')} m` : `${f.distance_km.toFixed(1)} km`) : null;
  const pace = f.sport === 'swim' ? f.swim_pace : f.sport === 'run' ? f.avg_pace : undefined;
  const name = f.is_commute ? 'Commute' : f.title;

  // 1. What was done.
  const what = [dist ? `${dist} in ${f.duration}` : f.duration, pace ? `at ${pace}` : null].filter(Boolean).join(' ');
  parts.push(pick(s, 'done', [`${name} done: ${what}.`, `${name}: ${what}.`, `${name} in the bag: ${what}.`]));

  // 2. How hard, from zones (or load when there's no HR).
  const zones = f.zone_share ? zoneDescription(f.zone_share) : null;
  if (zones) {
    const e = zones.effort;
    parts.push(
      pick(s, 'effort', [
        `${capitalise(zones.text)}, so it counts as ${article(e)} ${e} session.`,
        `${capitalise(zones.text)}: ${article(e)} ${e} effort.`,
        `Heart rate was ${zones.text}, which makes it ${article(e)} ${e} one.`,
      ]),
    );
  } else {
    const l = f.load.this_session;
    parts.push(
      pick(s, 'load', [
        l === 'very hard' ? 'A very big session for your load.' : `${capitalise(article(l))} ${l} session for your load.`,
        l === 'very hard' ? 'Much bigger than a usual day for you.' : `For your load, that's ${article(l)} ${l} one.`,
      ]),
    );
  }

  // 3. Against the plan, or a streak for extras.
  const p = f.planned?.title.toLowerCase();
  if (f.planned?.status === 'done') parts.push(pick(s, 'plan', [`That ticks off ${p}.`, `That's ${p} done.`, `${capitalise(p!)} on the plan: done.`]));
  else if (f.planned?.status === 'partial') parts.push(pick(s, 'plan', [`Shorter than the planned ${p}, but it counts.`, `Not the full ${p}, but it counts.`]));
  else if (!f.is_commute) parts.push(pick(s, 'extra', ['An extra session, not on the plan.', 'Not on the plan, so call it a bonus.']));

  // 4. The most interesting extra fact: a best or "vs last time", else the streak, then what's next.
  const noun = SPORT_NOUN[f.sport] ?? SPORT_NOUN.other!;
  const streak =
    f.streak && f.streak >= 2 && !f.is_commute
      ? pick(s, 'streak', [`Your ${ORDINAL[f.streak] ?? `${f.streak}th`} ${noun[0]} this week.`, `That's ${f.streak} ${noun[1]} this week.`])
      : null;
  if (f.comparisons[0]) parts.push(`${capitalise(f.comparisons[0])}.`);
  else if (streak) parts.push(streak);
  if (f.next && parts.length < 4) parts.push(pick(s, 'next', [`Next: ${f.next}.`, `Up next: ${f.next}.`]));
  return parts.slice(0, 4).join(' ');
}

/* ---------------- daily brief ---------------- */

export function recapText(r: WeekRecap, seed?: number): string {
  const sessions = r.sessions_planned > 0 ? `${r.sessions_done} of ${r.sessions_planned} sessions` : `${r.sessions_done} ${r.sessions_done === 1 ? 'session' : 'sessions'}`;
  const change =
    r.load_change_pct == null || Math.abs(r.load_change_pct) < 5
      ? ''
      : `, ${Math.abs(r.load_change_pct)} % ${r.load_change_pct > 0 ? 'more' : 'less'} load than the week before`;
  const first = pick(seed, 'recap', [`Last week: ${sessions}, ${r.hours} of training${change}.`, `Last week you did ${sessions} and ${r.hours} of training${change}.`]);
  return r.focus ? `${first} This week is ${r.focus}.` : first;
}

export function dailyText(f: DailyFacts): string {
  const s = f.seed;
  const parts: string[] = [];
  const key = f.today.find((x) => x.is_key);
  const main = key ?? f.today[0];

  const noData = !!f.why && /^Not enough data/.test(f.why);
  if (f.verdict === 'easy' && noData) parts.push("There isn't enough data from last night, so keep today easy to be safe.");
  else if (f.verdict === 'go') parts.push(pick(s, 'go', ['You look recovered and good to go.', 'Recovery looks good today.', 'All the signs say you\'re recovered.']));
  else if (f.verdict === 'easy') parts.push(`You're a little under-recovered${f.why ? `: ${lowerFirst(stripTakeEasy(f.why))}` : '.'}`);
  else if (f.verdict === 'rest') parts.push(`Your body is asking for rest${f.why ? `: ${lowerFirst(f.why)}` : '.'}`);
  else parts.push('No readiness data yet today; sync your watch for a verdict.');
  if (!/[.!?]$/.test(parts[0]!)) parts[0] += '.';

  if (f.last_week) parts.push(recapText(f.last_week, s));

  if (!main) parts.push(pick(s, 'rest', ['Nothing planned today, so enjoy the rest.', 'Rest day: let the training sink in.']));
  else {
    const later = f.today.filter((x) => x !== main);
    const laterText = later.length ? `, then ${later.map((x) => x.title.toLowerCase()).join(' and ')}` : '';
    const advice =
      f.verdict === 'rest' ? 'If you do move, keep it short and very easy'
      : f.verdict === 'easy' && main.is_key ? 'Keep the effort conversational and save the hard work for another day'
      : main.is_key ? pick(s, 'key', ['Make the hard parts count', 'Warm up properly and make the hard parts count'])
      : pick(s, 'easy', ['Keep it relaxed', 'Keep it comfortable; it should feel easy']);
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
