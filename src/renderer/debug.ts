import type { ActivityItem, LibraryItem, PlanSessionView, PlanWeekView, ReadinessDay, ReadinessFactor, SyncProgress, SyncResult, SyncStateRow } from '../shared/api';

/** M1 debug views. Plain DOM on purpose: the UI framework is decided before M4. */

const api = window.pacekat;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- tabs ---------- */
const tabs = document.querySelectorAll<HTMLButtonElement>('button.tab');
tabs.forEach((b) =>
  b.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'sync') void refreshSyncState();
    if (b.dataset.tab === 'data') void refreshTables();
    if (b.dataset.tab === 'readiness') void refreshReadiness();
    if (b.dataset.tab === 'activities') void refreshActivities();
    if (b.dataset.tab === 'plan') void refreshPlan();
  }),
);

function setMsg(el: HTMLElement, text: string, ok = true): void {
  el.textContent = text;
  el.classList.toggle('bad', !ok);
}

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { hour12: false }) : '—';
}

/* ---------- Garmin ---------- */
async function refreshGarmin(): Promise<void> {
  const s = await api.garmin.status();
  const parts = [s.hasKey ? 'Key saved.' : 'No key saved yet.'];
  if (s.lastOkAt) parts.push(`Last OK: ${fmtTime(s.lastOkAt)}.`);
  if (s.lastError) parts.push(`Last problem: ${s.lastError}`);
  $('garmin-status').textContent = parts.join(' ');
  $<HTMLButtonElement>('test-btn').disabled = !s.hasKey;
  $<HTMLButtonElement>('clear-btn').disabled = !s.hasKey;
}

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('key-input');
  const r = await api.garmin.setKey(input.value);
  setMsg($('garmin-msg'), r.message, r.ok);
  if (r.ok) {
    input.value = '';
    await refreshGarmin();
    await testConnection();
  }
});

async function testConnection(): Promise<void> {
  setMsg($('garmin-msg'), 'Testing…');
  const r = await api.garmin.testConnection();
  setMsg($('garmin-msg'), r.message, r.ok);
  await refreshGarmin();
}
$('test-btn').addEventListener('click', () => void testConnection());

$('clear-btn').addEventListener('click', async () => {
  if (!confirm('Remove the saved Garmin key? Synced data stays.')) return;
  const r = await api.garmin.clearKey();
  setMsg($('garmin-msg'), r.message, r.ok);
  await refreshGarmin();
});

$('open-folder').addEventListener('click', () => void api.app.openDataFolder());

async function refreshAppInfo(): Promise<void> {
  const i = await api.app.info();
  const dl = $('app-info');
  dl.replaceChildren();
  for (const [k, v] of [
    ['Version', i.version],
    ['Electron', i.electron],
    ['Time zone', i.timezone],
    ['Data folder', i.userData],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = k!;
    const dd = document.createElement('dd');
    dd.textContent = v!;
    dl.append(dt, dd);
  }
}

/* ---------- Sync ---------- */
const syncBtn = $<HTMLButtonElement>('sync-btn');
const fullBtn = $<HTMLButtonElement>('full-btn');

function showProgress(p: SyncProgress): void {
  const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  $('progress-bar').style.width = `${p.phase === 'done' ? 100 : pct}%`;
  setMsg($('sync-msg'), p.message, p.phase !== 'error');
  const busy = p.phase !== 'done' && p.phase !== 'error';
  syncBtn.disabled = busy;
  fullBtn.disabled = busy;
}
api.sync.onProgress(showProgress);

function showResult(r: SyncResult): void {
  setMsg($('sync-msg'), r.message, r.ok);
  const ul = $('sync-errors');
  ul.replaceChildren(
    ...r.errors.map((e) => {
      const li = document.createElement('li');
      li.textContent = e;
      return li;
    }),
  );
  syncBtn.disabled = false;
  fullBtn.disabled = false;
  void refreshSyncState();
  void refreshGarmin();
  void refreshReadiness();
  void refreshActivities();
  void refreshPlan();
}

async function runSync(full: boolean): Promise<void> {
  syncBtn.disabled = true;
  fullBtn.disabled = true;
  $('sync-errors').replaceChildren();
  showResult(await api.sync.run({ full }));
}
syncBtn.addEventListener('click', () => void runSync(false));
fullBtn.addEventListener('click', () => void runSync(true));

async function refreshSyncState(): Promise<void> {
  const s = await api.sync.status();
  $('last-sync').textContent = `Last finished: ${fmtTime(s.lastFinishedAt)}${s.running ? ' · running now' : ''}`;
  if (s.running) {
    syncBtn.disabled = true;
    fullBtn.disabled = true;
  }
  renderTable(
    $('state-table'),
    ['Data', 'Synced to', 'Last run', 'Error'],
    s.states.map((r: SyncStateRow) => [r.dataType, r.lastSyncedDate, fmtTime(r.lastRunAt), r.lastError]),
  );
}

/* ---------- Readiness ---------- */
const VERDICT_WORD: Record<ReadinessDay['verdict'], string> = { go: 'Go', easy: 'Keep it easy', rest: 'Rest' };
const MARK: Record<ReadinessFactor['status'], string> = { ok: '✓', amber: '!', red: '✕', missing: '–' };
const FACTOR_LABEL: Record<string, string> = {
  hrv: 'HRV',
  resting_hr: 'Resting HR',
  sleep: 'Sleep',
  body_battery: 'Body Battery',
  acwr: 'Load ratio',
  yesterday_load: 'Yesterday',
};

async function refreshReadiness(): Promise<void> {
  const [days, daily, summary] = await Promise.all([api.metrics.readiness(30), api.metrics.daily(30), api.metrics.summary()]);
  const today = days[0];
  $('today-date').textContent = today ? `Today · ${today.date}` : 'No data yet — sync first.';
  $('today-verdict').textContent = today ? VERDICT_WORD[today.verdict] : '—';
  $('today-meter').className = `meter ${today?.verdict ?? ''}`;
  $('today-summary').textContent = today?.summary ?? '';
  $('today-factors').replaceChildren(
    ...(today?.factors ?? []).map((f) => {
      const li = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = `mark ${f.status}`;
      mark.textContent = MARK[f.status];
      mark.title = f.status;
      const label = document.createElement('span');
      label.className = 'muted';
      label.textContent = FACTOR_LABEL[f.key] ?? f.key;
      const reason = document.createElement('span');
      reason.textContent = f.reason;
      li.append(mark, label, reason);
      return li;
    }),
  );

  const info: Array<[string, string]> = [
    ['Max HR', `${summary.hrMax} bpm (${summary.hrMaxSource})`],
    ['Effort → load factor k', `${summary.k.toFixed(2)} ${summary.kCalibrated ? `(calibrated from ${summary.kSamples} sessions)` : `(default; ${summary.kSamples}/10 sessions with RPE + HR)`}`],
    ['History since', summary.historyStart ?? '—'],
    ['Activities', String(summary.activities)],
    ['Need an RPE', String(summary.needsRpe)],
  ];
  $('engine-info').replaceChildren(
    ...info.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );

  const loadBy = new Map(daily.map((d) => [d.date, d]));
  const keys = Object.keys(FACTOR_LABEL);
  renderTable(
    $('readiness-table'),
    ['Date', 'Verdict', 'Load', 'ACWR', ...keys.map((k) => FACTOR_LABEL[k]!), 'Why'],
    days.map((d) => {
      const m = loadBy.get(d.date);
      const byKey = new Map(d.factors.map((f) => [f.key, f]));
      return [
        d.date,
        VERDICT_WORD[d.verdict],
        m ? Math.round(m.load) : null,
        m?.acwr != null ? m.acwr.toFixed(2) : '—',
        ...keys.map((k) => MARK[byKey.get(k)?.status ?? 'missing']),
        d.summary,
      ];
    }),
  );
}

/* ---------- Activities + RPE ---------- */
const METHOD_LABEL: Record<string, string> = {
  hr_trimp: 'HR',
  avg_hr_trimp: 'avg HR',
  srpe: 'RPE',
  srpe_estimate: 'RPE (assumed)',
  strength_max: 'HR/RPE',
};

async function refreshActivities(): Promise<void> {
  const list = await api.activities.list(100);
  const need = list.filter((a) => a.needsRpe).length;
  $('rpe-note').textContent = need ? `${need} need an RPE` : '';
  const table = $('activities-table');
  const head = ['Date', 'Activity', 'Sport', 'Min', 'Km', 'Avg HR', 'Load', 'From', 'RPE', 'Commute'];
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const a of list) tbody.append(activityRow(a));
  table.replaceChildren(thead, tbody);
}

function activityRow(a: ActivityItem): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (a.needsRpe) tr.className = 'needs-rpe';
  const cell = (v: string | number | null, cls?: string) => {
    const td = document.createElement('td');
    td.textContent = v == null ? '' : String(v);
    if (cls) td.className = cls;
    tr.append(td);
    return td;
  };
  cell(a.date);
  cell(a.name).title = a.name ?? '';
  cell(a.subSport ?? a.sport, `sport-${a.sport}`);
  cell(a.durationMin != null ? Math.round(a.durationMin) : null);
  cell(a.distanceKm);
  cell(a.avgHr);
  cell(a.load != null ? Math.round(a.load) : null).title = a.loadReasons.join(' ');
  cell(a.loadMethod ? (METHOD_LABEL[a.loadMethod] ?? a.loadMethod) : null);

  const rpeTd = document.createElement('td');
  const sel = document.createElement('select');
  sel.append(new Option(a.needsRpe ? 'set…' : '—', ''));
  for (let i = 1; i <= 10; i++) sel.append(new Option(String(i), String(i)));
  sel.value = a.rpe != null ? String(a.rpe) : '';
  sel.addEventListener('change', async () => {
    const r = await api.activities.setRpe(a.id, sel.value ? Number(sel.value) : null);
    setMsg($('act-msg'), r.message, r.ok);
    await refreshActivities();
  });
  rpeTd.append(sel);
  tr.append(rpeTd);

  const comTd = document.createElement('td');
  const com = document.createElement('select');
  com.append(new Option(`auto (${a.commuteSource === 'auto' && a.isCommute ? 'yes' : 'no'})`, 'auto'), new Option('yes', 'yes'), new Option('no', 'no'));
  com.value = a.commuteSource === 'manual' ? (a.isCommute ? 'yes' : 'no') : 'auto';
  com.disabled = a.sport !== 'bike' && a.commuteSource !== 'manual';
  com.addEventListener('change', async () => {
    const v = com.value === 'auto' ? null : com.value === 'yes';
    const r = await api.activities.setCommute(a.id, v);
    setMsg($('act-msg'), r.message, r.ok);
    await refreshActivities();
  });
  comTd.append(com);
  tr.append(comTd);
  return tr;
}

/* ---------- Plan ---------- */
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let planWeek: string | null = null;
let library: LibraryItem[] = [];

const addDaysIso = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const todayIso = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function refreshPlan(): Promise<void> {
  if (!library.length) library = await api.plan.library();
  const w = await api.plan.week(planWeek ?? undefined);
  planWeek = w.weekStart;
  $('week-title').textContent = `Week of ${w.weekStart}${w.preview ? ' (preview)' : ''}`;
  const race = w.nextRace ? ` · next race: ${w.nextRace.name} (${w.nextRace.priority}) in ${w.nextRace.daysOut} days` : '';
  $('week-meta').textContent = `${w.phase} · ${w.mode}${w.deload ? ' · recovery week' : ''} · load ${w.plannedLoad}${w.cap != null ? ` / cap ${w.cap}` : ''}${race}`;
  const li = (t: string) => {
    const el = document.createElement('li');
    el.textContent = t;
    return el;
  };
  $('week-notes').replaceChildren(...w.notes.map(li));
  $('week-warnings').replaceChildren(...w.warnings.map((x) => li(`⚠ ${x.message}`)));
  renderSuggestion(w);
  renderGrid(w);
  $('changes-list').replaceChildren(
    ...(w.changes.length ? w.changes : []).map((c) => li(`${c.date} · ${c.actor === 'user' ? 'you' : 'engine'}: ${c.reason}`)),
  );
  if (!w.changes.length) $('changes-list').replaceChildren(li('No changes this week.'));
  await refreshRaces();
}

function renderSuggestion(w: PlanWeekView): void {
  const box = $('suggestion');
  const sug = w.suggestion;
  box.classList.toggle('hidden', !sug);
  if (!sug) return;
  $('suggestion-reason').textContent = sug.reason;
  $('suggestion-changes').replaceChildren(
    ...sug.changes.map((c) => {
      const el = document.createElement('li');
      el.textContent = `${c.before} → ${c.after}`;
      return el;
    }),
  );
  $('suggestion-accept').onclick = async () => {
    const r = await api.plan.acceptSuggestion(sug.id);
    setMsg($('plan-msg'), r.message, r.ok);
    await refreshPlan();
  };
  $('suggestion-dismiss').onclick = async () => {
    const r = await api.plan.dismissSuggestion(sug.id);
    setMsg($('plan-msg'), r.message, r.ok);
    await refreshPlan();
  };
}

function renderGrid(w: PlanWeekView): void {
  const today = todayIso();
  const grid = $('week-grid');
  grid.replaceChildren(
    ...DAYS.map((name, i) => {
      const date = addDaysIso(w.weekStart, i);
      const col = document.createElement('div');
      col.className = `day${date === today ? ' today' : ''}`;
      const h = document.createElement('h3');
      h.textContent = `${name} ${date.slice(5)}`;
      col.append(h);
      for (const s of w.sessions.filter((x) => x.date === date)) col.append(sessionCard(s, w));
      return col;
    }),
  );
}

function sessionCard(s: PlanSessionView, w: PlanWeekView): HTMLElement {
  const el = document.createElement('div');
  const inactive = s.status === 'skipped' || s.status === 'moved';
  el.className = `sess ${s.sport}${inactive ? ' inactive' : ''}`;
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = `${s.isKey ? '★ ' : ''}${s.title}`;
  if (s.status !== 'planned') {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = s.status;
    t.append(b);
  }
  if (s.source === 'manual') {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = 'edited';
    t.append(b);
  }
  const m = document.createElement('div');
  m.className = 'm';
  m.textContent = s.sport === 'rest' ? 'Rest' : `${s.durationMin} min · ${s.intensity} · load ${Math.round(s.estLoad)}`;
  el.title = [s.purpose, s.structure ? [s.structure.warmup, s.structure.main, s.structure.cooldown].filter(Boolean).join(' / ') : '', Object.entries(s.targets).map(([k, v]) => `${k}: ${v}`).join(', ')]
    .filter(Boolean)
    .join('\n');
  el.append(t, m);
  if (s.notes.length) {
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = s.notes.join(' ');
    el.append(n);
  }
  if (!w.preview) el.append(actionsSelect(s, w));
  return el;
}

function actionsSelect(s: PlanSessionView, w: PlanWeekView): HTMLSelectElement {
  const sel = document.createElement('select');
  const group = (label: string, opts: Array<[string, string]>) => {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const [v, t] of opts) g.append(new Option(t, v));
    return g;
  };
  sel.append(new Option('Actions…', ''));
  if (s.status === 'skipped') sel.append(new Option('Put back', 'unskip'));
  else if (s.sport !== 'rest') sel.append(new Option('Skip', 'skip'));
  sel.append(new Option('Make this day a rest day', 'rest'));
  sel.append(group('Move to', DAYS.map((d, i) => [`move:${addDaysIso(w.weekStart, i)}`, d] as [string, string]).filter(([v]) => v !== `move:${s.date}`)));
  const others = w.sessions.filter((o) => o.id !== s.id && o.status !== 'moved' && o.status !== 'skipped');
  if (others.length) sel.append(group('Swap with', others.map((o) => [`swap:${o.id}`, `${DAYS[(new Date(`${o.date}T00:00:00Z`).getUTCDay() + 6) % 7]} · ${o.title}`] as [string, string])));
  const lib = [...library].sort((a, b) => Number(b.sport === s.sport) - Number(a.sport === s.sport) || a.title.localeCompare(b.title));
  sel.append(group('Change to', lib.map((l) => [`change:${l.key}`, `${l.isKey ? '★ ' : ''}${l.title}`] as [string, string])));
  sel.addEventListener('change', async () => {
    const [cmd, arg] = sel.value.split(':') as [string, string | undefined];
    if (!cmd) return;
    const r =
      cmd === 'skip' ? await api.plan.skip(s.id)
      : cmd === 'unskip' ? await api.plan.unskip(s.id)
      : cmd === 'rest' ? await api.plan.makeRest(s.date)
      : cmd === 'move' ? await api.plan.move(s.id, arg!)
      : cmd === 'swap' ? await api.plan.swap(s.id, Number(arg))
      : await api.plan.change(s.id, arg!);
    setMsg($('plan-msg'), [r.message, ...r.warnings.map((x) => `⚠ ${x.message}`)].join(' '), r.ok);
    await refreshPlan();
  });
  return sel;
}

$('week-prev').addEventListener('click', () => {
  if (!planWeek) return;
  planWeek = addDaysIso(planWeek, -7);
  void refreshPlan();
});
$('week-next').addEventListener('click', () => {
  if (!planWeek) return;
  planWeek = addDaysIso(planWeek, 7);
  void refreshPlan();
});
$('week-today').addEventListener('click', () => {
  planWeek = null;
  void refreshPlan();
});

const RACE_TYPES: Array<[string, string]> = [
  ['sprint_tri', 'Sprint triathlon'], ['olympic_tri', 'Olympic triathlon'], ['5k', '5 km'], ['10k', '10 km'],
  ['half_marathon', 'Half marathon'], ['marathon', 'Marathon'], ['gran_fondo', 'Gran fondo'], ['mtb', 'MTB race'], ['other', 'Other'],
];
$<HTMLSelectElement>('race-type').append(...RACE_TYPES.map(([v, t]) => new Option(t, v)));

async function refreshRaces(): Promise<void> {
  const races = await api.races.list();
  const table = $('races-table');
  const tbody = document.createElement('tbody');
  for (const r of races) {
    const tr = document.createElement('tr');
    for (const v of [r.date, r.name, RACE_TYPES.find(([k]) => k === r.type)?.[1] ?? r.type, r.priority]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    const td = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      if (!confirm(`Remove ${r.name}?`)) return;
      const res = await api.races.remove(r.id);
      setMsg($('race-msg'), res.message, res.ok);
      await refreshPlan();
    });
    td.append(del);
    tr.append(td);
    tbody.append(tr);
  }
  if (!races.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = 'No races yet — the plan is in maintain mode.';
    td.className = 'muted';
    tr.append(td);
    tbody.append(tr);
  }
  table.replaceChildren(tbody);
}

$('race-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api.races.save({
    name: $<HTMLInputElement>('race-name').value,
    date: $<HTMLInputElement>('race-date').value,
    type: $<HTMLSelectElement>('race-type').value as never,
    priority: $<HTMLSelectElement>('race-priority').value as 'A',
    notes: null,
  });
  setMsg($('race-msg'), res.message, res.ok);
  if (res.ok) {
    $<HTMLInputElement>('race-name').value = '';
    await refreshPlan();
  }
});

$('block-btn').addEventListener('click', async () => {
  const weeks = await api.plan.block(4);
  renderTable(
    $('block-table'),
    ['Week', 'Phase', 'Load', ...DAYS],
    weeks.map((w) => [
      `${w.weekStart}${w.deload ? ' (recovery)' : ''}`,
      w.phase,
      `${w.plannedLoad}${w.cap != null ? ` / ${w.cap}` : ''}`,
      ...DAYS.map((_, i) =>
        w.sessions
          .filter((s) => s.date === addDaysIso(w.weekStart, i) && s.status !== 'skipped' && s.status !== 'moved')
          .map((s) => `${s.isKey ? '★' : ''}${s.title}${s.durationMin ? ` ${s.durationMin}'` : ''}`)
          .join(' + '),
      ),
    ]),
  );
});

/* ---------- Data browser ---------- */
const PAGE = 100;
let currentTable: string | null = null;
let offset = 0;

async function refreshTables(): Promise<void> {
  const list = await api.debug.tables();
  const ul = $('table-list');
  ul.replaceChildren(
    ...list.map((t) => {
      const li = document.createElement('li');
      li.classList.toggle('active', t.name === currentTable);
      const name = document.createElement('span');
      name.textContent = t.name;
      const n = document.createElement('span');
      n.className = 'muted';
      n.textContent = String(t.rows);
      li.append(name, n);
      li.addEventListener('click', () => {
        currentTable = t.name;
        offset = 0;
        void refreshTables();
        void loadRows();
      });
      return li;
    }),
  );
}

async function loadRows(): Promise<void> {
  if (!currentTable) return;
  const r = await api.debug.rows(currentTable, PAGE, offset);
  $('rows-title').textContent = currentTable;
  $('page-info').textContent = r.total ? `${offset + 1}–${Math.min(offset + PAGE, r.total)} of ${r.total}` : 'empty';
  $<HTMLButtonElement>('prev-page').disabled = offset === 0;
  $<HTMLButtonElement>('next-page').disabled = offset + PAGE >= r.total;
  renderTable($('rows-table'), r.columns, r.rows);
}
$('prev-page').addEventListener('click', () => {
  offset = Math.max(0, offset - PAGE);
  void loadRows();
});
$('next-page').addEventListener('click', () => {
  offset += PAGE;
  void loadRows();
});

function renderTable(table: HTMLElement, columns: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of r) {
      const td = document.createElement('td');
      td.textContent = v == null ? '' : String(v);
      td.title = td.textContent;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);
}

/* ---------- boot ---------- */
void refreshGarmin();
void refreshAppInfo();
void refreshSyncState();
void refreshReadiness();
// First run: no key yet → start on the Garmin tab.
void api.garmin.status().then((s) => {
  if (!s.hasKey) document.querySelector<HTMLButtonElement>('[data-tab=garmin]')?.click();
});
