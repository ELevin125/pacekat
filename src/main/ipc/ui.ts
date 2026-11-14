import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { IPC, type ActivityDetail, type ActivityItem, type PlanEditResult, type Result, type SettingsPatch, type TemplateSlotView } from '../../shared/api';
import type { DB } from '../db';
import { localToday } from '../util/dates';
import { getActivityDetail } from '../activities/detail';
import { activitySummary, dailySummary } from '../summaries/service';
import { getTrends } from '../trends';
import { applySettings, setZones, settingsView } from '../settings';
import type { SecretStore } from '../secrets';
import type { PlanService } from '../plan/service';

export interface UiIpcContext {
  db: DB;
  secrets: SecretStore;
  plan: PlanService;
  fitDir: string;
  timeZone: string;
  getWindow: () => BrowserWindow | null;
  recompute: () => void;
  notify: () => void;
  openDebug: () => void;
  listActivities: (where: string, params: unknown[], limit: number) => ActivityItem[];
}

/** Handlers for the M4/M5 pages: activity drawer, summaries, trends, settings, backup. */
export function registerUiIpc(ctx: UiIpcContext): void {
  const { db } = ctx;
  const today = () => localToday(ctx.timeZone);
  const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  ipcMain.handle(IPC.activitiesDetail, (_e, id: unknown): ActivityDetail | null => {
    const d = getActivityDetail(db, ctx.fitDir, Number(id));
    if (!d) return null;
    return { ...d, summary: activitySummary(db, d) };
  });

  ipcMain.handle(IPC.activitiesBetween, (_e, from: unknown, to: unknown): ActivityItem[] =>
    isDate(from) && isDate(to) ? ctx.listActivities('a.local_date BETWEEN ? AND ?', [from, to], 500) : [],
  );

  ipcMain.handle(IPC.summariesDaily, (_e, date: unknown) => {
    const d = isDate(date) ? date : today();
    return db.prepare('SELECT 1 FROM readiness WHERE local_date = ?').get(d) || db.prepare('SELECT 1 FROM planned_sessions WHERE local_date = ?').get(d) ? dailySummary(db, d) : null;
  });

  ipcMain.handle(IPC.trendsGet, (_e, weeks: unknown) => getTrends(db, [4, 8, 12].includes(Number(weeks)) ? Number(weeks) : 12, today()));

  ipcMain.handle(IPC.settingsGet, () => settingsView(db, ctx.secrets, today()));
  ipcMain.handle(IPC.settingsSet, (_e, patch: unknown): Result => {
    if (!patch || typeof patch !== 'object') return { ok: false, message: 'Invalid settings.' };
    const r = applySettings(db, patch as SettingsPatch);
    if (r.ok && r.recompute) ctx.recompute();
    if (r.ok) ctx.notify();
    return { ok: r.ok, message: r.message };
  });
  ipcMain.handle(IPC.settingsSetZones, (_e, zones: unknown): Result => {
    const r = setZones(db, zones === null ? null : Array.isArray(zones) ? (zones as Array<{ zone: number; minBpm: number; maxBpm: number }>) : []);
    if (r.ok) {
      ctx.recompute();
      ctx.notify();
    }
    return r;
  });
  ipcMain.handle(IPC.settingsTemplate, (): TemplateSlotView[] => ctx.plan.templateView());
  ipcMain.handle(IPC.settingsSetTemplate, (_e, slots: unknown): Result => {
    if (!Array.isArray(slots)) return { ok: false, message: 'Invalid week.' };
    const r = ctx.plan.setTemplate(slots as TemplateSlotView[], today());
    if (r.ok) ctx.notify();
    return r;
  });

  ipcMain.handle(IPC.planUndoSuggestion, (_e, id: unknown): PlanEditResult => {
    const r = ctx.plan.undoSuggestion(Number(id), today());
    if (r.ok) ctx.notify();
    return r;
  });
  ipcMain.handle(IPC.planAcceptedToday, () => ctx.plan.acceptedToday(today()));
  ipcMain.handle(IPC.racesTimeline, () => ctx.plan.timeline(today()));

  ipcMain.handle(IPC.appOpenDebug, () => ctx.openDebug());

  ipcMain.handle(IPC.appExportBackup, async (): Promise<Result> => {
    const win = ctx.getWindow();
    const name = `pacekat-backup-${today()}.zip`;
    const pick = win ? await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'Zip', extensions: ['zip'] }] }) : await dialog.showSaveDialog({ defaultPath: name });
    if (pick.canceled || !pick.filePath) return { ok: false, message: 'Backup cancelled.' };
    const tmp = mkdtempSync(join(tmpdir(), 'pacekat-backup-'));
    try {
      const dbCopy = join(tmp, 'pacekat.db');
      await db.backup(dbCopy);
      const files: Record<string, Uint8Array> = { 'pacekat.db': new Uint8Array(readFileSync(dbCopy)) };
      if (existsSync(ctx.fitDir)) for (const f of readdirSync(ctx.fitDir)) files[`fit/${f}`] = new Uint8Array(readFileSync(join(ctx.fitDir, f)));
      writeFileSync(pick.filePath, zipSync(files, { level: 6 }));
      return { ok: true, message: `Backup saved to ${pick.filePath}.` };
    } catch (err) {
      return { ok: false, message: `Couldn't write the backup: ${(err as Error).message}` };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
