import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import { IPC, type AppInfo, type GarminStatus, type Result, type SyncStatus, type TableInfo, type TableRows } from '../../shared/api';
import type { DB } from '../db';
import { getSetting, setSetting } from '../db/settings';
import { GarminAuthError, GarminClient } from '../garmin/client';
import { staticEndpoints } from '../garmin/endpoints';
import { GARMIN_KEY, GARMIN_TOKEN, normaliseGarminKey, type SecretStore } from '../secrets';
import { SyncService } from '../sync';

export interface IpcContext {
  db: DB;
  secrets: SecretStore;
  userData: string;
  fitDir: string;
  timeZone: string;
  getWindow: () => BrowserWindow | null;
  log: (msg: string) => void;
}

/** Wires the typed API (src/shared/api.ts) to main-process services. */
export function registerIpc(ctx: IpcContext): { sync: () => SyncService | null; runSync: (full?: boolean) => Promise<void> } {
  const { db, secrets } = ctx;

  const makeClient = (): GarminClient | null => {
    const apiKey = secrets.get(GARMIN_KEY);
    if (!apiKey) return null;
    return new GarminClient({
      apiKey,
      // Dev/testing only: point at a mock server.
      baseUrl: !app.isPackaged ? process.env.GARMIN_API_BASE : undefined,
      tokenStore: secrets.tokenStore(),
      log: ctx.log,
    });
  };

  let syncService: SyncService | null = null;
  const getSync = (): SyncService | null => {
    const client = makeClient();
    if (!client) return null;
    if (!syncService || !syncService.isRunning) {
      syncService = new SyncService({ db, client, fitDir: ctx.fitDir, timeZone: ctx.timeZone, log: ctx.log });
    }
    return syncService;
  };

  const markOk = () => {
    setSetting(db, 'garmin_last_ok_at', new Date().toISOString());
    setSetting(db, 'garmin_last_error', null);
  };
  const markError = (msg: string) => setSetting(db, 'garmin_last_error', msg);

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    userData: ctx.userData,
    timezone: ctx.timeZone,
    electron: process.versions.electron ?? '',
  }));
  ipcMain.handle(IPC.appOpenDataFolder, async () => {
    await shell.openPath(ctx.userData);
  });

  ipcMain.handle(IPC.garminStatus, (): GarminStatus => ({
    hasKey: secrets.has(GARMIN_KEY),
    lastOkAt: getSetting<string | null>(db, 'garmin_last_ok_at', null),
    lastError: getSetting<string | null>(db, 'garmin_last_error', null),
  }));

  ipcMain.handle(IPC.garminSetKey, (_e, input: unknown): Result => {
    if (typeof input !== 'string') return { ok: false, message: 'Invalid key.' };
    const n = normaliseGarminKey(input);
    if (!n.ok) return n;
    try {
      secrets.set(GARMIN_KEY, n.key);
      secrets.delete(GARMIN_TOKEN); // token belonged to the old key
      setSetting(db, 'garmin_last_error', null);
      return { ok: true, message: 'Key saved. Testing the connection is next.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  ipcMain.handle(IPC.garminClearKey, (): Result => {
    secrets.delete(GARMIN_KEY);
    secrets.delete(GARMIN_TOKEN);
    return { ok: true, message: 'Garmin key removed.' };
  });

  ipcMain.handle(IPC.garminTest, async (): Promise<Result> => {
    const client = makeClient();
    if (!client) return { ok: false, message: 'No Garmin key saved yet.' };
    try {
      await client.ensureToken(true);
      const res = await client.get(staticEndpoints[0]!.build());
      if (!res.ok) throw new Error(`Garmin answered HTTP ${res.status}.`);
      const name = (res.json as { displayName?: unknown } | null)?.displayName;
      markOk();
      return { ok: true, message: typeof name === 'string' && name ? `Connected to Garmin as ${name}.` : 'Connected to Garmin.' };
    } catch (err) {
      const msg = err instanceof GarminAuthError ? err.message : `Could not reach Garmin: ${(err as Error).message}`;
      markError(msg);
      return { ok: false, message: msg };
    }
  });

  const runSync = async (full = false) => {
    const s = getSync();
    if (!s) throw new Error('No Garmin key saved yet.');
    const result = await s.run({ full }, (p) => ctx.getWindow()?.webContents.send(IPC.syncProgress, p));
    if (result.ok) markOk();
    else markError(result.message);
    return result;
  };

  ipcMain.handle(IPC.syncRun, async (_e, opts: unknown) => {
    const full = !!(opts && typeof opts === 'object' && (opts as { full?: unknown }).full === true);
    try {
      return await runSync(full);
    } catch (err) {
      return { ok: false, message: (err as Error).message, from: '', to: '', newActivities: 0, errors: [] };
    }
  });

  ipcMain.handle(IPC.syncStatus, (): SyncStatus => ({
    running: syncService?.isRunning ?? false,
    lastFinishedAt: getSetting<string | null>(db, 'last_sync_finished_at', null),
    states: (db.prepare('SELECT * FROM sync_state ORDER BY data_type').all() as Array<Record<string, string | null>>).map((r) => ({
      dataType: r.data_type ?? '',
      lastSyncedDate: r.last_synced_date ?? null,
      lastRunAt: r.last_run_at ?? null,
      lastError: r.last_error ?? null,
    })),
  }));

  // --- Debug views (M1): read-only table browser. Secrets are never exposed. ---
  const HIDDEN = new Set(['secrets']);
  const tableNames = (): string[] =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
      .map((r) => r.name)
      .filter((n) => !HIDDEN.has(n));

  ipcMain.handle(IPC.debugTables, (): TableInfo[] =>
    tableNames().map((name) => ({ name, rows: (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n })),
  );

  ipcMain.handle(IPC.debugRows, (_e, table: unknown, limit: unknown, offset: unknown): TableRows => {
    if (typeof table !== 'string' || !tableNames().includes(table)) throw new Error('Unknown table');
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const stmt = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT ? OFFSET ?`);
    const columns = stmt.columns().map((c) => c.name);
    const rows = (stmt.raw(true).all(lim, off) as unknown[][]).map((r) =>
      r.map((v) => {
        if (v == null) return null;
        if (typeof v === 'number') return v;
        if (typeof v === 'bigint') return Number(v);
        if (v instanceof Uint8Array) return `<${v.length} bytes>`;
        const s = String(v);
        return s.length > 300 ? `${s.slice(0, 300)}… (${s.length} chars)` : s;
      }),
    );
    return { columns, rows, total };
  });

  return { sync: () => syncService, runSync: async (full) => void (await runSync(full).catch((e) => ctx.log(`sync failed: ${(e as Error).message}`))) };
}
