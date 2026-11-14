import { GARMIN_API_BASE, GARMIN_TOKEN_PATH, type RequestSpec } from './endpoints';

/**
 * Minimal Garmin Personal API client. Plain Node `fetch`, no Electron imports,
 * so the probe script and the app's sync share it.
 *
 * Auth (per Garmin's Personal API FAQ): POST the personal API key to the token
 * endpoint with `Authorization: ApiKey <key>`; it returns an OAuth2 access token
 * valid for 24 h (or until the key expires). There are no refresh tokens: just
 * exchange the key again.
 *
 * Never log the key or the token.
 */

export interface CachedToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface TokenStore {
  load(): CachedToken | null | Promise<CachedToken | null>;
  save(token: CachedToken): void | Promise<void>;
}

export interface GarminClientOptions {
  apiKey: string;
  baseUrl?: string;
  tokenStore?: TokenStore;
  /** Pause between requests to stay polite (rate limits are undocumented). */
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Called once with the token response's shape (keys + value types, no values). */
  onTokenShape?: (shape: Record<string, string>) => void;
}

export type GarminResponse =
  | { status: number; ok: true; contentType: string; json: unknown; bytes?: undefined }
  | { status: number; ok: true; contentType: string; bytes: Uint8Array; json?: undefined }
  | { status: number; ok: false; contentType: string; errorText: string };

/** Garmin couldn't be reached at all (offline, DNS, timeout) after retries. */
export class GarminNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GarminNetworkError';
  }
}

export class GarminAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GarminAuthError';
  }
}

const REFRESH_MARGIN_MS = 60 * 60 * 1000; // refresh when < 1 h left
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Network failures are retried less than 429/5xx: if we're offline, waiting won't help much. */
const MAX_NETWORK_RETRIES = 2;

export class GarminClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: CachedToken | null = null;
  private tokenLoaded = false;
  private lastRequestAt = 0;

  constructor(private readonly opts: GarminClientOptions) {
    if (!opts.apiKey?.trim()) throw new Error('Garmin API key is empty');
    this.baseUrl = (opts.baseUrl ?? GARMIN_API_BASE).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Exchange the key for a token if the cached one is missing or close to expiry. */
  async ensureToken(force = false): Promise<string> {
    if (!this.tokenLoaded) {
      this.token = (await this.opts.tokenStore?.load()) ?? null;
      this.tokenLoaded = true;
    }
    if (!force && this.token && this.token.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return this.token.accessToken;
    }
    const res = await this.fetchNetworkSafe(this.baseUrl + GARMIN_TOKEN_PATH, {
      method: 'POST',
      // The token body's content type isn't documented; requiring JSON gets a 406. Accept anything.
      headers: { Authorization: `ApiKey ${this.opts.apiKey.trim()}`, Accept: '*/*' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GarminAuthError(
        `Token exchange failed: HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (key invalid, expired or revoked?)' : ''}`,
        res.status,
      );
    }
    this.token = parseTokenResponse(text, this.opts.onTokenShape);
    await this.opts.tokenStore?.save(this.token);
    return this.token.accessToken;
  }

  /** GET with backoff on 429/5xx and one token refresh on 401. */
  async get(spec: RequestSpec, accept: 'json' | 'bytes' = 'json'): Promise<GarminResponse> {
    const url = new URL(this.baseUrl + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, String(v));

    const maxRetries = this.opts.maxRetries ?? 4;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const token = await this.ensureToken();
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            // Prefer JSON but never force a 406 if an endpoint answers in another type.
            Accept: accept === 'json' ? 'application/json, */*;q=0.1' : '*/*',
          },
        });
      } catch (err) {
        if (attempt >= Math.min(maxRetries, MAX_NETWORK_RETRIES)) throw toNetworkError(err);
        await this.backoff(attempt, null, `network error on ${spec.path}`);
        continue;
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await res.body?.cancel();
        await this.ensureToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await res.body?.cancel();
        await this.backoff(attempt, res.headers.get('retry-after'), `HTTP ${res.status} on ${spec.path}`);
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        return { status: res.status, ok: false, contentType, errorText: (await res.text()).slice(0, 500) };
      }
      if (accept === 'bytes') {
        return { status: res.status, ok: true, contentType, bytes: new Uint8Array(await res.arrayBuffer()) };
      }
      const text = await res.text();
      // 204 No Content (e.g. HRV on a night without data) → null.
      return { status: res.status, ok: true, contentType, json: text.trim() ? JSON.parse(text) : null };
    }
  }

  private async throttle(): Promise<void> {
    const gap = this.opts.minIntervalMs ?? 250;
    const wait = this.lastRequestAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async backoff(attempt: number, retryAfter: string | null, why: string): Promise<void> {
    const fromHeader = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
    const ms = Math.min(fromHeader ?? 1000 * 2 ** attempt + Math.random() * 250, 60_000);
    this.opts.log?.(`${why}; retrying in ${Math.round(ms)} ms`);
    await sleep(ms);
  }

  private async fetchNetworkSafe(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchWithTimeout(url, init);
    } catch (err) {
      throw toNetworkError(err);
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) });
  }
}

function toNetworkError(err: unknown): GarminNetworkError {
  const e = err as Error & { cause?: { code?: string } };
  const code = e.cause?.code ? ` (${e.cause.code})` : e.name === 'TimeoutError' ? ' (timed out)' : '';
  return new GarminNetworkError(`Couldn't reach Garmin${code}. Check the internet connection; we'll try again next sync.`);
}

/**
 * The token response format isn't documented. Accept the usual OAuth2 JSON
 * (`access_token`, `expires_in`) plus a few likely variants, or a bare token.
 */
export function parseTokenResponse(
  text: string,
  onShape?: (shape: Record<string, string>) => void,
): CachedToken {
  const trimmed = text.trim();
  let body: unknown;
  try {
    body = JSON.parse(trimmed);
  } catch {
    body = trimmed;
  }
  if (typeof body === 'string') {
    onShape?.({ '(body)': 'string' });
    if (!body) throw new GarminAuthError('Token response was empty', 200);
    return { accessToken: body.replace(/^"|"$/g, ''), expiresAt: Date.now() + DEFAULT_TOKEN_TTL_MS };
  }
  if (!body || typeof body !== 'object') throw new GarminAuthError('Unrecognised token response', 200);
  const o = body as Record<string, unknown>;
  onShape?.(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? 'null' : typeof v])));

  const accessToken = [o.access_token, o.accessToken, o.token].find((v): v is string => typeof v === 'string');
  if (!accessToken) throw new GarminAuthError(`Token response has no access token (keys: ${Object.keys(o).join(', ')})`, 200);

  let expiresAt = Date.now() + DEFAULT_TOKEN_TTL_MS;
  const expiresIn = [o.expires_in, o.expiresIn].find((v) => typeof v === 'number' || typeof v === 'string');
  const expiresAbs = [o.expires_at, o.expiresAt, o.expiration, o.expiry].find((v) => v != null);
  if (expiresIn != null && Number.isFinite(Number(expiresIn))) {
    expiresAt = Date.now() + Number(expiresIn) * 1000;
  } else if (typeof expiresAbs === 'number') {
    expiresAt = expiresAbs > 1e12 ? expiresAbs : expiresAbs * 1000;
  } else if (typeof expiresAbs === 'string' && !Number.isNaN(Date.parse(expiresAbs))) {
    expiresAt = Date.parse(expiresAbs);
  }
  return { accessToken, expiresAt };
}
