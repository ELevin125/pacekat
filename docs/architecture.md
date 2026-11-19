# Architecture

## Stack

| Concern | Choice | Notes |
|---|---|---|
| Shell | **Electron** | Cross-platform; the developer's familiar setup. |
| Language | **TypeScript** (strict) everywhere | Main, preload, renderer, engine, scripts. |
| Build | **Vite** (renderer) + electron-vite or equivalent | |
| UI framework | **React 19** | Plain CSS: `tokens.css` (all colours/sizes) + `app.css` (from the mockup) + `extra.css`. Debug views stay plain TypeScript + DOM in their own window. |
| Database | **SQLite via `better-sqlite3`** (v13+) | Synchronous, fast, well-trodden in Electron. v13 is N-API with bundled prebuilds, so the same binary loads in Node (tests) and Electron — no `electron-rebuild` step. |
| FIT parsing | **`@garmin/fitsdk`** (Garmin's official JS SDK) | |
| Charts | Small hand-written SVG components | 4–12 weekly points per series; no library needed. Follow `ui.md` colour rules. |
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
  /shared/format.ts      ← pure formatting (durations, paces, dates, targets), used by main and renderer
  /main
    main.ts              ← app lifecycle, window, single-instance lock
    /garmin              ← Personal API client, endpoint catalogue, dates, zip handling (no Electron imports)
    /fit                 ← FIT decoding (@garmin/fitsdk)
    /sync                ← SyncService, range splitting, activity mapping, FIT facts, daily_health derivation
    /db                  ← better-sqlite3, migrations/, settings
    /secrets             ← safeStorage-encrypted key + token cache
    /ipc                 ← IPC handlers
    /engine              ← PURE functions: load, ACWR, readiness, commute, matching (M2); plan, adaptation (M3)
      constants.ts       ← all thresholds in one place
      sessions.json      ← session library (data, not code)
      /plan              ← phases, week generation, validators, adaptation rules
    /metrics             ← recompute: DB ↔ engine glue, runs after every sync and manual edit
    /plan                ← plan service: stores weeks, matching, missed-session moves, suggestions, edits, plan_changes log
    /util/dates.ts       ← pure calendar-date helpers (shared by garmin, engine, sync)
    /activities          ← activity detail for the drawer (laps, HR zones from FIT, cached)
    /summaries           ← facts → template text (M6 LLM plugs in here), cached in `summaries`
    /trends              ← weekly aggregation + focus hints
    /settings            ← thresholds, sensors + nudges, zones override, Garmin status
    /ai                  ← (M6)
  /preload/index.ts      ← contextBridge → window.pacekat (built as CJS for the sandbox)
  /renderer
    main.tsx, App.tsx    ← React entry, rail, page switching, sync state, first run
    api.ts               ← window.pacekat + useApi() (refetches on the main process's data:changed event)
    view.ts              ← pure view-model helpers (tested)
    /pages               ← Today, Week, Trends, Settings
    /components          ← Drawer, FirstRun, charts, icons, shared bits
    /styles              ← tokens.css, app.css, extra.css
    debug.html / debug.ts ← M1–M3 debug views (Settings → Developer)
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
npm run dist:linux   # .deb + AppImage in release/ (the Windows installer comes from CI)
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

Config: `electron-builder.yml`. CI: `.github/workflows/ci.yml`. Install steps for the athlete: `install-guide.md`.

- **Windows:** electron-builder NSIS, one-click, per-user (no admin rights), Desktop + Start-menu shortcuts, opens after install, keeps the data folder on uninstall. Built in CI on `windows-latest` (`npm run dist:win`). Every push to `main` uploads the installers as artifacts (`Pacekat-Setup-windows`, `Pacekat-linux`); a `v*` tag publishes the `.exe`, `.deb` and AppImage as a GitHub Release.
- **Linux:** a `.deb` (installs to `/opt/Pacekat`, menu entry + icon, depends on `libsecret` for key encryption) and an AppImage (runs anywhere; needs FUSE / `libfuse2`). Built locally with `npm run dist:linux` into `release/` (gitignored), and in CI next to the Windows installer.
- **Native module:** better-sqlite3 13 ships N-API prebuilds for every platform, so there's no rebuild step (`npmRebuild: false`); `*.node` files are unpacked from the asar. Its C sources are excluded from the package.
- **What ships:** `out/**`, `package.json`, `build/icon.png`, and the main process's runtime deps (`better-sqlite3`, `@garmin/fitsdk`, `fflate`). React and the font are bundled into the renderer by Vite, so they're devDependencies. Package ≈ 135 MB (mostly Electron); shipped deps have no known vulnerabilities (`npm audit --omit=dev`).
- **Data folder:** `app.getPath('userData')` = `%APPDATA%\pacekat` on Windows, `~/.config/pacekat` on Linux.
- **Icon:** `build/icon.svg` → `icon.png` / `icon.ico` (ImageMagick).
- **Code signing:** not in v1. The SmartScreen click-through is in the install guide.
- **Auto-update:** not in v1. Run a newer installer over the old one; data is kept.
- **Local AI (M6, deferred):** would add `llama-server` binaries fetched in CI (pinned + checksum) via `extraResources`; the model would be an in-app download, never in the installer (see `ai-summary.md`).

Verified 2026-11-19: the Linux AppImage starts from a fresh profile, applies migrations, loads SQLite from the unpacked module and shows first-run; the `.deb`'s metadata, files and desktop entry check out (not installed, since that needs sudo). The Windows installer has not been run yet: it needs the CI job (first push) and a Windows machine.
