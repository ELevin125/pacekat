import { useState } from 'react';
import type { ActivityItem, LibraryItem, PlanEditResult, PlanSessionView, PlanWeekView } from '../../shared/api';
import { INTENSITY_LABEL, PHASE_LABEL, hoursMinutes, weekRange, weekdayShort } from '../../shared/format';
import { api, todayIso, useApi } from '../api';
import type { AppNav } from '../App';
import { Popover, SyncLine, useToast } from '../components/common';
import { Icon, SportIcon } from '../components/Icons';
import { VERDICT_WORD, sportTotals } from '../view';

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const SPORT_NAME: Record<string, string> = { swim: 'Swim', bike: 'Bike', run: 'Run', strength: 'Strength', other: 'Other', rest: 'Rest' };

export function WeekPage({ nav }: { nav: AppNav }) {
  const today = todayIso();
  const [ws, setWs] = useState<string | null>(null);
  const week = useApi(() => api.plan.week(ws ?? undefined), [ws]);
  const w = week.data;
  const start = w?.weekStart;
  const acts = useApi(() => (start ? api.activities.between(addDays(start, -7), addDays(start, 6)) : Promise.resolve([] as ActivityItem[])), [start]);
  const readiness = useApi(() => api.metrics.readiness(120));
  const daily = useApi(() => api.metrics.daily(120));
  const library = useApi(() => api.plan.library());
  const [toast, show] = useToast();

  if (!w) return <main className="page" />;
  const days = Array.from({ length: 7 }, (_, i) => addDays(w.weekStart, i));
  const thisActs = (acts.data ?? []).filter((a) => a.date >= w.weekStart);
  const lastActs = (acts.data ?? []).filter((a) => a.date < w.weekStart);
  const actById = new Map((acts.data ?? []).map((a) => [a.id, a]));
  const verdict = new Map((readiness.data ?? []).map((r) => [r.date, r.verdict]));
  const load = new Map((daily.data ?? []).map((d) => [d.date, d.load]));
  const planned = (d: string) => w.sessions.filter((s) => s.date === d && s.status !== 'moved' && s.status !== 'skipped').reduce((a, s) => a + s.estLoad, 0);
  const loadMax = Math.max(1, ...days.map((d) => Math.max(load.get(d) ?? 0, planned(d))));
  const dayWarnings = (d: string) => w.warnings.filter((x) => x.code === 'key_back_to_back' && x.dates[1] === d);
  const weekWarnings = w.warnings.filter((x) => x.code !== 'key_back_to_back');
  const totals = sportTotals(thisActs, lastActs, w.sessions);
  const totalMax = Math.max(1, ...totals.map((t) => Math.max(t.minutes, t.lastMinutes, t.plannedMinutes)));

  const onEdit = (r: PlanEditResult) => show([r.message, ...r.warnings.map((x) => x.message)].join(' '), r.ok);

  return (
    <main className="page week-page">
      <div className="page-head week-head">
        <button className="arrow" title="Previous week" aria-label="Previous week" onClick={() => setWs(addDays(w.weekStart, -7))}>
          ‹
        </button>
        <h1>{weekRange(w.weekStart)}</h1>
        <button className="arrow" title="Next week" aria-label="Next week" onClick={() => setWs(addDays(w.weekStart, 7))}>
          ›
        </button>
        <span className="chip">{PHASE_LABEL[w.phase] ?? w.phase}</span>
        {w.deload && <span className="chip">Recovery week</span>}
        {w.preview && <span className="chip">Preview</span>}
        {w.nextRace && (
          <span className="chip">
            {w.nextRace.name} in {w.nextRace.daysOut} days
          </span>
        )}
        {ws && <button className="link week-today" onClick={() => setWs(null)}>This week</button>}
        <div className="right">
          <span>
            Planned load {w.plannedLoad}
            {w.cap != null ? ` · cap ${w.cap}` : ''}
          </span>
          <span>·</span>
          <SyncLine sync={nav.sync} />
        </div>
      </div>

      {(w.notes.length > 0 || weekWarnings.length > 0 || w.preview) && (
        <div className="week-notes">
          {w.preview && <span className="faint">Preview: this week is planned for real on its Monday, using how this week actually goes.</span>}
          {weekWarnings.map((x) => (
            <span key={x.message} className="warn-inline">
              <b>!</b> {x.message}
            </span>
          ))}
          {w.notes.map((n) => (
            <span key={n} className="muted">
              {n}
            </span>
          ))}
        </div>
      )}

      <div className="week-cols">
        {days.map((d) => {
          const list = w.sessions.filter((s) => s.date === d && s.status !== 'moved');
          const pl = planned(d);
          const actual = load.get(d) ?? 0;
          const v = verdict.get(d);
          return (
            <div key={d} className={`wcol${d === today ? ' today' : ''}`}>
              <div className="wcol-head">
                <span className="d">{weekdayShort(d)}</span>
                <span className="n">{Number(d.slice(8))}</span>
              </div>
              {dayWarnings(d).map((x) => (
                <div key={x.message} className="warnbox">
                  <b>!</b>
                  <span>{x.message}</span>
                </div>
              ))}
              <div className="wcol-cards">
                {list.map((s) => (
                  <SessionCard key={s.id} s={s} w={w} library={library.data ?? []} activity={s.matchedActivityId ? actById.get(s.matchedActivityId) : undefined} onEdit={onEdit} onOpen={nav.openActivity} />
                ))}
              </div>
              <div className="dayfoot">
                {d < today || d === today ? <span className="rv">{v ? VERDICT_WORD[v] : 'No readiness'}</span> : <span className="faint">{d === addDays(today, 1) ? 'Readiness tomorrow' : 'Readiness on the day'}</span>}
                <div className="lb" title={`Done ${Math.round(actual)} · planned ${Math.round(pl)}`}>
                  <span style={{ width: `${(Math.min(actual, loadMax) / loadMax) * 100}%` }} />
                  {pl > 0 && <i style={{ left: `${(pl / loadMax) * 100}%` }} />}
                </div>
                <span>{d <= today ? `Load ${Math.round(actual)} of ${Math.round(pl)}` : `Planned load ${Math.round(pl)}`}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="week-bottom">
        <section className="tile">
          <div className="label">Week totals · tick = last week</div>
          <div className="totals">
            {totals.length === 0 && <div className="faint">Nothing planned or done this week yet.</div>}
            {totals.map((t) => (
              <div key={t.sport} className={`trow s-${t.sport}`}>
                <span>{SPORT_NAME[t.sport]}</span>
                <div className="tbar">
                  <span style={{ width: `${(t.minutes / totalMax) * 100}%` }} />
                  {t.lastMinutes > 0 && <i style={{ left: `${(t.lastMinutes / totalMax) * 100}%` }} />}
                </div>
                <span className="r">
                  {t.minutes ? hoursMinutes(t.minutes * 60, { alwaysHours: true }) : `0 h 00 of ${hoursMinutes(t.plannedMinutes * 60, { alwaysHours: true })}`}
                  {t.sport === 'swim' && t.distanceKm > 0 ? ` · ${Math.round(t.distanceKm * 1000)} m` : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="tile">
          <div className="label">Changes this week</div>
          <ul className="changes">
            {w.changes.length === 0 && <li className="faint">No changes yet.</li>}
            {w.changes.slice(0, 6).map((c, i) => (
              <li key={i}>
                <span className="who">{c.actor === 'user' ? 'You' : 'Engine'}</span>
                <span>{c.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {toast}
    </main>
  );
}

function stateLine(s: PlanSessionView, a: ActivityItem | undefined): { cls: string; text: string } {
  if (s.status === 'done') return { cls: 'done', text: `✓ Done${a?.durationMin ? ` · ${Math.round(a.durationMin)} min` : ''}${a && a.durationMin && a.durationMin > s.durationMin * 1.15 ? ' · longer than planned' : ''}` };
  if (s.status === 'partial') return { cls: 'done', text: `◐ Partly done${a?.durationMin ? ` · ${Math.round(a.durationMin)} min` : ''}` };
  if (s.status === 'missed') return { cls: 'missed', text: '— Missed' };
  if (s.status === 'skipped') return { cls: 'missed', text: 'Skipped' };
  return { cls: '', text: '○ Planned' };
}

function SessionCard({
  s,
  w,
  library,
  activity,
  onEdit,
  onOpen,
}: {
  s: PlanSessionView;
  w: PlanWeekView;
  library: LibraryItem[];
  activity: ActivityItem | undefined;
  onEdit: (r: PlanEditResult) => void;
  onOpen: (id: number) => void;
}) {
  if (s.sport === 'rest') {
    return (
      <div className={`card rest-card${s.status === 'skipped' ? ' missed' : ''}`}>
        <div className="row1">
          <Icon name="rest" className="sport-ico tiny" /> Rest
        </div>
        <div className="t">Rest day</div>
        {!w.preview && <CardMenu s={s} w={w} library={library} onEdit={onEdit} />}
      </div>
    );
  }
  const commute = s.sessionKey === 'commute_ride';
  const st = stateLine(s, activity);
  const target = s.targets.hr ?? s.targets.swim ?? s.targets.rpe ?? INTENSITY_LABEL[s.intensity];
  const changes = w.changes.filter((c) => c.sessionId === s.id);
  const why = [...s.notes, ...changes.map((c) => c.reason)].filter((x, i, arr) => arr.indexOf(x) === i);
  return (
    <div className={`card s-${commute ? 'commute' : s.sport}${s.status === 'missed' || s.status === 'skipped' ? ' missed' : ''}`}>
      <div className="row1">
        <SportIcon sport={s.sport} size={14} />
        {SPORT_NAME[s.sport] ?? s.sport}
        {commute ? ' · fixed' : ''}
        {s.isKey && <span className="key-tag">Key</span>}
        {s.source === 'manual' && <span className="key-tag soft">Edited</span>}
      </div>
      <div className="t">{s.title}</div>
      <div className="meta">
        {s.durationMin} min · {target}
      </div>
      {activity ? (
        <button className={`state link-state ${st.cls}`} onClick={() => onOpen(activity.id)}>
          {st.text}
        </button>
      ) : (
        <div className={`state ${st.cls}`}>{st.text}</div>
      )}
      {(why.length > 0 || s.purpose) && (
        <Popover
          className="why"
          align="left"
          trigger={(toggle) => (
            <button className="link faint" onClick={toggle}>
              {changes.length ? 'Why did this change?' : 'Why this?'}
            </button>
          )}
        >
          {() => (
            <div className="why-pop">
              {s.purpose && <p>{s.purpose}</p>}
              {why.map((x) => (
                <p key={x} className="muted">
                  {x}
                </p>
              ))}
            </div>
          )}
        </Popover>
      )}
      {!w.preview && <CardMenu s={s} w={w} library={library} onEdit={onEdit} />}
    </div>
  );
}

type Picker = null | 'swap' | 'move' | 'change';

function CardMenu({ s, w, library, onEdit }: { s: PlanSessionView; w: PlanWeekView; library: LibraryItem[]; onEdit: (r: PlanEditResult) => void }) {
  const [picker, setPicker] = useState<Picker>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(w.weekStart, i));
  const others = w.sessions.filter((o) => o.id !== s.id && o.status !== 'moved' && o.status !== 'skipped');
  const lib = [...library].sort((a, b) => Number(b.sport === s.sport) - Number(a.sport === s.sport) || a.title.localeCompare(b.title));
  const run = async (close: () => void, p: Promise<PlanEditResult>) => {
    close();
    setPicker(null);
    onEdit(await p);
  };
  return (
    <Popover
      className="kebab-wrap"
      trigger={(toggle) => (
        <button
          className="kebab"
          aria-label={`Actions for ${s.title}`}
          onClick={() => {
            setPicker(null);
            toggle();
          }}
        >
          <Icon name="more" width={16} height={16} />
        </button>
      )}
    >
      {(close) =>
        picker === null ? (
          <>
            <button onClick={() => setPicker('swap')}>Swap with…</button>
            <button onClick={() => setPicker('move')}>Move to…</button>
            {s.sport !== 'rest' && <button onClick={() => setPicker('change')}>Change session…</button>}
            <hr />
            {s.status === 'skipped' ? (
              <button onClick={() => void run(close, api.plan.unskip(s.id))}>Put back</button>
            ) : (
              s.sport !== 'rest' && <button onClick={() => void run(close, api.plan.skip(s.id))}>Skip</button>
            )}
            <button onClick={() => void run(close, api.plan.makeRest(s.date))}>Make rest day</button>
          </>
        ) : picker === 'move' ? (
          <>
            <div className="menu-title">Move to</div>
            {days
              .filter((d) => d !== s.date)
              .map((d) => (
                <button key={d} onClick={() => void run(close, api.plan.move(s.id, d))}>
                  {weekdayShort(d)} {Number(d.slice(8))}
                </button>
              ))}
          </>
        ) : picker === 'swap' ? (
          <>
            <div className="menu-title">Swap with</div>
            {others.map((o) => (
              <button key={o.id} onClick={() => void run(close, api.plan.swap(s.id, o.id))}>
                {weekdayShort(o.date)} · {o.sport === 'rest' ? 'Rest day' : o.title}
              </button>
            ))}
          </>
        ) : (
          <div className="menu-scroll">
            <div className="menu-title">Change to</div>
            {lib.map((l) => (
              <button key={l.key} onClick={() => void run(close, api.plan.change(s.id, l.key))}>
                {l.isKey ? '★ ' : ''}
                {l.title}
                <span className="faint"> · {SPORT_NAME[l.sport] ?? l.sport}</span>
              </button>
            ))}
          </div>
        )
      }
    </Popover>
  );
}
