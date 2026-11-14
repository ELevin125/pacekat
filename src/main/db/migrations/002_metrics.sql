-- Garmin's "low" HRV line (BaselineScoreDTO.lowUpper): below it Garmin calls the night low.
ALTER TABLE daily_health ADD COLUMN hrv_low_ms INTEGER;

-- M2: per-day load and ACWR, recomputed from activities by metrics/recompute.ts.
CREATE TABLE daily_metrics (
  local_date  TEXT PRIMARY KEY,
  load        REAL NOT NULL,
  acute       REAL NOT NULL,
  chronic     REAL NOT NULL,
  acwr        REAL,
  band        TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
