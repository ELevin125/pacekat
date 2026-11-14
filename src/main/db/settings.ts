import { nowIso, type DB } from './index';

/** Key/value settings stored as JSON. */
export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}

export function deleteSetting(db: DB, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
