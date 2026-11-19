# Pacekat

An offline desktop app that turns your Garmin data into a daily readiness verdict and an adaptive weekly training plan toward the races you choose. Single user; all data stays on your computer.

Open it once a day and see what you did, how recovered you are, what to do today, and a week plan that stays sensible when life gets in the way.

## What it does

- **Syncs** from Garmin's official Personal API when the app opens, or on demand. Setup is: install, paste a Garmin key, done.
- **Readiness:** Go / Keep it easy / Rest each morning, with a plain-language reason per factor (HRV, resting HR, sleep, Body Battery, load ratio, yesterday's load).
- **Week plan** built from your usual week and your races, with quick edits (swap, move, skip, rest day, change session).
- **Adapts:** offers an easier session on low-readiness days, and moves a missed key session to a safe day without load spikes. Every change is explained.
- **Races** with A/B/C priority: the plan periodises toward the next A race (base → build → peak → taper), or keeps you fit in maintain mode when there's none.
- **Trends** over 4–12 weeks: load by sport, load ratio, recovery, swim/run/commute efficiency, VO2 max.
- **Hardware toggles** (chest strap, running dynamics, swim HR storage, bike power) that change which metrics are trusted and shown.
- **Short summaries** of each activity and each day, written from templates (deterministic, offline).

## Not in scope (v1)

- Garmin Health API / business developer program, or unofficial Garmin login libraries.
- Pushing workouts to the watch (the Personal API is read-only).
- Power as the primary load metric (see `docs/coaching-engine.md`).
- Cloud sync, accounts, multi-user, mobile app.
- Anything that needs a separate install (no "install Python first").
- Medical advice. It's a training aid, with a disclaimer in Settings.

## Principles

1. **The engine decides, with reasons.** Every recommendation comes from testable rules and says why.
2. **You're the boss.** Manual edits are always allowed; the engine warns, it doesn't block.
3. **Conservative by default.** When data is missing or ambiguous, recommend easier, not harder.
4. **Local and private.** All data lives in the app's data folder. The only network calls go to the Garmin Personal API.
5. **Degrade gracefully.** No HRV, no chest strap, no race: every feature has a fallback.
6. **Store raw, derive later.** Garmin's raw JSON and the original FIT files are kept, so new metrics never need a re-fetch.

## Install

- **Windows:** run `Pacekat-Setup-<version>.exe` from the latest release. Step by step, including the SmartScreen warning and creating a Garmin key: `docs/install-guide.md`.
- **Linux:** `sudo apt install ./pacekat_<version>_amd64.deb`, or run `Pacekat-<version>.AppImage`.

## Development

```bash
npm install
npm run dev                              # run the app with hot reload
npm test                                 # unit, engine and sync tests
npm run typecheck
GARMIN_API_KEY=GCDC_... npm run probe    # data probe → fixtures/COVERAGE.md
npm run dist:linux                       # .deb + AppImage in release/
```

The Windows installer is built by GitHub Actions on every push to `main`; publishing a release on GitHub attaches all packages to it. More in `docs/architecture.md` → Development and Packaging.

## Docs

| File | What it covers |
|---|---|
| `docs/architecture.md` | Stack, process layout, folders, storage, packaging |
| `docs/garmin-data.md` | Garmin Personal API, sync, data model, the data probe |
| `docs/coaching-engine.md` | Load, readiness, plan generation, adaptation rules |
| `docs/ui.md` | Pages, layout, sport colours, interactions |
| `docs/ai-summary.md` | Summary facts contract; the local LLM design (deferred) |
| `docs/install-guide.md` | Installing and first-time setup on Windows |
| `docs/roadmap.md` | Milestones, status, open questions |
