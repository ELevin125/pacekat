# Pacekat — Project Overview

**Pacekat** is a personal, offline-first desktop app that turns one athlete's Garmin data into a daily readiness verdict and an adaptive weekly training plan toward the races he chooses.

Built for a friend. Runs on the athlete's Windows machine; developed on Linux. Single user, all data local.

## Read these in order

| File | What it covers |
|---|---|
| `README.md` | Purpose, scope, principles (this file) |
| `architecture.md` | Stack, process layout, folder structure, storage, packaging |
| `garmin-data.md` | Garmin Personal API, sync, data model, the data probe |
| `coaching-engine.md` | Load, readiness, plan generation, adaptation rules |
| `ai-summary.md` | Bundled local LLM for the daily/activity summary |
| `ui.md` | Pages, bento layout, sport colours, interactions |
| `roadmap.md` | Milestones in build order, open questions |

## The purpose, in one line

The athlete opens the app once a day and sees: what he did, how recovered he is, what to do today, and a week plan that stays sensible when life gets in the way.

## The athlete

- Multisport: swim (mostly pool, some open water), bike (commutes + MTB), run (incl. Saturday parkrun), strength (gym 2×/week).
- Current focus: sprint triathlon (750 m swim / 20 km bike / 5 km run). No fixed race date yet; he wants to add his own races over time, including other event types (half marathon, gran fondo, MTB).
- Device: Garmin fenix 8. Chest strap: HRM 200 now, HRM 600 soon. Bike power meter planned, not owned yet.
- Machine: Windows, Ryzen 5, 32 GB RAM (may also have a desktop with an RTX 4070 — app must work on either).
- He is not technical. Setup must be: install, paste a Garmin key, done.

## His baseline week (default template, editable in Settings)

| Day | Default |
|---|---|
| Mon | ~12 km round-trip bike commute |
| Tue | Upper body strength + abs, 20-min swim |
| Wed | ~12 km round-trip bike commute |
| Thu | Lower body strength + abs |
| Fri | Rest / active recovery |
| Sat | MTB trail ride **or** 5 km parkrun, + swim |
| Sun | Structured run **or** full rest (depends on weekly load) |

## In scope (v1)

- Sync from Garmin's **official Personal API** on app open + manual button.
- Daily readiness verdict with plain-language reasons.
- Week plan (Mon–Sun) generated from the template + race calendar, with quick manual edits (swap, move, skip, rest, edit).
- Automatic adaptation: low readiness → downgrade; missed key session → redistribute without load spikes.
- Race list with A/B/C priority; plan periodises toward the next A race; "base/maintain" mode when there is none.
- Hardware toggles (chest strap, running dynamics, swim HR storage, bike power) that change which metrics are used/shown.
- Trends over 4–12 weeks.
- Optional bundled local LLM that writes a short Strava-style summary. App fully works without it.

## Explicitly out of scope (v1)

- Garmin Health API / business developer program (requires company approval — not applicable).
- Unofficial Garmin login libraries (`garminconnect`, `garth`, etc.). Possible opt-in add-on later, never the default.
- Pushing workouts to the watch (Personal API is read-only).
- Power-based training as the primary load metric (no power meter yet; see `coaching-engine.md`).
- Cloud sync, accounts, multi-user, mobile app.
- Any external install requirement (no "install Ollama/Python first").
- Medical advice. The app is a training aid; show a short disclaimer in Settings/About.
- "Filtering contacts/messages" — Garmin's API never returns them; we simply don't request unrelated data.

## Design principles

1. **Deterministic engine decides, LLM only narrates.** Every recommendation comes from testable rules with stated reasons. The LLM rewrites facts into prose and never invents numbers or changes the plan.
2. **The athlete is the boss.** Manual edits are always allowed; the engine warns, it doesn't block.
3. **Conservative by default.** When data is missing or ambiguous, recommend easier, not harder.
4. **Local and private.** All data in the app's user-data folder. Only network calls: Garmin Personal API and the one-time model download.
5. **Degrade gracefully.** Missing HRV, no chest strap, no model, no race — every feature has a fallback.
6. **Store raw, derive later.** Keep Garmin's raw JSON and original FIT files so new metrics can be extracted without re-fetching.
