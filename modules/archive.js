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
        console.error("selectArchiveFolder error:", e);
        alert("Error: " + e.message);
    }
}

// --- Scan for Archive ---
async function scanForArchive() {
    const properties = ui.getSelectedProperties();
    if (properties.length === 0) {
        return alert("Please select one or more properties to perform a scan/archive.");
    }

    const types = [];
    if (document.getElementById('chk-scan-rules').checked) types.push('rules');
    if (document.getElementById('chk-scan-de').checked) types.push('data_elements');
    if (document.getElementById('chk-scan-ext').checked) types.push('extensions');
    if (document.getElementById('chk-scan-rc').checked) types.push('rule_components');
    if (document.getElementById('chk-scan-env').checked) types.push('environments');
    if (document.getElementById('chk-scan-lib').checked) types.push('libraries');

    if (types.length === 0) return alert("Select at least one type to scan.");

    ui.logArchive(`Scanning ${properties.length} properties for items...`, 0);
    document.getElementById('btn-start-archive').disabled = true;

    // Reset scan result storage
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
            
            // Log details
            ui.logArchive(`[${property.name}] Scan Complete. Found ${counts.total} items total:`);
            ui.logArchive(`[${property.name}] - Rules: ${counts.rules || 0}`);
            ui.logArchive(`[${property.name}] - Data Elements: ${counts.data_elements || 0}`);
            ui.logArchive(`[${property.name}] - Extensions: ${counts.extensions || 0}`);
            // Note: Single property UI counters are now ignored, relying only on console.

            totalItemsFound += counts.total;
            
            // Store scan result for archiving
            window.lastScanResult[property.id] = { counts, types, name: property.name };
        }
        
        ui.logArchive(`\n✅ All Scans Complete! Total items found across all properties: ${totalItemsFound}`, 100);
        document.getElementById('btn-start-archive').disabled = false;

    } catch (e) {
        ui.logArchive("❌ Scan Failed: " + e.message);
    }
}

// --- Start Archive Run ---
async function startArchive() {
    const properties = ui.getSelectedProperties();
    
    if (properties.length === 0) {
        return alert("Please select one or more properties to start the archive process.");
    }

    const folder = document.getElementById('archive-folder-path').value;
    if (!folder) return alert("Please select an archive location.");
    
    if (!window.lastScanResult || Object.keys(window.lastScanResult).length === 0) return alert("Please run a scan first.");

    document.getElementById('archive-console').innerHTML = '';
    ui.logArchive(`Starting Archive Process for ${properties.length} properties...`, 0);

    // Listener for progress
    const logListener = (e, { msg, progress }) => ui.logArchive(msg, progress);
    ipcRenderer.on('archive-progress', logListener);

    try {
        for (const property of properties) {
            const scanData = window.lastScanResult[property.id];

            if (!scanData) {
                ui.logArchive(`[${property.name}] ⚠️ Skipping archive: no scan data found.`);
                continue;
            }
            
            ui.logArchive(`\n--- [${property.name}] Starting Archive Run ---`);
            
            await ipcRenderer.invoke('perform-archive-run', {
                propertyId: property.id,
                targetDir: `${folder}/${property.name}`, // APPEND PROPERTY NAME
                types: scanData.types,
                token: ui.getGlobalToken(),
                creds: ui.getCurrentCreds()
            });
            ui.logArchive(`[${property.name}] ✅ Archive Complete!`, 100);
        }
        ui.logArchive("\n✅ All Archiving Runs Complete!", 100);
    } catch (e) {
        ui.logArchive("❌ Archive Failed: " + e.message);
    } finally {
        ipcRenderer.removeListener('archive-progress', logListener);
    }
}

// --- Export to window ---
window.selectArchiveFolder = selectArchiveFolder;
window.scanForArchive = scanForArchive;
window.startArchive = startArchive;

module.exports = {
    selectArchiveFolder,
    scanForArchive,
    startArchive
};
