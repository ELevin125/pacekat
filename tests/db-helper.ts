import Database from 'better-sqlite3';
import { migrate, type DB } from '../src/main/db';

export function openDbForTest(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
