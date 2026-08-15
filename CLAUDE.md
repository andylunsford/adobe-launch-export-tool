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

Two-process Electron app:

- **Main process** (`main.js`): IPC handlers, file system ops, Adobe Reactor API calls, DB writes
- **Renderer process** (`index.html`, `renderer.js`, `modules/`): UI logic, calls main via `ipcRenderer.invoke()`

Key directories:
- `modules/` — renderer-side feature modules (archive, auth, compare, export, sync, ui-helpers)
- `lib/reactor-core/` — pure JS: API-to-file serialization, diffing, utilities
- `lib/db/` — SQLite cache layer (better-sqlite3); schema, migrations, public API
- `__tests__/` — Jest unit tests mirroring `lib/` structure
- `e2e/` — Playwright E2E tests with IPC mock injection

## IPC Pattern

Renderer modules call `ipcRenderer.invoke('handler-name', payload)`. All handlers are registered in `main.js` via `ipcMain.handle()`. Never put API or file-system logic in renderer modules directly.

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
