import { useState } from 'react';
import { api } from '../api';
import type { AppNav } from '../App';

/**
 * First run: paste the Garmin key, test it, then the 90-day backfill with
 * progress. Setup must be "install, paste a key, done" (README).
 */
export function FirstRun({ nav, onStart, onDone }: { nav: AppNav; onStart: () => void; onDone: () => void }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [step, setStep] = useState<'key' | 'syncing' | 'done'>('key');
  const [busy, setBusy] = useState(false);
  const p = nav.sync.progress;

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    const saved = await api.garmin.setKey(key);
    if (!saved.ok) {
      setMsg({ text: saved.message, ok: false });
      setBusy(false);
      return;
    }
    const test = await api.garmin.testConnection();
    if (!test.ok) {
      setMsg({ text: test.message, ok: false });
      setBusy(false);
      return;
    }
    onStart();
    setKey('');
    setStep('syncing');
    setBusy(false);
    await nav.sync.run();
    setStep('done');
  };

  const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Welcome to Pacekat</h1>
      </div>
      <div className="first-run">
        <section className="tile">
          {step === 'key' && (
            <>
              <div className="label">Step 1 of 2 · Connect Garmin</div>
              <h2 className="fr-title">Paste your Garmin key</h2>
              <ol className="fr-steps">
                <li>
                  Sign in to Garmin Connect on the web and open{' '}
                  <a href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noreferrer">
                    Personal API Key
                  </a>
                  .
                </li>
                <li>Choose Create Key, accept the terms and pick <b>1 year</b>.</li>
                <li>Copy the key (it starts with <code>GCDC_</code>; Garmin shows it only once) and paste it here.</li>
              </ol>
              <form
                className="fr-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void connect();
                }}
              >
                <input id="fr-key" type="password" autoComplete="off" spellCheck={false} placeholder="GCDC_…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Garmin key" />
                <button className="btn primary" type="submit" disabled={busy || !key.trim()}>
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
              </form>
              {msg && <p className={msg.ok ? 'muted' : 'err-text'}>{msg.text}</p>}
              <p className="faint fr-note">The key is stored encrypted on this computer. Nothing else leaves your machine.</p>
            </>
          )}
          {step !== 'key' && (
            <>
              <div className="label">Step 2 of 2 · First sync</div>
              <h2 className="fr-title">{step === 'done' ? (nav.sync.lastResult?.ok === false ? 'Synced, with a problem' : 'All set') : 'Getting your last 90 days'}</h2>
              <p className="muted">{step === 'done' ? (nav.sync.lastResult?.message ?? 'Done.') : (p?.message ?? 'Starting…')}</p>
              <div className="progress wide">
                <span style={{ width: `${step === 'done' ? 100 : pct}%` }} />
              </div>
              <p className="faint fr-note">This takes a minute or two the first time. After that, the app syncs each time you open it.</p>
              {step === 'done' && (
                <div className="btn-row">
                  <button className="btn primary" onClick={onDone}>
                    Go to Today
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
