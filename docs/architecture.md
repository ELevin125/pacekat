# Architecture

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | **Electron** | Cross-platform; the developer's familiar setup. |
| Language | **TypeScript** (strict) everywhere | Main, preload, renderer, engine, scripts. |
| Build | **Vite** (renderer) + electron-vite or equivalent | |
| UI framework | **React or Svelte — decide before the UI milestone** | Data and engine milestones don't depend on it. |
| Database | **SQLite via `better-sqlite3`** | Synchronous, fast, well-trodden in Electron. Native module → rebuild per platform. |
| FIT parsing | **`@garmin/fitsdk`** (Garmin's official JS SDK) | |
| Charts | Lightweight lib (uPlot or Chart.js) | Keep bundle small; follow `ui.md` colour rules. |
| Tests | **Vitest** | Engine is pure functions tested against recorded fixtures. |
| Local LLM | **llama.cpp `llama-server`** shipped as a sidecar binary | See `ai-summary.md`. |
| Packaging | **electron-builder** → NSIS installer (Windows), AppImage (Linux dev) | |
| CI | GitHub Actions: `windows-latest` builds the installer, `ubuntu-latest` runs tests | Native modules must be built on the target OS. |

No Python anywhere. Garmin's Personal API is plain HTTPS with a bearer token.

## Process layout

```
┌──────────────────────────── Electron main process ────────────────────────────┐
│  garmin/     Personal API client (token exchange, paging, retries)            │
│  sync/       Incremental sync → SQLite + FIT files on disk                    │
│  db/         better-sqlite3, migrations, repositories                         │
│  engine/     PURE functions: load, readiness, plan, adaptation (no IO)        │
│  ai/         llama-server lifecycle, model download, summary generation       │
│  secrets/    Garmin key encrypted with Electron safeStorage                   │
│  ipc/        Typed IPC handlers exposed to renderer via preload               │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │ contextBridge (typed API, no Node in renderer)
┌──────────────────────────────────────┴────────────────────────────────────────┐
│  Renderer: Today · Week · Trends · Races & Settings                            │
└───────────────────────────────────────────────────────────────────────────────┘
            spawn on demand (localhost, random port)
                    ▼
          llama-server (bundled binary) + GGUF model in userData
```

Rules:
- `contextIsolation: true`, `nodeIntegration: false`. Renderer talks only through the typed preload API.
- `engine/` has **no imports** from `db/`, `garmin/`, Electron or Node IO. Inputs in, results out. This is what makes it testable and safe to change.
- All dates handled as local calendar dates in the athlete's timezone (Africa/Johannesburg by default; read from system). Store timestamps as UTC ISO strings, store "day" fields as `YYYY-MM-DD` local.

## Suggested repo layout

```
/docs                  ← these files
/scripts
  probe.ts             ← Milestone 0 data probe (see garmin-data.md)
/fixtures              ← GITIGNORED. Real personal health data. Never commit.
/src
  /main
    /garmin
    /sync
    /db
      migrations/
    /engine
      load.ts
      readiness.ts
      plan.ts
      adapt.ts
      sessions.json    ← session library (data, not code)
      constants.ts     ← all thresholds in one place
    /ai
    /secrets
    /ipc
    main.ts
  /preload
  /renderer
/resources
  /llama               ← llama-server binaries per platform (fetched in CI, not committed)
/tests
```

## Storage locations (Electron `app.getPath('userData')`)

```
userData/
  pacekat.db           SQLite
  fit/<activityId>.fit Original activity files
  models/<name>.gguf   Downloaded LLM model
  logs/
```

Settings → "Open data folder" and "Export backup (zip)" buttons.

## Secrets

- Garmin Personal API key (starts with `GCDC_`) is pasted once by the user, encrypted with `safeStorage.encryptString` (DPAPI on Windows, libsecret/kwallet on Linux) and stored in the DB.
- The 24 h access token is cached the same way and refreshed automatically.
- Never log the key or token. Redact in error reports.

## Network policy

Only these hosts:
- Garmin Personal API (see `garmin-data.md`)
- Model download host (one-time, see `ai-summary.md`)

No telemetry, no analytics, no update pings in v1.

## Packaging

- electron-builder NSIS installer, per-user install (no admin rights needed).
- `llama-server` binaries are downloaded from llama.cpp GitHub releases **in CI** (pinned version + checksum) and placed in `resources/llama/<platform>/` via `extraResources`. Windows uses the **Vulkan** build (works on NVIDIA and AMD iGPU; falls back to CPU).
- The model is **not** in the installer; downloaded in-app (see `ai-summary.md`).
- Code signing: not in v1 (SmartScreen warning is acceptable for a friend's machine; document how to click through).
- Auto-update: not in v1. Ship new installers manually.
