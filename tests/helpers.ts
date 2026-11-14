import { Encoder, Profile, type Mesg } from '@garmin/fitsdk';
import { zipSync } from 'fflate';
import { openDbForTest } from './db-helper';
import type { GarminResponse } from '../src/main/garmin/client';
import type { RequestSpec } from '../src/main/garmin/endpoints';
import type { GarminGetter } from '../src/main/sync';

export { openDbForTest };

/** Minimal valid activity FIT file. */
export function makeFit(sport: string, opts: { seconds?: number; power?: boolean; vo2?: number } = {}): Uint8Array {
  const enc = new Encoder();
  const e = { onMesg: (num: number | undefined, m: Record<string, unknown>) => enc.onMesg(num!, m as Mesg) };
  const t0 = new Date('2026-11-10T05:00:00Z');
  const n = opts.seconds ?? 60;
  e.onMesg(Profile.MesgNum.FILE_ID, { type: 'activity', manufacturer: 'garmin', product: 4536, timeCreated: t0, serialNumber: 1 });
  for (let i = 0; i < n; i++) {
    e.onMesg(Profile.MesgNum.RECORD, {
      timestamp: new Date(t0.getTime() + i * 1000),
      heartRate: 130 + (i % 10),
      ...(opts.power ? { power: 200 } : {}),
    });
  }
  if (opts.vo2) e.onMesg(Profile.MesgNum.MAX_MET_DATA, { updateTime: t0, vo2Max: opts.vo2, sport, subSport: 'generic' });
  e.onMesg(Profile.MesgNum.SESSION, {
    timestamp: new Date(t0.getTime() + n * 1000), startTime: t0, sport, subSport: 'generic',
    totalElapsedTime: n, totalTimerTime: n, totalTrainingEffect: 3.1,
  });
  e.onMesg(Profile.MesgNum.ACTIVITY, { timestamp: new Date(t0.getTime() + n * 1000), numSessions: 1, type: 'manual', event: 'activity', eventType: 'stop' });
  return enc.close();
}

export const zipOf = (name: string, bytes: Uint8Array): Uint8Array => zipSync({ [name]: bytes });

type Handler = (spec: RequestSpec, accept: 'json' | 'bytes') => GarminResponse | Promise<GarminResponse>;

export const json = (body: unknown, status = 200): GarminResponse =>
  status < 300 ? { status, ok: true, contentType: 'application/json', json: body } : { status, ok: false, contentType: 'application/json', errorText: JSON.stringify(body) };

export const bytes = (b: Uint8Array): GarminResponse => ({ status: 200, ok: true, contentType: 'application/x-zip-compressed', bytes: b });

/** Fake Garmin client: routes by path prefix, records every call. */
export class FakeGarmin implements GarminGetter {
  calls: RequestSpec[] = [];
  tokenError: Error | null = null;
  constructor(private readonly routes: Array<[RegExp, Handler]>) {}

  async ensureToken(): Promise<string> {
    if (this.tokenError) throw this.tokenError;
    return 'tok';
  }

  async get(spec: RequestSpec, accept: 'json' | 'bytes' = 'json'): Promise<GarminResponse> {
    this.calls.push(spec);
    for (const [re, h] of this.routes) if (re.test(spec.path)) return h(spec, accept);
    return json([], 200);
  }

  callsTo(re: RegExp): RequestSpec[] {
    return this.calls.filter((c) => re.test(c.path));
  }
}
