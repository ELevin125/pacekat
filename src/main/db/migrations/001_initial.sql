-- Initial schema. See docs/garmin-data.md "Data model".
-- Dates: `*_utc` are UTC ISO strings; `local_date` / `day` fields are YYYY-MM-DD in the athlete's timezone.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Encrypted with Electron safeStorage (DPAPI on Windows). Never logged.
CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  value      BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_state (
  data_type        TEXT PRIMARY KEY,
  last_synced_date TEXT,
  last_run_at      TEXT,
  last_error       TEXT
);

-- Raw Garmin payloads, one row per data type per local day ("store raw, derive later").
CREATE TABLE raw_daily (
  data_type  TEXT NOT NULL,
  local_date TEXT NOT NULL,
  raw_json   TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (data_type, local_date)
);

-- Raw payloads without a per-day key (profile, settings).
CREATE TABLE raw_static (
  data_type  TEXT PRIMARY KEY,
  raw_json   TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Derived from raw_daily by sync/derive.ts; safe to rebuild at any time.
CREATE TABLE daily_health (
  local_date           TEXT PRIMARY KEY,
  resting_hr           INTEGER,
  hrv_last_night_ms    INTEGER,
  hrv_weekly_avg_ms    INTEGER,
  hrv_baseline_low_ms  INTEGER,
  hrv_baseline_high_ms INTEGER,
  hrv_status           TEXT,
  sleep_seconds        INTEGER,
  sleep_score          INTEGER,
  body_battery_wake    INTEGER,
  body_battery_min     INTEGER,
  body_battery_max     INTEGER,
  stress_avg           INTEGER,
  respiration_avg      REAL,
  spo2_avg             REAL,
  steps                INTEGER,
  weight_kg            REAL,
  derived_at           TEXT NOT NULL
);

CREATE TABLE activities (
  id                   INTEGER PRIMARY KEY,
  garmin_activity_id   TEXT NOT NULL UNIQUE,
  name                 TEXT,
  start_utc            TEXT,
  local_date           TEXT NOT NULL,
  sport                TEXT NOT NULL,          -- swim | bike | run | strength | other
  sub_sport            TEXT,                   -- Garmin activityType.typeKey
  duration_s           REAL,
  moving_s             REAL,
  distance_m           REAL,
  elevation_gain_m     REAL,
  avg_hr               INTEGER,
  max_hr               INTEGER,
  avg_power            REAL,
  np_power             REAL,
  avg_cadence          REAL,
  avg_pace_s_per_km    REAL,
  swim_pace_s_per_100m REAL,
  swolf                REAL,
  pool_length_m        REAL,
  is_open_water        INTEGER NOT NULL DEFAULT 0,
  is_commute           INTEGER NOT NULL DEFAULT 0,
  commute_source       TEXT,                   -- auto | manual
  rpe                  INTEGER CHECK (rpe IS NULL OR rpe BETWEEN 1 AND 10),
  load                 REAL,
  load_method          TEXT,                   -- hr_trimp | avg_hr_trimp | srpe | power_tss
  garmin_training_load REAL,                   -- Garmin's own number, for comparison only
  vo2max               REAL,
  fit_path             TEXT,
  fit_status           TEXT,                   -- ok | missing | not_fit | error | crc_error
  fit_parsed_at        TEXT,
  raw_json             TEXT NOT NULL,          -- search summary
  detail_json          TEXT,                   -- /activity-service/activity/{id}
  updated_at           TEXT NOT NULL
);
CREATE INDEX activities_local_date ON activities (local_date);

-- Sport-specific metrics not worth columns (from FIT parsing etc.).
CREATE TABLE activity_extras (
  activity_id INTEGER NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  PRIMARY KEY (activity_id, key)
);

CREATE TABLE hr_zones (
  sport   TEXT NOT NULL,   -- DEFAULT, RUNNING, CYCLING, ... as Garmin names them
  zone    INTEGER NOT NULL,
  min_bpm INTEGER NOT NULL,
  max_bpm INTEGER NOT NULL,
  source  TEXT NOT NULL,   -- garmin | manual (manual always wins)
  PRIMARY KEY (sport, zone)
);

-- Tables below are filled from M3 onwards; created now so the schema is in one place.

CREATE TABLE races (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  date     TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('sprint_tri','olympic_tri','5k','10k','half_marathon','marathon','gran_fondo','mtb','other')),
  priority TEXT NOT NULL CHECK (priority IN ('A','B','C')),
  notes    TEXT
);

CREATE TABLE week_template (
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Monday
  slot         INTEGER NOT NULL,
  default_kind TEXT NOT NULL,
  options_json TEXT,
  PRIMARY KEY (weekday, slot)
);

CREATE TABLE planned_sessions (
  id                  INTEGER PRIMARY KEY,
  local_date          TEXT NOT NULL,
  slot                INTEGER NOT NULL,
  sport               TEXT NOT NULL,
  session_key         TEXT,
  title               TEXT NOT NULL,
  duration_min        REAL,
  intensity           TEXT CHECK (intensity IN ('rest','z1','z2','tempo','threshold','vo2','race')),
  targets_json        TEXT,
  purpose             TEXT,
  is_key              INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','partial','missed','skipped','moved')),
  matched_activity_id INTEGER REFERENCES activities (id) ON DELETE SET NULL,
  source              TEXT NOT NULL CHECK (source IN ('engine','manual'))
);
CREATE INDEX planned_sessions_date ON planned_sessions (local_date);

CREATE TABLE plan_changes (
  id          INTEGER PRIMARY KEY,
  created_at  TEXT NOT NULL,
  local_date  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('engine','user'))
);

CREATE TABLE readiness (
  local_date   TEXT PRIMARY KEY,
  verdict      TEXT NOT NULL CHECK (verdict IN ('go','easy','rest')),
  factors_json TEXT NOT NULL,
  computed_at  TEXT NOT NULL
);

CREATE TABLE summaries (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('activity','daily')),
  ref        TEXT NOT NULL,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('llm','template')),
  model      TEXT,
  facts_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref)
);
