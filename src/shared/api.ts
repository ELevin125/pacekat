/**
 * The typed API the preload script exposes to the renderer as `window.pacekat`.
 * Shared by main (handlers), preload (bridge) and renderer (callers).
 * Types only — no runtime code, no Node imports.
 */

export interface Result {
  ok: boolean;
  message: string;
}

export interface GarminStatus {
  hasKey: boolean;
  /** ISO time of the last successful connection test or sync. */
  lastOkAt: string | null;
  lastError: string | null;
}

export interface SyncProgress {
  phase: 'starting' | 'profile' | 'daily' | 'activities' | 'files' | 'derive' | 'done' | 'error';
  message: string;
  done: number;
  total: number;
}

export interface SyncStateRow {
  dataType: string;
  lastSyncedDate: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface SyncResult extends Result {
  from: string;
  to: string;
  newActivities: number;
  errors: string[];
}

export interface SyncStatus {
  running: boolean;
  lastFinishedAt: string | null;
  states: SyncStateRow[];
}

export interface TableInfo {
  name: string;
  rows: number;
}

export interface TableRows {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  total: number;
}

export interface AppInfo {
  version: string;
  userData: string;
  timezone: string;
  electron: string;
}

export interface PacekatApi {
  app: {
    info(): Promise<AppInfo>;
    openDataFolder(): Promise<void>;
  };
  garmin: {
    status(): Promise<GarminStatus>;
    setKey(key: string): Promise<Result>;
    clearKey(): Promise<Result>;
    testConnection(): Promise<Result>;
  };
  sync: {
    run(opts?: { full?: boolean }): Promise<SyncResult>;
    status(): Promise<SyncStatus>;
    /** Subscribe to progress events; returns an unsubscribe function. */
    onProgress(cb: (p: SyncProgress) => void): () => void;
  };
  debug: {
    tables(): Promise<TableInfo[]>;
    rows(table: string, limit: number, offset: number): Promise<TableRows>;
  };
}

/** IPC channel names (invoke). */
export const IPC = {
  appInfo: 'app:info',
  appOpenDataFolder: 'app:openDataFolder',
  garminStatus: 'garmin:status',
  garminSetKey: 'garmin:setKey',
  garminClearKey: 'garmin:clearKey',
  garminTest: 'garmin:test',
  syncRun: 'sync:run',
  syncStatus: 'sync:status',
  syncProgress: 'sync:progress', // main → renderer event
  debugTables: 'debug:tables',
  debugRows: 'debug:rows',
} as const;
