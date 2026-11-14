# M4 plan — UI: Today + Week

Draft, 2026-11-14. Layout and style follow `ui.md`. The mockup in `mockups/app.html` covers the whole app (M4 and M5 pages) and is where they get tested. Open it in a browser and use the rail; click the latest-activity tile for the drawer and the ⋮ on Saturday's run for quick actions.

**Exit (from the roadmap):** the athlete can use it daily, with template summaries.

## Do we need a mockup?

Yes, a cheap one, and it now exists: `docs/mockups/app.html` is one static HTML file that uses the real tokens and data shaped like `src/shared/api.ts`. No Figma. Reasons:
- The athlete "doesn't really know what he wants," so showing him something beats asking him questions. Send him screenshots before building.
- It already caught problems that `ui.md` doesn't cover (see "Changes to ui.md" below).
- Its CSS can go straight into the renderer as `tokens.css` + component styles.

Throw it away once the real pages render. Don't keep it in sync.

## Decisions

| Topic | Proposal | Why |
|---|---|---|
| Framework | **React 19** + TypeScript (Svelte 5 is the alternative) | Most examples and tooling, the safest choice for long-term maintenance, and the electron-vite templates. The app is small enough that either works; this is the open roadmap question. |
| Styling | Plain CSS: `tokens.css` (from `ui.md`) + CSS Modules per component. No Tailwind, no UI kit | The tokens already exist, and a hand-tuned bento fights utility classes. The CSP stays `style-src 'self'`. |
| Font | Inter Variable bundled through `@fontsource-variable/inter` | Works offline; `font-src` is covered by `default-src 'self'`. Tabular numerals everywhere. |
| Charts | **None in M4.** The meter, zone bars, load bars and phase line are CSS/SVG | uPlot arrives with Trends in M5. |
| Routing | A small state store: `page` ∈ today/week/trends/settings plus `drawer: activityId \| null`. No router | 4 pages and a drawer, no deep links. |
| Data | Thin hooks over `window.pacekat`, refetched on a new **`data:changed`** main→renderer event | Metrics recompute after sync and after edits; the UI just needs one "refresh" signal. |
| Icons | Inline SVG sprite: 4 rail icons + 5 sport icons | No icon font, no extra dependency. |

## Changes to `ui.md` found while mocking

1. **Compact layout** at ≤1440 px wide or ≤860 px tall (a 1080p laptop at 125 % scaling, or the 1100×700 minimum). Readiness factors switch to 2 columns with value only (the reason moves to a tooltip), the activity summary line and session structure are hidden, and padding tightens. Without this, Today doesn't fit on one screen at minimum size.
2. **Factor marks** (no green/amber): outline ✓ = fine, filled white `!` = watch, red ✕ = genuine red, dashed circle = missing.
3. **Two sessions today:** the first or key session is the big one; the second is a "Later:" line at the bottom of the tile.
4. **Accepted suggestion** → the tile turns into "Changed to X · Undo"; the session tile shows "was: …".
5. **Week page** has a lot of empty space at 1080p, so each day gets a footer with that day's readiness verdict and its load against planned load. Below the days: totals by sport against last week (a tick on each bar) and this week's `plan_changes` log.
6. **Debug views** move to Settings → Developer instead of being deleted.

## API gaps (main/preload work in M4)

- `activities.detail(id)`: laps or swim intervals, time in each HR zone, planned-vs-done, swim pool length and SWOLF. Laps and zone times aren't stored yet; derive them from the FIT file (`fit_path`) on demand and cache them in `activity_extras`.
- `summaries.activity(id)` / `summaries.daily(date)`: **template** summaries built from the facts object described in `ai-summary.md`, cached in the existing `summaries` table (`source = 'template'`). The M6 LLM path plugs in behind the same call.
- `onChanged(cb)` event after recompute, plan edits or sync.
- Week totals by sport: compute in main (`plan.week` already has sessions, and activities give the actual time).
- Today needs `readiness(1)`, `plan.week()`, `activities.list(1)` and `sync.status()`. All of these exist.

## Build order

1. **Shell:** pick the framework, `tokens.css`, Inter, rail, page switching, footer sync status. Debug views reachable under Settings → Developer.
2. **Readiness hero + week strip + next race:** only needs M2 APIs plus `plan.week()`.
3. **Template summaries** (activity + daily brief), with unit tests on the facts → text step.
4. **Latest activity tile + drawer** (`activities.detail`, RPE editor, commute toggle).
5. **Today's session tile + suggestion accept/dismiss/undo.**
6. **Week page:** columns, quick-action menu with Swap/Move pickers (choose a day or session), Skip/Unskip, Make rest day, Change session (library picker), inline warnings, "Why?" → `plan_changes`, day footers, totals.
7. **Empty and edge states:** no key yet (first-run card → paste key), first 90-day sync with progress, < 28 days of history (baseline note), no race ("add one"), rest day today, missing readiness data, sync error.
8. **Minimal Settings** to make the above work: Garmin key and a races list/add form. The full page is still M5.
9. **Check:** typecheck, Vitest on templates and view-model formatters, manual pass at 1920×1080 and 1100×700, screenshots to the athlete.

Steps 1–4 don't depend on M3; steps 5–6 need the M3 plan engine merged.

## M5 pages in the mockup (not planned in detail yet)

The mockup also has Trends and Races & Settings, so the whole app can be judged at once. Decisions it makes:
- **Trends scrolls**; only Today has to fit on one screen. The range control (4/8/12 weeks) and sport chips sit in one row in the header. The chips filter the load chart, and each sport keeps its colour when the others are hidden.
- **One y-axis per chart.** Every pair from `ui.md` (pace + SWOLF, resting HR + HRV, commute speed + HR, load + load ratio) is two small charts in one tile, never a dual-axis chart. Pace charts put faster at the top.
- **Load tile:** weekly stacked bars by sport, with the load ratio as its own strip underneath showing the 0.8–1.3 band and sharing the week positions. The current week is labelled "so far".
- **Focus areas:** 1–3 rule-based hints, a mix of "watch" and "going well". A hint can link to the setting that fixes it.
- **Off states:** running dynamics shows a placeholder tile that links to Hardware instead of disappearing, so the athlete knows the chart exists. VO2 max only appears if the probe confirms the data.
- **Races & Settings** is one scrolling page with a sub-nav: Races (A/B/C list + resulting phase timeline with race markers), My week (template roles per day), Body & zones, Hardware (toggles + auto-suggest nudge), Garmin, AI summaries, Data & about, Developer.
- **Sport colours vs the dataviz check:** they pass the colour-blindness and contrast checks on the dark tiles, but they're brighter than the usual dark-mode band. That's deliberate (it's the poster look), and everything is always labelled.

## Open questions

- [ ] React or Svelte. Proposal: React.
- [ ] Is it OK that factor reasons move into tooltips in the compact layout? (The verdict summary still says why.)
- [ ] Should the athlete see the mockup before the build starts? Recommended: yes, send 3 screenshots.
- [ ] Trends: weekly averages everywhere, or daily points for HRV / resting HR?
- [ ] Commute colour: bike orange at 55 % looks brownish in the strip. Keep it, or use a striped/hatched bike fill?
