import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type PacekatApi, type SyncProgress } from '../shared/api';

const api: PacekatApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    openDataFolder: () => ipcRenderer.invoke(IPC.appOpenDataFolder),
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
  debug: {
    tables: () => ipcRenderer.invoke(IPC.debugTables),
    rows: (table, limit, offset) => ipcRenderer.invoke(IPC.debugRows, table, limit, offset),
  },
};

contextBridge.exposeInMainWorld('pacekat', api);
