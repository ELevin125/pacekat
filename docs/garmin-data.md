# Garmin Data

## Source: Garmin Connect **Personal API** (official)

Launched 21 Oct 2026. Any Garmin Connect user can create a personal API key for their own account — no application or approval.

- Overview: https://developer.garmin.com/gc-developer-program/personal/personal-api/
- **Swagger / OpenAPI spec (source of truth):** https://developer.garmin.com/gc-developer-program/personal/swagger-docs/
- FAQ: https://developer.garmin.com/gc-developer-program/personal/personal-faq/

> Checked against Garmin's OpenAPI spec (v1.0.0, embedded in the Swagger page) and FAQ on 2026-11-14. Endpoint catalogue in code: `src/main/garmin/endpoints.ts`. What the athlete's account actually returns is still to be confirmed by running the probe (below).

### Auth (confirmed in FAQ)

1. User signs in to Garmin Connect **website** → https://connect.garmin.com/app/settings/personalApiToken → Create Key → accepts terms → picks an expiry: **30, 90, 180 days or 1 year**. The key is shown **once**. It starts with `GCDC_`. Garmin emails a reminder about a week before expiry.
2. App exchanges key for a token:
   `POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token` with header `Authorization: ApiKey <key>` → OAuth2 access token valid **24 h or until the key expires**, whichever is first.
3. Data calls: `GET https://personal.connectapi.garmin.com/...` with `Authorization: Bearer <token>`. (A `.cn` server exists for China accounts.)
4. **No refresh tokens** — just exchange the key again. We do that when < 1 h remains, or on a 401.
5. The token response body format is **not documented**. The client accepts standard OAuth2 JSON (`access_token`, `expires_in`) and a few variants; the probe records the actual shape (values redacted).

Key expiry matters for the UX: Settings must show "Garmin key expired or revoked — paste a new one" on a 401 from the token endpoint, and the athlete should pick the 1-year lifetime.

No password, no MFA, no SSO scraping.

### Endpoints (confirmed in spec — all GET)

| Name in code | Path | Range limit |
|---|---|---|
| daily-summaries | `/usersummary-service/v2/dailysummaries?startDate&endDate` | 1 year |
| sleep-summaries | `/sleep-service/sleep/dailySleepSummariesByDate?startDate&endDate` | 31 days |
| hrv-daily | `/hrv-service/hrv/daily/{from}/{to}` | undocumented → we use 28 |
| body-battery | `/wellness-service/wellness/bodyBattery/reports/daily?startDate&endDate` | 31 days |
| steps / stress | `/usersummary-service/stats/{steps,stress}/daily/{start}/{end}` | 28 days |
| hydration | `/usersummary-service/stats/hydration/daily/{start}/{end}` | 31 days |
| weight-range | `/weight-service/weight/range/{start}/{end}` | undocumented → 31 |
| wellness-activities | `/wellnessactivity-service/activity/summary/range/{from}/{until}` | undocumented → 31 |
| hrv-day, sleep-day, user-summary-day, heart-rate-day, spo2-day | single-date variants | 1 day |
| user-settings | `/userprofile-service/userprofile/settings` | — |
| hr-zones | `/biometric-service/heartRateZones/v2` | — |
| fitness-age | `/fitnessage-service/fitnessage/v2/{date}` (latest as of date) | — |
| activity search | `/activitylist-service/activities/search/activities?startDate&endDate&start&limit` (limit default 99, dates = local start date, inclusive) | paged |
| activity detail / workouts | `/activity-service/activity/{id}` and `/{id}/workouts` | — |
| activity file | `/download-service/files/activity/{id}` → **zip** (`application/x-zip-compressed`) containing the original file (normally `.fit`) | — |

Deliberately **not called** (unrelated to training): nutrition logs, weight goals, menstrual-cycle endpoints.

HRV single-day returns **204** when there's no data for that night.

### Seen in real data (first sync, 2026-11-14)

- **Weight is in grams** (e.g. `88000`), despite the spec saying kilograms. `derive.ts` converts values > 1000. `sourceType` can be `USER_SETTING` (profile weight), `MANUAL` or `CHANGE_LOG`.
- **FIT records are not per-second**: walks came at ≈ 1 record / 6 s ("smart recording"). Load integrates over real sample gaps (`coaching-engine.md` §1).
- HRV baseline appears after ~3 weeks of nightly readings; `lowUpper` < `balancedLow` < `balancedUpper`. Garmin's `status` (BALANCED / UNBALANCED / LOW) follows the **weekly** average vs these bands.
- Body Battery reports return a row for every requested day, even before the account has data; the other daily endpoints only return days with data.
- Token exchange returns **406** if the request says `Accept: application/json`; send `Accept: */*`.

### Notable fields in the activity summary schema

`SummarizedActivityDTO` includes `vO2MaxValue`, `activityTrainingLoad`, `aerobicTrainingEffect`/`anaerobicTrainingEffect`, `hrTimeInZone_1..5`, `averageSwolf`, `poolLength`, `activeLengths`, running dynamics averages (`avgGroundContactTime`, `avgVerticalOscillation`, `avgStrideLength`), power fields (`normPower`, `trainingStressScore`, `maxAvgPower_*`), `startTimeLocal`/`startTimeGMT`. So **VO2 max is likely available per activity** — confirm with real data.

### What it does NOT provide

- Training Readiness score, Training Status, recovery time (not in the spec).
- Device list, gear.
- Workouts / Training API / Courses API (no pushing workouts to the watch).

Consequence: **the app computes its own load and readiness** (see `coaching-engine.md`). That was the plan anyway. Garmin's `activityTrainingLoad` is stored for comparison but not used as our load.

### Rate limits

Not documented. Be polite: sequential requests, ≥ 250 ms apart (probe: 400 ms), exponential backoff on 429/5xx honouring `Retry-After`.

## Milestone 0 — data probe

Goal: find out exactly what the athlete's fenix 8 data looks like through this API before trusting the DB design.

```bash
GARMIN_API_KEY=GCDC_... npm run probe                    # last 21 days
npm run probe -- --days 21 --daily-sample 3             # per-day endpoints only for the last 3 days
npm run probe -- --report-only                          # rebuild COVERAGE.md from saved fixtures
```

`scripts/probe.ts` (run with `tsx`, no Electron):

1. Exchanges the key for a token (records the token response shape, values redacted).
2. Calls every training-relevant endpoint above for the window, chunked to range limits. Raw responses → `fixtures/<endpoint-name>/<from>_<to>.json` (or `<date>.json`, `static.json`).
3. Lists activities in the window; saves detail + workouts JSON and unzips each original file to `fixtures/fit/<activityId>.fit`.
4. Parses each FIT with `@garmin/fitsdk`: message types and fields per sport, per-second HR coverage, power, running dynamics, swim lengths/strokes/SWOLF, training effect, `maxMetData.vo2Max`, HRV (beat-to-beat) messages.
5. Writes `fixtures/probe-manifest.json` and `fixtures/COVERAGE.md`: endpoint → status codes, records, every non-null field with fill counts; an evidence section per M0 question; FIT coverage per sport.

`fixtures/` is **gitignored** — it is personal health data. The developer runs the probe on their own account during development; the athlete runs it once (or the developer runs it with the athlete's key) for real fenix 8 data.

The fixtures then double as **test data** for the engine.

## Sync behaviour (implemented in M1: `src/main/sync/`)

- Triggered on app open and by a "Sync" button. No background service. One sync at a time.
- Endpoints used by the app: daily-summaries, sleep-summaries, hrv-daily, body-battery, weight-range, activity search/detail/file, user-settings, hr-zones. (The probe calls a few more to see what exists.)
- `sync_state` records the last fully-synced day per data type, plus the last error.
- **First run:** backfill 90 days (needed for 28-day chronic load and baselines), chunked per range limit, with progress events.
- **Incremental:** re-fetch from (last synced day − 2 days) to today, because Garmin data for recent days can change after late watch syncs. Upsert by natural key. "Re-sync last 90 days" forces a full backfill.
- New activities: summary → `activities`, detail → `detail_json`, original file unzipped to `userData/fit/<garminId>.fit` and parsed (presence of HR stream, power, running dynamics, swim lengths, TE, VO2 max → `activity_extras`). Files that fail are retried next sync; a 404 is marked `missing` and not retried; non-FIT uploads (GPX/TCX) are kept and marked `not_fit`.
- Garmin-sourced columns are updated on every sync; user-entered ones (`rpe`, commute flags, `load`) are never touched by sync.
- HR zones from Garmin never overwrite zones the user set manually.
- Failures are non-fatal per data type: the error is recorded, `last_synced_date` stays put so the gap is retried, and other types continue. A 401/403 (key expired or revoked) stops the sync with a clear message.
- After fetching, `daily_health` is re-derived for every touched day.

## Data model (initial — adjust after the probe)

Implemented in `src/main/db/migrations/001_initial.sql`. "Store raw, derive later":

- `raw_daily (data_type, local_date, raw_json)` — each range response split into one row per day per data type.
- `raw_static (data_type, raw_json)` — profile settings and HR zones as returned.
- `daily_health` is **derived** from `raw_daily` by `src/main/sync/derive.ts` and can be rebuilt any time without re-fetching. Bump `DERIVE_VERSION` when the mapping changes; every stored day is re-derived on next start. Field mapping (from the spec): resting HR ← `daily-summaries.heartRate.restingValue`; HRV ← `hrv-daily.lastNightAvg/weeklyAvg`, baseline ← `baseline.balancedLow/balancedUpper`; sleep ← `sleepTimeSeconds`, `sleepScores.overall.value`; Body Battery at wake ← first reading ≤ 3 h after `sleepEndTimestampGMT`; min/max, stress, respiration, SpO2, steps ← daily summary; weight ← weight-range.
- `activities.raw_json` keeps the search summary; `detail_json` keeps the detail call.

Initial sketch (kept for reference; the migration is authoritative and adds `garmin_training_load`, `vo2max`, `fit_status`, `fit_parsed_at`, `detail_json`, and a `secrets` table):

```
activities
  id (pk), garmin_activity_id (unique), start_utc, local_date, sport, sub_sport,
  duration_s, moving_s, distance_m, elevation_gain_m,
  avg_hr, max_hr, avg_power, np_power, avg_cadence,
  avg_pace_s_per_km, swim_pace_s_per_100m, swolf, pool_length_m, is_open_water,
  is_commute (bool), commute_source ('auto'|'manual'),
  rpe (1-10, nullable), load, load_method ('hr_trimp'|'srpe'|'power_tss'),
  fit_path, raw_json, updated_at

activity_extras          -- sport-specific metrics not worth columns
  activity_id, key, value

daily_health
  local_date (pk), resting_hr, hrv_last_night_ms, hrv_weekly_avg_ms,
  hrv_baseline_low_ms, hrv_baseline_high_ms, hrv_status,
  sleep_seconds, sleep_score, body_battery_wake, body_battery_min, body_battery_max,
  stress_avg, respiration_avg, spo2_avg, steps, weight_kg, raw_json

hr_zones                 -- from Garmin profile; manual override allowed
  sport, zone, min_bpm, max_bpm, source

races
  id, name, date, type ('sprint_tri'|'olympic_tri'|'5k'|'10k'|'half_marathon'|'marathon'|'gran_fondo'|'mtb'|'other'),
  priority ('A'|'B'|'C'), notes

week_template
  weekday (0=Mon), slot, default_kind, options_json

planned_sessions
  id, local_date, slot, sport, session_key (→ sessions.json), title,
  duration_min, intensity ('rest'|'z1'|'z2'|'tempo'|'threshold'|'vo2'|'race'),
  targets_json, purpose, is_key (bool), status ('planned'|'done'|'partial'|'missed'|'skipped'|'moved'),
  matched_activity_id, source ('engine'|'manual')

plan_changes             -- audit log; shown as "why did my plan change?"
  id, created_at, local_date, kind, reason, before_json, after_json, actor ('engine'|'user')

readiness
  local_date (pk), verdict ('go'|'easy'|'rest'), factors_json, computed_at

summaries
  id, kind ('activity'|'daily'), ref (activity id or date), text, source ('llm'|'template'),
  model, facts_json, created_at

settings                 -- key/value: sensors, max_hr, rest_hr, swim CSS, run threshold pace, etc.
sync_state               -- data_type, last_synced_date, last_run_at, last_error
```

Migrations: numbered SQL files, applied on startup in a transaction.
