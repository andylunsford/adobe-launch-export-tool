/**
 * Developer Sync Module
 * Handles local download (of a property, or of one library), status check (diff),
 * push to Launch, and generating a test build from a library.
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

async function selectOverridesFolder() {
    try {
        const path = await window.api.selectFolder();
        if (!path) return;
        document.getElementById('test-build-overrides-path').value = path;
        await window.api.saveConfigField({ key: 'test_build_overrides_dir', value: path });
    } catch (e) {
        console.error("selectOverridesFolder error:", e);
        alert("Error: " + e.message);
    }
}

// The overrides folder chosen last time, read once: when the Developer Sync tab is
// first shown (renderer.js), or when Generate needs it first. Not when this module is
// imported: that read raced the E2E tests' mocks, so it could get the real config.
let restoringOverridesFolder = null;
function restoreOverridesFolder() {
    restoringOverridesFolder ??= (async () => {
        try {
            const config = await window.api.getSavedConfig();
            const field = document.getElementById('test-build-overrides-path');
            // A folder chosen in the meantime wins
            if (config.test_build_overrides_dir && !field.value) field.value = config.test_build_overrides_dir;
        } catch (e) {
            console.error("restoreOverridesFolder error:", e);
        }
    })();
    return restoringOverridesFolder;
}

function clearLog() {
    document.getElementById('sync-console').innerHTML = '';
}

// An action that can't go ahead says why in the log, which it starts afresh
function refuse(message) {
    clearLog();
    ui.logSync(message);
}

// --- Library Picker ---
function makeOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
}

// The library picked, or null for the whole property. The picker lists one
// property's libraries, and `propertyId` is whose.
function selectedLibrary() {
    const picker = document.getElementById('sync-library');
    const option = picker.selectedOptions[0];
    if (!option || !option.value) return null;
    return { id: option.value, name: option.dataset.name, propertyId: picker.dataset.propertyId };
}

// The one property a library action works on. Says why, and returns null, when
// there isn't exactly one, or when the library picked is another property's.
function propertyForLibrary(action, library = null) {
    const properties = ui.getSelectedProperties();
    if (properties.length !== 1) {
        refuse(`${action} needs exactly one property selected.`);
        return null;
    }
    const [property] = properties;
    if (library && library.propertyId !== property.id) {
        refuse(`The libraries listed belong to another property. Click Libraries to list ${property.name}'s.`);
        return null;
    }
    return property;
}

// Where a property is synced: its own folder, or with a library picked, a folder
// for that library, named as sanitizeFolderName (main.js) names one. A name that
// loses every character is replaced by the library's id.
function syncFolder(folder, property, library) {
    if (!library) return `${folder}/${property.name}`;
    const name = library.name.replace(/[^a-zA-Z0-9\- ]/g, '').trim() || library.id;
    return `${folder}/${property.name} - ${name}`;
}

// Lists the property's libraries that aren't published, and its development environments
async function loadSyncLibraries() {
    const property = propertyForLibrary('Listing libraries');
    if (!property) return;

    clearLog();
    ui.logSync(`[${property.name}] Listing libraries and development environments...`);

    try {
        const request = { token: ui.getGlobalToken(), creds: ui.getCurrentCreds(), propertyId: property.id };
        const [libraries, environments] = await Promise.all([
            window.api.getLibraries(request),
            window.api.getEnvironments(request)
        ]);

        const picker = document.getElementById('sync-library');
        picker.options.length = 1; // "Whole property" stays
        libraries.filter(library => library.attributes.state !== 'published').forEach(library => {
            const option = makeOption(library.id, `${library.attributes.name} (${library.attributes.state})`);
            option.dataset.name = library.attributes.name;
            picker.appendChild(option);
        });
        picker.dataset.propertyId = property.id;

        document.getElementById('test-build-environment').replaceChildren(
            ...environments
                .filter(environment => environment.attributes.stage === 'development')
                .map(environment => makeOption(environment.id, environment.attributes.name))
        );

        ui.logSync(`[${property.name}] Libraries not yet published: ${picker.options.length - 1}.`);
    } catch (e) {
        ui.logSync(`[${property.name}] ❌ Error: ${e.message}`);
    }
}

// One line per item: its folder, and its name (a component's with its rule's)
function itemLine(mark, item, note = '') {
    const name = item.rule_name ? `${item.rule_name} › ${item.name}` : item.name;
    return `  [${mark}] ${item.path || `${item.type}/${item.id}`}${name ? ` (${name})` : ''}${note}`;
}

function logLines(property, title, lines) {
    if (lines.length === 0) return;
    ui.logSync(`[${property.name}] ${title} [${lines.length}]`);
    lines.forEach(line => ui.logSync(line));
}

function logList(property, title, mark, items) {
    logLines(property, title, items.map(item => itemLine(mark, item)));
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

    // A library belongs to one property
    const library = selectedLibrary();
    if (library && !propertyForLibrary('Downloading a library', library)) return;

    clearLog();
    ui.logSync(`Starting Initialization for ${properties.length} properties...`);

    // Listener for logs
    const offSyncLog = window.api.onSyncLog((msg) => ui.logSync(msg));

    try {
        for (const property of properties) {
            ui.logSync(`[${property.name}] Starting download${library ? ` of library ${library.name}` : ''}...`);

            const summary = await window.api.performSyncDownload({
                property: { id: property.id, name: property.name },
                library: library && { id: library.id, name: library.name },
                targetDir: syncFolder(folder, property, library), // APPEND PROPERTY NAME (AND LIBRARY NAME)
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

    // A library's folder is diffed against that library, which belongs to one property
    const library = selectedLibrary();
    if (library && !propertyForLibrary('Checking a library', library)) return;

    clearLog();
    ui.logSync(`Checking Status (Diffing) for ${properties.length} properties...`);

    for (const property of properties) {
        ui.logSync(`\n--- [${property.name}] Starting Diff Check ---`);

        try {
            const result = await window.api.performSyncDiff({
                property: { id: property.id, name: property.name }, // Pass property context
                targetDir: syncFolder(folder, property, library), // APPEND PROPERTY NAME (AND LIBRARY NAME)
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
    // The folder it would push is a library's
    if (selectedLibrary()) return refuse('Pushing a library sync isn\'t available yet. Choose "Whole property" to push a property.');

    const properties = ui.getSelectedProperties();
    const folder = document.getElementById('sync-folder-path').value;

    if (properties.length === 0) return alert("Please select one or more properties from the property list.");
    if (!folder) return alert("Please select a local folder.");

    clearLog();
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

// --- Test Build ---
// What the build changed, then where to point Chrome. A build that was stopped
// wrote nothing, and lists what stopped it.
function reportTestBuild(property, overridesDir, result) {
    if (result.stopped) {
        logLines(property, '⛔ Stopped', result.problems.map(problem => `  ${problem}`));
        return;
    }
    const { replaced, added, dropped, warnings } = result.report;
    logLines(property, 'Replaced', replaced.map(item => `  [~] ${item}`));
    logLines(property, 'Added', added.map(item => `  [+] ${item}`));
    logLines(property, 'Dropped', dropped.map(item => `  [-] ${item}`));
    logLines(property, '⚠ Warnings', warnings.map(warning => `  ${warning}`));
    ui.logSync(`[${property.name}] Point Chrome DevTools → Sources → Overrides at ${overridesDir} (overrides apply only while DevTools is open).`);
}

// One test build at a time: two would log over each other and write the same files at once
let generating = false;

// Applies the library in the sync folder to production's script, and writes the result to the overrides folder
async function generateTestBuild() {
    if (generating) return;
    generating = true;
    const button = document.getElementById('test-build-generate');
    button.disabled = true;
    try {
        await buildFromLibrary();
    } finally {
        generating = false;
        button.disabled = false;
    }
}

async function buildFromLibrary() {
    const library = selectedLibrary();
    const property = propertyForLibrary('Generating a test build', library);
    if (!property) return;

    await restoreOverridesFolder();
    const folder = document.getElementById('sync-folder-path').value;
    const overridesDir = document.getElementById('test-build-overrides-path').value;
    if (!library) return refuse('Choose a library first: click Libraries, pick one and download it.');
    if (!folder) return refuse('Select the local project folder the library was downloaded to.');
    if (!overridesDir) return refuse('Choose an overrides folder to write the test build to.');

    clearLog();
    ui.logSync(`[${property.name}] Generating a test build from library ${library.name}...`);

    const offSyncLog = window.api.onSyncLog((msg) => ui.logSync(msg));

    try {
        const result = await window.api.generateTestBuild({
            targetDir: syncFolder(folder, property, library),
            overridesDir,
            environmentId: document.getElementById('test-build-environment').value,
            token: ui.getGlobalToken(),
            creds: ui.getCurrentCreds()
        });
        reportTestBuild(property, overridesDir, result);
    } catch (e) {
        ui.logSync(`[${property.name}] ❌ Error: ${e.message}`);
    } finally {
        offSyncLog();
    }
}

// --- Export to window ---
window.selectSyncFolder = selectSyncFolder;
window.selectOverridesFolder = selectOverridesFolder;
window.loadSyncLibraries = loadSyncLibraries;
window.initSyncDownload = initSyncDownload;
window.checkSyncStatus = checkSyncStatus;
window.pushToLaunch = pushToLaunch;
window.generateTestBuild = generateTestBuild;

export {
    selectSyncFolder,
    selectOverridesFolder,
    restoreOverridesFolder,
    loadSyncLibraries,
    initSyncDownload,
    checkSyncStatus,
    pushToLaunch,
    generateTestBuild
};
