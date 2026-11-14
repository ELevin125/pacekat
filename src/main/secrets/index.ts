import { nowIso, type DB } from '../db';
import type { CachedToken, TokenStore } from '../garmin/client';

/**
 * Encrypted secret storage. The cipher is Electron's safeStorage in the app
 * (DPAPI on Windows, libsecret/kwallet on Linux) and a fake in tests.
 * Values are never logged.
 */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(enc: Buffer): string;
}

export const GARMIN_KEY = 'garmin_api_key';
export const GARMIN_TOKEN = 'garmin_access_token';

export class SecretStore {
  constructor(private readonly db: DB, private readonly cipher: Cipher) {}

  set(name: string, value: string): void {
    if (!this.cipher.isAvailable()) {
      throw new Error('OS encryption is not available, so the Garmin key cannot be stored safely.');
    }
    this.db
      .prepare(
        `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, this.cipher.encrypt(value), nowIso());
  }

  get(name: string): string | null {
    const row = this.db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as { value: Buffer } | undefined;
    if (!row) return null;
    try {
      return this.cipher.decrypt(row.value);
    } catch {
      // Encrypted on another machine/user profile, or keyring changed.
      return null;
    }
  }

  has(name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name);
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  /** Access-token cache for GarminClient, encrypted like the key. */
  tokenStore(): TokenStore {
    return {
      load: (): CachedToken | null => {
        const raw = this.get(GARMIN_TOKEN);
        if (!raw) return null;
        try {
          const t = JSON.parse(raw) as CachedToken;
          return typeof t.accessToken === 'string' && typeof t.expiresAt === 'number' ? t : null;
        } catch {
          return null;
        }
      },
      save: (t: CachedToken) => this.set(GARMIN_TOKEN, JSON.stringify(t)),
    };
  }
}

/** Light sanity check before storing a pasted key. */
export function normaliseGarminKey(input: string): { ok: true; key: string } | { ok: false; message: string } {
  const key = input.trim().replace(/^ApiKey\s+/i, '');
  if (!key) return { ok: false, message: 'Paste your Garmin Personal API key.' };
  if (/\s/.test(key)) return { ok: false, message: 'The key should not contain spaces or line breaks.' };
  if (!key.startsWith('GCDC_')) return { ok: false, message: 'Garmin Personal API keys start with "GCDC_". Check you copied the whole key.' };
  return { ok: true, key };
}
