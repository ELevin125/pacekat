# AI Summary (optional, local, bundled)

> **Status: deferred (2026-11-19).** The app ships with template summaries only (`src/main/summaries/`). See `roadmap.md` → M6 for why. This document stays as the design for when it's picked up; the facts → text contract below is what the templates already implement.

## What it does

Writes short prose, like Strava's summaries:
- **Activity summary** — 2–4 sentences after each new activity.
- **Daily brief** — 2–3 sentences on the Today page: how recovered he is, what today's session is for, one tip.

Roughly 1–3 generations per day. Speed doesn't matter much; reliability does.

## What it must NOT do

- Make decisions. The engine decides; the model narrates the engine's output.
- Invent numbers, PRs, or comparisons not present in its input.
- Give medical advice.

## Runtime: bundled llama.cpp server

- Ship `llama-server` from llama.cpp's GitHub releases (pinned version, checksum verified in CI) in `resources/llama/<platform>/`.
- Windows: **Vulkan** build (uses NVIDIA or AMD GPU if present, falls back to CPU). Linux dev: Vulkan or CPU build.
- The main process spawns it **on demand** on `127.0.0.1` and a random free port, waits for `/health`, calls the OpenAI-compatible `/v1/chat/completions`, and shuts it down after ~2 min idle.
- Timeout per generation: 90 s. On any failure → template fallback (below). Log the error; never surface a stack trace.
- The user never installs anything separately.

## Model

- One small instruct model in **GGUF**, Q4_K_M quantisation, ~2.5–5 GB. Pick during the AI milestone; requirements:
  - licence permits redistribution (Apache-2.0 / MIT preferred),
  - good English instruction following at 3–8 B parameters,
  - runs acceptably on a Ryzen 5 laptop CPU with 32 GB RAM.
- **Not in the installer.** Settings → AI → "Download AI model (x.x GB)" with progress, resume support and SHA-256 verification. Stored in `userData/models/`.
- Settings toggle: AI summaries on/off. Off or no model → templates.

## Prompt contract

The engine builds a **facts object**; only facts go to the model.

```jsonc
// activity summary input (example shape)
{
  "kind": "activity",
  "sport": "run",
  "title": "Saturday parkrun",
  "duration": "24:31",
  "distance_km": 5.0,
  "avg_pace": "4:54 /km",
  "avg_hr": 168,
  "time_in_zones": { "z1": "1:10", "z2": "3:05", "z3": "8:40", "z4": "10:20", "z5": "1:16" },
  "planned": { "title": "Parkrun (tempo effort)", "status": "done" },
  "comparisons": ["fastest parkrun in last 8 weeks (previous best 25:02)"],
  "load": { "this_session": "high", "week_so_far": "on track" },
  "next": "Sunday: rest"
}
```

System prompt (outline):
- You are a friendly endurance coach writing a short note to an amateur triathlete.
- Use ONLY the facts provided. Do not add numbers that are not in the facts.
- 2–4 sentences, plain English, encouraging but honest. No emojis, no hashtags, no medical advice.

**Number guard:** after generation, extract every number in the output; each must appear in the facts (allowing simple reformatting like `5.0`→`5`). If any doesn't, regenerate once at lower temperature; if it fails again, use the template.

Cache results in `summaries` with `facts_json`, so the same activity isn't regenerated unless its facts change.

## Template fallback

Deterministic sentences built from the same facts object, e.g.:
> "Parkrun done in 24:31 — your fastest in 8 weeks. Most of it was in zones 3–4, so that counts as a hard session. Rest tomorrow."

The template path must be good enough that the app feels complete with AI switched off.
