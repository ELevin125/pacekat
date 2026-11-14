import { useState } from 'react';
import type { TrendSport } from '../../shared/api';
import { dayMonth, pace } from '../../shared/format';
import { api, useApi } from '../api';
import type { AppNav } from '../App';
import { Mark } from '../components/common';
import { SportIcon } from '../components/Icons';
import { LineChart, RatioStrip, StackedBars } from '../components/charts';

const SPORT_NAME: Record<TrendSport, string> = { swim: 'Swim', bike: 'Bike', run: 'Run', strength: 'Strength', other: 'Other' };
const last = <T,>(xs: Array<T | null>): T | null => [...xs].reverse().find((x) => x != null) ?? null;
const r0 = (v: number) => String(Math.round(v));

export function TrendsPage({ nav }: { nav: AppNav }) {
  const [weeks, setWeeks] = useState(12);
  const [hidden, setHidden] = useState<Set<TrendSport>>(new Set());
  const t = useApi(() => api.trends.get(weeks), [weeks]);
  const settings = useApi(() => api.settings.get());
  const d = t.data;
  if (!d) return <main className="page scroll" />;

  const labels = d.weeks.map(dayMonth);
  const sports = (['swim', 'bike', 'run', 'strength', 'other'] as TrendSport[]).filter((s) => s !== 'other' || d.load.other.some((v) => v > 0));
  const shown = sports.filter((s) => !hidden.has(s));
  const toggle = (s: TrendSport) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(s)) next.delete(s);
      else if (shown.length > 1) next.add(s);
      return next;
    });
  const hasVo2 = d.vo2.some((v) => v != null);
  const dyn = settings.data?.sensors.runningDynamics;

  return (
    <main className="page scroll">
      <div className="page-head">
        <h1>Trends</h1>
        <span className="sub">
          Last {weeks} weeks · {labels[0]} – now
        </span>
        <div className="right filters">
          <div className="seg" role="group" aria-label="Range">
            {[4, 8, 12].map((n) => (
              <button key={n} className={weeks === n ? 'on' : ''} onClick={() => setWeeks(n)}>
                {n} wk
              </button>
            ))}
          </div>
          <span className="sep" />
          {sports.map((s) => (
            <button key={s} className={`fchip s-${s}${hidden.has(s) ? '' : ' on'}`} onClick={() => toggle(s)} aria-pressed={!hidden.has(s)}>
              <span className="dot" />
              {SPORT_NAME[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="tgrid">
        <section className="tile chart tg-load">
          <div className="tile-head">
            <span className="label">Weekly load by sport</span>
            <span className="hint">TRIMP · current week so far</span>
          </div>
          <StackedBars labels={labels} partialLast series={shown.map((s) => ({ key: s, name: SPORT_NAME[s], color: `var(--sport-${s})`, values: d.load[s] }))} />
          <div className="legend-row">
            {shown.map((s) => (
              <span key={s}>
                <i style={{ background: `var(--sport-${s})` }} />
                {SPORT_NAME[s]}
                {s === 'bike' ? ' (incl. commutes)' : ''}
              </span>
            ))}
          </div>
          <div className="chart-sub">
            <span>Load ratio (acute : chronic)</span>
            <span>
              now <b>{d.acwrNow != null ? d.acwrNow.toFixed(2) : '—'}</b> · safe range 0.8–1.3
            </span>
          </div>
          <RatioStrip values={d.acwr} labels={labels} />
        </section>

        <section className="tile tg-focus">
          <div className="label">Focus areas</div>
          <ul className="focus-list">
            {d.focus.length === 0 && <li className="focus-empty">Nothing to flag yet. Hints appear as more training builds up.</li>}
            {d.focus.map((f) => (
              <li key={f.title}>
                <Mark status={f.kind === 'watch' ? 'watch' : 'good'} />
                <div>
                  <div className="t">{f.title}</div>
                  <div className="d">{f.detail}</div>
                  {f.action && (
                    <div className="act">
                      <button className="link" onClick={() => nav.go('settings', f.action)}>
                        {f.action === 'week' ? 'Edit my week' : f.action === 'hardware' ? 'Open Hardware' : 'Open Body & zones'}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="disclaimer focus-note">Hints are simple rules, not diagnoses. They appear and disappear as your data changes.</div>
        </section>

        <section className="tile chart tg-4">
          <div className="tile-head">
            <span className="label">Recovery</span>
            <span className="hint">weekly average</span>
          </div>
          <div className="chart-sub">
            <span>HRV (ms){d.hrvBand ? ' vs your normal range' : ''}</span>
            <span>
              this week <b>{last(d.hrv) != null ? r0(last(d.hrv)!) : '—'}</b>
            </span>
          </div>
          <LineChart values={d.hrv} labels={labels} opts={{ name: 'HRV', fmt: r0, ...(d.hrvBand ? { band: d.hrvBand, bandLabel: 'normal range' } : {}) }} />
          <div className="chart-sub">
            <span>Resting HR (bpm)</span>
            <span>
              this week <b>{last(d.rhr) != null ? r0(last(d.rhr)!) : '—'}</b>
            </span>
          </div>
          <LineChart values={d.rhr} labels={labels} opts={{ name: 'Resting HR', fmt: r0 }} />
        </section>

        <section className="tile chart tg-4 s-swim">
          <div className="tile-head">
            <SportIcon sport="swim" />
            <span className="label">Swim · pool</span>
            <span className="hint">faster ↑</span>
          </div>
          <div className="chart-sub">
            <span>Avg pace /100 m</span>
            <span>
              last <b>{pace(last(d.swimPace))}</b>
            </span>
          </div>
          <LineChart values={d.swimPace} labels={labels} opts={{ name: 'Pace /100 m', fmt: pace, invert: true, color: 'var(--sport-swim)' }} />
          <div className="chart-sub">
            <span>SWOLF (lower is better)</span>
            <span>
              last <b>{last(d.swolf) != null ? r0(last(d.swolf)!) : '—'}</b>
            </span>
          </div>
          <LineChart values={d.swolf} labels={labels} opts={{ name: 'SWOLF', fmt: r0, invert: true, color: 'var(--sport-swim)' }} />
        </section>

        <section className="tile chart tg-4 s-run">
          <div className="tile-head">
            <SportIcon sport="run" />
            <span className="label">Run · easy runs</span>
            <span className="hint">faster ↑</span>
          </div>
          <div className="chart-sub">
            <span>Aerobic efficiency: pace at {d.refHr} bpm</span>
            <span>
              last <b>{last(d.runEff) != null ? `${pace(last(d.runEff))} /km` : '—'}</b>
            </span>
          </div>
          <LineChart values={d.runEff} labels={labels} opts={{ name: `Pace at ${d.refHr} bpm`, fmt: pace, invert: true, color: 'var(--sport-run)' }} />
          <div className="chart-sub">
            <span>Cadence (spm) · 160 guide</span>
            <span>
              last <b>{last(d.cadence) != null ? r0(last(d.cadence)!) : '—'}</b>
            </span>
          </div>
          <LineChart values={d.cadence} labels={labels} opts={{ name: 'Cadence', fmt: r0, refLine: 160, color: 'var(--sport-run)' }} />
        </section>

        <section className="tile chart tg-4 s-bike">
          <div className="tile-head">
            <SportIcon sport="bike" />
            <span className="label">Bike · commutes</span>
            <span className="hint">commutes only, so rides compare</span>
          </div>
          <div className="chart-sub">
            <span>Avg speed (km/h)</span>
            <span>
              last <b>{last(d.commuteSpeed)?.toFixed(1) ?? '—'}</b>
            </span>
          </div>
          <LineChart values={d.commuteSpeed} labels={labels} opts={{ name: 'Speed', fmt: (v) => v.toFixed(1), color: 'var(--sport-bike)' }} />
          <div className="chart-sub">
            <span>Avg HR (bpm)</span>
            <span>
              last <b>{last(d.commuteHr) != null ? r0(last(d.commuteHr)!) : '—'}</b>
            </span>
          </div>
          <LineChart values={d.commuteHr} labels={labels} opts={{ name: 'Avg HR', fmt: r0, color: 'var(--sport-bike)' }} />
        </section>

        {dyn && d.dynamics ? (
          <section className="tile chart tg-4 s-run">
            <div className="tile-head">
              <SportIcon sport="run" />
              <span className="label">Running dynamics</span>
            </div>
            <div className="chart-sub">
              <span>Ground contact time (ms)</span>
              <span>
                last <b>{last(d.dynamics.gct) != null ? r0(last(d.dynamics.gct)!) : '—'}</b>
              </span>
            </div>
            <LineChart values={d.dynamics.gct} labels={labels} opts={{ name: 'GCT', fmt: r0, invert: true, color: 'var(--sport-run)' }} />
            <div className="chart-sub">
              <span>Vertical oscillation (cm)</span>
              <span>
                last <b>{last(d.dynamics.vertOsc)?.toFixed(1) ?? '—'}</b>
              </span>
            </div>
            <LineChart values={d.dynamics.vertOsc} labels={labels} opts={{ name: 'Vertical oscillation', fmt: (v) => v.toFixed(1), invert: true, color: 'var(--sport-run)' }} />
          </section>
        ) : (
          <section className="tile tg-4 off-tile">
            <div className="tile-head">
              <SportIcon sport="run" />
              <span className="label">Running dynamics</span>
            </div>
            <div className="ghost">
              Ground contact time, vertical oscillation and stride length.
              <br />
              Needs an HRM 600 or another running-dynamics sensor.
              <br />
              <button className="link ghost-link" onClick={() => nav.go('settings', 'hardware')}>
                Turn on in Hardware
              </button>
            </div>
          </section>
        )}

        {hasVo2 && (
          <section className="tile chart tg-4">
            <div className="tile-head">
              <span className="label">VO2 max</span>
              <span className="hint">from Garmin</span>
            </div>
            <div className="stat-big">
              {d.vo2Now ?? '—'}
              <small>ml/kg/min</small>
            </div>
            {d.vo2Change != null && d.vo2Change !== 0 && (
              <div className="muted vo2-delta">
                {d.vo2Change > 0 ? '+' : ''}
                {d.vo2Change} since {labels[d.vo2.findIndex((v) => v != null)]}
              </div>
            )}
            <LineChart values={d.vo2} labels={labels} opts={{ name: 'VO2 max', fmt: r0 }} />
          </section>
        )}
      </div>
    </main>
  );
}
