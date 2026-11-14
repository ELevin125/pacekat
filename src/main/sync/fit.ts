import { decodeFit } from '../fit/decode';

/**
 * What M1 extracts from an activity's FIT file. Load (TRIMP) in M2 re-reads
 * the file from disk for the per-second HR stream; here we only check the file
 * and record which data is present.
 */
export interface FitFacts {
  status: 'ok' | 'crc_error' | 'error';
  error?: string;
  extras: Record<string, string | number>;
}

export function parseFitFacts(bytes: Uint8Array): FitFacts {
  const d = decodeFit(bytes);
  if (!d.ok) return { status: 'error', error: d.errors.join('; ') || 'decode failed', extras: {} };

  const m = d.messages;
  const session = (m.sessionMesgs?.[0] ?? {}) as Record<string, unknown>;
  const records = (m.recordMesgs ?? []) as Array<Record<string, unknown>>;
  const hrSamples = records.filter((r) => typeof r.heartRate === 'number').length;
  const has = (f: string) => records.some((r) => r[f] != null);

  const extras: Record<string, string | number> = {
    fit_sport: String(session.sport ?? ''),
    fit_sub_sport: String(session.subSport ?? ''),
    fit_records: records.length,
    fit_hr_samples: hrSamples,
    fit_has_power: has('power') ? 1 : 0,
    fit_running_dynamics: has('verticalOscillation') || has('stanceTime') ? 1 : 0,
    fit_swim_lengths: (m.lengthMesgs ?? []).length,
    fit_hrv_messages: (m.hrvMesgs ?? []).length,
  };
  const te = session.totalTrainingEffect;
  if (typeof te === 'number') extras.fit_total_training_effect = te;
  const ate = session.totalAnaerobicTrainingEffect;
  if (typeof ate === 'number') extras.fit_anaerobic_training_effect = ate;
  const vo2 = ((m.maxMetDataMesgs ?? []) as Array<Record<string, unknown>>).map((x) => x.vo2Max).find((v) => typeof v === 'number');
  if (typeof vo2 === 'number') extras.fit_vo2max = vo2;

  return {
    status: d.integrity ? 'ok' : 'crc_error',
    ...(d.errors.length ? { error: d.errors.join('; ') } : {}),
    extras,
  };
}
