import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Migrations are numbered SQL files bundled at build time (Vite glob), applied
 * in order on startup, each in its own transaction. `user_version` tracks the
 * last applied number.
 */
const files = import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = Object.entries(files)
  .map(([path, sql]) => {
    const name = path.split('/').pop()!;
    const m = /^(\d+)_/.exec(name);
    if (!m) throw new Error(`Migration file must start with a number: ${name}`);
    return { version: Number(m[1]), name, sql };
  })
  .sort((a, b) => a.version - b.version);

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB, list: Migration[] = migrations): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  let applied = 0;
  for (const m of list) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    applied++;
  }
  return applied;
}

export const nowIso = (): string => new Date().toISOString();
