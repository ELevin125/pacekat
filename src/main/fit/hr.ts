import { decodeFit } from './decode';
import type { HrSample } from '../engine/load';

/** HR samples (timestamp + bpm) from a FIT file's record messages. Empty if none. */
export function hrSamplesFromFit(bytes: Uint8Array): HrSample[] {
  const d = decodeFit(bytes);
  if (!d.ok) return [];
  const out: HrSample[] = [];
  for (const r of (d.messages.recordMesgs ?? []) as Array<Record<string, unknown>>) {
    const hr = r.heartRate;
    const ts = r.timestamp;
    if (typeof hr !== 'number' || hr <= 0 || !(ts instanceof Date)) continue;
    out.push({ t: ts.getTime(), hr });
  }
  return out.sort((a, b) => a.t - b.t);
}
