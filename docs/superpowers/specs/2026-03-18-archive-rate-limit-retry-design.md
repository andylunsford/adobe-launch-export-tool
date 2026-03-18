# Archive Rate-Limit Retry with Resume

**Date:** 2026-03-18
**Status:** Approved

---

## Problem

`perform-archive-run` makes many sequential and parallel Adobe Reactor API calls (list fetches + per-item revision fetches). Adobe rate-limits these with HTTP 429. Currently a 429 terminates the entire archive run with an unrecoverable error.

## Goal

When a 429 is encountered:
1. Pause and show a live countdown to the user
2. Retry once after the cooldown
3. On a second consecutive 429, stop cleanly and allow the user to resume the archive from where it paused (session-only — state is lost on app restart)

---

## Design

### `rateLimitedGet(url, headers, sendUpdate)`

A drop-in replacement for `axios.get` used exclusively inside `perform-archive-run` and the shared queue runner.

Behaviour:
- **Success** → return response as-is
- **First 429** → read `Retry-After` header (default: 60 s), send countdown to UI via `sendUpdate` every second, wait, retry once
- **Second 429** → throw `new Error('RATE_LIMIT_EXHAUSTED')` (sentinel)
- **Any other error** → re-throw unchanged

Countdown message format: `⏸ Rate limited — retrying in {N}s…`

### Session State

Module-level variable in `main.js`:

```js
let pendingArchive = null;
// Shape when set:
// {
//   workQueue: Array<{ type, item }>,
//   resumeIndex: number,        // chunk-aligned index into workQueue
//   processedItems: number,
//   totalItems: number,
//   propertyId, targetDir, types, token, creds
// }
```

Cleared on successful completion. Not persisted — lost on app restart.

### `runArchiveQueue(params, sendUpdate)` (extracted helper)

The queue-processing loop extracted from `perform-archive-run` into a shared function so both the initial run and resume share identical logic. Accepts `{ workQueue, startIndex, processedItems, totalItems, propertyId, targetDir, headers, sendUpdate }`.

Throws `RATE_LIMIT_EXHAUSTED` up to the caller when the sentinel is caught.

### Modified `perform-archive-run`

- All `axios.get` calls inside the handler replaced with `rateLimitedGet`
- After the work queue is built, calls `runArchiveQueue(...)`
- Catches `RATE_LIMIT_EXHAUSTED`:
  - Saves `pendingArchive` with `resumeIndex` = start of the failed chunk
  - Emits `archive-progress` with `{ msg: '⛔ Rate limited twice. Click Resume when ready.', progress: pct, rateLimited: true }`
  - Returns without throwing (archive is paused, not failed)
- `resumeIndex` is chunk-aligned so any partially-processed items in the interrupted chunk are re-run (idempotent — file writes are guarded by `if (!fs.existsSync(revPath))`)

### `resume-archive-run` IPC Handler

- Reads `pendingArchive`; if null, returns `{ success: false, error: 'No paused archive in this session' }`
- Reconstructs `headers` from stored `token` + `creds`
- Calls `runArchiveQueue(...)` from `pendingArchive.resumeIndex`
- Clears `pendingArchive` on success
- On `RATE_LIMIT_EXHAUSTED` during resume: updates `pendingArchive` with new `resumeIndex`, emits `rateLimited: true` event again

### Rate-Limiting During List Phase

The list-building phase (`queueType` + rule_components loop) also uses `rateLimitedGet`. A 429 there gets one countdown+retry. If it hits twice during list-building the archive fails with a standard error (no partial queue to resume from — the list is incomplete).

---

## Files Changed

| File | Change |
|------|--------|
| `main.js` | Add `rateLimitedGet`, `pendingArchive` state, extract `runArchiveQueue`, modify `perform-archive-run`, add `resume-archive-run` handler |
| `modules/archive.js` | Handle `rateLimited: true` on `archive-progress`; show/hide Resume button |
| `index.html` | Add hidden Resume button inside archive tab |
| `e2e/fixtures.js` | Add `resume-archive-run` to mock channels |

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| First 429 anywhere in archive run | Countdown shown, single retry |
| Second 429 after retry | Archive paused, Resume button shown |
| Second 429 during list phase | Archive fails with clear error (no resume) |
| Resume called with no pending session | Returns error, UI shows "session expired" message |
| Non-429 error | Re-thrown, existing error handling unchanged |

---

## Testing

- **E2E mock**: `resume-archive-run` added to fixture channels returning `{ success: true }`
- **Manual**: Run archive on large property → trigger 429 → verify countdown in log → verify ⛔ message + Resume button after second hit → click Resume → verify archive completes
