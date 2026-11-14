import { useEffect, useRef, useState } from 'react';
import type { RaceTypeId, RaceView, Result, Sensors, SettingsView, TemplateSlotView, TimelineView } from '../../shared/api';
import { PHASE_LABEL, daysBetween, localTime, pace, parsePace, shortDate } from '../../shared/format';
import { api, todayIso, useApi } from '../api';
import type { AppNav } from '../App';
import { Popover, Switch, useToast } from '../components/common';
import { Icon } from '../components/Icons';

const SECTIONS: Array<{ id: string; label: string; group: string }> = [
  { id: 'races', label: 'Races', group: 'Training' },
  { id: 'week', label: 'My week', group: 'Training' },
  { id: 'body', label: 'Body & zones', group: 'Training' },
  { id: 'hardware', label: 'Hardware', group: 'Training' },
  { id: 'garmin', label: 'Garmin', group: 'App' },
  { id: 'ai', label: 'AI summaries', group: 'App' },
  { id: 'data', label: 'Data & about', group: 'App' },
  { id: 'dev', label: 'Developer', group: 'App' },
];

const RACE_TYPES: Array<[RaceTypeId, string]> = [
  ['sprint_tri', 'Sprint triathlon'],
  ['olympic_tri', 'Olympic triathlon'],
  ['5k', '5 km'],
  ['10k', '10 km'],
  ['half_marathon', 'Half marathon'],
  ['marathon', 'Marathon'],
  ['gran_fondo', 'Gran fondo'],
  ['mtb', 'MTB race'],
  ['other', 'Other'],
];
const raceTypeLabel = (t: string) => RACE_TYPES.find(([k]) => k === t)?.[1] ?? t;

type Msg = (r: Result | { ok: boolean; message: string }) => void;

export function SettingsPage({ nav, section }: { nav: AppNav; section?: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(section ?? 'races');
  const settings = useApi(() => api.settings.get());
  const [toast, show] = useToast();
  const msg: Msg = (r) => show(r.message, r.ok);

  const jump = (id: string) => {
    setActive(id);
    body.current?.querySelector(`#sec-${id}`)?.scrollIntoView({ block: 'start' });
  };
  useEffect(() => {
    if (section) jump(section);
  }, [section]);

  const s = settings.data;
  let group = '';
  return (
    <main className="page">
      <div className="page-head">
        <h1>Races &amp; Settings</h1>
      </div>
      <div className="settings">
        <nav className="subnav" aria-label="Settings sections">
          {SECTIONS.map((x) => {
            const head = x.group !== group ? (group = x.group) : null;
            return (
              <div key={x.id} className="subnav-item">
                {head && <div className="grp">{head}</div>}
                <button className={active === x.id ? 'on' : ''} onClick={() => jump(x.id)}>
                  {x.label}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="sbody" ref={body}>
          <RacesSection msg={msg} />
          <WeekSection msg={msg} openWater={s?.openWater ?? false} />
          {s && <BodySection s={s} msg={msg} />}
          {s && <HardwareSection s={s} msg={msg} />}
          {s && <GarminSection s={s} nav={nav} msg={msg} />}
          <section className="tile" id="sec-ai">
            <h2>AI summaries</h2>
            <p className="lead">A small model running on this computer will turn the engine's numbers into short notes. Nothing leaves your machine. Until then you get template summaries, which work fine.</p>
            <div className="trow2 first">
              <div className="txt">
                Use AI summaries
                <div className="muted">Off · using templates. The model download arrives in a later update.</div>
              </div>
              <Switch on={false} onChange={() => {}} label="Use AI summaries" disabled />
            </div>
          </section>
          <DataSection msg={msg} />
          <section className="tile" id="sec-dev">
            <h2>Developer</h2>
            <p className="lead">Raw tables, sync state and engine debug views, in a separate window.</p>
            <div className="btn-row">
              <button className="btn" onClick={() => void api.app.openDebug()}>
                Open debug views
              </button>
            </div>
          </section>
        </div>
      </div>
      {toast}
    </main>
  );
}

/* ---------------- Races ---------------- */

const emptyRace = { name: '', date: '', type: 'sprint_tri' as RaceTypeId, priority: 'A' as 'A' | 'B' | 'C' };

function RacesSection({ msg }: { msg: Msg }) {
  const races = useApi(() => api.races.list());
  const timeline = useApi(() => api.races.timeline());
  const [form, setForm] = useState<(typeof emptyRace & { id?: number }) | null>(null);
  const today = todayIso();

  const save = async () => {
    if (!form) return;
    const r = await api.races.save({ ...form, notes: null });
    msg(r);
    if (r.ok) setForm(null);
  };

  return (
    <section className="tile" id="sec-races">
      <div className="sec-head">
        <div>
          <h2>Races</h2>
          <p className="lead">A races shape the plan. B races get a short taper. C races are training days with a number on.</p>
        </div>
        {!form && (
          <button className="btn primary" onClick={() => setForm({ ...emptyRace })}>
            Add race
          </button>
        )}
      </div>
      {form && (
        <form
          className="race-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input id="race-name" placeholder="Race name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Race name" />
          <input id="race-date" type="date" value={form.date} min={today} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label="Race date" />
          <select id="race-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as RaceTypeId })} aria-label="Race type">
            {RACE_TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <select id="race-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as 'A' })} aria-label="Priority">
            <option value="A">A · build toward it</option>
            <option value="B">B · short taper</option>
            <option value="C">C · training race</option>
          </select>
          <button className="btn primary" type="submit">
            {form.id ? 'Save race' : 'Add race'}
          </button>
          <button className="btn" type="button" onClick={() => setForm(null)}>
            Cancel
          </button>
        </form>
      )}
      <div className="race-row race-head">
        <span />
        <span>Name</span>
        <span className="rtype">Type</span>
        <span>Date</span>
        <span>In</span>
        <span />
      </div>
      {(races.data ?? []).length === 0 && <p className="muted race-empty">No races yet. Without one, the plan stays in maintain mode: your usual week with a little variety.</p>}
      {(races.data ?? []).map((r: RaceView) => {
        const days = daysBetween(today, r.date);
        return (
          <div key={r.id} className="race-row">
            <span className={`prio ${r.priority}`}>{r.priority}</span>
            <span>{r.name}</span>
            <span className="rtype muted">{raceTypeLabel(r.type)}</span>
            <span>{shortDate(r.date)}</span>
            <span className="muted">{days >= 0 ? `${days} days` : 'done'}</span>
            <Popover
              trigger={(t) => (
                <button className="kebab static" onClick={t} aria-label={`Actions for ${r.name}`}>
                  <Icon name="more" width={16} height={16} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <button
                    onClick={() => {
                      close();
                      setForm({ id: r.id, name: r.name, date: r.date, type: r.type, priority: r.priority });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={async () => {
                      close();
                      msg(await api.races.remove(r.id));
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </Popover>
          </div>
        );
      })}
      {timeline.data && <Timeline t={timeline.data} />}
    </section>
  );
}

function Timeline({ t }: { t: TimelineView }) {
  const total = daysBetween(t.from, t.to) + 1;
  const pos = (d: string) => `${(daysBetween(t.from, d) / total) * 100}%`;
  const months: Array<{ label: string; at: string }> = [];
  for (let d = new Date(`${t.from}T00:00:00Z`); d <= new Date(`${t.to}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 1)) {
    const iso = d.toISOString().slice(0, 10);
    months.push({ label: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }), at: iso < t.from ? t.from : iso });
  }
  return (
    <div className="timeline">
      <div className="label tl-label">Resulting phases</div>
      <div className="tl-bar">
        {t.segments.map((s) => {
          const cur = s.from <= t.today && s.to >= t.today;
          return (
            <span key={s.from} className={cur ? 'cur' : s.phase === 'taper' ? 'taper' : ''} style={{ flex: s.days }} title={`${PHASE_LABEL[s.phase]}: ${shortDate(s.from)} – ${shortDate(s.to)}`}>
              {s.days >= 10 ? `${PHASE_LABEL[s.phase] ?? s.phase}${cur ? ' · now' : ''}` : ''}
            </span>
          );
        })}
      </div>
      <div className="tl-marks">
        <span className="m now" style={{ left: pos(t.today) }}>
          Today
        </span>
        {t.races
          .filter((r) => r.date >= t.from && r.date <= t.to)
          .map((r) => (
            <span key={r.id} className="m" style={{ left: pos(r.date) }}>
              {r.priority} · {r.name}
            </span>
          ))}
      </div>
      <div className="tl-axis">
        {months.map((m) => (
          <span key={m.at}>{m.label}</span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- My week ---------------- */

const ROLES: Array<{ id: string; label: string; sport: string; hint?: string }> = [
  { id: 'commute', label: 'Commute', sport: 'commute', hint: 'fixed' },
  { id: 'strength_upper', label: 'Upper body', sport: 'strength' },
  { id: 'strength_lower', label: 'Lower body', sport: 'strength' },
  { id: 'swim_quality', label: 'Swim · quality', sport: 'swim' },
  { id: 'swim_endurance', label: 'Swim · endurance', sport: 'swim' },
  { id: 'sat_main', label: 'Main', sport: 'run', hint: 'MTB or parkrun' },
  { id: 'sun_run', label: 'Run', sport: 'run', hint: 'long / easy' },
  { id: 'recovery', label: 'Recovery', sport: 'other', hint: 'rest or mobility' },
  { id: 'rest', label: 'Rest', sport: 'other' },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function WeekSection({ msg, openWater }: { msg: Msg; openWater: boolean }) {
  const tmpl = useApi(() => api.settings.template());
  const [draft, setDraft] = useState<TemplateSlotView[] | null>(null);
  const slots = draft ?? tmpl.data ?? [];
  const dirty = draft !== null;
  const setSlots = (fn: (s: TemplateSlotView[]) => TemplateSlotView[]) => setDraft(fn(slots.map((x) => ({ ...x }))));

  return (
    <section className="tile" id="sec-week">
      <h2>My week</h2>
      <p className="lead">Your usual week. The engine picks the actual session for each slot from the phase you're in. Commutes are fixed and never moved.</p>
      <div className="tmpl">
        {DAYS.map((name, wd) => {
          const day = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.weekday === wd);
          return (
            <div key={name} className="col">
              <span className="dn">{name}</span>
              {day.map(({ s, i }) => {
                const role = ROLES.find((r) => r.id === s.role) ?? ROLES.at(-1)!;
                return (
                  <div key={i} className={`role s-${role.sport}`}>
                    <select
                      aria-label={`${name} slot`}
                      value={s.role}
                      onChange={(e) =>
                        setSlots((all) =>
                          e.target.value === '__remove'
                            ? all.filter((_, j) => j !== i)
                            : all.map((x, j) => (j === i ? { ...x, role: e.target.value, ...(e.target.value === 'sat_main' ? { choices: ['mtb', 'parkrun'] } : { choices: undefined }) } : x)),
                        )
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                      <option value="__remove">Remove</option>
                    </select>
                    {role.hint && s.role !== 'sat_main' && <small>{role.hint}</small>}
                    {s.role === 'sat_main' && (
                      <span className="choices">
                        {['mtb', 'parkrun'].map((c) => (
                          <label key={c}>
                            <input
                              type="checkbox"
                              checked={(s.choices ?? ['mtb', 'parkrun']).includes(c)}
                              onChange={(e) =>
                                setSlots((all) =>
                                  all.map((x, j) => {
                                    if (j !== i) return x;
                                    const cur = new Set(x.choices ?? ['mtb', 'parkrun']);
                                    if (e.target.checked) cur.add(c);
                                    else if (cur.size > 1) cur.delete(c);
                                    return { ...x, choices: [...cur] };
                                  }),
                                )
                              }
                            />
                            {c === 'mtb' ? 'MTB' : 'parkrun'}
                          </label>
                        ))}
                      </span>
                    )}
                  </div>
                );
              })}
              <button className="add-slot" onClick={() => setSlots((all) => [...all, { weekday: wd, slot: 99, role: 'rest' }])}>
                + add
              </button>
            </div>
          );
        })}
      </div>
      {dirty && (
        <div className="btn-row save-row">
          <button
            className="btn primary"
            onClick={async () => {
              const r = await api.settings.setTemplate(slots);
              msg(r);
              if (r.ok) {
                setDraft(null);
                tmpl.reload();
              }
            }}
          >
            Save my week
          </button>
          <button className="btn" onClick={() => setDraft(null)}>
            Discard changes
          </button>
          <span className="muted">Saving re-plans the rest of this week.</span>
        </div>
      )}
      <div className="trow2">
        <div className="txt">
          Open-water access
          <div className="muted">Plans open-water swims in the build and peak phases.</div>
        </div>
        <Switch on={openWater} label="Open-water access" onChange={async (v) => msg(await api.settings.set({ openWater: v }))} />
      </div>
    </section>
  );
}

/* ---------------- Body & zones ---------------- */

function NumberField({
  label,
  unit,
  value,
  source,
  parse,
  format,
  onSave,
  disabled,
  dim,
}: {
  label: string;
  unit: string;
  value: number | null;
  source: string;
  parse: (s: string) => number | null;
  format: (v: number) => string;
  onSave: (v: number | null) => void;
  disabled?: boolean;
  dim?: boolean;
}) {
  const [text, setText] = useState(value != null ? format(value) : '');
  useEffect(() => setText(value != null ? format(value) : ''), [value, format]);
  const commit = () => {
    const t = text.trim();
    if (t === (value != null ? format(value) : '')) return;
    if (!t) return onSave(null);
    const v = parse(t);
    if (v == null) return setText(value != null ? format(value) : '');
    onSave(v);
  };
  return (
    <div className={`field${dim ? ' dim' : ''}`}>
      <label htmlFor={`f-${label}`}>{label}</label>
      <div className="in">
        <input
          id={`f-${label}`}
          value={text}
          placeholder="—"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="muted">{unit}</span>
      </div>
      <div className="src">{source}</div>
    </div>
  );
}

const intParse = (s: string) => (/^\d{2,3}$/.test(s.trim()) ? Number(s.trim()) : null);
const intFmt = (v: number) => String(Math.round(v));

function BodySection({ s, msg }: { s: SettingsView; msg: Msg }) {
  const [zones, setZones] = useState(s.zones);
  useEffect(() => setZones(s.zones), [s.zones]);
  const dirty = JSON.stringify(zones) !== JSON.stringify(s.zones);
  const manual = s.zones.some((z) => z.source === 'manual');
  const maxSrc = s.maxHr.source === 'setting' ? `You set this${s.maxHr.garmin ? ` · Garmin says ${s.maxHr.garmin}` : ''}` : s.maxHr.source === 'garmin' ? 'From Garmin · type to override' : 'Default · set yours';
  return (
    <section className="tile" id="sec-body">
      <h2>Body &amp; zones</h2>
      <p className="lead">Used for load and targets. Anything you type here wins over Garmin's value; clear a field to go back.</p>
      <div className="fields">
        <NumberField label="Max HR" unit="bpm" value={s.maxHr.value} source={maxSrc} parse={intParse} format={intFmt} onSave={async (v) => msg(await api.settings.set({ maxHr: v }))} />
        <NumberField label="Resting HR" unit="bpm" value={s.restHr} source="Automatic · 7-day average" parse={intParse} format={intFmt} onSave={() => {}} disabled />
        <NumberField
          label="Run threshold pace"
          unit="/km"
          value={s.runThresholdSPerKm}
          source={s.runThresholdSPerKm ? 'You set this · used for run targets' : 'Set it to get pace targets'}
          parse={parsePace}
          format={pace}
          onSave={async (v) => msg(await api.settings.set({ runThresholdSPerKm: v }))}
        />
        <NumberField
          label="Swim CSS"
          unit="/100 m"
          value={s.swimCssSPer100m}
          source={s.swimCssSPer100m ? 'You set this · used for swim targets' : 'Set it to get swim targets'}
          parse={parsePace}
          format={pace}
          onSave={async (v) => msg(await api.settings.set({ swimCssSPer100m: v }))}
        />
        <NumberField
          label="FTP"
          unit="W"
          value={s.ftpW}
          source={s.sensors.bikePower ? 'Used for power targets' : 'Appears when Bike power is on'}
          parse={intParse}
          format={intFmt}
          disabled={!s.sensors.bikePower}
          dim={!s.sensors.bikePower}
          onSave={async (v) => msg(await api.settings.set({ ftpW: v }))}
        />
      </div>
      {zones.length === 5 ? (
        <>
          <table className="ztable">
            <thead>
              <tr>
                <th>Zone</th>
                <th>From</th>
                <th>To</th>
                <th className="zbar-col" />
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {zones.map((z, i) => (
                <tr key={z.zone}>
                  <td>Z{z.zone}</td>
                  <td>
                    <input
                      className="zin"
                      aria-label={`Zone ${z.zone} from`}
                      value={z.minBpm}
                      onChange={(e) => {
                        const v = Number(e.target.value.replace(/\D/g, '')) || 0;
                        setZones(zones.map((x, j) => (j === i ? { ...x, minBpm: v } : j === i - 1 ? { ...x, maxBpm: v - 1 } : x)));
                      }}
                    />
                  </td>
                  <td>{z.maxBpm}</td>
                  <td>
                    <div className="zbar" style={{ width: `${(i + 1) * 20}%`, opacity: [0.35, 0.5, 0.65, 0.8, 1][i] }} />
                  </td>
                  <td className="muted">{z.source === 'manual' ? 'You' : 'Garmin'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(dirty || manual) && (
            <div className="btn-row save-row">
              {dirty && (
                <button className="btn primary" onClick={async () => msg(await api.settings.setZones(zones.map(({ zone, minBpm, maxBpm }) => ({ zone, minBpm, maxBpm }))))}>
                  Save zones
                </button>
              )}
              {manual && (
                <button className="btn" onClick={async () => msg(await api.settings.setZones(null))}>
                  Use Garmin's zones
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="muted">Heart-rate zones arrive from Garmin with the first sync.</p>
      )}
    </section>
  );
}

/* ---------------- Hardware ---------------- */

const SENSOR_ROWS: Array<{ key: keyof Sensors; title: string; detail: string }> = [
  { key: 'chestStrap', title: 'Chest strap', detail: 'Trust heart rate for intervals and strength.' },
  { key: 'swimHrStorage', title: 'Swim HR storage (HRM 600 / HRM-Pro)', detail: 'Use heart rate for swim load instead of RPE.' },
  { key: 'runningDynamics', title: 'Running dynamics', detail: 'Show ground contact time, vertical oscillation and stride length trends.' },
  { key: 'bikePower', title: 'Bike power', detail: 'Power targets, NP / IF / TSS and the FTP setting.' },
];

function HardwareSection({ s, msg }: { s: SettingsView; msg: Msg }) {
  return (
    <section className="tile" id="sec-hardware">
      <h2>Hardware</h2>
      <p className="lead">Tell the app which sensors you use, so it knows which numbers to trust.</p>
      {SENSOR_ROWS.map((row, i) => {
        const nudge = s.nudges.find((n) => n.key === row.key);
        return (
          <div key={row.key} className={`trow2${i === 0 ? ' first' : ''}`}>
            <div className="txt">
              {row.title}
              <div className="muted">{row.detail}</div>
              {nudge && (
                <div className="nudge">
                  <span>{nudge.message}</span>
                  <button className="btn primary small" onClick={async () => msg(await api.settings.set({ sensors: { [row.key]: true } }))}>
                    Turn on
                  </button>
                  <button className="link faint" onClick={async () => msg(await api.settings.set({ dismissNudge: row.key }))}>
                    Not now
                  </button>
                </div>
              )}
            </div>
            <Switch on={s.sensors[row.key]} label={row.title} onChange={async (v) => msg(await api.settings.set({ sensors: { [row.key]: v } }))} />
          </div>
        );
      })}
    </section>
  );
}

/* ---------------- Garmin ---------------- */

function GarminSection({ s, nav, msg }: { s: SettingsView; nav: AppNav; msg: Msg }) {
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState('');
  const g = s.garmin;
  const status = g.lastError ? 'Problem' : g.hasKey ? 'Connected' : 'Not connected';
  return (
    <section className="tile" id="sec-garmin">
      <h2>Garmin</h2>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <span className={g.lastError ? 'status-bad' : g.hasKey ? 'status-on' : 'muted'}>{status}</span>
          {g.lastError && <div className="err-text small-note">{g.lastError}</div>}
        </dd>
        <dt>Key</dt>
        <dd>{g.keyHint ?? '—'}</dd>
        <dt>Last sync</dt>
        <dd>
          {g.lastSyncAt ? `${shortDate(g.lastSyncAt.slice(0, 10))} ${localTime(g.lastSyncAt)}` : 'Never'}
          {g.newActivitiesLastSync != null ? ` · ${g.newActivitiesLastSync} new ${g.newActivitiesLastSync === 1 ? 'activity' : 'activities'}` : ''}
        </dd>
        <dt>History</dt>
        <dd>{g.historyStart ? `Since ${shortDate(g.historyStart)}` : '—'}</dd>
      </dl>
      <div className="btn-row">
        <button className="btn" disabled={nav.sync.running} onClick={() => void nav.sync.run()}>
          {nav.sync.running ? 'Syncing…' : 'Sync now'}
        </button>
        <button className="btn" onClick={async () => msg(await api.garmin.testConnection())}>
          Test connection
        </button>
        <button className="btn" onClick={() => setReplacing((r) => !r)}>
          Replace key
        </button>
        <button className="btn" disabled={nav.sync.running} onClick={() => void nav.sync.run(true)}>
          Re-sync last 90 days
        </button>
      </div>
      {replacing && (
        <form
          className="fr-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await api.garmin.setKey(key);
            msg(r);
            if (r.ok) {
              setKey('');
              setReplacing(false);
              msg(await api.garmin.testConnection());
            }
          }}
        >
          <input id="replace-key" type="password" autoComplete="off" spellCheck={false} placeholder="GCDC_…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="New Garmin key" />
          <button className="btn primary" type="submit" disabled={!key.trim()}>
            Save key
          </button>
        </form>
      )}
      <details className="howto">
        <summary>How to create a Garmin key</summary>
        <ol>
          <li>
            Sign in to Garmin Connect on the web and open{' '}
            <a href="https://connect.garmin.com/app/settings/personalApiToken" target="_blank" rel="noreferrer">
              Personal API Key
            </a>
            .
          </li>
          <li>Choose Create Key, accept the terms and pick 1 year, so you don't have to do this again soon.</li>
          <li>Copy the key starting with <code>GCDC_</code> (it's shown only once) and paste it here.</li>
        </ol>
      </details>
    </section>
  );
}

/* ---------------- Data & about ---------------- */

function DataSection({ msg }: { msg: Msg }) {
  const info = useApi(() => api.app.info());
  return (
    <section className="tile" id="sec-data">
      <h2>Data &amp; about</h2>
      <p className="lead">Everything lives in one folder on this computer.</p>
      <div className="btn-row">
        <button className="btn" onClick={() => void api.app.openDataFolder()}>
          Open data folder
        </button>
        <button className="btn" onClick={async () => msg(await api.app.exportBackup())}>
          Export backup (.zip)
        </button>
      </div>
      <dl className="kv data-kv">
        <dt>Version</dt>
        <dd>{info.data?.version ?? '—'}</dd>
        <dt>Data folder</dt>
        <dd className="muted">{info.data?.userData ?? '—'}</dd>
        <dt>Time zone</dt>
        <dd>{info.data?.timezone ?? '—'}</dd>
      </dl>
      <div className="disclaimer">Pacekat gives training suggestions, not medical advice. If something hurts or feels wrong, rest and talk to a professional.</div>
    </section>
  );
}
