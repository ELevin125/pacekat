import type { SyncProgress, SyncResult, SyncStateRow } from '../shared/api';

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
