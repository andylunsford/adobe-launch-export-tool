/**
 * Export Module
 * Handles selection of properties and running the bulk export job.
 */

const { ipcRenderer, shell } = require('electron');
const ui = require('./ui-helpers');

// --- Start Bulk Export Job ---
async function startExportJob() {
    const checks = document.querySelectorAll('.prop-check:checked');
    const propertyIds = Array.from(checks).map(cb => cb.value);
    const propertyNames = Array.from(checks).map(cb => cb.dataset.name);

    if (propertyIds.length === 0) {
        alert("Please select at least one property to export.");
        return;
    }

    const exportMode = document.querySelector('input[name="export-mode"]:checked').value;
    const notesPath = document.getElementById('notes-path-input').value;

    ui.showLoading(`Exporting ${propertyIds.length} properties...`);

    try {
        const result = await ipcRenderer.invoke('perform-export', {
            propertyIds,
            propertyNames,
            exportMode,
            notesPath,
            token: ui.getGlobalToken(),
            creds: ui.getCurrentCreds()
        });
        
        const { targetDir } = result;

        ui.hideLoading();
        if (targetDir) {
            alert(`✅ Export Complete! Files saved to:\n\n${targetDir}`);
            shell.openPath(targetDir);
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
