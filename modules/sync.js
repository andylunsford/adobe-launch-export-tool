/**
 * Developer Sync Module
 * Handles local download, status check (diff), and push to Launch.
 */

import * as ui from './ui-helpers.js';

// --- Folder Selection ---
async function selectSyncFolder() {
    try {
        const path = await window.api.selectFolder();
        if (path) document.getElementById('sync-folder-path').value = path;
    } catch (e) {
        console.error("selectSyncFolder error:", e);
        alert("Error: " + e.message);
    }
}

// One line per item: its folder, and its name (a component's with its rule's)
function itemLine(mark, item, note = '') {
    const name = item.rule_name ? `${item.rule_name} › ${item.name}` : item.name;
    return `  [${mark}] ${item.path || `${item.type}/${item.id}`}${name ? ` (${name})` : ''}${note}`;
}

function logList(property, title, mark, items) {
    if (items.length === 0) return;
    ui.logSync(`[${property.name}] ${title} [${items.length}]`);
    items.forEach(item => ui.logSync(itemLine(mark, item)));
}

function reportDownload(property, summary) {
    ui.logSync(`[${property.name}] ✅ Downloaded ${summary.written} items.`);
    if (summary.removedFiles > 0) {
        ui.logSync(`[${property.name}] Removed ${summary.removedFiles} code files the items no longer have.`);
    }
    logList(property, 'Moved to _deleted (deleted in Launch)', 'x', summary.setAside);
    logList(property, 'Kept local edits (to take Launch\'s version, delete the folder and download again)', '~', summary.keptLocal);
    logList(property, 'Kept, though Launch no longer lists them (local edits, or not downloaded by this tool)', '?', summary.keptUnlisted);
    if (summary.incomplete.length > 0) {
        ui.logSync(`[${property.name}] ⚠ Some rules' components couldn't be listed, so no rule component folders were moved or relinked.`);
    }
}

// --- Download Initialization ---
async function initSyncDownload() {
    const properties = ui.getSelectedProperties();
    const folder = document.getElementById('sync-folder-path').value;
    
    if (properties.length === 0) return alert("Please select one or more properties from the property list.");
    if (!folder) return alert("Please select a local folder.");

    document.getElementById('sync-console').innerHTML = ''; // Clear log
    ui.logSync(`Starting Initialization for ${properties.length} properties...`);

    // Listener for logs
    const offSyncLog = window.api.onSyncLog((msg) => ui.logSync(msg));

    try {
        for (const property of properties) {
            ui.logSync(`[${property.name}] Starting download...`);

            const summary = await window.api.performSyncDownload({
                property: { id: property.id, name: property.name },
                targetDir: `${folder}/${property.name}`, // APPEND PROPERTY NAME
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });
            reportDownload(property, summary);
        }
        ui.logSync("All downloads complete.");
    } catch (e) {
        ui.logSync(`❌ Error: ${e.message}`);
    } finally {
        offSyncLog();
    }
}

// --- Sync Status Check ---
async function checkSyncStatus() {
    const properties = ui.getSelectedProperties();
    const folder = document.getElementById('sync-folder-path').value;
    
    if (properties.length === 0) return alert("Please select one or more properties from the property list.");
    if (!folder) return alert("Please select a local folder.");

    document.getElementById('sync-console').innerHTML = ''; // Clear log
    ui.logSync(`Checking Status (Diffing) for ${properties.length} properties...`);

    for (const property of properties) {
        ui.logSync(`\n--- [${property.name}] Starting Diff Check ---`);

        try {
            const result = await window.api.performSyncDiff({
                property: { id: property.id, name: property.name }, // Pass property context
                targetDir: `${folder}/${property.name}`, // APPEND PROPERTY NAME
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });

            if (!result.hasBase) {
                ui.logSync(`[${property.name}] No download record yet, so each folder was compared with its own data.json. Download again to create one.`);
            }
            logList(property, 'Files To Be Pushed (New)', '+', result.added);
            logList(property, 'Files To Be Pushed (Modified)', '~', result.modified);
            logList(property, 'Files To Be Pushed (Deleted Locally)', '-', result.deleted);
            logList(property, 'Files To Be Pulled (New/Modified in Launch)', '<', result.behind);
            logList(property, 'Deleted in Launch (Download moves these to _deleted)', 'x', result.deletedInLaunch);
            if (result.conflict.length > 0) {
                ui.logSync(`[${property.name}] ⚠ Conflicts [${result.conflict.length}]`);
                result.conflict.forEach(item => ui.logSync(itemLine('!', item, `: ${item.details.reason}`)));
            }
            result.errors.forEach(error => ui.logSync(`[${property.name}] ⚠ ${error.path ? `${error.path}: ` : ''}${error.message}`));

            const states = ['added', 'modified', 'deleted', 'behind', 'deletedInLaunch', 'conflict', 'errors'];
            if (states.every(state => result[state].length === 0)) {
                ui.logSync(`[${property.name}] ✅ Everything is in sync!`);
            }

        } catch (e) {
            ui.logSync(`[${property.name}] ❌ Error: ${e.message}`);
        }
    }
}

// --- Push to Launch ---
async function pushToLaunch() {
    const properties = ui.getSelectedProperties();
    const folder = document.getElementById('sync-folder-path').value;

    if (properties.length === 0) return alert("Please select one or more properties from the property list.");
    if (!folder) return alert("Please select a local folder.");
    
    document.getElementById('sync-console').innerHTML = '';
    ui.logSync(`Starting Push to Launch for ${properties.length} properties...`);

    for (const property of properties) {
        ui.logSync(`\n--- [${property.name}] Starting Push ---`);

        try {
            const result = await window.api.performSyncPush({
                property: { id: property.id, name: property.name }, // Pass property context
                targetDir: `${folder}/${property.name}`, // APPEND PROPERTY NAME
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });
            ui.logSync(`[${property.name}] ✅ Push Complete! ${result}`);
        } catch (e) {
            ui.logSync(`[${property.name}] ❌ Error: ${e.message}`);
        }
    }
}

// --- Export to window ---
window.selectSyncFolder = selectSyncFolder;
window.initSyncDownload = initSyncDownload;
window.checkSyncStatus = checkSyncStatus;
window.pushToLaunch = pushToLaunch;

export {
    selectSyncFolder,
    initSyncDownload,
    checkSyncStatus,
    pushToLaunch
};
