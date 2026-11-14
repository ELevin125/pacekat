import { decodeFit } from '../../src/main/fit/decode';

/* ---------- JSON field coverage ---------- */

export interface FieldStats {
  records: number;
  /** path → number of records where the value is present and non-null. */
  fields: Map<string, number>;
  /** path → JS type(s) seen. */
  types: Map<string, Set<string>>;
}

export function newFieldStats(): FieldStats {
  return { records: 0, fields: new Map(), types: new Map() };
}

/** Top-level array → each element is a record; anything else → one record. */
export function addJsonToStats(stats: FieldStats, body: unknown): void {
  if (body == null) return;
  const records = Array.isArray(body) ? body : [body];
  for (const rec of records) {
    stats.records++;
    const seen = new Set<string>();
    walk(rec, '', 0, seen, stats.types);
    for (const p of seen) stats.fields.set(p, (stats.fields.get(p) ?? 0) + 1);
  }
}

const MAX_DEPTH = 6;
const MAX_ARRAY_SCAN = 25;

function walk(v: unknown, path: string, depth: number, seen: Set<string>, types: Map<string, Set<string>>): void {
  if (v === null || v === undefined) return;
  const key = path || '(root)';
  const t = Array.isArray(v) ? 'array' : typeof v;
  if (path) {
    seen.add(key);
    if (!types.has(key)) types.set(key, new Set());
    types.get(key)!.add(t);
  }
  if (depth >= MAX_DEPTH) return;
  if (Array.isArray(v)) {
    for (const item of v.slice(0, MAX_ARRAY_SCAN)) {
      if (item !== null && typeof item === 'object') walk(item, `${path}[]`, depth + 1, seen, types);
    }
  } else if (typeof v === 'object') {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      walk(child, path ? `${path}.${k}` : k, depth + 1, seen, types);
    }
  }
}

/* ---------- FIT inspection ---------- */

export interface FitInspection {
  file: string;
  ok: boolean;
  integrity: boolean;
  errors: string[];
  sport: string;
  subSport: string;
  /** message type → count */
  messageCounts: Record<string, number>;
  /** message type → fields with at least one non-null value */
  messageFields: Record<string, string[]>;
  records: number;
  recordsWithHr: number;
  medianRecordIntervalS: number | null;
  hasPower: boolean;
  runningDynamics: string[];
  swim: { lengths: number; poolLength: unknown; avgSwolf: unknown; strokesOnLengths: number };
  trainingEffect: Record<string, unknown>;
  vo2Max: unknown[];
  hrvMessages: number;
}

export function inspectFit(file: string, bytes: Uint8Array): FitInspection {
  const d = decodeFit(bytes, { includeUnknownData: true });
  const m = d.messages;
  const messageCounts: Record<string, number> = {};
  const messageFields: Record<string, string[]> = {};
  for (const [type, list] of Object.entries(m)) {
    if (!Array.isArray(list)) continue;
    messageCounts[type] = list.length;
    const fields = new Set<string>();
    for (const msg of list.slice(0, 2000)) {
      for (const [k, v] of Object.entries(msg as Record<string, unknown>)) if (v != null) fields.add(k);
    }
    messageFields[type] = [...fields].sort();
  }

  const session = (m.sessionMesgs?.[0] ?? {}) as Record<string, unknown>;
  const records = (m.recordMesgs ?? []) as Array<Record<string, unknown>>;
  const recordsWithHr = records.filter((r) => typeof r.heartRate === 'number').length;
  const times = records
    .map((r) => (r.timestamp instanceof Date ? r.timestamp.getTime() : null))
    .filter((t): t is number => t != null);
  const intervals = times.slice(1).map((t, i) => (t - times[i]!) / 1000).filter((x) => x > 0).sort((a, b) => a - b);
  const median = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : null;

  const recordFields = new Set(messageFields.recordMesgs ?? []);
  const dyn = ['verticalOscillation', 'stanceTime', 'stanceTimeBalance', 'stepLength', 'verticalRatio'].filter((f) => recordFields.has(f));
  const lengths = (m.lengthMesgs ?? []) as Array<Record<string, unknown>>;

  return {
    file,
    ok: d.ok,
    integrity: d.integrity,
    errors: d.errors,
    sport: String(session.sport ?? 'unknown'),
    subSport: String(session.subSport ?? 'unknown'),
    messageCounts,
    messageFields,
    records: records.length,
    recordsWithHr,
    medianRecordIntervalS: median,
    hasPower: recordFields.has('power'),
    runningDynamics: dyn,
    swim: {
      lengths: lengths.length,
      poolLength: session.poolLength ?? null,
      avgSwolf: session.avgSwolf ?? null,
      strokesOnLengths: lengths.filter((l) => typeof l.totalStrokes === 'number').length,
    },
    trainingEffect: pick(session, ['totalTrainingEffect', 'totalAnaerobicTrainingEffect', 'trainingLoadPeak', 'trainingStressScore', 'intensityFactor', 'normalizedPower']),
    vo2Max: ((m.maxMetDataMesgs ?? []) as Array<Record<string, unknown>>).map((x) => x.vo2Max),
    hrvMessages: (m.hrvMesgs ?? []).length,
  };
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
}
