import { useCallback, useEffect, useState } from 'react';
import type { SyncProgress, SyncResult } from '../shared/api';
import { localTime } from '../shared/format';
import { api, useApi } from './api';
import { Icon, IconSprite } from './components/Icons';
import { Drawer } from './components/Drawer';
import { FirstRun } from './components/FirstRun';
import { TodayPage } from './pages/Today';
import { WeekPage } from './pages/Week';
import { TrendsPage } from './pages/Trends';
import { SettingsPage } from './pages/Settings';

export type Page = 'today' | 'week' | 'trends' | 'settings';

export interface SyncState {
  running: boolean;
  progress: SyncProgress | null;
  lastFinishedAt: string | null;
  lastResult: SyncResult | null;
  run: (full?: boolean) => Promise<void>;
}

export interface AppNav {
  go: (page: Page, section?: string) => void;
  openActivity: (id: number) => void;
  sync: SyncState;
}

const PAGES: Array<{ id: Page; icon: string; label: string }> = [
  { id: 'today', icon: 'today', label: 'Today' },
  { id: 'week', icon: 'week', label: 'Week' },
  { id: 'trends', icon: 'trends', label: 'Trends' },
  { id: 'settings', icon: 'settings', label: 'Races & Settings' },
];

function useSync(): SyncState {
  const status = useApi(() => api.sync.status());
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(
    () =>
      api.sync.onProgress((p) => {
        setProgress(p);
        setRunning(p.phase !== 'done' && p.phase !== 'error');
      }),
    [],
  );
  useEffect(() => {
    if (status.data?.running) setRunning(true);
  }, [status.data?.running]);

  const run = useCallback(async (full = false) => {
    setRunning(true);
    const r = await api.sync.run({ full });
    setLastResult(r);
    setRunning(false);
    status.reload();
  }, [status]);

  return { running, progress, lastFinishedAt: status.data?.lastFinishedAt ?? null, lastResult, run };
}

export function App() {
  const [page, setPage] = useState<Page>('today');
  const [section, setSection] = useState<string | undefined>();
  const [drawer, setDrawer] = useState<number | null>(null);
  const [setup, setSetup] = useState(false);
  const garmin = useApi(() => api.garmin.status());
  const sync = useSync();

  const nav: AppNav = {
    go: (p, s) => {
      setPage(p);
      setSection(s);
    },
    openActivity: setDrawer,
    sync,
  };

  const firstRun = !!garmin.data && (!garmin.data.hasKey || setup);
  const dotTitle = sync.running ? 'Syncing…' : sync.lastFinishedAt ? `Synced ${localTime(sync.lastFinishedAt)}` : 'Not synced yet';
  const dotClass = sync.running ? 'sync-dot running' : garmin.data?.lastError ? 'sync-dot error' : 'sync-dot';

  return (
    <>
      <IconSprite />
      <div className="app">
        <nav className="rail" aria-label="Pages">
          <div className="logo">P</div>
          {PAGES.map((p) => (
            <button key={p.id} className={`rail-btn${page === p.id ? ' active' : ''}`} onClick={() => nav.go(p.id)} aria-label={p.label} aria-current={page === p.id}>
              <Icon name={p.icon} />
              <span className="tip">{p.label}</span>
            </button>
          ))}
          <div className="rail-spacer" />
          <span className={dotClass} title={dotTitle} />
        </nav>

        {firstRun && page !== 'settings' ? (
          <FirstRun
            nav={nav}
            onStart={() => setSetup(true)}
            onDone={() => {
              setSetup(false);
              garmin.reload();
              nav.go('today');
            }}
          />
        ) : page === 'today' ? (
          <TodayPage nav={nav} />
        ) : page === 'week' ? (
          <WeekPage nav={nav} />
        ) : page === 'trends' ? (
          <TrendsPage nav={nav} />
        ) : (
          <SettingsPage nav={nav} section={section} />
        )}
      </div>
      <Drawer id={drawer} onClose={() => setDrawer(null)} />
    </>
  );
}
