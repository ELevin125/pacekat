/**
 * Milestone 0 — Garmin data probe.
 *
 * Pulls the last N days from every training-relevant Personal API endpoint,
 * saves raw responses + original activity files under fixtures/ (gitignored:
 * real health data), and writes fixtures/COVERAGE.md describing what's there.
 *
 *   GARMIN_API_KEY=GCDC_... npm run probe
 *   npm run probe -- --days 21 --daily-sample 3
 *   npm run probe -- --report-only        # rebuild COVERAGE.md from saved fixtures
 *
 * Env: GARMIN_API_KEY (required unless --report-only), GARMIN_API_BASE (optional override).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GarminClient, type GarminResponse } from '../src/main/garmin/client';
import { activities, dailyEndpoints, fitnessAge, rangeEndpoints, staticEndpoints, type RequestSpec } from '../src/main/garmin/endpoints';
import { addDays, chunkRange, eachDay, localToday } from '../src/main/garmin/dates';
import { extractActivityFiles } from '../src/main/garmin/activity-file';
import { writeCoverage } from './probe/report';
import type { Manifest } from './probe/types';

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '21' },
    'daily-sample': { type: 'string', default: '3' },
    out: { type: 'string', default: 'fixtures' },
    'report-only': { type: 'boolean', default: false },
  },
});

const OUT = resolve(args.out!);

async function main(): Promise<void> {
  if (args['report-only']) {
    const manifest = JSON.parse(readFileSync(join(OUT, 'probe-manifest.json'), 'utf8')) as Manifest;
    writeCoverage(OUT, manifest);
    console.log(`Rebuilt ${join(OUT, 'COVERAGE.md')}`);
    return;
  }

  const apiKey = process.env.GARMIN_API_KEY;
  if (!apiKey) {
    console.error('Set GARMIN_API_KEY (starts with GCDC_). Create one at https://connect.garmin.com/app/settings/personalApiToken');
    process.exit(2);
  }
  if (!apiKey.startsWith('GCDC_')) console.warn('Warning: key does not start with GCDC_ — continuing anyway.');

  const days = Number(args.days);
  const dailySample = Number(args['daily-sample']);
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(dailySample) || dailySample < 0) {
    console.error('--days must be >= 1 and --daily-sample >= 0');
    process.exit(2);
  }

  const to = localToday();
  const from = addDays(to, -(days - 1));
  const manifest: Manifest = {
    ranAt: new Date().toISOString(),
    from,
    to,
    baseUrl: process.env.GARMIN_API_BASE ?? 'default',
    tokenShape: null,
    entries: [],
  };

  const client = new GarminClient({
    apiKey,
    baseUrl: process.env.GARMIN_API_BASE,
    minIntervalMs: 400,
    log: (m) => console.log(`  … ${m}`),
    onTokenShape: (s) => (manifest.tokenShape = s),
  });

  mkdirSync(OUT, { recursive: true });
  console.log(`Probing ${from} → ${to} into ${OUT}`);

  process.stdout.write('Token exchange… ');
  await client.ensureToken();
  console.log('ok');

  const saveJson = async (endpoint: string, fileStem: string, spec: RequestSpec): Promise<GarminResponse> => {
    const t0 = Date.now();
    let res: GarminResponse;
    try {
      res = await client.get(spec, 'json');
    } catch (err) {
      manifest.entries.push({ endpoint, path: spec.path, file: null, status: 0, contentType: '', ms: Date.now() - t0, error: (err as Error).message });
      console.log(`  ✗ ${endpoint} ${fileStem}: ${(err as Error).message}`);
      return { status: 0, ok: false, contentType: '', errorText: (err as Error).message };
    }
    const dir = join(OUT, endpoint);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${fileStem}.json`);
    const payload = res.ok ? res.json : { _status: res.status, _error: res.errorText };
    writeFileSync(file, JSON.stringify(payload, null, 2));
    manifest.entries.push({
      endpoint,
      path: spec.path,
      file: rel(file),
      status: res.status,
      contentType: res.contentType,
      ms: Date.now() - t0,
      ...(res.ok ? {} : { error: res.errorText.slice(0, 200) }),
    });
    console.log(`  ${res.ok ? '✓' : '✗'} ${endpoint} ${fileStem} → ${res.status}`);
    return res;
  };

  console.log('Static endpoints');
  for (const ep of staticEndpoints) await saveJson(ep.name, 'static', ep.build());
  await saveJson('fitness-age', to, fitnessAge(to));

  console.log('Range endpoints');
  for (const ep of rangeEndpoints) {
    for (const [a, b] of chunkRange(from, to, ep.maxDays)) await saveJson(ep.name, `${a}_${b}`, ep.build(a, b));
  }

  if (dailySample > 0) {
    const sampleFrom = addDays(to, -(Math.min(dailySample, days) - 1));
    console.log(`Per-day endpoints (${sampleFrom} → ${to})`);
    for (const ep of dailyEndpoints) for (const d of eachDay(sampleFrom, to)) await saveJson(ep.name, d, ep.build(d));
  }

  console.log('Activities');
  const ids: Array<number | string> = [];
  for (let start = 0; ; start += activities.pageSize) {
    const res = await saveJson('activities-search', `${from}_${to}_${start}`, activities.search(from, to, start, activities.pageSize));
    if (!res.ok || !Array.isArray(res.json)) break;
    for (const a of res.json as Array<{ activityId?: number | string }>) if (a.activityId != null) ids.push(a.activityId);
    if (res.json.length < activities.pageSize) break;
  }
  console.log(`  ${ids.length} activities`);

  for (const id of ids) {
    await saveJson('activity-detail', String(id), activities.detail(id));
    await saveJson('activity-workouts', String(id), activities.workouts(id));

    const t0 = Date.now();
    const spec = activities.file(id);
    try {
      const res = await client.get(spec, 'bytes');
      let saved: string | null = null;
      if (res.ok && res.bytes) {
        const files = extractActivityFiles(res.bytes, String(id));
        mkdirSync(join(OUT, 'fit'), { recursive: true });
        files.forEach((f, i) => {
          const name = files.length === 1 ? `${id}.${f.ext || 'bin'}` : `${id}_${i}.${f.ext || 'bin'}`;
          writeFileSync(join(OUT, 'fit', name), f.bytes);
          saved ??= rel(join(OUT, 'fit', name));
        });
      }
      manifest.entries.push({
        endpoint: 'activity-file',
        path: spec.path,
        file: saved,
        status: res.status,
        contentType: res.contentType,
        ms: Date.now() - t0,
        ...(res.ok ? {} : { error: res.errorText.slice(0, 200) }),
      });
      console.log(`  ${res.ok ? '✓' : '✗'} activity-file ${id} → ${res.status}`);
    } catch (err) {
      manifest.entries.push({ endpoint: 'activity-file', path: spec.path, file: null, status: 0, contentType: '', ms: Date.now() - t0, error: (err as Error).message });
    }
  }

  writeFileSync(join(OUT, 'probe-manifest.json'), JSON.stringify(manifest, null, 2));
  writeCoverage(OUT, manifest);
  console.log(`\nDone. Read ${join(OUT, 'COVERAGE.md')}`);
}

function rel(p: string): string {
  return p.startsWith(OUT) ? p.slice(OUT.length + 1) : p;
}

main().catch((err) => {
  // Never print the key/token: errors from the client never include them.
  console.error(`Probe failed: ${(err as Error).message}`);
  process.exit(1);
});
