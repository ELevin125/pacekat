import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, type DB } from '../db';
import type { GarminResponse } from '../garmin/client';
import { GarminAuthError, GarminNetworkError } from '../garmin/client';
import { activities as activityEndpoints, rangeEndpoints, staticEndpoints, type DateStr, type RequestSpec } from '../garmin/endpoints';
import { addDays, chunkRange, daysBetween, eachDay, localToday } from '../util/dates';
import { extractActivityFiles } from '../garmin/activity-file';
import type { SyncProgress, SyncResult, SyncStateRow } from '../../shared/api';
import { DAILY_DATA_TYPES, splitByDay, type DailyDataType } from './split';
import { mapActivitySummary, type ActivityRow } from './activities';
import { parseFitFacts } from './fit';
import { deriveDailyHealth } from './derive';

/** Days of history on first run (28-day chronic load + baselines need it). */
export const BACKFILL_DAYS = 90;
/** Re-fetch this many days before the last synced day: Garmin data for recent days changes after late watch syncs. */
export const OVERLAP_DAYS = 2;

export interface GarminGetter {
  get(spec: RequestSpec, accept?: 'json' | 'bytes'): Promise<GarminResponse>;
  ensureToken(force?: boolean): Promise<string>;
}

export interface SyncDeps {
  db: DB;
  client: GarminGetter;
  fitDir: string;
  timeZone: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

type Progress = (p: SyncProgress) => void;

export class SyncService {
  private running = false;

  constructor(private readonly deps: SyncDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(opts: { full?: boolean } = {}, onProgress: Progress = () => {}): Promise<SyncResult> {
    if (this.running) {
      return { ok: false, message: 'A sync is already running.', from: '', to: '', newActivities: 0, errors: [] };
    }
    this.running = true;
    try {
      return await this.runInner(opts, onProgress);
    } finally {
      this.running = false;
    }
  }

  private async runInner(opts: { full?: boolean }, progress: Progress): Promise<SyncResult> {
    const { db, client, timeZone } = this.deps;
    const today = localToday(timeZone, this.deps.now?.() ?? new Date());
    const earliest = addDays(today, -(BACKFILL_DAYS - 1));
    const errors: string[] = [];
    const touchedDates = new Set<string>();

    progress({ phase: 'starting', message: 'Connecting to Garmin…', done: 0, total: 1 });
    try {
      await client.ensureToken();
    } catch (err) {
      const msg = err instanceof GarminAuthError || err instanceof GarminNetworkError ? err.message : `Could not reach Garmin: ${(err as Error).message}`;
      progress({ phase: 'error', message: msg, done: 0, total: 1 });
      return { ok: false, message: msg, from: earliest, to: today, newActivities: 0, errors: [msg] };
    }

    const fromFor = (type: string): DateStr => {
      if (opts.full) return earliest;
      const last = this.state(type)?.lastSyncedDate;
      if (!last) return earliest;
      const from = addDays(last, -OVERLAP_DAYS);
      return daysBetween(earliest, from) < 0 ? earliest : from;
    };
    const overallFrom = [...DAILY_DATA_TYPES, 'activities'].map(fromFor).sort()[0] ?? earliest;

    // 1. Profile: settings + HR zones.
    progress({ phase: 'profile', message: 'Profile and heart-rate zones', done: 0, total: staticEndpoints.length });
    for (const [i, ep] of staticEndpoints.entries()) {
      try {
        const body = await this.getJson(ep.build());
        db.prepare(
          `INSERT INTO raw_static (data_type, raw_json, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT (data_type) DO UPDATE SET raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`,
        ).run(ep.name, JSON.stringify(body), nowIso());
        if (ep.name === 'hr-zones') this.saveHrZones(body);
        this.setState(ep.name, today, null);
      } catch (err) {
        if (err instanceof GarminAuthError || err instanceof GarminNetworkError) return this.abort(err, earliest, today, errors);
        errors.push(this.recordError(ep.name, err));
      }
      progress({ phase: 'profile', message: ep.name, done: i + 1, total: staticEndpoints.length });
    }

    // 2. Daily health data, chunked to each endpoint's range limit.
    const plan = DAILY_DATA_TYPES.map((type) => {
      const ep = rangeEndpoints.find((e) => e.name === type)!;
      return { type, ep, chunks: chunkRange(fromFor(type), today, ep.maxDays) };
    });
    const totalChunks = plan.reduce((s, p) => s + p.chunks.length, 0);
    let doneChunks = 0;
    const upsertRaw = db.prepare(
      `INSERT INTO raw_daily (data_type, local_date, raw_json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (data_type, local_date) DO UPDATE SET raw_json = excluded.raw_json, fetched_at = excluded.fetched_at`,
    );
    for (const { type, ep, chunks } of plan) {
      let failed = false;
      for (const [a, b] of chunks) {
        progress({ phase: 'daily', message: `${label(type)} ${a} → ${b}`, done: doneChunks, total: totalChunks });
        try {
          const items = splitByDay(type as DailyDataType, await this.getJson(ep.build(a, b)));
          db.transaction(() => {
            for (const { date, item } of items) {
              upsertRaw.run(type, date, JSON.stringify(item), nowIso());
              touchedDates.add(date);
            }
          })();
        } catch (err) {
          if (err instanceof GarminAuthError || err instanceof GarminNetworkError) return this.abort(err, earliest, today, errors);
          errors.push(this.recordError(type, err));
          failed = true;
          break; // keep last_synced_date where it was so the gap is retried next time
        }
        doneChunks++;
      }
      if (!failed) this.setState(type, today, null);
    }

    // 3. Activities: list, upsert, fetch detail for new ones.
    const actFrom = fromFor('activities');
    const newIds: string[] = [];
    let activitiesOk = true;
    try {
      for (let start = 0; ; start += activityEndpoints.pageSize) {
        progress({ phase: 'activities', message: `Activities ${actFrom} → ${today}`, done: start, total: start + activityEndpoints.pageSize });
        const body = await this.getJson(activityEndpoints.search(actFrom, today, start, activityEndpoints.pageSize));
        if (!Array.isArray(body)) throw new Error('activity search: expected an array');
        for (const a of body) {
          const row = mapActivitySummary(a as Record<string, unknown>, timeZone);
          if (!row) {
            const id = (a as { activityId?: unknown } | null)?.activityId;
            errors.push(this.recordError('activities', new Error('skipped: missing id or start time'), `activity ${String(id ?? '?')}`));
            continue;
          }
          if (this.upsertActivity(row)) newIds.push(row.garmin_activity_id);
        }
        if (body.length < activityEndpoints.pageSize) break;
      }
    } catch (err) {
      if (err instanceof GarminAuthError || err instanceof GarminNetworkError) return this.abort(err, earliest, today, errors);
      errors.push(this.recordError('activities', err));
      activitiesOk = false;
    }

    // 4. Detail + original file for new activities, and retry files that failed before.
    const needFiles = db
      .prepare(`SELECT garmin_activity_id FROM activities WHERE fit_path IS NULL AND (fit_status IS NULL OR fit_status = 'error') ORDER BY start_utc`)
      .all() as Array<{ garmin_activity_id: string }>;
    const work = [...new Set([...newIds, ...needFiles.map((r) => r.garmin_activity_id)])];
    mkdirSync(this.deps.fitDir, { recursive: true });
    for (const [i, id] of work.entries()) {
      progress({ phase: 'files', message: `Activity file ${i + 1} of ${work.length}`, done: i, total: work.length });
      try {
        if (newIds.includes(id)) {
          const detail = await this.getJson(activityEndpoints.detail(id));
          db.prepare('UPDATE activities SET detail_json = ?, updated_at = ? WHERE garmin_activity_id = ?').run(JSON.stringify(detail), nowIso(), id);
        }
        await this.fetchActivityFile(id);
      } catch (err) {
        if (err instanceof GarminAuthError || err instanceof GarminNetworkError) return this.abort(err, earliest, today, errors);
        errors.push(this.recordError('activities', err, `activity ${id}`));
        db.prepare(`UPDATE activities SET fit_status = 'error', updated_at = ? WHERE garmin_activity_id = ?`).run(nowIso(), id);
      }
    }
    if (activitiesOk) this.setState('activities', today, errors.some((e) => e.startsWith('activities')) ? 'Some activity files failed; will retry.' : null);

    // 5. Derive daily_health for every day we touched (plus the overlap window).
    progress({ phase: 'derive', message: 'Updating daily health', done: 0, total: 1 });
    for (const d of eachDay(overallFrom, today)) touchedDates.add(d);
    deriveDailyHealth(db, touchedDates);

    const finishedAt = nowIso();
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('last_sync_finished_at', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(finishedAt), finishedAt);

    const ok = errors.length === 0;
    const message = ok
      ? `Synced ${overallFrom} → ${today}. ${newIds.length} new ${newIds.length === 1 ? 'activity' : 'activities'}.`
      : `Synced with ${errors.length} problem${errors.length === 1 ? '' : 's'}. ${newIds.length} new activities.`;
    progress({ phase: 'done', message, done: 1, total: 1 });
    return { ok, message, from: overallFrom, to: today, newActivities: newIds.length, errors };
  }

  states(): SyncStateRow[] {
    return (this.deps.db.prepare('SELECT * FROM sync_state ORDER BY data_type').all() as Array<Record<string, string | null>>).map(toStateRow);
  }

  private state(type: string): SyncStateRow | null {
    const r = this.deps.db.prepare('SELECT * FROM sync_state WHERE data_type = ?').get(type) as Record<string, string | null> | undefined;
    return r ? toStateRow(r) : null;
  }

  private setState(type: string, lastSyncedDate: string | null, error: string | null): void {
    this.deps.db
      .prepare(
        `INSERT INTO sync_state (data_type, last_synced_date, last_run_at, last_error) VALUES (?, ?, ?, ?)
         ON CONFLICT (data_type) DO UPDATE SET
           last_synced_date = COALESCE(excluded.last_synced_date, sync_state.last_synced_date),
           last_run_at = excluded.last_run_at, last_error = excluded.last_error`,
      )
      .run(type, lastSyncedDate, nowIso(), error);
  }

  private recordError(type: string, err: unknown, context?: string): string {
    const msg = `${type}${context ? ` (${context})` : ''}: ${(err as Error).message}`;
    this.deps.log?.(`sync error — ${msg}`);
    this.setState(type, null, (err as Error).message.slice(0, 500));
    return msg;
  }

  /** Stop the whole sync: no point hitting every endpoint when the key is dead or we're offline. */
  private abort(err: Error, from: string, to: string, errors: string[]): SyncResult {
    return { ok: false, message: err.message, from, to, newActivities: 0, errors: [...errors, err.message] };
  }

  private async getJson(spec: RequestSpec): Promise<unknown> {
    const res = await this.deps.client.get(spec, 'json');
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new GarminAuthError(`Garmin refused access (HTTP ${res.status}). The key may have expired or been revoked.`, res.status);
      throw new Error(`HTTP ${res.status} from ${spec.path}`);
    }
    return res.json ?? null;
  }

  /** Insert or update Garmin-sourced columns; never touches rpe, commute flags or load. Returns true if new. */
  private upsertActivity(row: ActivityRow): boolean {
    const { db } = this.deps;
    const exists = db.prepare('SELECT id FROM activities WHERE garmin_activity_id = ?').get(row.garmin_activity_id);
    const cols = Object.keys(row) as Array<keyof ActivityRow>;
    if (exists) {
      db.prepare(
        `UPDATE activities SET ${cols.filter((c) => c !== 'garmin_activity_id').map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at
         WHERE garmin_activity_id = @garmin_activity_id`,
      ).run({ ...row, updated_at: nowIso() });
      return false;
    }
    db.prepare(`INSERT INTO activities (${cols.join(', ')}, updated_at) VALUES (${cols.map((c) => '@' + c).join(', ')}, @updated_at)`).run({
      ...row,
      updated_at: nowIso(),
    });
    return true;
  }

  private async fetchActivityFile(garminId: string): Promise<void> {
    const { db, fitDir } = this.deps;
    const res = await this.deps.client.get(activityEndpoints.file(garminId), 'bytes');
    const setFile = db.prepare(
      'UPDATE activities SET fit_path = ?, fit_status = ?, fit_parsed_at = ?, updated_at = ? WHERE garmin_activity_id = ?',
    );
    if (!res.ok || !res.bytes) {
      if (res.status === 401 || res.status === 403) throw new GarminAuthError(`Garmin refused access (HTTP ${res.status}).`, res.status);
      setFile.run(null, 'missing', null, nowIso(), garminId);
      if (res.status !== 404) throw new Error(`HTTP ${res.status} downloading file`);
      return;
    }
    const files = extractActivityFiles(res.bytes, garminId);
    const fit = files.find((f) => f.ext === 'fit');
    if (!fit) {
      const other = files[0];
      if (other) writeFileSync(join(fitDir, `${garminId}.${other.ext || 'bin'}`), other.bytes);
      setFile.run(null, 'not_fit', nowIso(), nowIso(), garminId);
      return;
    }
    const fileName = `${garminId}.fit`;
    writeFileSync(join(fitDir, fileName), fit.bytes);
    const facts = parseFitFacts(fit.bytes);
    const activity = db.prepare('SELECT id FROM activities WHERE garmin_activity_id = ?').get(garminId) as { id: number };
    const putExtra = db.prepare(
      `INSERT INTO activity_extras (activity_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (activity_id, key) DO UPDATE SET value = excluded.value`,
    );
    db.transaction(() => {
      for (const [k, v] of Object.entries(facts.extras)) putExtra.run(activity.id, k, String(v));
      if (facts.error) putExtra.run(activity.id, 'fit_error', facts.error.slice(0, 500));
      // Fill VO2 max from the file if the summary didn't have it.
      if (typeof facts.extras.fit_vo2max === 'number') {
        db.prepare('UPDATE activities SET vo2max = COALESCE(vo2max, ?) WHERE id = ?').run(facts.extras.fit_vo2max, activity.id);
      }
      setFile.run(facts.status === 'error' ? null : fileName, facts.status, nowIso(), nowIso(), garminId);
    })();
  }

  private saveHrZones(body: unknown): void {
    if (!Array.isArray(body)) return;
    const { db } = this.deps;
    const upsert = db.prepare(
      `INSERT INTO hr_zones (sport, zone, min_bpm, max_bpm, source) VALUES (?, ?, ?, ?, 'garmin')
       ON CONFLICT (sport, zone) DO UPDATE SET min_bpm = excluded.min_bpm, max_bpm = excluded.max_bpm
       WHERE hr_zones.source <> 'manual'`,
    );
    db.transaction(() => {
      for (const z of body as Array<Record<string, unknown>>) {
        const sport = typeof z.sport === 'string' ? z.sport : 'DEFAULT';
        const floors = [z.zone1Floor, z.zone2Floor, z.zone3Floor, z.zone4Floor, z.zone5Floor].map((v) => (typeof v === 'number' ? v : null));
        const max = typeof z.maxHeartRateUsed === 'number' ? z.maxHeartRateUsed : null;
        if (floors.some((f) => f == null) || max == null) continue;
        for (let i = 0; i < 5; i++) {
          const lo = floors[i]!;
          const hi = i < 4 ? floors[i + 1]! - 1 : max;
          upsert.run(sport, i + 1, lo, hi);
        }
      }
    })();
  }
}

function toStateRow(r: Record<string, string | null>): SyncStateRow {
  return {
    dataType: r.data_type ?? '',
    lastSyncedDate: r.last_synced_date ?? null,
    lastRunAt: r.last_run_at ?? null,
    lastError: r.last_error ?? null,
  };
}

function label(type: string): string {
  return (
    { 'daily-summaries': 'Daily summaries', 'sleep-summaries': 'Sleep', 'hrv-daily': 'HRV', 'body-battery': 'Body Battery', 'weight-range': 'Weight' } as Record<string, string>
  )[type] ?? type;
}
