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

            const result = await window.api.performSyncDownload({
                property: { id: property.id, name: property.name },
                targetDir: `${folder}/${property.name}`, // APPEND PROPERTY NAME
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });
            ui.logSync(`[${property.name}] ✅ ${result}`);
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

            if (result.added.length > 0) {
                ui.logSync(`[${property.name}] Files To Be Pushed (New) [${result.added.length}]`);
                result.added.forEach(f => ui.logSync(`  [+] ${f.path}`));
            }
            if (result.modified.length > 0) {
                ui.logSync(`[${property.name}] Files To Be Pushed (Modified) [${result.modified.length}]`);
                result.modified.forEach(f => ui.logSync(`  [~] ${f.path}`));
            }
            if (result.behind.length > 0) {
                ui.logSync(`[${property.name}] Files To Be Pulled (New/Modified in Launch) [${result.behind.length}]`);
                result.behind.forEach(f => ui.logSync(`  [<] ${f.path}`));
            }
            
            if (result.added.length === 0 && result.modified.length === 0 && result.behind.length === 0) {
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
