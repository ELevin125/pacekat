import type { ActivityDetail, PlanSessionView, PlanWeekView, ReadinessDay, SettingsView, SuggestionView, TimelineView } from '../../shared/api';
import { INTENSITY_LABEL, PHASE_LABEL, clock, daysBetween, distance, hoursMinutes, localTime, longDate, pace, relativeDay, resolveTarget, shortDate, weekdayShort } from '../../shared/format';
import { api, todayIso, useApi } from '../api';
import type { AppNav } from '../App';
import { Mark, SyncLine, useToast } from '../components/common';
import { SportIcon } from '../components/Icons';
import { FACTOR_LABEL, VERDICT_WORD, activeSessions, factorValue, phaseBars, pillState, readinessSentence, todaysSessions, weekProgress } from '../view';

export function TodayPage({ nav }: { nav: AppNav }) {
  const today = todayIso();
  const readiness = useApi(() => api.metrics.readiness(1));
  const week = useApi(() => api.plan.week());
  const accepted = useApi(() => api.plan.acceptedToday());
  const latestList = useApi(() => api.activities.list(1));
  const latestId = latestList.data?.[0]?.id;
  const latest = useApi(() => (latestId ? api.activities.detail(latestId) : Promise.resolve(null)), [latestId]);
  const brief = useApi(() => api.summaries.daily());
  const timeline = useApi(() => api.races.timeline());
  const settings = useApi(() => api.settings.get());
  const weekActs = useApi(() => (week.data ? api.activities.between(week.data.weekStart, today) : Promise.resolve([])), [week.data?.weekStart]);
  const [toast, show] = useToast();

  const day = readiness.data?.find((d) => d.date === today) ?? null;
  const w = week.data;
  const sub = w ? `${PHASE_LABEL[w.phase] ?? w.phase}${w.deload ? ' · recovery week' : ''}${w.mode === 'baseline' ? ' · building a baseline' : ''}` : '';

  return (
    <main className="page">
      <div className="page-head">
        <h1>{longDate(today)}</h1>
        <span className="sub">{sub}</span>
        <div className="right">
          <SyncLine sync={nav.sync} />
        </div>
      </div>

      <div className="bento">
        <ReadinessTile day={day} suggestion={w?.suggestion ?? null} accepted={accepted.data ?? null} onMsg={show} />
        <SessionTile week={w} today={today} accepted={accepted.data ?? null} settings={settings.data} />
        <RaceTile week={w} timeline={timeline.data} today={today} onAdd={() => nav.go('settings', 'races')} />
        <ActivityTile a={latest.data ?? null} today={today} onOpen={nav.openActivity} />
        <section className="tile t-brief">
          <div className="label">Daily brief</div>
          <div className="brief-text">{brief.data?.text ?? 'Your daily brief appears after the first sync.'}</div>
          <div className="brief-src">{brief.data ? `${brief.data.source === 'llm' ? 'AI summary' : 'Template summary'} · AI off` : ''}</div>
        </section>
        <WeekStrip week={w} today={today} doneMinutes={(weekActs.data ?? []).reduce((a, x) => a + (x.durationMin ?? 0), 0)} onOpen={() => nav.go('week')} />
      </div>
      {toast}
    </main>
  );
}

/* ---------------- readiness hero ---------------- */

function ReadinessTile({ day, suggestion, accepted, onMsg }: { day: ReadinessDay | null; suggestion: SuggestionView | null; accepted: SuggestionView | null; onMsg: (m: string, ok?: boolean) => void }) {
  if (!day) {
    return (
      <section className="tile t-ready">
        <div className="label">Readiness</div>
        <div className="verdict">
          <div className="big faint">—</div>
        </div>
        <p className="ready-sum">No readiness yet for today. It appears once your watch has synced last night's sleep and HRV.</p>
      </section>
    );
  }
  const order: Array<ReadinessDay['verdict']> = ['rest', 'easy', 'go'];
  const on = order.indexOf(day.verdict);
  return (
    <section className="tile t-ready">
      <div className="label">Readiness</div>
      <div className="verdict">
        <div className="big">{VERDICT_WORD[day.verdict]}</div>
        <div aria-hidden="true">
          <div className="meter">
            {order.map((_, i) => (
              <span key={i} className={i === on ? 'on' : ''} />
            ))}
          </div>
          <div className="meter-labels">
            {['Rest', 'Easy', 'Go'].map((l, i) => (
              <span key={l} className={i === on ? 'on' : ''}>
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="ready-sum">{readinessSentence(day)}</p>
      <ul className="factors">
        {day.factors.map((f) => (
          <li key={f.key} title={f.reason}>
            <Mark status={f.status} />
            <span className="name">{FACTOR_LABEL[f.key] ?? f.key}</span>
            <span className="val">{factorValue(f)}</span>
            <span className="why">{f.reason}</span>
          </li>
        ))}
      </ul>
      {suggestion && <SuggestionBox s={suggestion} onMsg={onMsg} />}
      {!suggestion && accepted && (
        <div className="suggest">
          <div className="what muted">
            Changed to <b className="fg">{accepted.changes.map((c) => c.after).join(', ')}</b>.{' '}
            <button
              className="link"
              onClick={async () => {
                const r = await api.plan.undoSuggestion(accepted.id);
                onMsg(r.message, r.ok);
              }}
            >
              Undo
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function SuggestionBox({ s, onMsg }: { s: SuggestionView; onMsg: (m: string, ok?: boolean) => void }) {
  const first = s.changes[0];
  const isRest = s.kind === 'readiness_rest';
  const title = isRest ? 'Take today as a rest day?' : first ? `Swap today's ${first.before.toLowerCase()} for ${first.after.replace(/ \(\d+ min\)$/, '').toLowerCase()}?` : 'Make today easier?';
  return (
    <div className="suggest">
      <div className="what">
        <div>
          <b>{title}</b>
        </div>
        <div className="muted">{s.reason}</div>
      </div>
      <div className="acts">
        <button
          className="btn"
          onClick={async () => {
            const r = await api.plan.dismissSuggestion(s.id);
            onMsg(r.message, r.ok);
          }}
        >
          Keep plan
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            const r = await api.plan.acceptSuggestion(s.id);
            onMsg([r.message, ...r.warnings.map((x) => x.message)].join(' '), r.ok);
          }}
        >
          {isRest ? 'Rest today' : 'Make it easy'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- today's session ---------------- */

function targetsFor(s: PlanSessionView, settings: SettingsView | undefined) {
  const t = { runThresholdSPerKm: settings?.runThresholdSPerKm, swimCssSPer100m: settings?.swimCssSPer100m };
  const hr = s.sport === 'strength' ? null : (s.targets.hr ?? INTENSITY_LABEL[s.intensity] ?? s.intensity);
  const third = s.targets.pace ? { v: resolveTarget(s.targets.pace, t), k: 'pace target' } : s.targets.swim ? { v: resolveTarget(s.targets.swim, t), k: 'swim target' } : s.targets.rpe ? { v: s.targets.rpe, k: 'RPE' } : null;
  return { hr, third };
}

function SessionTile({ week, today, accepted, settings }: { week: PlanWeekView | undefined; today: string; accepted: SuggestionView | null; settings: SettingsView | undefined }) {
  const { main, later } = week ? todaysSessions(week.sessions, today) : { main: null, later: [] };
  if (!main) {
    return (
      <section className="tile t-session s-other">
        <div className="sess-bar" />
        <div className="sess-head">
          <SportIcon sport="rest" />
          <span className="label">Today</span>
        </div>
        <div className="sess-title">Rest day</div>
        <div className="sess-purpose">Recovery is part of the plan: this is when the training sinks in. A walk is fine.</div>
      </section>
    );
  }
  const was = accepted?.changes.find((c) => c.sessionId === main.id)?.before;
  const { hr, third } = targetsFor(main, settings);
  const done = main.status === 'done' || main.status === 'partial';
  return (
    <section className={`tile t-session s-${main.sport}`}>
      <div className="sess-bar" />
      <div className="sess-head">
        <SportIcon sport={main.sport} />
        <span className="label">Today · {main.sport}</span>
        {main.isKey && <span className="key-tag">Key</span>}
        {done && <span className="chip done-chip">✓ {main.status === 'done' ? 'Done' : 'Partly done'}</span>}
      </div>
      <div className="sess-title">{main.title}</div>
      {was && <div className="sess-old">was: {was}</div>}
      <div className="sess-meta">
        <div>
          <span className="v">{main.durationMin} min</span>
          <span className="k">duration</span>
        </div>
        {hr && (
          <div>
            <span className="v">{hr}</span>
            <span className="k">heart rate</span>
          </div>
        )}
        {third && (
          <div>
            <span className="v">{third.v}</span>
            <span className="k">{third.k}</span>
          </div>
        )}
      </div>
      {main.purpose && <div className="sess-purpose">{main.purpose}</div>}
      {main.structure && (
        <div className="sess-structure">
          {main.structure.warmup && (
            <>
              <b>Warm-up</b>
              <span>{main.structure.warmup}</span>
            </>
          )}
          <b>Main</b>
          <span>{main.structure.main}</span>
          {main.structure.cooldown && (
            <>
              <b>Cool-down</b>
              <span>{main.structure.cooldown}</span>
            </>
          )}
        </div>
      )}
      {later.map((l) => (
        <div key={l.id} className={`sess-also s-${l.sport}`}>
          <SportIcon sport={l.sport} />
          <span>
            Later: <b className="fg">{l.title}</b> · {l.durationMin} min{l.targets.swim || l.targets.hr ? ` · ${l.targets.swim ?? l.targets.hr}` : ''}
          </span>
        </div>
      ))}
    </section>
  );
}

/* ---------------- next race ---------------- */

function RaceTile({ week, timeline, today, onAdd }: { week: PlanWeekView | undefined; timeline: TimelineView | undefined; today: string; onAdd: () => void }) {
  const race = week?.nextRace;
  if (!race) {
    return (
      <section className="tile t-race">
        <div className="label">Next race</div>
        <div className="race-none">No race set. The plan keeps you fit in maintain mode until you add one.</div>
        <div>
          <button className="btn" onClick={onAdd}>
            Add a race
          </button>
        </div>
      </section>
    );
  }
  const days = daysBetween(today, race.date);
  const bars = timeline && race.priority === 'A' ? phaseBars(timeline, race.date) : [];
  return (
    <section className="tile t-race">
      <div className="label">Next race · {race.priority}</div>
      <div className="race-name">{race.name}</div>
      <div className="race-days">
        {days}
        <small>{days === 1 ? 'day' : 'days'}</small>
      </div>
      <div className="muted race-when">
        {shortDate(race.date)} · {(PHASE_LABEL[week!.phase] ?? week!.phase).toLowerCase()} phase
      </div>
      {bars.length > 0 && (
        <>
          <div className="phase-line">
            {bars.map((b, i) => (
              <span key={i} className={b.state === 'future' ? '' : b.state} style={{ flex: b.days }} />
            ))}
          </div>
          <div className="phase-names">
            {bars.map((b, i) => (
              <span key={i} style={{ flex: b.days }}>
                {PHASE_LABEL[b.phase] ?? b.phase}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------- latest activity ---------------- */

export function activityNumbers(a: ActivityDetail): Array<{ v: string; k: string }> {
  const secs = a.movingS ?? a.durationS;
  const out: Array<{ v: string; k: string }> = [];
  if (a.sport === 'swim') {
    out.push({ v: distance(a.distanceM, 'swim').replace(' m', ''), k: 'm' }, { v: clock(secs), k: 'time' }, { v: pace(a.swimPaceSPer100m), k: '/100 m' });
  } else if (a.sport === 'run') {
    out.push({ v: a.distanceM ? (a.distanceM / 1000).toFixed(2) : '—', k: 'km' }, { v: clock(secs), k: 'time' }, { v: pace(a.avgPaceSPerKm), k: '/km' });
  } else if (a.sport === 'bike' || a.sport === 'other') {
    out.push({ v: a.distanceM ? (a.distanceM / 1000).toFixed(1) : '—', k: 'km' }, { v: clock(secs), k: 'time' });
    if (a.sport === 'bike' && a.distanceM && secs) out.push({ v: ((a.distanceM / secs) * 3.6).toFixed(1), k: 'km/h' });
  } else {
    out.push({ v: clock(secs), k: 'time' });
    if (a.load != null) out.push({ v: String(Math.round(a.load)), k: 'load' });
  }
  if (a.avgHr) out.push({ v: String(a.avgHr), k: 'avg HR' });
  return out;
}

export function ZoneBar({ a }: { a: ActivityDetail }) {
  const zones = a.zones;
  const total = zones?.reduce((s, z) => s + z.seconds, 0) ?? 0;
  if (!zones || !total) return null;
  const top = zones.reduce((m, z) => (z.seconds > m.seconds ? z : m), zones[0]!);
  return (
    <>
      <div className="zones" aria-label="Time in heart-rate zones">
        {zones.map((z, i) => (
          <span key={z.zone} style={{ flex: z.seconds, opacity: [0.35, 0.55, 0.8, 1, 1][i] }} title={`Z${z.zone}: ${clock(z.seconds)}`} />
        ))}
      </div>
      <div className="zone-key">
        <span>HR zones Z1 → Z5</span>
        <span>mostly Z{top.zone}</span>
      </div>
    </>
  );
}

function ActivityTile({ a, today, onOpen }: { a: ActivityDetail | null; today: string; onOpen: (id: number) => void }) {
  if (!a) {
    return (
      <section className="tile t-activity">
        <div className="label">Latest activity</div>
        <div className="race-none">No activities yet. They show up here after your next sync.</div>
      </section>
    );
  }
  const when = `${relativeDay(a.date, today)}${a.startUtc ? ` ${localTime(a.startUtc)}` : ''}`;
  return (
    <section className={`tile t-activity s-${a.isCommute ? 'commute' : a.sport}`} onClick={() => onOpen(a.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(a.id)}>
      <div className="sess-head">
        <SportIcon sport={a.sport} />
        <span className="label">Latest · {when}</span>
        {a.needsRpe && (
          <button
            className="btn rpe-ask"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(a.id);
            }}
          >
            Add RPE
          </button>
        )}
      </div>
      <div className="act-title">{a.isCommute ? 'Commute' : (a.name ?? a.subSport ?? a.sport)}</div>
      <div className="act-nums">
        {activityNumbers(a).map((n) => (
          <div key={n.k}>
            <span className="v">{n.v}</span>
            <span className="k">{n.k}</span>
          </div>
        ))}
      </div>
      <ZoneBar a={a} />
      <div className="act-sum">{a.summary.text}</div>
    </section>
  );
}

/* ---------------- week strip ---------------- */

function WeekStrip({ week, today, doneMinutes, onOpen }: { week: PlanWeekView | undefined; today: string; doneMinutes: number; onOpen: () => void }) {
  if (!week) return <section className="tile t-week" />;
  const prog = weekProgress(week.sessions, doneMinutes);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${week.weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  return (
    <section className="tile t-week">
      <div className="strip-head">
        <span className="label">This week</span>
        <span className="muted">
          {prog.done} of {prog.total} sessions done · {hoursMinutes(prog.doneMinutes * 60, { alwaysHours: true })} of {hoursMinutes(prog.plannedMinutes * 60, { alwaysHours: true })}
        </span>
        <button className="link strip-open" onClick={onOpen}>
          Open week
        </button>
      </div>
      <div className="strip">
        {days.map((d) => {
          const list = week.sessions.filter((s) => s.date === d && s.status !== 'moved');
          const shown = activeSessions(list).length ? list.filter((s) => s.status !== 'skipped') : list;
          return (
            <div key={d} className={`day${d === today ? ' today' : ''}`}>
              <div className="dname">
                <span>{weekdayShort(d)}</span>
                <span>{Number(d.slice(8))}</span>
              </div>
              {shown.map((s) => {
                const st = pillState(s);
                const commute = s.sessionKey === 'commute_ride';
                return (
                  <div key={s.id} className={`pill ${st}${commute ? ' commute' : ''} s-${commute ? 'commute' : s.sport}`} title={`${s.title} · ${s.status}`}>
                    {s.sport === 'rest' ? 'Rest' : commute ? 'Commute' : s.title}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="strip-foot">
        <span>Filled = done · outline = planned · struck = missed</span>
        <span className="legend">
          {['swim', 'bike', 'run', 'strength'].map((s) => (
            <span key={s}>
              <i style={{ background: `var(--sport-${s})` }} />
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
          ))}
        </span>
      </div>
    </section>
  );
}
