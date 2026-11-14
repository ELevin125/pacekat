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

export interface MetricsSummary {
  hrMax: number;
  hrMaxSource: 'setting' | 'garmin' | 'fallback';
  k: number;
  kCalibrated: boolean;
  kSamples: number;
  historyStart: string | null;
  activities: number;
  needsRpe: number;
}

export interface ReadinessFactor {
  key: string;
  status: 'ok' | 'amber' | 'red' | 'missing';
  value: number | null;
  reason: string;
}

export interface ReadinessDay {
  date: string;
  verdict: 'go' | 'easy' | 'rest';
  summary: string;
  factors: ReadinessFactor[];
  acwr: number | null;
}

export interface DailyMetric {
  date: string;
  load: number;
  acute: number;
  chronic: number;
  acwr: number | null;
  band: string;
}

export interface ActivityItem {
  id: number;
  date: string;
  name: string | null;
  sport: string;
  subSport: string | null;
  durationMin: number | null;
  distanceKm: number | null;
  avgHr: number | null;
  load: number | null;
  loadMethod: string | null;
  loadReasons: string[];
  needsRpe: boolean;
  rpe: number | null;
  isCommute: boolean;
  commuteSource: 'auto' | 'manual' | null;
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
  metrics: {
    summary(): Promise<MetricsSummary>;
    /** Most recent first. */
    readiness(days: number): Promise<ReadinessDay[]>;
    daily(days: number): Promise<DailyMetric[]>;
  };
  activities: {
    /** Most recent first. */
    list(limit: number): Promise<ActivityItem[]>;
    /** 1–10, or null to clear. */
    setRpe(id: number, rpe: number | null): Promise<Result>;
    /** true/false sets it manually; null goes back to automatic detection. */
    setCommute(id: number, value: boolean | null): Promise<Result>;
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
  metricsSummary: 'metrics:summary',
  metricsReadiness: 'metrics:readiness',
  metricsDaily: 'metrics:daily',
  activitiesList: 'activities:list',
  activitiesSetRpe: 'activities:setRpe',
  activitiesSetCommute: 'activities:setCommute',
  debugTables: 'debug:tables',
  debugRows: 'debug:rows',
} as const;
