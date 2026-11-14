import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReadinessFactor } from '../../shared/api';
import { localTime } from '../../shared/format';
import type { SyncState } from '../App';

/** Factor mark: outline ✓ fine · filled ! watch · red ✕ warning · dashed missing (no green/amber). */
export function Mark({ status }: { status: ReadinessFactor['status'] | 'watch' | 'good' }) {
  const s = status === 'amber' || status === 'watch' ? 'watch' : status === 'good' ? 'ok' : status;
  const glyph = s === 'ok' ? '✓' : s === 'watch' ? '!' : s === 'red' ? '✕' : '';
  const label = s === 'ok' ? 'fine' : s === 'watch' ? 'watch' : s === 'red' ? 'warning' : 'no data';
  return (
    <span className={`mark ${s}`} role="img" aria-label={label}>
      {glyph}
    </span>
  );
}

/** "Synced 07:12 · Sync now" in page headers. */
export function SyncLine({ sync }: { sync: SyncState }) {
  if (sync.running) {
    const p = sync.progress;
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : null;
    return <span>Syncing{p ? `: ${p.message}` : '…'}{pct != null && pct < 100 ? ` (${pct} %)` : ''}</span>;
  }
  const err = sync.lastResult && !sync.lastResult.ok ? sync.lastResult.message : null;
  return (
    <>
      {err ? <span className="err-text" title={err}>Sync problem</span> : <span>{sync.lastFinishedAt ? `Synced ${localTime(sync.lastFinishedAt)}` : 'Not synced yet'}</span>}
      <span>·</span>
      <button className="link" onClick={() => void sync.run()}>
        Sync now
      </button>
    </>
  );
}

/** A small popover menu anchored to its trigger; closes on outside click or Escape. */
export function Popover({ trigger, children, className, align = 'right' }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; className?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`pop-anchor ${className ?? ''}`} ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && <div className={`menu open ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** Short-lived message at the bottom of the screen. */
export function useToast(): [ReactNode, (msg: string, ok?: boolean) => void] {
  const [t, setT] = useState<{ msg: string; ok: boolean; n: number } | null>(null);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), t.ok ? 3500 : 7000);
    return () => clearTimeout(id);
  }, [t]);
  const node = t ? (
    <div className={`toast${t.ok ? '' : ' bad'}`} role="status">
      {t.msg}
    </div>
  ) : null;
  return [node, (msg, ok = true) => setT({ msg, ok, n: Date.now() })];
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`sw${on ? ' on' : ''}`} onClick={() => onChange(!on)} />;
}
