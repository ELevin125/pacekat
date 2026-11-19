import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DB } from './db';
import { registerIpc } from './ipc';
import { GARMIN_KEY, SecretStore } from './secrets';

let win: BrowserWindow | null = null;
let debugWin: BrowserWindow | null = null;
let db: DB | null = null;

// Dev/testing only: isolate the data folder (e.g. for smoke tests against a mock Garmin).
if (!app.isPackaged && process.env.PACEKAT_USER_DATA) app.setPath('userData', process.env.PACEKAT_USER_DATA);
const userData = app.getPath('userData');
const paths = {
  db: join(userData, 'pacekat.db'),
  fit: join(userData, 'fit'),
  models: join(userData, 'models'),
  logs: join(userData, 'logs'),
};

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(join(paths.logs, 'main.log'), line);
  } catch {
    /* logging must never crash the app */
  }
  if (!app.isPackaged) process.stdout.write(line);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0B0D10',
    title: 'Pacekat',
    icon: join(__dirname, '../../build/icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.once('ready-to-show', () => w.show());

  lockDown(w);

  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(__dirname, '../renderer/index.html'));
  return w;
}

const PRELOAD = () => join(__dirname, '../preload/index.cjs');
const lockDown = (w: BrowserWindow) => {
  // No in-app navigation away from our page; external links open in the browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (url !== w.webContents.getURL()) e.preventDefault();
  });
};

/** Raw tables, sync state and engine views from M1–M3 (Settings → Developer). */
function openDebugWindow(): void {
  if (debugWin && !debugWin.isDestroyed()) {
    debugWin.focus();
    return;
  }
  debugWin = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0B0D10',
    title: 'Pacekat · Developer',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD(), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lockDown(debugWin);
  if (process.env.ELECTRON_RENDERER_URL) void debugWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}/debug.html`);
  else void debugWin.loadFile(join(__dirname, '../renderer/debug.html'));
  debugWin.on('closed', () => (debugWin = null));
}

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Windows: group the taskbar entry and notifications under the installed app's id.
  if (process.platform === 'win32') app.setAppUserModelId('com.pacekat.app');

  app.whenReady().then(() => {
    for (const p of [paths.fit, paths.models, paths.logs]) mkdirSync(p, { recursive: true });
    db = openDb(paths.db);
    const secrets = new SecretStore(db, {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Johannesburg';

    const ipc = registerIpc({ db, secrets, userData, fitDir: paths.fit, timeZone, getWindow: () => win, log, openDebug: openDebugWindow });
    win = createWindow();
    log(`started; userData=${userData} tz=${timeZone}`);

    // Sync on open (non-blocking). Progress events reach the window once it loads.
    if (secrets.has(GARMIN_KEY)) {
      win.webContents.once('did-finish-load', () => void ipc.runSync(false));
    }
  });

  app.on('window-all-closed', () => {
    db?.close();
    app.quit();
  });
}
