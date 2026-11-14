# Architecture

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | **Electron** | Cross-platform; the developer's familiar setup. |
| Language | **TypeScript** (strict) everywhere | Main, preload, renderer, engine, scripts. |
| Build | **Vite** (renderer) + electron-vite or equivalent | |
| UI framework | **React or Svelte — decide before the UI milestone** | Data and engine milestones don't depend on it. M1 debug views are plain TypeScript + DOM. |
| Database | **SQLite via `better-sqlite3`** (v13+) | Synchronous, fast, well-trodden in Electron. v13 is N-API with bundled prebuilds, so the same binary loads in Node (tests) and Electron — no `electron-rebuild` step. |
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

## Repo layout

```
/docs                    ← these files
/scripts
  probe.ts               ← M0 data probe (see garmin-data.md)
  /probe                 ← probe inspection + COVERAGE.md report
/fixtures                ← GITIGNORED. Real personal health data. Never commit.
/src
  /shared/api.ts         ← typed IPC API shared by main, preload and renderer (types only)
  /main
    main.ts              ← app lifecycle, window, single-instance lock
    /garmin              ← Personal API client, endpoint catalogue, dates, zip handling (no Electron imports)
    /fit                 ← FIT decoding (@garmin/fitsdk)
    /sync                ← SyncService, range splitting, activity mapping, FIT facts, daily_health derivation
    /db                  ← better-sqlite3, migrations/, settings
    /secrets             ← safeStorage-encrypted key + token cache
    /ipc                 ← IPC handlers
    /engine              ← (M2+) PURE functions: load, readiness, plan, adaptation
      sessions.json      ← session library (data, not code)
      constants.ts       ← all thresholds in one place
    /ai                  ← (M6)
  /preload/index.ts      ← contextBridge → window.pacekat (built as CJS for the sandbox)
  /renderer              ← UI (M1: debug views)
/resources
  /llama                 ← llama-server binaries per platform (fetched in CI, not committed)
/tests                   ← Vitest
```

## Development

```bash
npm install
npm run dev          # electron-vite dev with HMR
npm test             # vitest
npm run typecheck    # main/preload/scripts/tests + renderer
npm run build        # bundles into out/
npm start            # run the built app
```

Dev-only environment variables (ignored in packaged builds):
- `GARMIN_API_BASE` — point the app (and the probe) at a mock Garmin server.
- `PACEKAT_USER_DATA` — use a separate data folder (smoke tests, clean first-run).

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
