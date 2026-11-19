# UI

The athlete "doesn't really know what he wants." Direction from him: bento grids look cool; colour-code by sport for multisport. Two references were shared:
1. A **bento poster** — rounded tiles of uneven size, one big hero tile, neutral greys, a clean grotesk sans, light and dark variants.
2. A **dark sports dashboard** — near-black background, card tiles with big numbers, a lime accent, line and bar charts.

Combine them: **dark bento grid, neutral greys, sport colours are the only colours.**

## Navigation

Slim left icon rail with 4 destinations. App opens on Today. Window min size ~1100×700; the layout must also work maximised on a 1080p laptop.

## Pages

### 1. Today (home) — fits on one screen, no scroll at 1080p

Bento tiles:
- **Readiness (hero, largest):** verdict word ("Go" / "Keep it easy" / "Rest"), a 3-step meter, and 3–5 factor rows (HRV, resting HR, sleep, Body Battery, load ratio) each with a small status mark and a one-line reason. If the engine has a suggestion (e.g. downgrade today's session) → accept/dismiss buttons here.
- **Today's session:** sport-coloured; title, duration, target zone(s), purpose, structure (expandable). "Done" state once matched.
- **Latest activity:** sport, key numbers, mini HR-zone bar, AI/template summary. Click → activity drawer. RPE prompt if needed.
- **This week strip:** Mon–Sun mini-cells coloured by sport, planned vs done, today highlighted.
- **Next race:** name, countdown in days, current phase. If none: "No race set — add one" link.
- **Daily brief** (AI/template, 2–3 sentences) — can share the readiness tile or sit as its own small tile.
- Footer status: "Synced 07:12 · Sync now".

### 2. Week

- Mon–Sun columns/cards (current week; arrows to previous/next week).
- Each card: planned session(s) with sport colour, intensity, duration; done/partial/missed state; matched activity.
- Quick actions per session: **Swap with…**, **Move to…**, **Skip**, **Make rest day**, **Edit**. Drag-and-drop between days is a nice-to-have.
- Validator warnings shown inline (e.g. "Two hard days in a row") — never blocking.
- "Why did this change?" link per session → its `plan_changes` entries.
- Week totals: time and load by sport, vs last week.

### 3. Trends

- Time range: 4 / 8 / 12 weeks. Sport filter chips.
- Tiles: weekly load by sport (stacked bars) + ACWR line with the 0.8–1.3 band; resting HR & HRV vs baseline; swim pace/100 m + SWOLF; run aerobic efficiency + cadence; bike commute speed/HR (power curve if enabled); running dynamics if enabled.
- Short "focus areas" tile with the engine's weak-link hints.

### 4. Races & Settings

- **Races:** list + add/edit (name, date, type, A/B/C priority). Shows the resulting phase timeline.
- **My week:** edit the baseline week template.
- **Body & zones:** max HR, resting HR (auto), HR zones (from Garmin, editable), run threshold pace, swim CSS, FTP (only if bike power on).
- **Hardware:** sensor toggles (see `coaching-engine.md` §8).
- **Garmin:** paste key (with a short illustrated how-to), connection status, last sync, re-sync last 90 days.
- **AI:** on/off, model download/remove, status.
- **Data:** open data folder, export backup, about + "not medical advice".

### Activity drawer (slide-in panel, not a page)

Summary numbers, splits/laps (swim: per-length/interval), HR zone distribution, planned-vs-done, RPE editor, commute toggle (rides), summary text.

## As built (M4/M5, 2026-11-19)

The pages follow `docs/mockups/app.html`. Decisions made while mocking and building, on top of the sections above:

- **Compact layout** at ≤ 1440 px wide or ≤ 860 px tall (a 1080p laptop at 125 % scaling, or the 1100×700 minimum): readiness factors go to two columns with the value only (reason in a tooltip), session structure and activity summary line are hidden. Today fits on one screen at 1100×700 (checked).
- **Factor marks**, no green/amber: outline ✓ fine · filled `!` watch · red ✕ warning · dashed circle no data. The hero sentence is built from the flagged factors ("HRV is under your normal range and yesterday was bigger than a usual day. Everything else looks fine.").
- **Two sessions today:** the key (or first) session is the big one; others are a "Later:" line. Strength shows RPE, not a heart-rate zone. Targets turn into numbers once run threshold pace / swim CSS are set (e.g. "Threshold + 10–15 s/km" → "4:45–4:50 /km").
- **Suggestions:** accept/dismiss in the readiness tile; once accepted it reads "Changed to X · Undo" and the session tile shows "was: …".
- **First run:** paste key → test → 90-day sync with a progress bar, then Today.
- **Week:** day footers with that day's readiness and load against planned; totals by sport against last week (tick); the week's `plan_changes`; a "Why this? / Why did this change?" popover per card; ⋮ menu with Swap/Move pickers, Change session (library), Skip/Put back, Make rest day. Menus in the left three columns open to the right. Future weeks are read-only previews until their Monday.
- **Trends** scrolls (only Today must fit). One y-axis per chart, so every pair is two small charts in one tile; pace axes put faster at the top; the load ratio is its own strip under the load bars with the 0.8–1.3 band. Walking etc. shows as "Other" in grey when present. Running dynamics shows a placeholder linking to Hardware until the sensor is on; VO2 max appears only when the data has it. Empty series say "No data in this range".
- **Races & Settings** is one scrolling page with a sub-nav. Debug views live under Developer and open in their own window.
- **Charts** are small hand-written SVG components (`src/renderer/components/charts.tsx`), not a library: 4–12 points per series didn't justify uPlot.

## Visual system

- **Base:** near-black background (~`#0B0D10`), tiles ~`#15181D`, borders ~`#22262D`, text ~`#E8EAED` / secondary ~`#9AA0A6`. Tile radius ~16 px, gap ~12 px.
- **Type:** Inter Variable, bundled via `@fontsource-variable/inter` (works offline). Tabular numerals for all metrics. Hero numbers large and light-weight like the poster.
- **Sport colours (the only hues in the UI):**

  | Sport | Token | Starting value |
  |---|---|---|
  | Swim | `--sport-swim` | blue `#3DA5FF` |
  | Bike | `--sport-bike` | orange `#FF8A3D` |
  | Run | `--sport-run` | lime `#B8F04A` |
  | Strength | `--sport-strength` | violet `#A78BFA` |
  | Other / commute | `--sport-other` | grey `#8A9099` (commutes = bike colour at reduced opacity) |

  The athlete suggested black for cycling; it disappears on a dark UI, hence orange. Easy to change: every colour lives in `src/renderer/styles/tokens.css`, and components use only those variables.
- **Status (readiness, warnings) is NOT colour-coded with green/amber**, because those hues collide with run/bike. Use words + the 3-step meter + icons. Red (`#FF5A5F`) is reserved for genuine warnings only.
- Check contrast (WCAG AA for text) and that sport colours are distinguishable for common colour-vision deficiencies; always pair colour with a sport icon/label.
- Light theme: not in v1, but keep everything tokenised so it's a palette swap (the poster shows the light variant).

## Interaction principles

- Everything the athlete needs daily is on Today; nothing important is more than one click away.
- Every engine suggestion explains itself in one line.
- Manual control always available; engine warns, never blocks.
- Units: metric (km, m, min/km, /100 m, kg). 24-hour time. Week starts Monday.
