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
