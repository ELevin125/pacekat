import data from '../sessions.json';
import { LOAD } from '../constants';
import type { Intensity, PlanSession, SessionDef } from './types';

/** The session library (sessions.json): data, not code. */
export const LIBRARY: ReadonlyMap<string, SessionDef> = new Map((data.sessions as SessionDef[]).map((s) => [s.key, s]));

export function session(key: string): SessionDef {
  const s = LIBRARY.get(key);
  if (!s) throw new Error(`Unknown session "${key}"`);
  return s;
}

/**
 * Representative heart-rate-reserve per intensity, used to estimate planned
 * load on the same TRIMP scale as completed activities.
 */
const HRR: Record<Intensity, number> = { rest: 0, z1: 0.45, z2: 0.58, tempo: 0.72, threshold: 0.8, vo2: 0.85, race: 0.85 };

export function estimateLoad(intensity: Intensity, durationMin: number): number {
  const hrr = HRR[intensity];
  return Math.round(durationMin * hrr * LOAD.trimpA * Math.exp(LOAD.trimpB * hrr) * 10) / 10;
}

export function toPlanSession(def: SessionDef, date: string, slot: number, durationMin: number, notes: string[] = []): PlanSession {
  const d = Math.round(durationMin);
  return {
    date,
    slot,
    sport: def.sport,
    sessionKey: def.key,
    title: def.title,
    durationMin: d,
    intensity: def.intensity,
    isKey: def.isKey,
    fixed: !!def.fixed,
    purpose: def.purpose,
    structure: def.structure,
    targets: def.targets,
    estLoad: estimateLoad(def.intensity, d),
    notes,
  };
}

/** Same sport, Z1–Z2, ~70 % of the duration (coaching-engine.md §7). */
export function easyVersion(s: PlanSession, share = 0.7, note?: string): PlanSession {
  const def = LIBRARY.get(s.sessionKey);
  const easyKey = def?.easyVariant;
  const base = easyKey ? session(easyKey) : null;
  const duration = Math.max(15, Math.round(s.durationMin * share));
  if (base) return { ...toPlanSession(base, s.date, s.slot, duration, [...s.notes]), notes: note ? [...s.notes, note] : s.notes };
  return {
    ...s,
    title: `Easy ${s.title.toLowerCase()}`,
    intensity: s.intensity === 'rest' ? 'rest' : 'z2',
    isKey: false,
    durationMin: duration,
    estLoad: estimateLoad(s.intensity === 'rest' ? 'rest' : 'z2', duration),
    notes: note ? [...s.notes, note] : s.notes,
  };
}

export function restSession(date: string, slot: number, note?: string): PlanSession {
  return toPlanSession(session('rest'), date, slot, 0, note ? [note] : []);
}
