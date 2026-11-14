import { Decoder, Stream, type FitMessages } from '@garmin/fitsdk';

export interface DecodedFit {
  ok: boolean;
  /** Header + file CRC both valid. */
  integrity: boolean;
  messages: FitMessages & Record<string, unknown[] | undefined>;
  errors: string[];
}

/** Decode a FIT file with Garmin's official SDK. Never throws. */
export function decodeFit(bytes: Uint8Array, opts: { includeUnknownData?: boolean } = {}): DecodedFit {
  try {
    const stream = Stream.fromByteArray(bytes);
    if (!Decoder.isFIT(stream)) {
      return { ok: false, integrity: false, messages: {}, errors: ['not a FIT file'] };
    }
    const decoder = new Decoder(Stream.fromByteArray(bytes));
    const integrity = decoder.checkIntegrity();
    const { messages, errors } = decoder.read({
      includeUnknownData: opts.includeUnknownData ?? false,
      mergeHeartRates: true,
      convertDateTimesToDates: true,
    });
    return {
      ok: true,
      integrity,
      messages: messages as DecodedFit['messages'],
      errors: errors.map((e) => e.message),
    };
  } catch (err) {
    return { ok: false, integrity: false, messages: {}, errors: [(err as Error).message] };
  }
}
