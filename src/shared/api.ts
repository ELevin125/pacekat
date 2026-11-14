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

export interface PlanSessionView {
  id: number;
  date: string;
  slot: number;
  sport: string;
  sessionKey: string | null;
  title: string;
  durationMin: number;
  intensity: string;
  isKey: boolean;
  fixed: boolean;
  purpose: string | null;
  structure: { warmup?: string; main: string; cooldown?: string } | null;
  targets: Record<string, string>;
  estLoad: number;
  notes: string[];
  status: 'planned' | 'done' | 'partial' | 'missed' | 'skipped' | 'moved';
  source: 'engine' | 'manual';
  matchedActivityId: number | null;
}

export interface PlanWarning {
  code: string;
  message: string;
  dates: string[];
}

export interface PlanChangeView {
  createdAt: string;
  date: string;
  kind: string;
  reason: string;
  actor: 'engine' | 'user';
  sessionId: number | null;
}

export interface SuggestionView {
  id: number;
  date: string;
  kind: string;
  reason: string;
  changes: Array<{ sessionId: number; before: string; after: string }>;
}

export interface PlanWeekView {
  weekStart: string;
  phase: string;
  mode: string;
  deload: boolean;
  cap: number | null;
  plannedLoad: number;
  notes: string[];
  nextRace: { name: string; date: string; priority: string; daysOut: number } | null;
  /** Future weeks are previews until their Monday, when they're planned for real. */
  preview: boolean;
  sessions: PlanSessionView[];
  warnings: PlanWarning[];
  changes: PlanChangeView[];
  suggestion: SuggestionView | null;
}

export interface PlanEditResult extends Result {
  warnings: PlanWarning[];
}

export interface LibraryItem {
  key: string;
  title: string;
  sport: string;
  intensity: string;
  isKey: boolean;
  durationMin: [number, number];
}

export type RaceTypeId = 'sprint_tri' | 'olympic_tri' | '5k' | '10k' | 'half_marathon' | 'marathon' | 'gran_fondo' | 'mtb' | 'other';

export interface RaceView {
  id: number;
  name: string;
  date: string;
  type: RaceTypeId;
  priority: 'A' | 'B' | 'C';
  notes: string | null;
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
  plan: {
    /** Defaults to the current week. */
    week(weekStart?: string): Promise<PlanWeekView>;
    /** Preview of the next `weeks` weeks from the current one. */
    block(weeks: number): Promise<PlanWeekView[]>;
    library(): Promise<LibraryItem[]>;
    swap(a: number, b: number): Promise<PlanEditResult>;
    move(id: number, date: string): Promise<PlanEditResult>;
    skip(id: number): Promise<PlanEditResult>;
    unskip(id: number): Promise<PlanEditResult>;
    makeRest(date: string): Promise<PlanEditResult>;
    change(id: number, sessionKey: string): Promise<PlanEditResult>;
    acceptSuggestion(id: number): Promise<PlanEditResult>;
    dismissSuggestion(id: number): Promise<Result>;
  };
  races: {
    list(): Promise<RaceView[]>;
    /** id 0 = new. */
    save(race: Omit<RaceView, 'id'> & { id?: number }): Promise<Result>;
    remove(id: number): Promise<Result>;
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
  planWeek: 'plan:week',
  planBlock: 'plan:block',
  planLibrary: 'plan:library',
  planSwap: 'plan:swap',
  planMove: 'plan:move',
  planSkip: 'plan:skip',
  planUnskip: 'plan:unskip',
  planMakeRest: 'plan:makeRest',
  planChange: 'plan:change',
  planAcceptSuggestion: 'plan:acceptSuggestion',
  planDismissSuggestion: 'plan:dismissSuggestion',
  racesList: 'races:list',
  racesSave: 'races:save',
  racesRemove: 'races:remove',
  debugTables: 'debug:tables',
  debugRows: 'debug:rows',
} as const;
