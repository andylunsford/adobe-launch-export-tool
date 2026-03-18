/**
 * Comparison Module
 * Handles loading environments/libraries and running environment comparisons.
 */

const { ipcRenderer } = require('electron');
const ui = require('./ui-helpers');

let currentComparison = null;
let entityAName = '';
let entityBName = '';

// --- Populate Property Dropdown from Selected List ---
function populateComparisonProperties() {
    const selectedProperties = ui.getSelectedProperties();
    const select = document.getElementById('compare-prop-select');
    select.innerHTML = '<option value="">Select Property...</option>';
    
    if (selectedProperties.length === 0) {
        select.innerHTML = '<option value="">Select Properties Globally First</option>';
        return;
    }
    
    selectedProperties.forEach(prop => {
        const opt = document.createElement('option');
        opt.value = prop.id;
        opt.innerText = prop.name;
        opt.dataset.name = prop.name;
        select.appendChild(opt);
    });
}

// --- Load Environments/Libraries for Compare ---
async function loadEnvironmentsForCompare() {
    const propertyId = document.getElementById('compare-prop-select').value;
    if (!propertyId) return;

    ui.showLoading("Fetching Environments/Libraries...");

    try {
        const [environments, libraries] = await Promise.all([
            ipcRenderer.invoke('get-environments', { 
                token: ui.getGlobalToken(), 
                creds: ui.getCurrentCreds(), 
                propertyId 
            }),
            ipcRenderer.invoke('get-libraries', { 
                token: ui.getGlobalToken(), 
                creds: ui.getCurrentCreds(), 
                propertyId 
            })
        ]);

        const data = [...environments, ...libraries];
        
        const envASelect = document.getElementById('envA-select');
        const envBSelect = document.getElementById('envB-select');
        [envASelect, envBSelect].forEach(select => {
            select.innerHTML = '<option value="">Select Environment or Library...</option>';
            data.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.id;
                opt.innerText = item.attributes.name;
                opt.dataset.type = item.type; // environment or library
                opt.dataset.buildId = item.relationships?.latest_build?.data?.id || 'N/A';
                opt.dataset.buildStatus = item.attributes?.status || 'N/A';
                opt.dataset.libraryStatus = item.attributes?.status || 'N/A'; // Library status for the library itself
                opt.title = `${item.type}: ${item.attributes.name}`;
                select.appendChild(opt);
            });
        });

        await refreshCacheStatus();

    } catch (e) {
        alert("Error loading environments: " + e.message);
    } finally {
        ui.hideLoading();
    }
}

// --- Refresh Cache Status ---
async function refreshCacheStatus() {
    const propertyId = document.getElementById('compare-prop-select').value;
    if (!propertyId) return;
    const stats = await ipcRenderer.invoke('get-cache-stats', { propertyId });
    const badge = document.getElementById('cache-status-badge');
    if (!stats || stats.rules === 0) {
        badge.textContent = 'Cache: empty';
        badge.style.color = 'var(--danger, #e74c3c)';
    } else {
        const age = stats.oldest_cached_at
            ? Math.round((Date.now() / 1000 - stats.oldest_cached_at) / 60) + ' min ago'
            : 'unknown';
        badge.textContent = `Cache: ${stats.rules} rules, ${stats.data_elements} DEs — ${age}`;
        badge.style.color = 'var(--success, #27ae60)';
    }
}
window.refreshCacheStatus = refreshCacheStatus;

// --- Update Info Display on Selection Change ---
function updateComparisonInfo(selectId, infoId) {
    const select = document.getElementById(selectId);
    const infoDiv = document.getElementById(infoId);
    const selectedOpt = select.options[select.selectedIndex];

    if (!selectedOpt || !selectedOpt.value) {
        infoDiv.innerHTML = 'Select an environment or library to see status.';
        return;
    }

    const type = selectedOpt.dataset.type;
    const name = selectedOpt.innerText;
    
    if (type === 'environments') {
        const buildId = selectedOpt.dataset.buildId;
        const buildStatus = selectedOpt.dataset.buildStatus;
        infoDiv.innerHTML = `**Environment**<br>Latest Build ID: ${buildId}<br>Status: ${buildStatus}`;
    } else if (type === 'libraries') {
        const libraryStatus = selectedOpt.dataset.libraryStatus;
        infoDiv.innerHTML = `**Library**<br>Status: ${libraryStatus}`;
    } else {
        infoDiv.innerHTML = `Info unavailable for ${type}.`;
    }
}

// --- Handle Compare Mode Change ---
function handleCompareModeChange() {
    const mode = document.getElementById('compare-mode-select').value;
    const lblA = document.getElementById('lbl-env-a');
    const lblB = document.getElementById('lbl-env-b');
    const colB = document.getElementById('col-b');

    if (mode === 'environments') {
        lblA.innerText = 'Environment A (Base)';
        lblB.innerText = 'Environment B (Compare)';
        colB.classList.remove('hidden');
    } else if (mode === 'libraries') {
        lblA.innerText = 'Library A (Base)';
        lblB.innerText = 'Library B (Compare)';
        colB.classList.remove('hidden');
    } else if (mode === 'history') {
        lblA.innerText = 'Target Environment';
        lblB.innerText = '(N/A - History Mode)';
        colB.classList.add('hidden');
    }
}

// --- Perform Comparison ---
async function performEnvironmentComparison() {
    const envAId = document.getElementById('envA-select').value;
    const envBId = document.getElementById('envB-select').value;
    const mode = document.getElementById('compare-mode-select').value; // FIXED: reading from dropdown

    if (!envAId || (mode !== 'history' && !envBId)) return alert("Select the required Environment(s)/Library(s).");
    if (mode !== 'history' && envAId === envBId) return alert("Please select two different entities to compare.");

    ui.showLoading("Performing Comparison...");

    try {
        entityAName = document.getElementById('envA-select').options[document.getElementById('envA-select').selectedIndex].text;
        entityBName = document.getElementById('envB-select').options[document.getElementById('envB-select').selectedIndex].text;

        const useCache = document.getElementById('chk-use-cache').checked;
        const result = await ipcRenderer.invoke('perform-environment-comparison', {
            token: ui.getGlobalToken(),
            creds: ui.getCurrentCreds(),
            envAId,
            envBId,
            mode,
            useCache
        });

        currentComparison = result;
        displayComparisonResults(result);

    } catch (e) {
        alert("Comparison Failed: " + e.message);
    } finally {
        ui.hideLoading();
    }
}

// --- Display Results ---
function displayComparisonResults(result) {
    const container = document.getElementById('comparison-content');
    container.innerHTML = '';

    if (result.fromCache) {
        const notice = document.createElement('div');
        notice.style.cssText = 'font-size:12px; color:var(--text-muted); margin-bottom:10px;';
        notice.textContent = 'Results from local cache. Uncheck "Use Cached Data" to fetch fresh.';
        container.appendChild(notice);
    }

    document.getElementById('comparison-results').classList.remove('hidden');

    const resourceTypes = [
        { key: 'rules', label: 'Rules' },
        { key: 'data_elements', label: 'Data Elements' },
        { key: 'extensions', label: 'Extensions' }
    ];

    let hasDifferences = false;

    resourceTypes.forEach(type => {
        const typeData = result[type.key];
        if (!typeData) return;

        const sections = [
            { key: 'onlyInB', title: `New ${type.label} (Added to ${entityBName})`, class: 'diff-added' },
            { key: 'onlyInA', title: `Removed ${type.label} (Missing from ${entityBName})`, class: 'diff-removed' },
            { key: 'modified', title: `Modified ${type.label}`, class: 'diff-modified' }
        ];

        sections.forEach(section => {
            const items = typeData[section.key] || [];
            if (items.length > 0) {
                hasDifferences = true;
                const sectionDiv = document.createElement('div');
                sectionDiv.className = 'comparison-section';
                
                const title = document.createElement('h4');
                title.style.margin = '20px 0 10px 0';
                title.style.borderBottom = '1px solid var(--border)';
                title.style.paddingBottom = '5px';
                title.innerText = section.title;
                sectionDiv.appendChild(title);

                items.forEach(item => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = `diff-item ${section.class}`;
                    itemDiv.style.padding = '8px 12px';
                    itemDiv.style.marginBottom = '5px';
                    itemDiv.style.borderRadius = '4px';
                    itemDiv.style.fontSize = '13px';
                    
                    let titleText = item.name;

                    if (section.key === 'modified') {
                        titleText += ' (Click to see changes)';
                        itemDiv.style.cursor = 'pointer';
                        
                        let diffSummary = '';
                        if (item.attributeDiffs && item.attributeDiffs.length > 0) {
                            diffSummary += '--- Attribute Changes ---\n';
                            item.attributeDiffs.forEach(d => {
                                diffSummary += `${d.field}: ${JSON.stringify(d.oldValue)} -> ${JSON.stringify(d.newValue)}\n`;
                            });
                        }
                        if (item.componentDiffs && item.componentDiffs.length > 0) {
                            diffSummary += '\n--- Component Changes ---\n';
                            item.componentDiffs.forEach(c => {
                                diffSummary += `[${c.type.toUpperCase()}] ${c.name} (${c.componentType})\n`;
                            });
                        }
                        itemDiv.onclick = () => showDiffModal(item.name, diffSummary || 'Metadata change (no specific attribute diff available).');
                    } else if (section.key === 'onlyInB') {
                        titleText += ' (Click to see full settings)';
                        itemDiv.style.cursor = 'pointer';
                        
                        // For new items, show the entire attributes object formatted nicely
                        const fullConfig = JSON.stringify(item.item.attributes, null, 2);
                        itemDiv.onclick = () => showDiffModal(item.name, `--- New Item Configuration ---\n${fullConfig}`);
                    }

                    itemDiv.innerText = titleText;
                    sectionDiv.appendChild(itemDiv);
                });

                container.appendChild(sectionDiv);
            }
        });
    });
    
    if (!hasDifferences) {
        container.innerHTML = `<p class="diff-identical" style="padding: 15px; background: var(--input-bg); border-radius: 6px; text-align: center;">✅ No differences found between ${entityAName} and ${entityBName}.</p>`;
    }
}

// --- Download Comparison Notes ---
async function downloadComparisonNotes() {
    if (!currentComparison) return alert("No comparison results to download.");

    let md = `# Release Notes: ${entityAName} vs ${entityBName}\n`;
    md += `*Generated on ${new Date().toLocaleString()}*\n\n`;

    const resourceTypes = [
        { key: 'rules', label: 'Rules' },
        { key: 'data_elements', label: 'Data Elements' },
        { key: 'extensions', label: 'Extensions' }
    ];

    let hasDiffs = false;

    resourceTypes.forEach(type => {
        const typeData = currentComparison[type.key];
        if (!typeData) return;

        const sections = [
            { key: 'onlyInB', title: `Added ${type.label}` },
            { key: 'onlyInA', title: `Removed ${type.label}` },
            { key: 'modified', title: `Modified ${type.label}` }
        ];

        sections.forEach(section => {
            const items = typeData[section.key] || [];
            if (items.length > 0) {
                hasDiffs = true;
                md += `## ${section.title}\n`;
                items.forEach(item => {
                    md += `- **${item.name}**\n`;
                    if (section.key === 'modified') {
                        if (item.attributeDiffs && item.attributeDiffs.length > 0) {
                            item.attributeDiffs.forEach(d => {
                                md += `  - *${d.field}*: \`${JSON.stringify(d.oldValue)}\` → \`${JSON.stringify(d.newValue)}\`\n`;
                            });
                        }
                        if (item.componentDiffs && item.componentDiffs.length > 0) {
                            item.componentDiffs.forEach(c => {
                                md += `  - [${c.type.toUpperCase()}] ${c.name} (${c.componentType})\n`;
                            });
                        }
                    } else if (section.key === 'onlyInB') {
                        // Include full settings for new items in a code block
                        md += "  - *Full Configuration:*\n";
                        md += "    ```json\n";
                        // Indent the JSON for better readability in Markdown
                        const config = JSON.stringify(item.item.attributes, null, 2).split('\n').map(l => `    ${l}`).join('\n');
                        md += `${config}\n`;
                        md += "    ```\n";
                    }
                });
                md += '\n';
            }
        });
    });

    if (!hasDiffs) {
        md += "_No differences detected._\n";
    }

    const defaultName = `release-notes-${entityAName}-vs-${entityBName}.md`.replace(/[^a-z0-9]/gi, '-').toLowerCase();

    try {
        const success = await ipcRenderer.invoke('save-file', {
            content: md,
            defaultName
        });
        if (success) {
            alert("✅ Release notes saved successfully!");
        }
    } catch (e) {
        alert("❌ Error saving file: " + e.message);
    }
}

// --- Diff Modal ---
function showDiffModal(name, diffText) {
    const diffContainer = document.getElementById('diff-content');
    const title = document.getElementById('diff-modal-title');
    
    title.innerText = `Difference: ${name}`;
    diffContainer.innerHTML = ''; // Clear previous content

    // Pre-process diff: replace \n with <br>, add color spans
    const htmlDiff = diffText.split('\n').map(line => {
        if (line.startsWith('+')) {
            return `<span style="color: var(--success);">${line}</span>`;
        } else if (line.startsWith('-')) {
            return `<span style="color: var(--danger);">${line}</span>`;
        } else if (line.startsWith('@@')) {
            return `<span style="color: var(--warning);">${line}</span>`;
        } else {
            return line;
        }
    }).join('<br>');
    
    diffContainer.innerHTML = htmlDiff;
    
    document.getElementById('diff-modal').classList.remove('hidden');
}

function closeDiffModal() {
    document.getElementById('diff-modal').classList.add('hidden');
}

// --- Export to window ---
window.loadEnvironmentsForCompare = loadEnvironmentsForCompare;
window.updateComparisonInfo = updateComparisonInfo;
window.handleCompareModeChange = handleCompareModeChange; // NEW
window.performEnvironmentComparison = performEnvironmentComparison;
window.downloadComparisonNotes = downloadComparisonNotes; // NEW
window.refreshCacheStatus = refreshCacheStatus;
window.closeDiffModal = closeDiffModal; // Added to enable closing from HTML button

// --- Module Exports ---
module.exports = {
    populateComparisonProperties, // NEW
    loadEnvironmentsForCompare,
    updateComparisonInfo,
    handleCompareModeChange, // NEW
    performEnvironmentComparison,
    downloadComparisonNotes, // NEW
    refreshCacheStatus,
    closeDiffModal
};
