# Garmin Data

## Source: Garmin Connect **Personal API** (official)

Launched 21 Oct 2026. Any Garmin Connect user can create a personal API key for their own account — no application or approval.

- Overview: https://developer.garmin.com/gc-developer-program/personal/personal-api/
- **Swagger / OpenAPI spec (source of truth):** https://developer.garmin.com/gc-developer-program/personal/swagger-docs/
- FAQ: https://developer.garmin.com/gc-developer-program/personal/personal-faq/

> The details below come from early community write-ups and probes. **Verify every path, parameter and limit against the Swagger spec before coding against it.** Milestone 0 exists to do exactly that.

### Auth (as reported)

1. User signs in to Garmin Connect **website** → Settings → **Personal API Key** → Create Key → accepts terms → picks key lifetime. The key is shown **once**. It starts with `GCDC_`.
2. App exchanges key for a bearer token:
   `POST /personalapitoken-service/personal-api/personal-api-key/token` with header `Authorization: ApiKey <key>` → returns an access token valid ~24 h.
3. Data calls: `GET https://personal.connectapi.garmin.com/...` with `Authorization: Bearer <token>`.
4. Refresh token proactively when < 1 h remains, or on 401.

No password, no MFA, no SSO scraping.

### What it provides (as reported)

- **Activities:** search/list, per-activity summary and splits, download of the activity file in its original format (.FIT).
- **Health (daily):** steps, stress, heart rate (incl. resting), sleep (incl. score), **HRV** (nightly + status/baseline), **Body Battery**, respiration, SpO2, hydration, weight, nutrition log, Fitness Age.
- **Profile:** settings, **heart-rate zones**.
- Read-only: every endpoint is a GET.

### What it does NOT provide (as reported)

- Training Readiness score, Training Status, recovery time, acute load, load focus (paths return 404).
- VO2 max as a direct metric (unconfirmed — check FIT files in Milestone 0).
- Device list, gear.
- Workouts / Training API / Courses API (no pushing workouts to the watch).

Consequence: **the app computes its own load and readiness** (see `coaching-engine.md`). That was the plan anyway.

### Range limits (as reported)

- Steps, stress: max 28 days per call.
- Sleep, hydration, Body Battery: max 31 days per call.
- Daily summaries: up to 1 year per call.
- Rate limits: not documented. Be polite: sequential requests, small delay, exponential backoff on 429/5xx.

## Milestone 0 — data probe (do this first)

Goal: find out exactly what the athlete's fenix 8 data looks like through this API before designing the DB.

`scripts/probe.ts` (run with `tsx`, no Electron):

1. Read `GARMIN_API_KEY` from env. Exchange for token.
2. For **every GET endpoint in the Swagger spec**, request the last 21 days (chunked to range limits). Save each raw response to `fixtures/<endpoint-name>/<from>_<to>.json`.
3. List activities in that window; download each original file to `fixtures/fit/<activityId>.fit`.
4. Parse each FIT with `@garmin/fitsdk`. For each file, record which message types and fields are present. Specifically look for:
   - VO2 max / max-metrics fields
   - running dynamics (vertical oscillation, ground contact time, stride length)
   - power (bike, run)
   - swim: lengths, stroke count/type, SWOLF, pool length
   - per-second heart rate
   - training effect / training load fields
5. Write `fixtures/COVERAGE.md`: endpoint → status code, record count, field list; FIT → fields present per sport.

`fixtures/` is **gitignored** — it is personal health data. The developer runs the probe on their own account during development; the athlete runs it once (or the developer runs it with the athlete's key) for real fenix 8 data.

The fixtures then double as **test data** for the engine.

## Sync behaviour

- Triggered on app open and by a "Sync" button. No background service.
- `sync_state` table records the last fully-synced day per data type.
- **First run:** backfill 90 days (needed for 28-day chronic load and baselines), chunked per range limit, with a progress indicator.
- **Incremental:** re-fetch from (last synced day − 2 days) to today, because Garmin data for recent days can change after late watch syncs. Upsert by natural key.
- New activities: fetch summary + download FIT, parse, compute derived fields, mark summary for (re)generation.
- Failures are non-fatal: show "Last synced at …" + a retry. Never block the UI on sync.

## Data model (initial — adjust after the probe)

Keep `raw_json` on every Garmin-derived row.

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
