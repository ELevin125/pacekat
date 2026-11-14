import { ipcMain } from 'electron';
import { IPC, type ActivityItem, type DailyMetric, type MetricsSummary, type ReadinessDay, type Result } from '../../shared/api';
import type { DB } from '../db';
import { addDays, localToday } from '../util/dates';
import { recomputeMetrics } from '../metrics/recompute';

export interface MetricsIpcContext {
  db: DB;
  fitDir: string;
  timeZone: string;
  log: (msg: string) => void;
  /** Runs after every recompute (e.g. the plan service's matching and adaptation). */
  afterRecompute?: (today: string) => void;
}

/** Activities as list items, most recent first. `where` is a trusted SQL fragment over alias `a`. */
export function listActivities(db: DB, where: string, params: unknown[], limit: number): ActivityItem[] {
  const lim = Math.min(Math.max(limit, 1), 500);
  const rows = db
    .prepare(
      `SELECT a.*,
         (SELECT value FROM activity_extras e WHERE e.activity_id = a.id AND e.key = 'needs_rpe') AS needs_rpe,
         (SELECT value FROM activity_extras e WHERE e.activity_id = a.id AND e.key = 'load_reasons') AS load_reasons
       FROM activities a WHERE ${where} ORDER BY a.start_utc DESC, a.id DESC LIMIT ?`,
    )
    .all(...params, lim) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    date: String(r.local_date),
    name: (r.name as string | null) ?? null,
    sport: String(r.sport),
    subSport: (r.sub_sport as string | null) ?? null,
    durationMin: r.duration_s == null ? null : Math.round(Number(r.duration_s) / 6) / 10,
    distanceKm: r.distance_m == null ? null : Math.round(Number(r.distance_m) / 10) / 100,
    avgHr: (r.avg_hr as number | null) ?? null,
    load: (r.load as number | null) ?? null,
    loadMethod: (r.load_method as string | null) ?? null,
    loadReasons: r.load_reasons ? (JSON.parse(String(r.load_reasons)) as string[]) : [],
    needsRpe: r.needs_rpe === '1',
    rpe: (r.rpe as number | null) ?? null,
    isCommute: r.is_commute === 1,
    commuteSource: (r.commute_source as ActivityItem['commuteSource']) ?? null,
  }));
}

/** Registers metrics + activity handlers. Returns the recompute function for sync/startup. */
export function registerMetricsIpc(ctx: MetricsIpcContext): () => MetricsSummary {
  const { db } = ctx;
  let last: MetricsSummary | null = null;

  const recompute = (): MetricsSummary => {
    const t0 = Date.now();
    const today = localToday(ctx.timeZone);
    last = recomputeMetrics(db, ctx.fitDir, today);
    try {
      ctx.afterRecompute?.(today);
    } catch (err) {
      ctx.log(`plan update failed: ${(err as Error).message}`);
    }
    ctx.log(`metrics recomputed in ${Date.now() - t0} ms (${last.activities} activities, k=${last.k.toFixed(2)}${last.kCalibrated ? '' : ' default'})`);
    return last;
  };

  const clampDays = (d: unknown) => Math.min(Math.max(Number(d) || 30, 1), 400);

  ipcMain.handle(IPC.metricsSummary, (): MetricsSummary => last ?? recompute());

  ipcMain.handle(IPC.metricsReadiness, (_e, days: unknown): ReadinessDay[] => {
    const from = addDays(localToday(ctx.timeZone), -(clampDays(days) - 1));
    const rows = db.prepare('SELECT local_date, verdict, factors_json FROM readiness WHERE local_date >= ? ORDER BY local_date DESC').all(from) as Array<{
      local_date: string;
      verdict: ReadinessDay['verdict'];
      factors_json: string;
    }>;
    return rows.map((r) => {
      const f = JSON.parse(r.factors_json) as { summary: string; factors: ReadinessDay['factors']; acwr: number | null };
      return { date: r.local_date, verdict: r.verdict, summary: f.summary, factors: f.factors, acwr: f.acwr };
    });
  });

  ipcMain.handle(IPC.metricsDaily, (_e, days: unknown): DailyMetric[] => {
    const from = addDays(localToday(ctx.timeZone), -(clampDays(days) - 1));
    return (db.prepare('SELECT local_date, load, acute, chronic, acwr, band FROM daily_metrics WHERE local_date >= ? ORDER BY local_date DESC').all(from) as Array<Record<string, number | string | null>>).map((r) => ({
      date: String(r.local_date),
      load: Number(r.load),
      acute: Number(r.acute),
      chronic: Number(r.chronic),
      acwr: r.acwr == null ? null : Number(r.acwr),
      band: String(r.band),
    }));
  });

  ipcMain.handle(IPC.activitiesList, (_e, limit: unknown): ActivityItem[] => listActivities(db, '1 = 1', [], Number(limit) || 50));

  ipcMain.handle(IPC.activitiesSetRpe, (_e, id: unknown, rpe: unknown): Result => {
    const aid = Number(id);
    if (!Number.isInteger(aid)) return { ok: false, message: 'Unknown activity.' };
    if (rpe !== null && !(Number.isInteger(rpe) && (rpe as number) >= 1 && (rpe as number) <= 10)) {
      return { ok: false, message: 'RPE must be a whole number from 1 to 10.' };
    }
    const r = db.prepare('UPDATE activities SET rpe = ? WHERE id = ?').run(rpe, aid);
    if (!r.changes) return { ok: false, message: 'Unknown activity.' };
    recompute();
    return { ok: true, message: rpe === null ? 'RPE cleared.' : `RPE ${rpe} saved.` };
  });

  ipcMain.handle(IPC.activitiesSetCommute, (_e, id: unknown, value: unknown): Result => {
    const aid = Number(id);
    if (!Number.isInteger(aid)) return { ok: false, message: 'Unknown activity.' };
    if (value !== null && typeof value !== 'boolean') return { ok: false, message: 'Invalid value.' };
    const r =
      value === null
        ? db.prepare(`UPDATE activities SET commute_source = NULL WHERE id = ?`).run(aid) // auto re-detects on recompute
        : db.prepare(`UPDATE activities SET is_commute = ?, commute_source = 'manual' WHERE id = ?`).run(value ? 1 : 0, aid);
    if (!r.changes) return { ok: false, message: 'Unknown activity.' };
    recompute();
    return { ok: true, message: value === null ? 'Commute back to automatic.' : value ? 'Marked as commute.' : 'Marked as not a commute.' };
  });

  return recompute;
}
