import { useEffect } from 'react';
import type { ActivityDetail } from '../../shared/api';
import { INTENSITY_LABEL, clock, distance, groupThousands, localTime, pace, shortDate } from '../../shared/format';
import { api, useApi } from '../api';
import { SportIcon } from './Icons';
import { Switch, useToast } from './common';

/** Slide-in activity detail (docs/ui.md "Activity drawer"). */
export function Drawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const detail = useApi(() => (id ? api.activities.detail(id) : Promise.resolve(null)), [id]);
  const [toast, show] = useToast();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const a = id ? detail.data : null;
  return (
    <div className={id ? 'drawer-open' : ''}>
      <div className="scrim" onClick={onClose} />
      <aside className={`drawer s-${a?.isCommute ? 'commute' : (a?.sport ?? 'other')}`} aria-hidden={!id} aria-label="Activity detail">
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {a && <DrawerBody a={a} onMsg={show} />}
        {id && detail.data === null && <p className="muted">That activity no longer exists.</p>}
      </aside>
      {toast}
    </div>
  );
}

function DrawerBody({ a, onMsg }: { a: ActivityDetail; onMsg: (m: string, ok?: boolean) => void }) {
  const secs = a.movingS ?? a.durationS;
  const tiles: Array<[string, string]> = [];
  if (a.distanceM) tiles.push([distance(a.distanceM, a.sport), 'distance']);
  tiles.push([clock(secs), a.movingS ? 'moving time' : 'time']);
  if (a.sport === 'swim' && a.swimPaceSPer100m) tiles.push([pace(a.swimPaceSPer100m), 'avg /100 m']);
  if (a.sport === 'run' && a.avgPaceSPerKm) tiles.push([pace(a.avgPaceSPerKm), 'avg /km']);
  if (a.sport === 'bike' && a.distanceM && secs) tiles.push([((a.distanceM / secs) * 3.6).toFixed(1), 'avg km/h']);
  if (a.avgHr) tiles.push([String(a.avgHr), 'avg HR']);
  if (a.swolf) tiles.push([String(Math.round(a.swolf)), 'avg SWOLF']);
  if (a.avgCadence && a.sport === 'run') tiles.push([String(Math.round(a.avgCadence)), 'cadence (spm)']);
  if (a.avgPower) tiles.push([String(Math.round(a.avgPower)), 'avg power (W)']);
  if (a.elevationGainM && a.sport !== 'swim') tiles.push([`${Math.round(a.elevationGainM)} m`, 'climb']);
  if (a.load != null) tiles.push([String(Math.round(a.load)), a.loadMethod?.startsWith('srpe') ? 'load (from RPE)' : 'load (TRIMP)']);

  const where = [a.sport === 'swim' ? (a.isOpenWater ? 'Open water' : a.poolLengthM ? `Pool ${a.poolLengthM} m` : 'Pool') : null, a.planned ? `matched to ${shortDate(a.date)}'s plan` : 'not on the plan'].filter(Boolean).join(' · ');
  const zoneTotal = a.zones?.reduce((s, z) => s + z.seconds, 0) ?? 0;
  const zoneMax = Math.max(1, ...(a.zones ?? []).map((z) => z.seconds));

  return (
    <>
      <div className="sess-head">
        <SportIcon sport={a.sport} />
        <span className="label">
          {a.subSport?.replace(/_/g, ' ') ?? a.sport} · {shortDate(a.date)}
          {a.startUtc ? ` · ${localTime(a.startUtc)}` : ''}
        </span>
      </div>
      <h2>{a.isCommute ? 'Commute' : (a.name ?? a.sport)}</h2>
      <div className="muted">{where}</div>
      <div className="dgrid">
        {tiles.slice(0, 9).map(([v, k]) => (
          <div key={k}>
            <div className="v">{v}</div>
            <div className="k">{k}</div>
          </div>
        ))}
      </div>

      <div className="section">
        <h3>Summary</h3>
        <div>{a.summary.text}</div>
      </div>

      {a.planned && (
        <div className="section">
          <h3>Planned vs done</h3>
          <div className="pvd">
            <div>
              <div className="faint">Planned</div>
              {a.planned.title} · {a.planned.durationMin} min · {a.planned.targets.hr ?? a.planned.targets.swim ?? INTENSITY_LABEL[a.planned.intensity] ?? a.planned.intensity}
            </div>
            <div>
              <div className="faint">Done</div>
              {Math.round((secs ?? 0) / 60)} min · {a.planned.status === 'done' ? 'counts as done' : a.planned.status === 'partial' ? 'partly done' : a.planned.status}
              {secs && a.planned.durationMin && secs / 60 > a.planned.durationMin * 1.15 ? ' · longer than planned' : ''}
            </div>
          </div>
        </div>
      )}

      {a.zones && zoneTotal > 0 && (
        <div className="section">
          <h3>Heart rate zones</h3>
          {a.zones.map((z, i) => (
            <div key={z.zone} className="zrow">
              <span>Z{z.zone}</span>
              <div className="zb" style={{ width: `${(z.seconds / zoneMax) * 100}%`, opacity: [0.35, 0.55, 0.8, 1, 1][i] }} title={`${z.minBpm}–${z.maxBpm} bpm`} />
              <span className="muted">{clock(z.seconds)}</span>
            </div>
          ))}
        </div>
      )}

      {a.laps.length > 1 && <Laps a={a} />}

      <div className="section">
        <h3>How hard did it feel? (RPE)</h3>
        <div className="rpe" role="radiogroup" aria-label="RPE">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              role="radio"
              aria-checked={a.rpe === n}
              className={a.rpe === n ? 'on' : ''}
              onClick={async () => {
                const r = await api.activities.setRpe(a.id, a.rpe === n ? null : n);
                onMsg(r.message, r.ok);
              }}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="faint small-note">
          1 = very easy, 10 = all-out. {a.needsRpe ? 'This activity needs one: its load is an estimate until you add it.' : 'Used for load when heart rate is unreliable (pool swims, strength).'}
        </div>
      </div>

      {a.sport === 'bike' && (
        <div className="section">
          <div className="toggle">
            <span>
              Commute
              <span className="faint"> · {a.commuteSource === 'manual' ? 'set by you' : 'detected automatically'}</span>
            </span>
            <Switch
              on={a.isCommute}
              label="Commute"
              onChange={async (v) => {
                const r = await api.activities.setCommute(a.id, v);
                onMsg(r.message, r.ok);
              }}
            />
          </div>
          {a.commuteSource === 'manual' && (
            <button
              className="link faint small-note"
              onClick={async () => {
                const r = await api.activities.setCommute(a.id, null);
                onMsg(r.message, r.ok);
              }}
            >
              Go back to automatic detection
            </button>
          )}
        </div>
      )}

      {a.loadReasons.length > 0 && (
        <div className="section">
          <h3>About the load</h3>
          <div className="muted">{a.loadReasons.join(' ')}</div>
        </div>
      )}
    </>
  );
}

function Laps({ a }: { a: ActivityDetail }) {
  const swim = a.sport === 'swim';
  return (
    <div className="section">
      <h3>{swim ? 'Intervals' : 'Laps'}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Distance</th>
              <th>Time</th>
              {swim ? <th>/100 m</th> : a.sport === 'run' ? <th>/km</th> : a.sport === 'bike' ? <th>km/h</th> : null}
              {swim ? <th>SWOLF</th> : <th>HR</th>}
            </tr>
          </thead>
          <tbody>
            {a.laps.map((l) => (
              <tr key={l.index}>
                <td>{l.index}</td>
                <td>{l.distanceM ? (swim ? `${groupThousands(Math.round(l.distanceM))} m` : distance(l.distanceM)) : '—'}</td>
                <td>{clock(l.durationS)}</td>
                {swim ? <td>{pace(l.swimPaceSPer100m)}</td> : a.sport === 'run' ? <td>{pace(l.paceSPerKm)}</td> : a.sport === 'bike' ? <td>{l.speedKmh ? l.speedKmh.toFixed(1) : '—'}</td> : null}
                {swim ? <td>{l.swolf ? Math.round(l.swolf) : '—'}</td> : <td>{l.avgHr ?? '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
