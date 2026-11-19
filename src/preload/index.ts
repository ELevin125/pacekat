import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type PacekatApi, type SyncProgress } from '../shared/api';

// One IPC listener fanned out to every subscriber (each page has many data hooks).
const changeListeners = new Set<() => void>();
ipcRenderer.on(IPC.dataChanged, () => changeListeners.forEach((cb) => cb()));

const api: PacekatApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openDataFolder: () => ipcRenderer.invoke(IPC.appOpenDataFolder),
    exportBackup: () => ipcRenderer.invoke(IPC.appExportBackup),
    openDebug: () => ipcRenderer.invoke(IPC.appOpenDebug),
    onChanged: (cb) => {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
  },
  garmin: {
    status: () => ipcRenderer.invoke(IPC.garminStatus),
    setKey: (key) => ipcRenderer.invoke(IPC.garminSetKey, key),
    clearKey: () => ipcRenderer.invoke(IPC.garminClearKey),
    testConnection: () => ipcRenderer.invoke(IPC.garminTest),
  },
  sync: {
    run: (opts) => ipcRenderer.invoke(IPC.syncRun, opts ?? {}),
    status: () => ipcRenderer.invoke(IPC.syncStatus),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: SyncProgress) => cb(p);
      ipcRenderer.on(IPC.syncProgress, listener);
      return () => ipcRenderer.removeListener(IPC.syncProgress, listener);
    },
  },
  metrics: {
    summary: () => ipcRenderer.invoke(IPC.metricsSummary),
    readiness: (days) => ipcRenderer.invoke(IPC.metricsReadiness, days),
    daily: (days) => ipcRenderer.invoke(IPC.metricsDaily, days),
  },
  activities: {
    list: (limit) => ipcRenderer.invoke(IPC.activitiesList, limit),
    setRpe: (id, rpe) => ipcRenderer.invoke(IPC.activitiesSetRpe, id, rpe),
    setCommute: (id, value) => ipcRenderer.invoke(IPC.activitiesSetCommute, id, value),
    detail: (id) => ipcRenderer.invoke(IPC.activitiesDetail, id),
    between: (from, to) => ipcRenderer.invoke(IPC.activitiesBetween, from, to),
  },
  summaries: {
    daily: (date) => ipcRenderer.invoke(IPC.summariesDaily, date),
  },
  trends: {
    get: (weeks) => ipcRenderer.invoke(IPC.trendsGet, weeks),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    setZones: (zones) => ipcRenderer.invoke(IPC.settingsSetZones, zones),
    template: () => ipcRenderer.invoke(IPC.settingsTemplate),
    setTemplate: (slots) => ipcRenderer.invoke(IPC.settingsSetTemplate, slots),
  },
  plan: {
    week: (weekStart) => ipcRenderer.invoke(IPC.planWeek, weekStart),
    block: (weeks) => ipcRenderer.invoke(IPC.planBlock, weeks),
    library: () => ipcRenderer.invoke(IPC.planLibrary),
    swap: (a, b) => ipcRenderer.invoke(IPC.planSwap, a, b),
    move: (id, date) => ipcRenderer.invoke(IPC.planMove, id, date),
    skip: (id) => ipcRenderer.invoke(IPC.planSkip, id),
    unskip: (id) => ipcRenderer.invoke(IPC.planUnskip, id),
    makeRest: (date) => ipcRenderer.invoke(IPC.planMakeRest, date),
    change: (id, key) => ipcRenderer.invoke(IPC.planChange, id, key),
    acceptSuggestion: (id) => ipcRenderer.invoke(IPC.planAcceptSuggestion, id),
    dismissSuggestion: (id) => ipcRenderer.invoke(IPC.planDismissSuggestion, id),
    undoSuggestion: (id) => ipcRenderer.invoke(IPC.planUndoSuggestion, id),
    acceptedToday: () => ipcRenderer.invoke(IPC.planAcceptedToday),
  },
  races: {
    list: () => ipcRenderer.invoke(IPC.racesList),
    save: (race) => ipcRenderer.invoke(IPC.racesSave, race),
    remove: (id) => ipcRenderer.invoke(IPC.racesRemove, id),
    timeline: () => ipcRenderer.invoke(IPC.racesTimeline),
  },
  debug: {
    tables: () => ipcRenderer.invoke(IPC.debugTables),
    rows: (table, limit, offset) => ipcRenderer.invoke(IPC.debugRows, table, limit, offset),
  },
};

contextBridge.exposeInMainWorld('pacekat', api);
