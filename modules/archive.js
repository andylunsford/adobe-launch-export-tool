/**
 * Archive Module
 * Handles scanning properties and running full historical exports/archiving.
 */

import * as ui from './ui-helpers.js';

// --- Folder Selection ---
async function selectArchiveFolder() {
    try {
        const path = await window.api.selectFolder();
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

    const types = SCAN_TYPES.filter(t => document.getElementById(t.checkbox).checked);
    if (types.length === 0) return alert('Select at least one type to scan.');
    const typeKeys = types.map(t => t.key);

    ui.logArchive(`Scanning ${properties.length} properties for items...`, 0);
    document.getElementById('btn-start-archive').disabled = true;
    SCAN_TYPES.forEach(t => { document.getElementById(t.badge).textContent = '-'; });

    // Every property starts as a pending row and fills in as its scan returns.
    window.lastScanResult = {};
    const rows = properties.map(property => ({ property, counts: null, error: null }));
    renderScanTable(types, rows);

    let scanned = 0;
    for (const row of rows) {
        const { property } = row;
        ui.logArchive(`\n--- [${property.name}] Starting Scan ---`);
        try {
            row.counts = await window.api.performArchiveScan({
                propertyId: property.id,
                types: typeKeys,
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });
            window.lastScanResult[property.id] = { counts: row.counts, types: typeKeys, name: property.name };
            ui.logArchive(`[${property.name}] Scan Complete. Found ${row.counts.total} items total:`);
            types.forEach(t => ui.logArchive(`[${property.name}] - ${t.label}: ${formatCount(row.counts[t.key])}`));
        } catch (e) {
            // One property failing shouldn't stop the rest; it is skipped on archive.
            // Drop Electron's "Error invoking remote method '…': Error:" wrapper.
            row.error = e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
            ui.logArchive(`[${property.name}] ❌ Scan Failed: ${e.message}`);
        }
        scanned++;
        ui.logArchive(`[${property.name}] (${scanned}/${rows.length} scanned)`, Math.round((scanned / rows.length) * 100));
        renderScanTable(types, rows);
    }

    const succeeded = rows.filter(r => r.counts);
    const grandTotal = succeeded.reduce((sum, r) => sum + r.counts.total, 0);
    types.forEach(t => {
        document.getElementById(t.badge).textContent = t.countable
            ? sumType(succeeded, t.key).toLocaleString()
            : 'via rules';
    });

    const failed = rows.length - succeeded.length;
    ui.logArchive(failed === 0
        ? `\n✅ All Scans Complete! Total items found across all properties: ${grandTotal}`
        : `\n⚠️ Scans finished with ${failed} failure(s). Total items found across ${succeeded.length} properties: ${grandTotal}`, 100);
    document.getElementById('btn-start-archive').disabled = succeeded.length === 0;
}

// --- Scan Result Helpers ---
// Rule components can't be listed in bulk (the API returns 403), so they are
// archived through their rules and have no count of their own.
const SCAN_TYPES = [
    { key: 'rules', label: 'Rules', checkbox: 'chk-scan-rules', badge: 'count-rules', countable: true },
    { key: 'data_elements', label: 'Data Elements', checkbox: 'chk-scan-de', badge: 'count-de', countable: true },
    { key: 'extensions', label: 'Extensions', checkbox: 'chk-scan-ext', badge: 'count-ext', countable: true },
    { key: 'rule_components', label: 'Rule Components', checkbox: 'chk-scan-rc', badge: 'count-rc', countable: false },
    { key: 'environments', label: 'Environments', checkbox: 'chk-scan-env', badge: 'count-env', countable: true },
    { key: 'libraries', label: 'Libraries', checkbox: 'chk-scan-lib', badge: 'count-lib', countable: true }
];

function formatCount(value) {
    return typeof value === 'number' ? value.toLocaleString() : 'via rules';
}

function sumType(rows, key) {
    return rows.reduce((sum, r) => sum + (typeof r.counts[key] === 'number' ? r.counts[key] : 0), 0);
}

function cell(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
}

// One row per property, one column per scanned type, a total column and a
// totals footer. Pending rows show "…"; failed rows show their error.
function renderScanTable(types, rows) {
    const table = document.getElementById('archive-scan-table');
    table.innerHTML = '';

    const head = table.createTHead().insertRow();
    head.append(cell('th', 'Property'), ...types.map(t => cell('th', t.label)), cell('th', 'Total'));

    const body = table.createTBody();
    rows.forEach(({ property, counts, error }) => {
        const tr = body.insertRow();
        tr.dataset.propertyId = property.id;
        tr.append(cell('td', property.name));
        if (error) {
            const err = cell('td', `Scan failed: ${error}`, 'scan-error');
            err.colSpan = types.length + 1;
            tr.append(err);
        } else if (!counts) {
            tr.append(...[...types, null].map(() => cell('td', '…', 'scan-pending')));
        } else {
            tr.append(
                ...types.map(t => cell('td', formatCount(counts[t.key]), t.countable ? '' : 'scan-na')),
                cell('td', counts.total.toLocaleString())
            );
        }
    });

    const done = rows.filter(r => r.counts);
    if (rows.length > 1 && done.length > 0) {
        const foot = table.createTFoot().insertRow();
        foot.append(
            cell('td', 'All properties'),
            ...types.map(t => cell('td', t.countable ? sumType(done, t.key).toLocaleString() : '—', t.countable ? '' : 'scan-na')),
            cell('td', done.reduce((sum, r) => sum + r.counts.total, 0).toLocaleString())
        );
    }

    document.getElementById('archive-scan-results').classList.remove('hidden');
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
    const offProgress = window.api.onArchiveProgress(({ msg, progress, rateLimited }) => {
        ui.logArchive(msg, progress);
        if (rateLimited) {
            document.getElementById('btn-resume-archive').style.display = '';
            document.getElementById('btn-start-archive').disabled = true;
        }
    });

    try {
        for (const property of properties) {
            const scanData = window.lastScanResult[property.id];

            if (!scanData) {
                ui.logArchive(`[${property.name}] ⚠️ Skipping archive: no scan data found.`);
                continue;
            }

            ui.logArchive(`\n--- [${property.name}] Starting Archive Run ---`);

            const result = await window.api.performArchiveRun({
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

        if (document.getElementById('btn-resume-archive').style.display === 'none') {
            ui.logArchive('\n✅ All Archiving Runs Complete!', 100);
            document.getElementById('btn-start-archive').disabled = false;
        }
    } catch (e) {
        ui.logArchive('❌ Archive Failed: ' + e.message);
        document.getElementById('btn-start-archive').disabled = false;
    } finally {
        offProgress();
    }
}

// --- Resume Archive Run ---
async function resumeArchive() {
    document.getElementById('btn-resume-archive').disabled = true;

    const offProgress = window.api.onArchiveProgress(({ msg, progress, rateLimited }) => {
        ui.logArchive(msg, progress);
        if (rateLimited) {
            document.getElementById('btn-resume-archive').disabled = false;
        }
    });

    try {
        const result = await window.api.resumeArchiveRun();

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
        offProgress();
    }
}

// --- Export to window ---
window.selectArchiveFolder = selectArchiveFolder;
window.scanForArchive = scanForArchive;
window.startArchive = startArchive;
window.resumeArchive = resumeArchive;

export {
    selectArchiveFolder,
    scanForArchive,
    startArchive,
    resumeArchive
};
