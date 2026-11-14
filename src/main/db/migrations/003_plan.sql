-- M3: plan engine persistence.

ALTER TABLE planned_sessions ADD COLUMN est_load REAL NOT NULL DEFAULT 0;
ALTER TABLE planned_sessions ADD COLUMN structure_json TEXT;
ALTER TABLE planned_sessions ADD COLUMN notes_json TEXT;
ALTER TABLE planned_sessions ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE planned_sessions ADD COLUMN race_id INTEGER REFERENCES races (id) ON DELETE SET NULL;

ALTER TABLE plan_changes ADD COLUMN session_id INTEGER;
CREATE INDEX plan_changes_session ON plan_changes (session_id);

-- One row per generated week: the engine's view of it when it was planned.
CREATE TABLE plan_weeks (
  week_start     TEXT PRIMARY KEY,
  phase          TEXT NOT NULL,
  mode           TEXT NOT NULL,
  deload         INTEGER NOT NULL,
  cap            REAL,
  planned_load   REAL NOT NULL,
  notes_json     TEXT NOT NULL,
  next_race_json TEXT,
  generated_at   TEXT NOT NULL
);

-- Readiness suggestions shown with accept/dismiss. One per day and kind, so a dismissed one isn't re-offered.
CREATE TABLE plan_suggestions (
  id           INTEGER PRIMARY KEY,
  local_date   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  reason       TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  UNIQUE (local_date, kind)
);
