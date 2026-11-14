# Coaching Engine

Pure TypeScript functions in `src/main/engine/`. No IO. Every output carries **reasons** (short strings) the UI can show. All thresholds live in `constants.ts` so they can be tuned without touching logic.

> This is a training aid, not medical advice. Keep defaults conservative.

## 1. Training load (one currency for every sport)

Load is always computed on the **same HR-based scale**, so commutes, MTB, swims, runs and gym sessions are comparable and history stays continuous when new sensors arrive.

Order of preference per activity:

1. **HR TRIMP (Banister)** from the HR samples in the FIT file:
   `TRIMP = Σ (dt_min × HRr × 0.64 × e^(1.92 × HRr))`, where `HRr = (HR − HRrest) / (HRmax − HRrest)` clamped to [0, 1].
   Garmin "smart recording" logs every few seconds (≈ 6 s seen in real data), so each sample counts for the time until the next one, **capped at 30 s** so pauses add no load. Used when samples cover ≥ 50 % of the activity; duration is moving time when Garmin gives it.
   `HRrest` = 7-day mean resting HR from `daily_health`; `HRmax` from settings (default: Garmin profile / zones; editable).
2. **Average-HR TRIMP** if only avg HR is available (same formula with one sample × duration).
3. **Session RPE** when HR is unreliable or missing: `sRPE = duration_min × RPE`, converted to TRIMP units with factor `k`:
   `k = median(TRIMP / sRPE)` over the athlete's last 60 days of sessions that have both (pool swims excluded unless swim HR is trusted), clamped to 0.1–1.0. Default `k = 0.3` until ≥ 10 such sessions exist.
   Sanity check for the default: 60 min at moderate effort (HRr ≈ 0.6) ≈ 73 TRIMP; at RPE 5 that's sRPE 300 → ratio ≈ 0.25. 60 min hard (HRr ≈ 0.8) ≈ 143 TRIMP at RPE 7–8 → ≈ 0.3. A higher default would roughly double-count swims and gym sessions until calibration kicks in.

HR reliability rules:
- **Pool swims:** wrist HR is unreliable → use sRPE **unless** the `swimHrStorage` sensor toggle is on (HRM 600 stores and forwards swim HR).
- **Strength:** HR TRIMP under-counts lifting; use `max(TRIMP, sRPE × k)`.
- Prompt for RPE (1–10 tap) after any activity that needs it; allow it on every activity. Until it's entered, the load assumes RPE 5 and is marked as an estimate (`srpe_estimate`).

**Power (TSS)** is computed and displayed for rides only when the `bikePower` toggle is on and the ride has power data. It is **not** used for the load ratio — switching the primary metric mid-history would distort it for ~4 weeks.

## 2. Acute:chronic workload ratio (ACWR)

- EWMA: acute λ = 2/(7+1), chronic λ = 2/(28+1), over daily load sums (0 on rest days).
- `ACWR = acute / chronic`. Needs ≥ 28 days of history; before that, show "building baseline" and skip ACWR-based rules (use the weekly ramp rule in §5 only).
- Bands: ≤ 0.8 detraining · 0.8–1.3 sweet spot · 1.3–1.5 caution · > 1.5 high risk.
- Provide `projectACWR(plan)` to evaluate proposed changes before applying them.

## 3. Daily readiness verdict

Output: `go` | `easy` | `rest` + list of factors with status and a one-line reason.

| Factor | Amber when | Red when |
|---|---|---|
| HRV (last night vs Garmin's "low" line, `baseline.lowUpper`; falls back to `balancedLow`) | below the low line | below it 3+ nights in a row |
| Resting HR vs 7-day mean | ≥ +5 bpm | ≥ +8 bpm |
| Sleep | < 6 h or score < 60 | < 5 h or score < 45 |
| Body Battery at wake | < 50 | < 30 |
| ACWR | > 1.3 | > 1.5 |
| Yesterday's load vs a typical training day (mean of days with load in the last 28; needs ≥ 4) | > 2× | > 3× |

Combine: any red → `rest`; ≥ 2 amber → `easy`; else `go`. If ≥ 3 inputs are missing → `easy` with reason "not enough data today".

**HRV and Body Battery count as one amber when both are amber**: Garmin computes Body Battery's overnight recharge from HRV, so one rough night would otherwise count twice.

Values live in `src/main/engine/constants.ts`. Checked against 30 days of real data (2026-11-14): 23 go · 3 easy · 4 rest, each non-go day with a concrete reason. Two changes came from that check:
- HRV first compared against `balancedLow`, which flagged ~1 night in 3 for being 1–3 ms under; Garmin's own low line fixes that.
- Yesterday's load was first compared against the 28-day *daily* average (rest days included). Anyone training 2–3×/week then got "rest" after every session; a typical training day is the right yardstick whatever the frequency.

## 4. Races & periodisation

Races have a priority:
- **A** — the plan builds toward it.
- **B** — 3-day mini-taper before, 2 easy days after; otherwise plan continues.
- **C** — treated as that day's hard session, no taper.

Phases, counted back from the next **A** race (within 24 weeks):

| Phase | When | Emphasis |
|---|---|---|
| Base | > 12 weeks out | Aerobic volume (Z2), technique, strength |
| Build | 12 → 4 weeks out | Add threshold/tempo, intervals, bricks |
| Peak | 4 → 1.5 weeks out | Race-specific intensity, volume holds |
| Taper | final 7–10 days (sprint distance) | Volume −40–50 %, keep short intensity |
| Recovery | week after race | Easy only |

- 3:1 loading — every 4th week planned load −30 %.
- No A race within 24 weeks → **Base / maintain** mode: the baseline week with modest variety, no ramp beyond +5 %/week.
- Phase lengths scale for other event types (keep a per-type config).

## 5. Weekly plan generation

Inputs: week template (README defaults, editable), phase, last 4 weeks' load, readiness history, races, sensor toggles, session library.

- **Session library** (`sessions.json`): data, not code. Each entry: `key`, `sport`, `title`, `intensity`, `duration_min` (range), `purpose`, `structure` (warm-up / main set / cool-down text), `targets` (HR zone; pace for run; pace/100 m for swim; power only if `bikePower`), `phases` where it's allowed, `is_key`.
  Must include at least: easy/technique/CSS-interval/open-water swims; easy/tempo/interval/long runs; parkrun (as C-race or tempo); easy/endurance/interval rides; MTB ride; **brick** (bike → run, build/peak phases); upper/lower strength; mobility/active recovery.
- Fill each template slot with a session appropriate to the phase. Max **3 key sessions** per week. **Never two key sessions on consecutive days.**
- **Commutes** (Mon/Wed) are fixed easy aerobic volume: counted in load, shown on the plan, never moved or upgraded by the engine.
- **Weekly ramp:** planned weekly load ≤ `rampRef` × 1.10 (× 1.05 in maintain mode), where
  `rampRef = max(previous week's actual load, 7 × chronic EWMA daily load)`.
  Using last week alone would trap the plan after every 3:1 deload (−30 %) or sick week — returning to normal needs ≈ +43 %. The chronic term remembers what the athlete is actually adapted to. Before 28 days of history, `rampRef` = previous week's actual.
- Sunday rule: plan the structured run only if the projected week load and ACWR allow; otherwise rest.

## 6. Matching planned vs done

- Match activities to planned sessions by local date + sport family; if several, pick the closest duration.
- Status: `done` (≥ 80 % of planned duration), `partial` (30–80 %), `missed` (day passed, nothing matched), unplanned activities shown as extras.
- **Commute detection:** cycling, Mon–Fri, 4–15 km per activity (one round trip or two legs), avg HR ≤ zone 2 upper bound → `is_commute = true` (`auto`). User can toggle per activity; manual always wins.

## 7. Adaptation rules (run after every sync and every manual edit)

1. **Readiness today:**
   - `rest` → replace today's session with rest or ≤ 30 min Z1 (same sport if possible).
   - `easy` → key session becomes its easy variant (same sport, Z1–Z2, ~70 % duration).
   - Always offered as a **suggestion with one-tap accept/dismiss**, never silently applied.
2. **Missed key session:** try to move it to the next slot this week that (a) isn't adjacent to another key day, (b) keeps projected ACWR ≤ 1.3, (c) isn't a commute. If none → drop it and note why. Never stack two sessions to "catch up".
3. **Manual edits** (swap days, move, skip, mark rest, change session): apply immediately, then run validators — key-days back-to-back, ACWR projection > 1.3, weekly ramp above the §5 cap — and show warnings. Don't block.
4. Every change writes a `plan_changes` row with a human reason ("Moved Thursday intervals to Saturday — you missed them and Saturday keeps your load ratio at 1.18").

## 8. Sensor toggles

Settings, each with auto-suggest ("We're seeing power data on your rides — turn on Bike power?"):

| Toggle | Effect |
|---|---|
| `chestStrap` | Trust HR for intervals/strength more; show HR-based metrics for runs/rides |
| `runningDynamics` (HRM 600) | Show GCT, vertical oscillation, stride length trends |
| `swimHrStorage` (HRM 600) | Use HR TRIMP for swims instead of sRPE |
| `bikePower` | Show/compute NP, IF, TSS; power targets in bike sessions; FTP setting appears |

## 9. Performance insights (Trends page)

Keep v1 simple and honest:
- Weekly load by sport (stacked), ACWR line.
- Resting HR and HRV vs baseline.
- Swim: pace per 100 m and SWOLF trend (pool only; open water separate).
- Run: **aerobic efficiency** = speed at a given HR on easy runs (proxy for fitness); cadence; running dynamics if toggle on.
- Bike: avg speed/HR on commutes as a cheap fitness proxy; power curve if toggle on.
- VO2 max: only if the probe finds it in FIT files; otherwise omit (Fitness Age is available as a weak substitute).
- "Weak link" hints: simple rules (e.g. swim volume < 15 % of weekly time while targeting a tri; run cadence < 160 spm on easy runs). Phrase as suggestions.

## Tests

- Unit tests for every formula and rule with hand-built inputs.
- Scenario tests from probe fixtures: "missed Thursday", "bad sleep before a key day", "race in 3 weeks", "no race", "first week of data".
