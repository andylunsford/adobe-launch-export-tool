# Archive Rate-Limit Retry with Resume

**Date:** 2026-03-18
**Status:** Draft

---

## Problem

`perform-archive-run` makes many sequential and parallel Adobe Reactor API calls (list fetches + per-item revision fetches). Adobe rate-limits these with HTTP 429. Currently a 429 terminates the entire archive run with an unrecoverable error.

## Goal

When a 429 is encountered during an archive run:
1. Pause and show a live countdown to the user
2. Retry once after the cooldown
3. On a second consecutive 429, stop cleanly and allow the user to resume from where it paused (session-only — state is lost on app restart)

---

## Design

### `rateLimitedGet(url, headers, sendUpdate)`

A helper that wraps a single `axios.get` call with rate-limit handling. Used in two places:

- **Inside `fetchList`** — `fetchList` currently calls `axios.get(next, ...)` in its pagination loop. This single call is replaced with `rateLimitedGet`. All list-building calls (initial queuing phase + rule_components loop) go through `fetchList`, so they are all covered automatically.
- **The direct `axios.get` at the extension package fetch site** inside the queue processor — also replaced with `rateLimitedGet`.

Behaviour:
- **Success** → return response as-is
- **First 429** → read `Retry-After` response header (default: 60 s if header absent), send countdown updates to the UI via `sendUpdate` every second (format: `⏸ Rate limited — retrying in Ns…` where N is a live integer), wait, retry once
- **Second 429** → throw `new Error('RATE_LIMIT_EXHAUSTED')` (sentinel)
- **Any other error** → re-throw unchanged

### `CHUNK_SIZE` constant

Moved from a local variable inside the queue processor to a module-level constant (`const ARCHIVE_CHUNK_SIZE = 5`). Used identically in both the initial run and resume so chunk boundaries are consistent.

### Session State

Module-level variable in `main.js`:

```js
let pendingArchive = null;
// Shape when set:
// {
//   workQueue: Array<{ type, item }>,  // full original queue
//   resumeIndex: number,               // chunk-aligned: start of the failed chunk
//   processedItems: number,
//   totalItems: number,
//   propertyId: string,
//   targetDir: string,
//   types: string[],
//   token: string,
//   creds: object
// }
```

Stores raw `token` and `creds` (not pre-built headers) so `getHeaders` can be called fresh on resume. Cleared on successful completion or when the renderer calls a new `perform-archive-run`. Not persisted — lost on app restart.

### `runArchiveQueue({ workQueue, startIndex, processedItems, totalItems, propertyId, targetDir, headers, sendUpdate })`

The queue-processing loop (chunk iteration + revision fetches) extracted from `perform-archive-run` into a standalone async function. Both the initial run and `resume-archive-run` call this with the same logic.

- Uses `ARCHIVE_CHUNK_SIZE` for chunking
- Uses `rateLimitedGet` for all HTTP calls
- Throws `RATE_LIMIT_EXHAUSTED` to the caller if the second 429 occurs
- Returns `{ processedItems, totalItems }` on success

### Modified `perform-archive-run`

Flow:
1. Build `workQueue` via `fetchList` calls (which use `rateLimitedGet` internally)
2. Call `runArchiveQueue({ workQueue, startIndex: 0, processedItems: 0, totalItems, ... })`
3. **On `RATE_LIMIT_EXHAUSTED` from `runArchiveQueue`**:
   - Save `pendingArchive` with `resumeIndex` = start of the failed chunk, `token`, `creds`
   - Emit `archive-progress` event: `{ msg: '⛔ Rate limited twice. Click Resume when ready.', progress: pct, rateLimited: true }`
   - **Return `{ rateLimited: true }`** — does not throw; the archive is paused, not failed
4. **On `RATE_LIMIT_EXHAUSTED` from the list-building phase** (thrown by `fetchList` before `runArchiveQueue` is called):
   - No queue has been built yet, so there is nothing to resume
   - Throw `new Error('Archive paused: rate limited twice during list setup. Please wait and try again.')` — propagates to the renderer as a regular archive failure with a clear message
   - No `pendingArchive` is saved; no Resume button is shown
5. **On success**: return `{ success: true }`
6. **On other errors**: throw as before

### `resume-archive-run` IPC Handler

- If `pendingArchive` is `null`: return `{ success: false, error: 'No paused archive in this session' }`
- Reconstruct `headers` via `getHeaders(pendingArchive.token, pendingArchive.creds)`
- Call `runArchiveQueue` from `pendingArchive.resumeIndex`
- **On success**: clear `pendingArchive`, return `{ success: true }`
- **On `RATE_LIMIT_EXHAUSTED`**: update `pendingArchive.resumeIndex` to the new failed chunk, re-emit `rateLimited: true` progress event, return `{ rateLimited: true }`
- **On other error**: return `{ success: false, error: e.message }`

### Multi-Property Runs

`archive.js` loops over selected properties and calls `perform-archive-run` once per property. When a `{ rateLimited: true }` response is received:

- The renderer **breaks out of the property loop immediately** (stops archiving further properties)
- The Resume button appears
- On resume, `resume-archive-run` completes only the **current (paused) property's remaining queue**
- After resume, the user must re-run the archive to process any remaining properties that were skipped

This is an explicit scope decision: session-only resume covers one property at a time. Multi-property resume would require storing the full property list, which is out of scope here.

### UI Changes (`modules/archive.js`)

- `archive-progress` listener: if event has `rateLimited: true`, log the message and **show** the Resume button (`#btn-resume-archive`), disable the Start button
- Resume button click handler: calls `ipcRenderer.invoke('resume-archive-run')`
  - On `{ success: true }`: hide Resume button, re-enable Start button, log `✅ Archive resumed and completed`
  - On `{ rateLimited: true }`: log the new paused message (button stays visible)
  - On `{ success: false }`: log the error, hide Resume button
- The `startArchive` loop must check the return value of `perform-archive-run` and break if `result?.rateLimited === true`

---

## Files Changed

| File | Change |
|------|--------|
| `main.js` | Add `rateLimitedGet`, `ARCHIVE_CHUNK_SIZE`, `pendingArchive` state; extract `runArchiveQueue`; modify `perform-archive-run`; add `resume-archive-run` handler |
| `modules/archive.js` | Break loop on `rateLimited: true`; handle Resume button show/hide/click |
| `index.html` | Add `#btn-resume-archive` button (hidden by default) inside archive tab |
| `e2e/fixtures.js` | Add `resume-archive-run` to mock channels returning `{ success: true }` |

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| First 429 anywhere in archive run | Countdown shown (seconds from `Retry-After` or 60 s), single retry |
| Second 429 after retry | Archive paused, `pendingArchive` saved, Resume button shown |
| Second 429 during list-building phase | Archive fails with clear error message (no queue to resume from) |
| Resume called with no pending session | Returns `{ success: false }`, UI logs "session expired" message |
| Second 429 during resume | `pendingArchive` updated, Resume button remains visible |
| Non-429 error | Re-thrown, existing error handling unchanged |
| App restart | `pendingArchive` is null; Resume button does not appear |

---

## Testing

- **E2E mock**: `resume-archive-run` added to `e2e/fixtures.js` channels, returning `{ success: true }`. `perform-archive-run` already absent from mock channels (archive tab tests do not exercise the run path). No automated test of the rate-limit path — this requires a real 429, so manual testing only.
- **Existing archive-tab E2E tests** (`e2e/04-tabs.spec.js`) only query `#tab-archive`, `#archive-folder-path`, `#archive-console`, resource-type checkboxes, and `#btn-start-archive`. None query `#btn-resume-archive`, so adding the new button does not break any existing tests.
- **Manual**: Run archive on large property → trigger 429 → verify countdown in log → verify ⛔ message + Resume button after second hit → click Resume → verify archive completes → verify Start button re-enabled
