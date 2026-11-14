import { ipcMain } from 'electron';
import { IPC, type LibraryItem, type PlanEditResult, type PlanWeekView, type RaceView, type Result } from '../../shared/api';
import { localToday } from '../util/dates';
import { weekStartOf } from '../engine';
import type { PlanService } from '../plan/service';

/** Plan + race handlers. Every edit re-validates and returns warnings; nothing is blocked. */
export function registerPlanIpc(plan: PlanService, timeZone: string, onChange: () => void): void {
  const today = () => localToday(timeZone);
  const id = (v: unknown) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
  const bad: PlanEditResult = { ok: false, message: 'Invalid request.', warnings: [] };
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const edit = (fn: () => PlanEditResult): PlanEditResult => {
    const r = fn();
    if (r.ok) onChange();
    return r;
  };

  ipcMain.handle(IPC.planWeek, (_e, weekStart: unknown): PlanWeekView => {
    const t = today();
    plan.ensureWeek(t);
    return plan.weekView(weekStartOf(date(weekStart) ?? t), t);
  });
  ipcMain.handle(IPC.planBlock, (_e, weeks: unknown): PlanWeekView[] => {
    const t = today();
    plan.ensureWeek(t);
    const n = Math.min(Math.max(Number(weeks) || 4, 1), 12);
    return [plan.weekView(weekStartOf(t), t), ...plan.previewWeeks(t, n - 1)];
  });
  ipcMain.handle(IPC.planLibrary, (): LibraryItem[] => plan.library());
  ipcMain.handle(IPC.planSwap, (_e, a: unknown, b: unknown) => (Number.isNaN(id(a)) || Number.isNaN(id(b)) ? bad : edit(() => plan.swap(id(a), id(b), today()))));
  ipcMain.handle(IPC.planMove, (_e, s: unknown, d: unknown) => (Number.isNaN(id(s)) || !date(d) ? bad : edit(() => plan.move(id(s), date(d)!, today()))));
  ipcMain.handle(IPC.planSkip, (_e, s: unknown) => (Number.isNaN(id(s)) ? bad : edit(() => plan.skip(id(s), today()))));
  ipcMain.handle(IPC.planUnskip, (_e, s: unknown) => (Number.isNaN(id(s)) ? bad : edit(() => plan.unskip(id(s), today()))));
  ipcMain.handle(IPC.planMakeRest, (_e, d: unknown) => (!date(d) ? bad : edit(() => plan.makeRest(date(d)!, today()))));
  ipcMain.handle(IPC.planChange, (_e, s: unknown, key: unknown) => (Number.isNaN(id(s)) || typeof key !== 'string' ? bad : edit(() => plan.change(id(s), key, today()))));
  ipcMain.handle(IPC.planAcceptSuggestion, (_e, s: unknown) => (Number.isNaN(id(s)) ? bad : edit(() => plan.acceptSuggestion(id(s), today()))));
  ipcMain.handle(IPC.planDismissSuggestion, (_e, s: unknown): Result => (Number.isNaN(id(s)) ? bad : plan.dismissSuggestion(id(s))));

  ipcMain.handle(IPC.racesList, (): RaceView[] => plan.raceViews());
  ipcMain.handle(IPC.racesSave, (_e, race: unknown): Result => {
    if (!race || typeof race !== 'object') return { ok: false, message: 'Invalid race.' };
    const r = race as Record<string, unknown>;
    const res = plan.saveRace(
      { id: r.id ? Number(r.id) : undefined, name: String(r.name ?? ''), date: String(r.date ?? ''), type: String(r.type ?? ''), priority: String(r.priority ?? ''), notes: r.notes == null ? null : String(r.notes) },
      today(),
    );
    if (res.ok) onChange();
    return res;
  });
  ipcMain.handle(IPC.racesRemove, (_e, rid: unknown): Result => {
    const res = Number.isNaN(id(rid)) ? { ok: false, message: 'Invalid race.' } : plan.removeRace(id(rid), today());
    if (res.ok) onChange();
    return res;
  });
}
