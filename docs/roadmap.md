# Roadmap

Build in this order. Each milestone should end with something runnable and tests passing. Confirm scope before starting each milestone.

## M0 — Data probe  ✅ built (2026-11-14) — real-data run pending the athlete's key
- `scripts/probe.ts` per `garmin-data.md`.
- Output: `fixtures/` (gitignored) + `fixtures/COVERAGE.md`.
- **Exit:** we know which fields exist for the athlete's fenix 8 (HRV shape, sleep score, Body Battery, swim metrics, VO2 max in FIT or not, HR zones). Update `garmin-data.md` and the data model accordingly.

## M1 — App skeleton + sync  ✅ built (2026-11-14) — verified on Linux against a mock API; Windows run pending (CI is M7)
- Electron + Vite + TS, typed preload API, SQLite with migrations.
- Settings: paste Garmin key (safeStorage), connection test.
- Sync: 90-day backfill with progress, incremental sync on open, FIT download + parse.
- Bare-bones debug views (tables) to inspect synced data.
- **Exit:** fresh install → paste key → 90 days of data in the DB on Linux and Windows.

## M2 — Metrics  ✅ built (2026-11-14) — tuned on 30 days of real data; the athlete's own check pending
- Load (TRIMP / sRPE / k calibration), ACWR, readiness verdict, commute detection, planned-vs-done matching (pure function; wired to the plan in M3).
- RPE prompt.
- Unit + fixture-based tests.
- **Exit:** readiness verdicts for the last 30 days look sensible to the athlete.

## M3 — Plan engine  ✅ built (2026-11-14) — scenario tests pass; 4-week blocks reviewed (maintain and race-in-3-weeks)
- Races (A/B/C), phases, week template, session library, weekly generation, adaptation rules, validators, `plan_changes` log.
- **Exit:** scenario tests pass; a generated 4-week block reads like a reasonable plan.

## M4 — UI: Today + Week  ✅ built (2026-11-19) — React 19; checked at 1920×1080 and 1100×700 on real data; athlete feedback pending
- React 19 (decided).
- Bento Today page, Week page with quick actions, activity drawer, nav rail, visual system tokens.
- **Exit:** The athlete can use it daily (with template summaries).

## M5 — Trends + Settings polish  ✅ built (2026-11-19) — Trends needs a training athlete's data to judge properly
- Trends page, Races & Settings pages complete, sensor toggles with auto-suggest, backup export.

## M6 — Local AI
- Choose model; CI fetches `llama-server`; in-app model download; summary generation with number guard; template fallback stays default when off.

## M7 — Packaging
- electron-builder NSIS (per-user), GitHub Actions Windows build, install guide for the athlete (incl. SmartScreen click-through and creating the Garmin key).

## Later / maybe
- Opt-in unofficial Garmin login add-on for Garmin's own Training Readiness score and pushing workouts to the watch.
- Light theme.
- Other event templates beyond tri/run/ride basics.
- Drag-and-drop week editing.
- Afrikaans UI text.

## Open questions
- [x] React or Svelte → React 19.
- [x] Exact Personal API endpoints and range limits — confirmed from the spec (see `garmin-data.md`). Rate limits and the token response body are undocumented; the probe records what we see.
- [ ] VO2 max: the activity summary schema has `vO2MaxValue`; the probe also checks FIT `maxMetData`. Confirm with the athlete's real data.
- [ ] The athlete's max HR (measured or Garmin-detected) and swim CSS / run threshold pace for targets.
- [ ] Confirm his baseline week still matches reality.
- [ ] Model choice and size (M6).
- [ ] Run the probe on the athlete's real fenix 8 data (needs his key) and review `fixtures/COVERAGE.md`.
- [ ] Which machine he'll run it on (laptop vs desktop with RTX 4070) — affects AI speed only.
