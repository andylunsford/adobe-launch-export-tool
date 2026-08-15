## Commands

```bash
npm start          # Run the Electron app
npm test           # Jest unit tests (lib/ and __tests__/)
npm run test:e2e   # Playwright E2E tests (requires xvfb on Linux)
npm run rebuild    # Rebuild native modules against the Electron ABI (better-sqlite3)
npm run dist:win   # Build Windows installer (.exe)
npm run dist:mac   # Build macOS dmg (universal)
npm run dist:linux # Build Linux AppImage
```

## Architecture

Two-process Electron app, with the renderer context-isolated:

- **Main process** (`main.js`): IPC handlers, file system ops, Adobe Reactor API calls, DB writes
- **Preload** (`preload.js`): the only bridge; exposes `window.api` via `contextBridge`
- **Renderer process** (`index.html`, `renderer.js`, `modules/`): UI logic, calls main via `window.api.*`

The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. It has no `require`, no `process`, and no Node built-ins — it renders Reactor API data, so a stray unescaped string must not be able to reach Node.

Key directories:
- `modules/` — renderer-side feature modules (archive, auth, compare, export, sync, ui-helpers), loaded as native ES modules
- `lib/reactor-core/` — pure JS: API-to-file serialization, diffing, utilities
- `lib/db/` — SQLite cache layer (better-sqlite3); schema, migrations, public API
- `__tests__/` — Jest unit tests mirroring `lib/` structure
- `e2e/` — Playwright E2E tests with IPC mock injection

## IPC Pattern

Renderer modules call `window.api.methodName(payload)`. Each method is declared individually in `preload.js` and forwards to an `ipcMain.handle()` registration in `main.js`. Never put API or file-system logic in renderer modules directly.

**Adding a channel takes three edits**: register the handler in `main.js`, add a named method in `preload.js`, then call `window.api.*` from the module. Do not add a generic `invoke(channel, payload)` passthrough — naming each channel is what keeps the renderer from reaching arbitrary handlers.

For main→renderer events (`archive-progress`, `sync-log`), `preload.js` exposes a subscribe function that returns an unsubscribe function:

```js
const off = window.api.onArchiveProgress(({ msg, progress }) => { ... });
try { ... } finally { off(); }
```

Listener identity does not survive `contextBridge`, so there is no `removeListener` — always call the returned disposer.

## Database

- Engine: `better-sqlite3` (synchronous SQLite), WAL mode, foreign keys ON
- Location: `app.getPath('userData')/nuclear-cache.db` (managed by `lib/db/index.js`)
- Schema: `lib/db/schema.js` — tables: properties, rules, data_elements, rule_components, extensions, environments, libraries
- Must call `initDb()` once in main process before any DB operations

## Gotchas

- **Native module rebuild**: `better-sqlite3` must be built against the Electron ABI, not the system Node ABI. `postinstall` runs `electron-builder install-app-deps` automatically on `npm install`, so this is usually handled. If the app crashes on launch with a module-version error, run `npm run rebuild`.
- **E2E on Linux**: `npm run test:e2e` requires `xvfb-run` (the script includes it). Running `npx playwright test` directly will fail headlessly.
- **E2E mock injection**: E2E tests inject IPC mocks via `fixtures.js` — don't call real Adobe APIs in tests.
- **IPC token flow**: Auth token is retrieved in the renderer via `ui.getGlobalToken()` and passed as payload to IPC calls; main.js does not manage auth state.

## Commit Style

Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`. Scope in parens where relevant (e.g., `feat(archive):`, `fix(compare):`).
