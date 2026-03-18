/**
 * Export Module
 * Handles selection of properties and running the bulk export job.
 */

const { ipcRenderer, shell } = require('electron');
const ui = require('./ui-helpers');

// --- Start Bulk Export Job ---
async function startExportJob() {
    const checks = document.querySelectorAll('.prop-check:checked');
    const properties = Array.from(checks).map(cb => ({ id: cb.value, name: cb.dataset.name }));

    if (properties.length === 0) {
        alert("Please select at least one property to export.");
        return;
    }

    const types = [];
    if (document.getElementById('opt-full-export')?.checked) types.push('full');
    if (document.getElementById('opt-library-export')?.checked) types.push('library');
    if (types.length === 0) types.push('full');

    ui.showLoading(`Exporting ${properties.length} properties...`);

    try {
        const result = await ipcRenderer.invoke('perform-export', {
            properties,
            types,
            token: ui.getGlobalToken(),
            creds: ui.getCurrentCreds()
        });

        ui.hideLoading();
        if (result && result.targetDir) {
            alert(`✅ Export Complete! Files saved to:\n\n${result.targetDir}`);
            shell.openPath(result.targetDir);
        } else {
            alert("❌ Export Failed: The export process returned an error.");
        }

    } catch (e) {
        ui.hideLoading();
        alert("❌ Export Failed: " + e.message);
    }
}

// --- Download Release Notes ---
async function downloadReleaseNotes() {
    const checks = document.querySelectorAll('.prop-check:checked');
    const propertyIds = Array.from(checks).map(cb => cb.value);

    if (propertyIds.length === 0) {
        alert("Please select at least one property to download notes for.");
        return;
    }

    ui.showLoading(`Downloading Release Notes for ${propertyIds.length} properties...`);

    try {
        const result = await ipcRenderer.invoke('download-notes', {
            propertyIds,
            token: ui.getGlobalToken(),
            creds: ui.getCurrentCreds()
        });

        ui.hideLoading();
        if (result.targetDir) {
            alert(`✅ Release Notes Download Complete! Files saved to:\n\n${result.targetDir}`);
            shell.openPath(result.targetDir);
        } else {
            alert("❌ Download Failed: The notes download process returned an error.");
        }
    } catch (e) {
        ui.hideLoading();
        alert("❌ Download Failed: " + e.message);
    }
}

// --- Export to window ---
window.startExportJob = startExportJob;
window.downloadReleaseNotes = downloadReleaseNotes;

module.exports = {
    startExportJob,
    downloadReleaseNotes
};
