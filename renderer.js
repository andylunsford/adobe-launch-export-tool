const { ipcRenderer, shell } = require('electron');
const extensionMapping = require('./extension-mapping');

let globalToken = null;
let currentCreds = {};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Footer Link
    const link = document.getElementById('credit-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); shell.openExternal(link.href); });

    // 2. Load Saved Config
    try {
        const savedConfig = await ipcRenderer.invoke('get-saved-config');

        // 3. Auto-Login if Creds exist
        if (savedConfig.credentials && savedConfig.credentials.client_id) {
            document.getElementById('clientId').value = savedConfig.credentials.client_id;
            document.getElementById('clientSecret').value = savedConfig.credentials.client_secret || "";
            document.getElementById('orgId').value = savedConfig.credentials.organization_id;

            // Attempt Silent Login
            await loginAndSave(true);

            // 4. Auto-Load Company if Saved
            if (savedConfig.company_id && globalToken) {
                // Pre-select the company in the dropdown (visual only)
                const select = document.getElementById('company-select');
                if (select) select.value = savedConfig.company_id;

                // Load properties immediately
                await loadProperties(savedConfig.company_id);
                document.getElementById('main-interface').classList.remove('hidden');
            } else {
                if (globalToken) togglePanel('company-panel');
            }
        } else {
            togglePanel('creds-panel');
        }
    } catch (e) {
        console.error("Init failed:", e);
        togglePanel('creds-panel');
    }
});

// --- UI HELPERS ---

function togglePanel(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden');
}

function showLoading(msg = "Loading...") {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    if (text) text.innerText = msg;
    if (overlay) overlay.classList.remove('hidden');
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    // Find the button that calls this function and make it active
    const btn = document.querySelector(`button[onclick="switchTab('${tabId}')"]`);
    if (btn) btn.classList.add('active');
}

function toggleSelectAll() {
    const val = document.getElementById('select-all-toggle').checked;
    document.querySelectorAll('.prop-check').forEach(cb => cb.checked = val);
}

// --- CORE LOGIC ---

async function loginAndSave(silent = false) {
    if (!silent) showLoading("Authenticating...");

    try {
        currentCreds = {
            client_id: document.getElementById('clientId').value.trim(),
            client_secret: document.getElementById('clientSecret').value.trim(),
            organization_id: document.getElementById('orgId').value.trim(),
            scope: "openid,AdobeID,additional_info.projectedProductContext,read_organizations,reactor.read,reactor.write",
            ims_endpoint: "https://ims-na1.adobelogin.com"
        };

        const result = await ipcRenderer.invoke('adobe-login', currentCreds);

        if (result.success) {
            globalToken = result.token;

            // [FIX] Await the company load so we catch errors here
            await loadCompanies();

            if (!silent) {
                document.getElementById('login-status').innerText = "✅ Connected!";
                setTimeout(() => {
                    // Close creds, open company selection
                    const credsPanel = document.getElementById('creds-panel');
                    if (!credsPanel.classList.contains('hidden')) togglePanel('creds-panel');

                    const companyPanel = document.getElementById('company-panel');
                    if (companyPanel.classList.contains('hidden')) togglePanel('company-panel');
                }, 500);
            }
        } else {
            if (!silent) document.getElementById('login-status').innerText = "❌ Error: " + result.error;
        }
    } catch (e) {
        console.error("Login Error:", e);
        if (!silent) document.getElementById('login-status').innerText = "❌ Exception: " + e.message;
    } finally {
        if (!silent) hideLoading(); // [FIX] Spinner ALWAYS turns off
    }
}

async function loadCompanies() {
    try {
        const companies = await ipcRenderer.invoke('get-companies', { token: globalToken, creds: currentCreds });

        const select = document.getElementById('company-select');
        select.innerHTML = '<option value="">Select a Company...</option>';

        // [FIX] Safety check to ensure companies is actually an array
        if (Array.isArray(companies)) {
            companies.forEach(comp => {
                const opt = document.createElement('option');
                opt.value = comp.id;
                opt.innerText = comp.attributes.name;
                select.appendChild(opt);
            });
        } else {
            console.error("Companies API returned unexpected format:", companies);
        }
    } catch (e) {
        console.error("Failed to load companies:", e);
        // Don't alert here if silent login, just log it
    }
}

async function saveCompanySelection() {
    const companyId = document.getElementById('company-select').value;
    if (!companyId) {
        alert("Please select a company.");
        return;
    }

    try {
        // Save to persistence
        await ipcRenderer.invoke('save-config-field', { key: 'company_id', value: companyId });

        // Load Properties (Handles its own loading spinner)
        await loadProperties(companyId);

        // Update UI
        togglePanel('company-panel');
        document.getElementById('main-interface').classList.remove('hidden');
    } catch (e) {
        alert("Failed to save company: " + e.message);
    }
}

async function loadProperties(companyId) {
    showLoading("Fetching Properties...");

    try {
        const properties = await ipcRenderer.invoke('get-properties', { token: globalToken, creds: currentCreds, companyId });

        // Populate Tab 1 List (Grid Layout)
        const list = document.getElementById('property-list');
        list.innerHTML = '';

        if (Array.isArray(properties)) {
            properties.forEach(prop => {
                const label = document.createElement('label');
                label.className = 'prop-item';
                label.innerHTML = `
                    <input type="checkbox" value="${prop.id}" data-name="${prop.attributes.name}" class="prop-check"> 
                    <span class="prop-name" title="${prop.attributes.name}">${prop.attributes.name}</span>
                `;
                list.appendChild(label);
            });

            // Populate Tab 2 Dropdown
            const compareSelect = document.getElementById('compare-prop-select');
            compareSelect.innerHTML = '<option value="">Select Property...</option>';
            properties.forEach(prop => {
                const opt = document.createElement('option');
                opt.value = prop.id;
                opt.innerText = prop.attributes.name;
                compareSelect.appendChild(opt);
            });
        } else {
            throw new Error("No properties found or API error.");
        }

    } catch (e) {
        alert("Error loading properties: " + e.message);
    } finally {
        hideLoading(); // [FIX] Spinner ALWAYS turns off
    }
}

// Store environment data globally for library info lookup
let environmentsData = [];

// [NEW] Logic for Tab 2 - Environment Comparison
async function loadEnvironmentsForCompare() {
    const propertyId = document.getElementById('compare-prop-select').value;
    if (!propertyId) return;

    showLoading("Fetching Environments...");
    try {
        const environments = await ipcRenderer.invoke('get-environments', { token: globalToken, creds: currentCreds, propertyId });
        environmentsData = environments; // Store for later use

        const fill = async (id) => {
            const sel = document.getElementById(id);
            sel.innerHTML = '<option value="">Select Environment...</option>';
            if (Array.isArray(environments)) {
                environments.forEach(env => {
                    const opt = document.createElement('option');
                    opt.value = env.id;
                    opt.innerText = `${env.attributes.name} (${env.attributes.stage})`;
                    sel.appendChild(opt);
                });
            }
        };

        await fill('env-a-select');
        await fill('env-b-select');

        // Clear library info displays
        document.getElementById('env-a-library-info').innerText = '';
        document.getElementById('env-b-library-info').innerText = '';
    } catch (e) {
        alert("Error fetching environments: " + e.message);
    } finally {
        hideLoading();
    }
}

async function updateEnvironmentLibraryInfo(envLetter) {
    const selectId = `env-${envLetter}-select`;
    const infoId = `env-${envLetter}-library-info`;

    const environmentId = document.getElementById(selectId).value;
    const infoDiv = document.getElementById(infoId);

    if (!environmentId) {
        infoDiv.innerText = '';
        return;
    }

    infoDiv.innerText = 'Loading library info...';

    try {
        const libraryInfo = await ipcRenderer.invoke('get-environment-library', {
            token: globalToken,
            creds: currentCreds,
            environmentId
        });

        if (libraryInfo) {
            const buildDate = new Date(libraryInfo.buildDate).toLocaleDateString();
            infoDiv.innerText = `📚 Library: ${libraryInfo.libraryName} (Last build: ${buildDate})`;
        } else {
            infoDiv.innerText = '⚠️ No builds found for this environment';
        }
    } catch (e) {
        infoDiv.innerText = '❌ Error loading library info';
        console.error('Error fetching library info:', e);
    }
}

async function performEnvironmentComparison() {
    const envAId = document.getElementById('env-a-select').value;
    const envBId = document.getElementById('env-b-select').value;

    if (!envAId || !envBId) {
        alert('Please select both environments to compare.');
        return;
    }

    if (envAId === envBId) {
        alert('Please select two different environments.');
        return;
    }

    showLoading('Comparing environments...');

    try {
        const comparison = await ipcRenderer.invoke('perform-environment-comparison', {
            token: globalToken,
            creds: currentCreds,
            envAId,
            envBId
        });

        displayComparisonResults(comparison);
        document.getElementById('comparison-results').classList.remove('hidden');
    } catch (e) {
        alert('Error performing comparison: ' + e.message);
    } finally {
        hideLoading();
    }
}

function displayComparisonResults(comparison) {
    const contentDiv = document.getElementById('comparison-content');
    contentDiv.innerHTML = '';

    // Helper to create a section
    function createSection(title, data) {
        const section = document.createElement('div');
        section.className = 'comparison-section';

        const header = document.createElement('h4');
        header.innerText = title;
        section.appendChild(header);

        // Check if there are any differences
        const hasDifferences = (data.onlyInA && data.onlyInA.length > 0) ||
            (data.onlyInB && data.onlyInB.length > 0) ||
            (data.modified && data.modified.length > 0);

        if (!hasDifferences) {
            // No differences - show "No Changes"
            const noChangesDiv = document.createElement('div');
            noChangesDiv.style.padding = '10px';
            noChangesDiv.style.color = 'var(--text-muted)';
            noChangesDiv.style.fontStyle = 'italic';
            noChangesDiv.innerText = '✓ No Changes';
            section.appendChild(noChangesDiv);
            return section;
        }

        // There are differences - show only the differences (not identical items)
        const categories = [
            { key: 'onlyInA', label: 'Removed', className: 'diff-removed' },
            { key: 'onlyInB', label: 'Added', className: 'diff-added' },
            { key: 'modified', label: 'Modified', className: 'diff-modified' }
        ];

        categories.forEach(cat => {
            if (data[cat.key] && data[cat.key].length > 0) {
                const catHeader = document.createElement('div');
                catHeader.style.fontWeight = '600';
                catHeader.style.marginTop = '10px';
                catHeader.style.marginBottom = '5px';
                catHeader.innerText = `${cat.label} (${data[cat.key].length})`;
                section.appendChild(catHeader);


                data[cat.key].forEach((item, index) => {
                    const itemDiv = document.createElement('div');
                    itemDiv.className = `diff-item ${cat.className}`;
                    itemDiv.style.cursor = cat.key === 'modified' && item.attributeDiffs && item.attributeDiffs.length > 0 ? 'pointer' : 'default';

                    // Build the display text
                    let displayText = item.name;

                    // Add "Renamed" indicator if this is a modified item with name change
                    if (cat.key === 'modified' && item.oldName && item.newName && item.oldName !== item.newName) {
                        displayText = `🏷️ Renamed: ${displayText}`;
                    }

                    // Add revision number(s)
                    if (cat.key === 'modified' && item.revisionNumberA !== undefined && item.revisionNumberB !== undefined) {
                        // For modified items, show "revision x to revision y"
                        displayText += ` (revision ${item.revisionNumberA} to ${item.revisionNumberB})`;
                    } else if (item.revisionNumber !== undefined) {
                        // For added/removed items, show single revision number
                        displayText += ` (revision ${item.revisionNumber})`;
                    }

                    // Add expand indicator for modified items with diffs
                    if (cat.key === 'modified' && item.attributeDiffs && item.attributeDiffs.length > 0) {
                        displayText += ' ▼';
                    }

                    itemDiv.innerText = displayText;

                    // Add click handler for modified items to show/hide diff details
                    if (cat.key === 'modified' && item.attributeDiffs && item.attributeDiffs.length > 0) {
                        const diffDetailsId = `diff-details-${cat.key}-${index}`;

                        itemDiv.onclick = () => {
                            const detailsDiv = document.getElementById(diffDetailsId);
                            if (detailsDiv.style.display === 'none') {
                                detailsDiv.style.display = 'block';
                                itemDiv.innerText = itemDiv.innerText.replace('▼', '▲');
                            } else {
                                detailsDiv.style.display = 'none';
                                itemDiv.innerText = itemDiv.innerText.replace('▲', '▼');
                            }
                        };

                        section.appendChild(itemDiv);

                        // Create diff details div
                        const diffDetailsDiv = document.createElement('div');
                        diffDetailsDiv.id = diffDetailsId;
                        diffDetailsDiv.style.display = 'none';
                        diffDetailsDiv.style.marginLeft = '20px';
                        diffDetailsDiv.style.marginTop = '5px';
                        diffDetailsDiv.style.padding = '10px';
                        diffDetailsDiv.style.background = 'var(--bg-primary)';
                        diffDetailsDiv.style.borderRadius = '4px';
                        diffDetailsDiv.style.fontSize = '12px';
                        // Add each attribute diff
                        item.attributeDiffs.forEach(diff => {
                            const diffItem = document.createElement('div');
                            diffItem.style.marginBottom = '8px';
                            diffItem.style.paddingBottom = '8px';
                            diffItem.style.borderBottom = '1px solid var(--border)';

                            const fieldName = document.createElement('div');
                            fieldName.style.fontWeight = '600';
                            fieldName.style.marginBottom = '4px';
                            fieldName.innerText = `${diff.field}:`;
                            diffItem.appendChild(fieldName);

                            const oldValue = document.createElement('div');
                            oldValue.style.color = '#e74c3c';
                            oldValue.style.marginLeft = '10px';
                            oldValue.innerText = `- ${formatValue(diff.oldValue)}`;
                            diffItem.appendChild(oldValue);

                            const newValue = document.createElement('div');
                            newValue.style.color = '#2ecc71';
                            newValue.style.marginLeft = '10px';
                            newValue.innerText = `+ ${formatValue(diff.newValue)}`;
                            diffItem.appendChild(newValue);

                            diffDetailsDiv.appendChild(diffItem);
                        });

                        // Add component diffs if present (for rules)
                        // Add component diffs if present (for rules)
                        if (item.componentDiffs && item.componentDiffs.length > 0) {
                            // Helper to render a component diff item
                            const renderComponentDiff = (compDiff) => {
                                const compDiffItem = document.createElement('div');
                                compDiffItem.style.marginBottom = '8px';
                                compDiffItem.style.paddingBottom = '8px';
                                compDiffItem.style.borderBottom = '1px solid var(--border)';

                                const compName = document.createElement('div');
                                compName.style.fontWeight = '600';
                                compName.style.marginBottom = '4px';

                                // Get friendly name for extension/delegate
                                const extName = extensionMapping.getFriendlyName(compDiff.componentType);
                                const typeName = extensionMapping.getFriendlyComponentType(compDiff.componentType);

                                // Construct display name: [Extension] Component Type: User Name
                                // If typeName is same as user name (or empty), logic might adjust, but basic format:
                                let displayName = `[${extName}]`;
                                if (typeName && typeName !== compDiff.name) {
                                    displayName += ` ${typeName}:`;
                                }
                                displayName += ` ${compDiff.name}`;

                                if (compDiff.type === 'added') {
                                    compName.style.color = '#2ecc71';
                                    compName.innerText = `+ Added: ${displayName}`;
                                    compDiffItem.appendChild(compName);
                                } else if (compDiff.type === 'removed') {
                                    compName.style.color = '#e74c3c';
                                    compName.innerText = `- Removed: ${displayName}`;
                                    compDiffItem.appendChild(compName);
                                } else if (compDiff.type === 'modified') {
                                    compName.style.color = '#f39c12';
                                    compName.style.cursor = 'pointer';
                                    compName.innerHTML = `~ Modified: ${displayName} <span style="font-size: 10px">▼</span>`;
                                    compDiffItem.appendChild(compName);

                                    // settings diff container
                                    const settingsDiffDiv = document.createElement('div');
                                    settingsDiffDiv.style.display = 'none';
                                    settingsDiffDiv.style.marginTop = '5px';
                                    settingsDiffDiv.style.padding = '8px';
                                    settingsDiffDiv.style.backgroundColor = '#2c3e50'; // Darker bg for code
                                    settingsDiffDiv.style.color = '#ecf0f1';
                                    settingsDiffDiv.style.fontFamily = 'Menlo, Monaco, Consolas, monospace';
                                    settingsDiffDiv.style.whiteSpace = 'pre-wrap';
                                    settingsDiffDiv.style.borderRadius = '4px';
                                    settingsDiffDiv.style.fontSize = '11px';

                                    // Toggle visibility on click
                                    compName.onclick = (e) => {
                                        e.stopPropagation(); // Prevent bubbling to parent
                                        if (settingsDiffDiv.style.display === 'none') {
                                            settingsDiffDiv.style.display = 'block';
                                            compName.innerHTML = `~ Modified: ${displayName} <span style="font-size: 10px">▲</span>`;

                                            // Render settings diff if not already done
                                            if (settingsDiffDiv.innerHTML === '') {
                                                const settingsA = compDiff.componentA.attributes.settings;
                                                const settingsB = compDiff.componentB.attributes.settings;

                                                // Try to parse JSON settings if possible
                                                let parsedA = settingsA;
                                                let parsedB = settingsB;

                                                try {
                                                    if (typeof settingsA === 'string') parsedA = JSON.parse(settingsA);
                                                    if (typeof settingsB === 'string') parsedB = JSON.parse(settingsB);
                                                } catch (e) { /* keep as string if parse fails */ }

                                                settingsDiffDiv.innerHTML = formatSettingsDiff(parsedA, parsedB);
                                            }
                                        } else {
                                            settingsDiffDiv.style.display = 'none';
                                            compName.innerHTML = `~ Modified: ${displayName} <span style="font-size: 10px">▼</span>`;
                                        }
                                    };

                                    compDiffItem.appendChild(settingsDiffDiv);
                                }
                                return compDiffItem;
                            };

                            // Group by type (Events, Conditions, Actions)
                            const events = item.componentDiffs.filter(d => extensionMapping.getComponentType(d.componentType) === 'events');
                            const conditions = item.componentDiffs.filter(d => extensionMapping.getComponentType(d.componentType) === 'conditions');
                            const actions = item.componentDiffs.filter(d => extensionMapping.getComponentType(d.componentType) === 'actions');
                            const others = item.componentDiffs.filter(d => extensionMapping.getComponentType(d.componentType) === 'unknown');

                            // Helper to append section
                            const appendSection = (title, items) => {
                                if (items.length > 0) {
                                    const header = document.createElement('div');
                                    header.style.fontWeight = '700';
                                    header.style.marginTop = '12px';
                                    header.style.marginBottom = '8px';
                                    header.style.fontSize = '13px';
                                    header.style.color = '#34495e';
                                    header.style.borderBottom = '1px solid #bdc3c7';
                                    header.innerText = title;
                                    diffDetailsDiv.appendChild(header);

                                    items.forEach(d => diffDetailsDiv.appendChild(renderComponentDiff(d)));
                                }
                            };

                            appendSection('Events (Trigger Rules)', events);
                            appendSection('Conditions (If)', conditions);
                            appendSection('Actions (Then)', actions);
                            appendSection('Other Components', others);
                        }

                        section.appendChild(diffDetailsDiv);
                    } else {
                        section.appendChild(itemDiv);
                    }
                });
            }
        });

        return section;
    }

    // Create sections for each type
    contentDiv.appendChild(createSection('Rules', comparison.rules));
    contentDiv.appendChild(createSection('Data Elements', comparison.data_elements));
    contentDiv.appendChild(createSection('Extensions', comparison.extensions));
}

async function startExportJob() {
    const propCheckboxes = document.querySelectorAll('.prop-check:checked');
    const statusDiv = document.getElementById('export-status');

    if (propCheckboxes.length === 0) return alert("Select at least one property.");

    const types = [];
    if (document.getElementById('opt-full-export').checked) types.push('full');
    if (document.getElementById('opt-library-export').checked) types.push('library');

    if (types.length === 0) return alert("Select at least one export type.");

    const selectedProps = Array.from(propCheckboxes).map(cb => ({
        id: cb.value, name: cb.getAttribute('data-name')
    }));

    // Listener
    const progressListener = (event, message) => {
        // Also update the loading spinner text if it's visible, or the status div
        if (!document.getElementById('loading-overlay').classList.contains('hidden')) {
            document.getElementById('loading-text').innerText = message;
        }
        statusDiv.innerText = message;
    };
    ipcRenderer.on('export-progress', progressListener);

    showLoading("Initializing Export...");

    try {
        const result = await ipcRenderer.invoke('perform-export', { types, properties: selectedProps, token: globalToken, creds: currentCreds });
        alert(result);
        statusDiv.innerText = "Done.";
    } catch (e) {
        alert("Export failed: " + e.message);
    } finally {
        ipcRenderer.removeListener('export-progress', progressListener);
        hideLoading();
    }
}

// Helper function to format values for diff display
function formatValue(value) {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (typeof value === 'object') {
        // For objects and arrays, show a formatted JSON string (truncated if too long)
        const jsonStr = JSON.stringify(value, null, 2);
        return jsonStr.length > 200 ? jsonStr.substring(0, 200) + '...' : jsonStr;
    }
    return String(value);
}

// Helper to format settings object comparison
// Helper to format settings object comparison
function formatSettingsDiff(objA, objB) {
    const jsonA = JSON.stringify(objA, null, 2);
    const jsonB = JSON.stringify(objB, null, 2);

    const linesA = jsonA.split('\n');
    const linesB = jsonB.split('\n');

    // Compute Longest Common Subsequence (LCS) matrix
    const matrix = Array(linesA.length + 1).fill(null).map(() => Array(linesB.length + 1).fill(0));

    for (let i = 1; i <= linesA.length; i++) {
        for (let j = 1; j <= linesB.length; j++) {
            if (linesA[i - 1] === linesB[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1] + 1;
            } else {
                matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
            }
        }
    }

    // Backtrack to generate diff
    let output = '';
    const diffLines = [];
    let i = linesA.length;
    let j = linesB.length;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
            diffLines.unshift(`  ${linesA[i - 1]}`);
            i--; j--;
        } else if (j > 0 && (i === 0 || matrix[i][j - 1] >= matrix[i - 1][j])) {
            diffLines.unshift(`<span style="color: #2ecc71;">+ ${linesB[j - 1]}</span>`);
            j--;
        } else if (i > 0 && (j === 0 || matrix[i][j - 1] < matrix[i - 1][j])) {
            diffLines.unshift(`<span style="color: #e74c3c;">- ${linesA[i - 1]}</span>`);
            i--;
        }
    }

    return diffLines.join('\n');
}