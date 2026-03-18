# Archive Rate-Limit Retry with Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `perform-archive-run` hits a 429, show a live countdown, retry once, and on a second consecutive 429 pause cleanly with a Resume button so the user can continue after the cooldown.

**Architecture:** Add `rateLimitedGet` wrapping every `axios.get` in the archive path. Extract the queue-processing loop into `runArchiveQueue` so both the initial run and `resume-archive-run` call the same code. Store pause state in a module-level `pendingArchive` variable (session-only, cleared on success or new run).

**Tech Stack:** Electron 28 IPC (`ipcMain.handle`), axios, existing `main.js` + `modules/archive.js` + `index.html` + `e2e/fixtures.js`.

---

## Files Changed

| File | Change |
|------|--------|
| `main.js` | Add `ARCHIVE_CHUNK_SIZE`, `pendingArchive`, `rateLimitedGet`; hoist `fetchList` to module scope; extract `runArchiveQueue`; modify `perform-archive-run`; add `resume-archive-run` |
| `modules/archive.js` | Break loop on `rateLimited`; show/hide Resume button; add `resumeArchive()`; update `archive-progress` listener |
| `index.html` | Add `#btn-resume-archive` (hidden by default) inside archive tab |
| `e2e/fixtures.js` | Add `resume-archive-run` to mock channels |

---

## Task 1: Add module-level helpers in `main.js`

**Files:**
- Modify: `main.js` (around line 923, before `ipcMain.handle('perform-archive-run', ...)`)

### Context

`main.js` currently has `fetchList` as a local async function defined inside `perform-archive-run` (lines 929–938) and `CHUNK_SIZE = 5` as a local constant (line 1011). Both need to be accessible from `runArchiveQueue` (Task 2) and `resume-archive-run` (Task 3), so they must be hoisted to module scope.

`rateLimitedGet` replaces every bare `axios.get` in the archive path. It wraps a single call: success → return; first 429 → countdown via `sendUpdate`, wait `Retry-After` seconds, retry once; second 429 → throw sentinel `RATE_LIMIT_EXHAUSTED`.

`pendingArchive` holds enough state to resume: `{ workQueue, resumeIndex, processedItems, totalItems, propertyId, targetDir, types, token, creds }`. Storing raw `token`/`creds` (not pre-built headers) so `getHeaders` is called fresh on resume.

- [ ] **Step 1: Add the three declarations above the `perform-archive-run` handler**

Insert the following code block **immediately before** the line `ipcMain.handle('perform-archive-run', ...` (currently around line 923):

```javascript
// ---------------------------------------------------------------------------
// Archive: module-level helpers and state
// ---------------------------------------------------------------------------

const ARCHIVE_CHUNK_SIZE = 5;

let pendingArchive = null;
// Shape when set:
// {
//   workQueue: Array<{ type, item }>,
//   resumeIndex: number,        // chunk-aligned start of failed chunk
//   processedItems: number,
//   totalItems: number,
//   propertyId: string,
//   targetDir: string,
//   types: string[],
//   token: string,
//   creds: object
// }

/**
 * Wraps axios.get with rate-limit handling.
 *   First 429  → wait Retry-After (or 60 s), send countdown, retry once
 *   Second 429 → throw Error('RATE_LIMIT_EXHAUSTED')
 *   Other err  → re-throw unchanged
 */
async function rateLimitedGet(url, headers, sendUpdate) {
    async function attempt() {
        return axios.get(url, { headers, httpsAgent: proxyAgent });
    }

    let res;
    try {
        res = await attempt();
    } catch (e) {
        if (e.response?.status !== 429) throw e;
        // First 429 — countdown then retry
        const retryAfter = parseInt(e.response.headers['retry-after'] ?? '60', 10);
        for (let remaining = retryAfter; remaining > 0; remaining--) {
            sendUpdate(`⏸ Rate limited — retrying in ${remaining}s…`, null);
            await new Promise(r => setTimeout(r, 1000));
        }
        try {
            res = await attempt();
        } catch (e2) {
            if (e2.response?.status === 429) throw new Error('RATE_LIMIT_EXHAUSTED');
            throw e2;
        }
    }
    return res;
}

/**
 * Module-scoped fetchList — used by both perform-archive-run and runArchiveQueue.
 * Replaces the identical local function that was inside perform-archive-run.
 */
async function archiveFetchList(url, headers, sendUpdate) {
    let all = [];
    let next = url;
    while (next) {
        const res = await rateLimitedGet(next, headers, sendUpdate);
        all = all.concat(res.data.data);
        next = res.data.links?.next;
    }
    return all;
}
```

- [ ] **Step 2: Remove the now-duplicate local `fetchList` inside `perform-archive-run`**

Delete lines 928–938 inclusive (line 928 is `// Helper to fetch all pages of a resource list`, line 938 is the closing `}` of `fetchList`). The handler will call `archiveFetchList` instead (done in Task 3).

- [ ] **Step 3: Verify the app still starts without errors**

Run `npm start`, open the Archive tab, confirm no DevTools console errors on load. Quit the app.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(archive): add ARCHIVE_CHUNK_SIZE, pendingArchive, rateLimitedGet, archiveFetchList at module scope"
```

---

## Task 2: Extract `runArchiveQueue` from `perform-archive-run`

**Files:**
- Modify: `main.js` (immediately before `ipcMain.handle('perform-archive-run', ...)`)

### Context

The queue-processing loop (lines 1010–1068 in the original file) will be extracted into a standalone async function. Both the initial run and `resume-archive-run` call this with the same logic.

The function signature:
```
runArchiveQueue({ workQueue, startIndex, processedItems, totalItems, propertyId, targetDir, headers, sendUpdate })
```

Returns `{ processedItems, totalItems }` on success. Throws `Error('RATE_LIMIT_EXHAUSTED')` (with `.resumeIndex` attached to the error) if the second 429 occurs mid-queue. Any other error is re-thrown unchanged.

**Important**: inside the extension package fetch (currently `axios.get` at line 1049), replace with `rateLimitedGet`. All `fetchList` calls inside the queue processor (line 1036 — fetching revisions) replace with `archiveFetchList`.

- [ ] **Step 1: Add `runArchiveQueue` function above the `perform-archive-run` handler**

```javascript
/**
 * Process a work queue from startIndex onwards, in chunks of ARCHIVE_CHUNK_SIZE.
 * Returns { processedItems, totalItems } on success.
 * Throws Error('RATE_LIMIT_EXHAUSTED') with .resumeIndex set to the failing chunk's start.
 */
async function runArchiveQueue({ workQueue, startIndex, processedItems, totalItems, propertyId, targetDir, headers, sendUpdate }) {
    let processed = processedItems;

    for (let i = startIndex; i < workQueue.length; i += ARCHIVE_CHUNK_SIZE) {
        const chunk = workQueue.slice(i, i + ARCHIVE_CHUNK_SIZE);

        // Collect any RATE_LIMIT_EXHAUSTED thrown inside the chunk's items
        let rateLimitHit = null;
        await Promise.all(chunk.map(async (job) => {
            const { type, item } = job;
            const itemId = item.id;
            const safeName = sanitizeFolderName(item.attributes.name || item.attributes.display_name || 'unnamed');

            const itemDir = path.join(targetDir, type, `${safeName}_${itemId}`);
            if (!fs.existsSync(itemDir)) fs.mkdirSync(itemDir, { recursive: true });

            try {
                const noRevisionTypes = ['builds', 'libraries', 'environments', 'rule_components'];

                if (noRevisionTypes.includes(type)) {
                    fs.writeFileSync(path.join(itemDir, `${type}_${itemId}.json`), JSON.stringify(item, null, 2));
                } else {
                    const revisionsUrl = `https://reactor.adobe.io/${type}/${itemId}/revisions`;
                    const revisions = await archiveFetchList(revisionsUrl, headers, sendUpdate);

                    revisions.forEach(rev => {
                        const revPath = path.join(itemDir, `rev_${rev.id}.json`);
                        if (!fs.existsSync(revPath)) {
                            fs.writeFileSync(revPath, JSON.stringify(rev, null, 2));
                        }
                    });

                    if (type === 'extensions') {
                        try {
                            const pkgUrl = `https://reactor.adobe.io/extensions/${itemId}/extension_package`;
                            const pkgRes = await rateLimitedGet(pkgUrl, headers, sendUpdate);
                            const pkg = pkgRes.data.data;
                            if (pkg) {
                                fs.writeFileSync(path.join(itemDir, `package_${pkg.id}.json`), JSON.stringify(pkg, null, 2));
                            }
                        } catch (pkgErr) {
                            if (pkgErr.message === 'RATE_LIMIT_EXHAUSTED') throw pkgErr;
                            console.error(`Failed to fetch package for extension ${itemId}:`, pkgErr.message);
                        }
                    }
                }
            } catch (itemErr) {
                if (itemErr.message === 'RATE_LIMIT_EXHAUSTED') {
                    rateLimitHit = itemErr;  // bubble up after all items settle
                } else {
                    console.error(`Failed to archive ${type} ${itemId}:`, itemErr.message);
                }
            }
        }));

        if (rateLimitHit) {
            const err = new Error('RATE_LIMIT_EXHAUSTED');
            err.resumeIndex = i;
            err.processedItems = processed;
            throw err;
        }

        processed += chunk.length;
        const pct = Math.round((processed / totalItems) * 100);
        sendUpdate(`Archived ${processed}/${totalItems} items...`, pct);
    }

    return { processedItems: processed, totalItems };
}
```

- [ ] **Step 2: Verify the function looks correct — no syntax errors**

Run: `node -e "require('./main.js')"` — expect Electron-specific errors (no `app`) but NOT syntax errors.

Actually, since `main.js` uses Electron modules at top-level, syntax-check instead:
```bash
node --check main.js
```
Expected: exits 0 (no output = no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(archive): extract runArchiveQueue with RATE_LIMIT_EXHAUSTED propagation"
```

---

## Task 3: Modify `perform-archive-run` and add `resume-archive-run`

**Files:**
- Modify: `main.js` — the `perform-archive-run` handler (lines ~923–1074) and add a new handler after it

### Context

`perform-archive-run` currently:
1. Defines local `fetchList` (now removed in Task 1)
2. Builds `workQueue` via `fetchList` calls
3. Runs the loop inline (now extracted into `runArchiveQueue` in Task 2)
4. Returns `true` on success

After this task, it will:
1. Call `archiveFetchList` for all list-building (which now routes through `rateLimitedGet`)
2. Catch `RATE_LIMIT_EXHAUSTED` from the list-building phase separately (no queue to resume → throw descriptive error, no `pendingArchive` saved)
3. Call `runArchiveQueue({ workQueue, startIndex: 0, processedItems: 0, totalItems, ... })`
4. On `RATE_LIMIT_EXHAUSTED` from queue phase → save `pendingArchive`, emit progress with `rateLimited: true`, **return** `{ rateLimited: true }` (not throw)
5. On success → clear `pendingArchive`, return `{ success: true }`

The `sendUpdate` signature changes: the `archive-progress` event payload gets an optional `rateLimited` field. To keep backward compat, update `sendUpdate` to pass through extra fields:
```javascript
const sendUpdate = (msg, progress, extra = {}) =>
    event.sender.send('archive-progress', { msg, progress, ...extra });
```

- [ ] **Step 1: Replace the body of `perform-archive-run`**

The handler currently spans lines 923–1074. Replace the entire handler body with:

```javascript
ipcMain.handle('perform-archive-run', async (event, { propertyId, targetDir, types, token, creds }) => {
    // Clear any stale pending state from a previous run
    pendingArchive = null;

    const headers = getHeaders(token, creds);
    const sendUpdate = (msg, progress, extra = {}) =>
        event.sender.send('archive-progress', { msg, progress, ...extra });

    try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        // ----------------------------------------------------------------
        // Phase 1: Build work queue (list-fetching phase)
        // ----------------------------------------------------------------
        const workQueue = [];

        const queueType = async (type, endpoint) => {
            if (types.includes(type)) {
                sendUpdate(`Fetching ${type} list...`, 0);
                try {
                    const items = await archiveFetchList(
                        `https://reactor.adobe.io/properties/${propertyId}/${endpoint}?page[size]=100`,
                        headers, sendUpdate
                    );
                    workQueue.push(...items.map(item => ({ type, item })));
                } catch (err) {
                    if (err.message === 'RATE_LIMIT_EXHAUSTED') throw err;
                    console.error(`Failed to list ${type}:`, err.message);
                }
            }
        };

        try {
            await queueType('rules', 'rules');
            await queueType('data_elements', 'data_elements');
            await queueType('extensions', 'extensions');
            await queueType('environments', 'environments');
            await queueType('libraries', 'libraries');

            // Builds (via Libraries)
            if (types.includes('builds')) {
                sendUpdate('Fetching Libraries for Build scan...', 0);
                let libsForBuilds = workQueue.filter(i => i.type === 'libraries').map(i => i.item);
                if (libsForBuilds.length === 0) {
                    libsForBuilds = await archiveFetchList(
                        `https://reactor.adobe.io/properties/${propertyId}/libraries?page[size]=100`,
                        headers, sendUpdate
                    );
                }
                for (const lib of libsForBuilds) {
                    try {
                        const builds = await archiveFetchList(
                            `https://reactor.adobe.io/libraries/${lib.id}/builds?page[size]=100`,
                            headers, sendUpdate
                        );
                        workQueue.push(...builds.map(b => ({ type: 'builds', item: b })));
                    } catch (e) {
                        if (e.message === 'RATE_LIMIT_EXHAUSTED') throw e;
                        /* ignore — library may have no builds */
                    }
                }
            }

            // Rule Components (via Rules)
            if (types.includes('rule_components')) {
                sendUpdate('Fetching Rules to find Components...', 0);
                let rulesForComps = workQueue.filter(i => i.type === 'rules').map(i => i.item);
                if (rulesForComps.length === 0) {
                    rulesForComps = await archiveFetchList(
                        `https://reactor.adobe.io/properties/${propertyId}/rules?page[size]=100`,
                        headers, sendUpdate
                    );
                }
                for (const r of rulesForComps) {
                    try {
                        const comps = await archiveFetchList(
                            `https://reactor.adobe.io/rules/${r.id}/rule_components?page[size]=100`,
                            headers, sendUpdate
                        );
                        workQueue.push(...comps.map(c => ({ type: 'rule_components', item: c })));
                    } catch (e) {
                        if (e.message === 'RATE_LIMIT_EXHAUSTED') throw e;
                        /* ignore */
                    }
                }
            }
        } catch (listErr) {
            if (listErr.message === 'RATE_LIMIT_EXHAUSTED') {
                throw new Error('Archive paused: rate limited twice during list setup. Please wait and try again.');
            }
            throw listErr;
        }

        const totalItems = workQueue.length;
        sendUpdate(`Found ${totalItems} items to archive. Starting...`, 0);

        // ----------------------------------------------------------------
        // Phase 2: Process queue
        // ----------------------------------------------------------------
        try {
            await runArchiveQueue({
                workQueue, startIndex: 0, processedItems: 0, totalItems,
                propertyId, targetDir, headers, sendUpdate
            });
        } catch (queueErr) {
            if (queueErr.message === 'RATE_LIMIT_EXHAUSTED') {
                const pct = Math.round((queueErr.processedItems / totalItems) * 100);
                pendingArchive = {
                    workQueue,
                    resumeIndex: queueErr.resumeIndex,
                    processedItems: queueErr.processedItems,
                    totalItems,
                    propertyId, targetDir, types, token, creds
                };
                sendUpdate('⛔ Rate limited twice. Click Resume when ready.', pct, { rateLimited: true });
                return { rateLimited: true };
            }
            throw queueErr;
        }

        pendingArchive = null;
        return { success: true };

    } catch (e) {
        throw new Error(`Archive Run Failed: ${e.message}`);
    }
});
```

- [ ] **Step 2: Add `resume-archive-run` handler immediately after `perform-archive-run`**

```javascript
ipcMain.handle('resume-archive-run', async (event) => {
    if (!pendingArchive) {
        return { success: false, error: 'No paused archive in this session' };
    }

    const { workQueue, resumeIndex, processedItems, totalItems,
            propertyId, targetDir, token, creds } = pendingArchive;
    const headers = getHeaders(token, creds);
    const sendUpdate = (msg, progress, extra = {}) =>
        event.sender.send('archive-progress', { msg, progress, ...extra });

    try {
        await runArchiveQueue({
            workQueue, startIndex: resumeIndex, processedItems, totalItems,
            propertyId, targetDir, headers, sendUpdate
        });
        pendingArchive = null;
        return { success: true };
    } catch (e) {
        if (e.message === 'RATE_LIMIT_EXHAUSTED') {
            const pct = Math.round((e.processedItems / totalItems) * 100);
            pendingArchive.resumeIndex = e.resumeIndex;
            pendingArchive.processedItems = e.processedItems;
            sendUpdate('⛔ Rate limited twice. Click Resume when ready.', pct, { rateLimited: true });
            return { rateLimited: true };
        }
        return { success: false, error: e.message };
    }
});
```

- [ ] **Step 3: Syntax-check**

```bash
node --check main.js
```
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(archive): modify perform-archive-run for rate-limit pause; add resume-archive-run handler"
```

---

## Task 4: UI changes — Resume button, archive.js, and E2E fixtures

**Files:**
- Modify: `index.html` — add `#btn-resume-archive`
- Modify: `modules/archive.js` — break loop on `rateLimited`, show/hide Resume button, add `resumeArchive()`
- Modify: `e2e/fixtures.js` — add `resume-archive-run` mock channel

### Context

`index.html` archive tab currently has `#btn-start-archive` and `#btn-scan-archive`. The new `#btn-resume-archive` sits alongside `#btn-start-archive`, hidden by default (`display:none`).

`modules/archive.js` `startArchive()` currently discards the return value of `ipcRenderer.invoke('perform-archive-run', ...)`. It must now:
- Check if `result?.rateLimited === true` → break the property loop, show Resume button, disable Start button
- Otherwise check `result?.success === true` → log complete

The `archive-progress` listener currently just logs every event. When the event has `rateLimited: true`, it must additionally show `#btn-resume-archive` and disable `#btn-start-archive`.

`resumeArchive()` calls `ipcRenderer.invoke('resume-archive-run')`:
- `{ success: true }` → hide Resume, re-enable Start, log `✅ Archive resumed and completed`
- `{ rateLimited: true }` → log the new pause message (button stays)
- `{ success: false, error }` → log error, hide Resume

`e2e/fixtures.js` `injectIPCMocks` needs `'resume-archive-run'` in the channels array and a stub handler returning `{ success: true }`.

- [ ] **Step 1: Add `#btn-resume-archive` to `index.html`**

Find the archive tab's button row. It currently contains `#btn-start-archive`. Add the Resume button **directly after** `#btn-start-archive`:

```html
<button id="btn-resume-archive" class="primary" onclick="resumeArchive()" style="display:none;">Resume Archive</button>
```

- [ ] **Step 2: Update `modules/archive.js`**

Replace the entire file content with the updated version below. The changes are:
1. `startArchive()` — update `archive-progress` listener to handle `rateLimited`, check return value of invoke, break loop if `rateLimited`
2. Add `resumeArchive()` function
3. Export and expose `resumeArchive`

```javascript
/**
 * Archive Module
 * Handles scanning properties and running full historical exports/archiving.
 */

const { ipcRenderer } = require('electron');
const ui = require('./ui-helpers');

// --- Folder Selection ---
async function selectArchiveFolder() {
    try {
        const path = await ipcRenderer.invoke('select-folder');
        if (path) {
            document.getElementById('archive-folder-path').value = path;
        }
    } catch (e) {
        console.error('selectArchiveFolder error:', e);
        alert('Error: ' + e.message);
    }
}

// --- Scan for Archive ---
async function scanForArchive() {
    const properties = ui.getSelectedProperties();
    if (properties.length === 0) {
        return alert('Please select one or more properties to perform a scan/archive.');
    }

    const types = [];
    if (document.getElementById('chk-scan-rules').checked) types.push('rules');
    if (document.getElementById('chk-scan-de').checked) types.push('data_elements');
    if (document.getElementById('chk-scan-ext').checked) types.push('extensions');
    if (document.getElementById('chk-scan-rc').checked) types.push('rule_components');
    if (document.getElementById('chk-scan-env').checked) types.push('environments');
    if (document.getElementById('chk-scan-lib').checked) types.push('libraries');

    if (types.length === 0) return alert('Select at least one type to scan.');

    ui.logArchive(`Scanning ${properties.length} properties for items...`, 0);
    document.getElementById('btn-start-archive').disabled = true;

    window.lastScanResult = {};
    let totalItemsFound = 0;

    try {
        for (const property of properties) {
            ui.logArchive(`\n--- [${property.name}] Starting Scan ---`);

            const counts = await ipcRenderer.invoke('perform-archive-scan', {
                propertyId: property.id,
                types,
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });

            ui.logArchive(`[${property.name}] Scan Complete. Found ${counts.total} items total:`);
            ui.logArchive(`[${property.name}] - Rules: ${counts.rules || 0}`);
            ui.logArchive(`[${property.name}] - Data Elements: ${counts.data_elements || 0}`);
            ui.logArchive(`[${property.name}] - Extensions: ${counts.extensions || 0}`);

            totalItemsFound += counts.total;
            window.lastScanResult[property.id] = { counts, types, name: property.name };
        }

        ui.logArchive(`\n✅ All Scans Complete! Total items found across all properties: ${totalItemsFound}`, 100);
        document.getElementById('btn-start-archive').disabled = false;

    } catch (e) {
        ui.logArchive('❌ Scan Failed: ' + e.message);
        document.getElementById('btn-start-archive').disabled = false;
    }
}

// --- Start Archive Run ---
async function startArchive() {
    const properties = ui.getSelectedProperties();

    if (properties.length === 0) {
        return alert('Please select one or more properties to start the archive process.');
    }

    const folder = document.getElementById('archive-folder-path').value;
    if (!folder) return alert('Please select an archive location.');

    if (!window.lastScanResult || Object.keys(window.lastScanResult).length === 0) {
        return alert('Please run a scan first.');
    }

    document.getElementById('archive-console').innerHTML = '';
    document.getElementById('btn-resume-archive').style.display = 'none';
    ui.logArchive(`Starting Archive Process for ${properties.length} properties...`, 0);

    document.getElementById('btn-start-archive').disabled = true;

    // Listener for progress — shows Resume button on rateLimited events
    const logListener = (e, { msg, progress, rateLimited }) => {
        ui.logArchive(msg, progress);
        if (rateLimited) {
            document.getElementById('btn-resume-archive').style.display = '';
            document.getElementById('btn-start-archive').disabled = true;
        }
    };
    ipcRenderer.on('archive-progress', logListener);

    try {
        for (const property of properties) {
            const scanData = window.lastScanResult[property.id];

            if (!scanData) {
                ui.logArchive(`[${property.name}] ⚠️ Skipping archive: no scan data found.`);
                continue;
            }

            ui.logArchive(`\n--- [${property.name}] Starting Archive Run ---`);

            const result = await ipcRenderer.invoke('perform-archive-run', {
                propertyId: property.id,
                targetDir: `${folder}/${property.name}`,
                types: scanData.types,
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });

            if (result?.rateLimited) {
                // Paused — Resume button already shown by progress listener
                break;
            }

            ui.logArchive(`[${property.name}] ✅ Archive Complete!`, 100);
        }

        if (!document.getElementById('btn-resume-archive').style.display ||
            document.getElementById('btn-resume-archive').style.display === 'none') {
            ui.logArchive('\n✅ All Archiving Runs Complete!', 100);
            document.getElementById('btn-start-archive').disabled = false;
        }
    } catch (e) {
        ui.logArchive('❌ Archive Failed: ' + e.message);
        document.getElementById('btn-start-archive').disabled = false;
    } finally {
        ipcRenderer.removeListener('archive-progress', logListener);
    }
}

// --- Resume Archive Run ---
async function resumeArchive() {
    document.getElementById('btn-resume-archive').disabled = true;

    const logListener = (e, { msg, progress, rateLimited }) => {
        ui.logArchive(msg, progress);
        if (rateLimited) {
            document.getElementById('btn-resume-archive').disabled = false;
        }
    };
    ipcRenderer.on('archive-progress', logListener);

    try {
        const result = await ipcRenderer.invoke('resume-archive-run');

        if (result?.success) {
            ui.logArchive('✅ Archive resumed and completed', 100);
            document.getElementById('btn-resume-archive').style.display = 'none';
            document.getElementById('btn-start-archive').disabled = false;
        } else if (result?.rateLimited) {
            // Progress listener already logged the pause message; button stays visible
            document.getElementById('btn-resume-archive').disabled = false;
        } else {
            ui.logArchive(`❌ Resume failed: ${result?.error ?? 'session expired or unknown error'}`);
            document.getElementById('btn-resume-archive').style.display = 'none';
            document.getElementById('btn-start-archive').disabled = false;
        }
    } catch (e) {
        ui.logArchive('❌ Resume failed: ' + e.message);
        document.getElementById('btn-resume-archive').style.display = 'none';
        document.getElementById('btn-start-archive').disabled = false;
    } finally {
        ipcRenderer.removeListener('archive-progress', logListener);
    }
}

// --- Export to window ---
window.selectArchiveFolder = selectArchiveFolder;
window.scanForArchive = scanForArchive;
window.startArchive = startArchive;
window.resumeArchive = resumeArchive;

module.exports = {
    selectArchiveFolder,
    scanForArchive,
    startArchive,
    resumeArchive
};
```

- [ ] **Step 3: Add `resume-archive-run` to `e2e/fixtures.js`**

In `injectIPCMocks`, add `'resume-archive-run'` to the `channels` array (line 56–62):

```javascript
const channels = [
    'get-saved-config', 'save-config-field',
    'adobe-login', 'get-companies', 'get-properties',
    'get-environments', 'get-libraries', 'get-environment-library',
    'perform-environment-comparison',
    'get-cache-stats', 'clear-cache',
    'resume-archive-run',   // NEW
];
```

Add the stub handler after the `clear-cache` handler:

```javascript
ipcMain.handle('resume-archive-run', () => ({ success: true }));
```

- [ ] **Step 4: Run the E2E test suite to verify no regressions**

```bash
npx playwright test
```
Expected: all 27 tests pass (the new `#btn-resume-archive` is hidden by default, so no existing archive-tab selectors break).

- [ ] **Step 5: Run syntax check**

```bash
node --check main.js
```
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add index.html modules/archive.js e2e/fixtures.js
git commit -m "feat(archive): add Resume button, rateLimited progress handling, and resumeArchive() in UI"
```

---

## Manual Verification

After all tasks are complete, verify the happy path and rate-limit path manually:

**Happy path:**
1. `npm start` → Archive tab → select a property → run Scan → run Archive
2. Confirm archive completes, `✅ All Archiving Runs Complete!` logged, Start button re-enabled, Resume button not visible

**Rate-limit simulation** (requires a real 429 or mocked main process):
1. First 429: countdown appears in log (e.g., `⏸ Rate limited — retrying in 59s…`)
2. Second 429: `⛔ Rate limited twice. Click Resume when ready.` + Resume button appears
3. Click Resume → archive continues from paused point
4. On completion: `✅ Archive resumed and completed`, Resume hidden, Start re-enabled

**App restart (session expiry):**
1. Hit the ⛔ state, quit and relaunch app
2. Click Resume → log shows `❌ Resume failed: No paused archive in this session`
3. Resume button hides, Start button re-enables

---

## Testing Notes

- **No Jest unit tests** exist for `perform-archive-run` — the function makes live network calls and the logic is too entangled to mock cheaply at this stage. Rate-limit behavior requires a real 429 response, so manual testing is the gate.
- **E2E Playwright tests** (`e2e/04-tabs.spec.js`) only assert that archive tab elements exist and the console is visible. Adding `#btn-resume-archive` (hidden) does not break any existing selector. The new `resume-archive-run` mock channel prevents unhandled IPC errors if any test inadvertently invokes it.
