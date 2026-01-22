const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');

// [SME Fix] Agent for Corporate Proxies
const proxyAgent = new https.Agent({ rejectUnauthorized: false });

const VARS_PATH = path.join(app.getPath('userData'), 'reactor_vars.json');

function createWindow() {
    const win = new BrowserWindow({
        width: 1100,
        height: 850,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

// --- HELPER FUNCTIONS ---

function sanitizeFolderName(name) {
    if (!name) return "Untitled";
    return name.replace(/[^a-zA-Z0-9\- ]/g, '').trim();
}

function saveVariables(data) {
    try {
        const storageData = JSON.parse(JSON.stringify(data));
        if (storageData.credentials && storageData.credentials.client_secret) {
            if (safeStorage.isEncryptionAvailable()) {
                const encryptedSecret = safeStorage.encryptString(storageData.credentials.client_secret);
                storageData.credentials.client_secret = encryptedSecret.toString('base64');
                storageData.credentials.is_encrypted = true;
            }
        }
        fs.writeFileSync(VARS_PATH, JSON.stringify(storageData, null, 2));
    } catch (err) {
        console.error("Failed to save variables:", err);
    }
}

function loadVariables() {
    if (fs.existsSync(VARS_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(VARS_PATH));
            if (data.credentials && data.credentials.is_encrypted && data.credentials.client_secret) {
                if (safeStorage.isEncryptionAvailable()) {
                    try {
                        const buffer = Buffer.from(data.credentials.client_secret, 'base64');
                        data.credentials.client_secret = safeStorage.decryptString(buffer);
                    } catch (e) {
                        data.credentials = {};
                    }
                }
            }
            return data;
        } catch (err) {
            console.error("Error reading var file:", err);
        }
    }
    return {};
}

// --- IPC HANDLERS ---

ipcMain.handle('get-saved-config', () => loadVariables());

ipcMain.handle('save-config-field', (event, { key, value }) => {
    const vars = loadVariables();
    vars[key] = value;
    saveVariables(vars);
    return true;
});

// Auth Handlers
ipcMain.handle('adobe-login', async (event, creds) => {
    try {
        const response = await axios.post(`${creds.ims_endpoint}/ims/token/v3`, null, {
            params: {
                grant_type: 'client_credentials',
                client_id: creds.client_id,
                client_secret: creds.client_secret,
                scope: creds.scope
            },
            httpsAgent: proxyAgent
        });

        const vars = loadVariables();
        vars.credentials = creds;
        saveVariables(vars);

        return { success: true, token: response.data.access_token };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-companies', async (event, { token, creds }) => {
    const response = await axios.get("https://reactor.adobe.io/companies", {
        headers: {
            "Authorization": `Bearer ${token}`,
            "x-api-key": creds.client_id,
            "Accept": "application/vnd.api+json;revision=1"
        },
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-properties', async (event, { token, creds, companyId }) => {
    const response = await axios.get(`https://reactor.adobe.io/companies/${companyId}/properties?page[size]=500`, {
        headers: {
            "Authorization": `Bearer ${token}`,
            "x-api-key": creds.client_id,
            "x-gw-ims-org-id": creds.organization_id,
            "Accept": "application/vnd.api+json;revision=1"
        },
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-libraries', async (event, { token, creds, propertyId }) => {
    const response = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/libraries?page[size]=100`, {
        headers: {
            "Authorization": `Bearer ${token}`,
            "x-api-key": creds.client_id,
            "x-gw-ims-org-id": creds.organization_id,
            "Accept": "application/vnd.api+json;revision=1"
        },
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-environments', async (event, { token, creds, propertyId }) => {
    const response = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/environments`, {
        headers: {
            "Authorization": `Bearer ${token}`,
            "x-api-key": creds.client_id,
            "x-gw-ims-org-id": creds.organization_id,
            "Accept": "application/vnd.api+json;revision=1"
        },
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-environment-library', async (event, { token, creds, environmentId }) => {
    try {
        const headers = {
            "Authorization": `Bearer ${token}`,
            "x-api-key": creds.client_id,
            "x-gw-ims-org-id": creds.organization_id,
            "Accept": "application/vnd.api+json;revision=1"
        };

        // Get the latest build for this environment
        const buildRes = await axios.get(`https://reactor.adobe.io/environments/${environmentId}/builds?page[size]=1`, {
            headers,
            httpsAgent: proxyAgent
        });

        if (buildRes.data.data && buildRes.data.data.length > 0) {
            const latestBuild = buildRes.data.data[0];
            const libraryId = latestBuild.relationships.library.data.id;

            // Get the library details
            const libRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}`, {
                headers,
                httpsAgent: proxyAgent
            });

            return {
                libraryId: libraryId,
                libraryName: libRes.data.data.attributes.name,
                buildDate: latestBuild.attributes.updated_at
            };
        }

        return null; // No builds found
    } catch (error) {
        console.error('Error fetching environment library:', error.message);
        return null;
    }
});

ipcMain.handle('perform-environment-comparison', async (event, { token, creds, envAId, envBId }) => {
    try {
        const headers = {
            "Authorization": `Bearer ${token}`,
            "x-api-key": creds.client_id,
            "x-gw-ims-org-id": creds.organization_id,
            "Accept": "application/vnd.api+json;revision=1"
        };

        // Helper function to fetch all pages of data from an endpoint
        async function fetchAllPages(url, headers) {
            let allData = [];
            let currentUrl = url;

            while (currentUrl) {
                const response = await axios.get(currentUrl, { headers, httpsAgent: proxyAgent });
                allData = allData.concat(response.data.data || []);

                // Check if there's a next page
                const links = response.data.links;
                currentUrl = links && links.next ? links.next : null;
            }

            return allData;
        }

        // Helper function to fetch build data for an environment
        async function fetchEnvironmentData(environmentId) {
            // Get the latest build
            const buildRes = await axios.get(`https://reactor.adobe.io/environments/${environmentId}/builds?page[size]=1`, {
                headers,
                httpsAgent: proxyAgent
            });

            if (!buildRes.data.data || buildRes.data.data.length === 0) {
                return { rules: [], data_elements: [], extensions: [], buildId: null };
            }

            const latestBuild = buildRes.data.data[0];
            const buildId = latestBuild.id;

            // Fetch ALL rules, data_elements, and extensions for this BUILD with pagination
            // This gives us the actual deployed revisions
            const [rules, data_elements, extensions] = await Promise.all([
                fetchAllPages(`https://reactor.adobe.io/builds/${buildId}/rules`, headers),
                fetchAllPages(`https://reactor.adobe.io/builds/${buildId}/data_elements`, headers),
                fetchAllPages(`https://reactor.adobe.io/builds/${buildId}/extensions`, headers)
            ]);

            // For each rule, fetch its rule components (events, actions, conditions)
            const rulesWithComponents = await Promise.all(rules.map(async (rule) => {
                try {
                    const ruleComponentsUrl = rule.relationships?.rule_components?.links?.related;
                    if (ruleComponentsUrl) {
                        const components = await fetchAllPages(ruleComponentsUrl, headers);
                        return {
                            ...rule,
                            rule_components: components
                        };
                    }
                    return rule;
                } catch (error) {
                    console.error(`Error fetching components for rule ${rule.id}:`, error.message);
                    return rule;
                }
            }));

            return {
                buildId: buildId,
                rules: rulesWithComponents,
                data_elements: data_elements,
                extensions: extensions
            };
        }

        // Fetch data for both environments
        const [envAData, envBData] = await Promise.all([
            fetchEnvironmentData(envAId),
            fetchEnvironmentData(envBId)
        ]);

        // Helper function to compare arrays of items
        function compareItems(itemsA, itemsB, itemType) {
            // Use origin ID as the stable identifier (falls back to item.id if no origin)
            // This ensures that renamed/modified items are properly matched across builds
            const getStableId = (item) => {
                return item.relationships?.origin?.data?.id || item.id;
            };

            const mapA = new Map(itemsA.map(item => [getStableId(item), item]));
            const mapB = new Map(itemsB.map(item => [getStableId(item), item]));

            const onlyInA = [];
            const onlyInB = [];
            const modified = [];
            const identical = [];

            // Check items in A - using origin ID as source of truth
            for (const [stableId, itemA] of mapA) {
                if (!mapB.has(stableId)) {
                    // Item exists in A but not in B
                    onlyInA.push({
                        id: itemA.id,
                        name: itemA.attributes.name,
                        revisionNumber: itemA.attributes.revision_number
                    });
                } else {
                    const itemB = mapB.get(stableId);
                    // Compare by checking if settings are different
                    const settingsA = JSON.stringify(itemA.attributes);
                    const settingsB = JSON.stringify(itemB.attributes);

                    // For rules, also compare rule components
                    const componentsA = itemA.rule_components ? JSON.stringify(itemA.rule_components) : null;
                    const componentsB = itemB.rule_components ? JSON.stringify(itemB.rule_components) : null;

                    if (settingsA !== settingsB || componentsA !== componentsB) {
                        // Item modified - show both old and new names if renamed
                        const nameA = itemA.attributes.name;
                        const nameB = itemB.attributes.name;
                        const displayName = nameA !== nameB ? `${nameA} → ${nameB}` : nameB;

                        // Create detailed diff of attributes
                        const attributeDiffs = [];
                        const allKeys = new Set([...Object.keys(itemA.attributes), ...Object.keys(itemB.attributes)]);

                        for (const key of allKeys) {
                            const valueA = itemA.attributes[key];
                            const valueB = itemB.attributes[key];

                            // Skip certain metadata fields that aren't meaningful for comparison
                            if (['created_at', 'updated_at', 'published_at', 'dirty', 'published', 'review_status', 'updated_by_email', 'updated_by_display_name'].includes(key)) {
                                continue;
                            }

                            if (JSON.stringify(valueA) !== JSON.stringify(valueB)) {
                                attributeDiffs.push({
                                    field: key,
                                    oldValue: valueA,
                                    newValue: valueB
                                });
                            }
                        }

                        // For rules, compare rule components (events, actions, conditions)
                        let componentDiffs = [];
                        if (itemA.rule_components || itemB.rule_components) {
                            const getComponentStableId = (comp) => comp.relationships?.origin?.data?.id || comp.id;

                            const componentsMapA = new Map((itemA.rule_components || []).map(c => [getComponentStableId(c), c]));
                            const componentsMapB = new Map((itemB.rule_components || []).map(c => [getComponentStableId(c), c]));

                            // Find added, removed, and modified components
                            const allComponentIds = new Set([...componentsMapA.keys(), ...componentsMapB.keys()]);

                            for (const componentId of allComponentIds) {
                                const compA = componentsMapA.get(componentId);
                                const compB = componentsMapB.get(componentId);

                                if (!compA && compB) {
                                    // Component added
                                    componentDiffs.push({
                                        type: 'added',
                                        componentType: compB.attributes.delegate_descriptor_id,
                                        name: compB.attributes.name || compB.attributes.delegate_descriptor_id,
                                        component: compB
                                    });
                                } else if (compA && !compB) {
                                    // Component removed
                                    componentDiffs.push({
                                        type: 'removed',
                                        componentType: compA.attributes.delegate_descriptor_id,
                                        name: compA.attributes.name || compA.attributes.delegate_descriptor_id,
                                        component: compA
                                    });
                                } else if (compA && compB) {
                                    // Check if component modified
                                    // Define a helper to stringify attributes excluding ignored fields
                                    const stringifyAttributes = (attrs) => {
                                        const cleanAttrs = { ...attrs };
                                        ['created_at', 'updated_at', 'dirty', 'published', 'review_status', 'updated_by_email', 'updated_by_display_name'].forEach(key => delete cleanAttrs[key]);
                                        return JSON.stringify(cleanAttrs);
                                    };

                                    const settingsCompA = stringifyAttributes(compA.attributes);
                                    const settingsCompB = stringifyAttributes(compB.attributes);

                                    if (settingsCompA !== settingsCompB) {
                                        componentDiffs.push({
                                            type: 'modified',
                                            componentType: compB.attributes.delegate_descriptor_id,
                                            name: compB.attributes.name || compB.attributes.delegate_descriptor_id,
                                            componentA: compA,
                                            componentB: compB
                                        });
                                    }
                                }
                            }
                        }

                        modified.push({
                            id: itemB.id,
                            name: displayName,
                            oldName: nameA,
                            newName: nameB,
                            revisionNumberA: itemA.attributes.revision_number,
                            revisionNumberB: itemB.attributes.revision_number,
                            itemA: itemA,  // Store full item data for detailed diff
                            itemB: itemB,
                            attributeDiffs: attributeDiffs,
                            componentDiffs: componentDiffs
                        });
                    } else {
                        // Item is identical
                        identical.push({
                            id: itemA.id,
                            name: itemA.attributes.name,
                            revisionNumber: itemA.attributes.revision_number
                        });
                    }
                }
            }

            // Check items only in B
            for (const [stableId, itemB] of mapB) {
                if (!mapA.has(stableId)) {
                    // Item exists in B but not in A
                    onlyInB.push({
                        id: itemB.id,
                        name: itemB.attributes.name,
                        revisionNumber: itemB.attributes.revision_number
                    });
                }
            }

            return { onlyInA, onlyInB, modified, identical };
        }

        // Compare each type
        const comparison = {
            rules: compareItems(envAData.rules, envBData.rules, 'rules'),
            data_elements: compareItems(envAData.data_elements, envBData.data_elements, 'data_elements'),
            extensions: compareItems(envAData.extensions, envBData.extensions, 'extensions')
        };

        return comparison;
    } catch (error) {
        console.error('Comparison error:', error);
        throw new Error(`Failed to compare environments: ${error.message}`);
    }
});

// --- EXPORT LOGIC (Fixed: Removed Error Swallowing) ---

ipcMain.handle('perform-export', async (event, args) => {
    const { types, properties, token, creds } = args;

    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select Export Folder',
        properties: ['openDirectory']
    });

    if (canceled || filePaths.length === 0) return "Export Cancelled";
    const baseDir = filePaths[0];

    const headers = {
        "Authorization": `Bearer ${token}`,
        "x-api-key": creds.client_id,
        "x-gw-ims-org-id": creds.organization_id,
        "Accept": "application/vnd.api+json;revision=1"
    };

    // Helper to send updates to UI
    const sendStatus = (msg) => event.sender.send('export-progress', msg);

    try {
        for (let i = 0; i < properties.length; i++) {
            const prop = properties[i];
            const propSafeName = sanitizeFolderName(prop.name);

            sendStatus(`Processing ${prop.name} (${i + 1}/${properties.length})...`);

            // --- OPTION 1: Full Export ---
            if (types.includes('full')) {
                const targetDir = path.join(baseDir, propSafeName, "Full Export");
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                sendStatus(`Fetching Rules for ${prop.name}...`);
                const rulesUrl = `https://reactor.adobe.io/properties/${prop.id}/rules?page[size]=1000`;
                await fetchAndSaveRules(rulesUrl, headers, targetDir);

                sendStatus(`Fetching Data Elements & Extensions for ${prop.name}...`);
                await fetchAndSaveComponents({
                    "data_elements": `https://reactor.adobe.io/properties/${prop.id}/data_elements?page[size]=1000`,
                    "extensions": `https://reactor.adobe.io/properties/${prop.id}/extensions?page[size]=1000`
                }, headers, targetDir);
            }

            // --- OPTION 2: Library Export ---
            if (types.includes('library')) {
                sendStatus(`Locating Production Library for ${prop.name}...`);

                // Fetch Env -> Build -> Library flow
                const envRes = await axios.get(`https://reactor.adobe.io/properties/${prop.id}/environments`, { headers, httpsAgent: proxyAgent });
                const prodEnv = envRes.data.data.find(e => e.attributes.stage === 'production');

                if (prodEnv) {
                    const buildRes = await axios.get(`https://reactor.adobe.io/environments/${prodEnv.id}/builds?page[size]=50`, { headers, httpsAgent: proxyAgent });
                    const builds = buildRes.data.data;

                    if (builds && builds.length > 0) {
                        builds.sort((a, b) => new Date(b.attributes.updated_at) - new Date(a.attributes.updated_at));
                        const latestBuild = builds[0];
                        const libraryId = latestBuild.relationships.library.data.id;

                        // Get Library Name
                        const libRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}`, { headers, httpsAgent: proxyAgent });
                        const libraryName = libRes.data.data.attributes.name;
                        const libSafeName = sanitizeFolderName(libraryName);

                        const targetDir = path.join(baseDir, propSafeName, "Library Export", libSafeName);
                        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                        sendStatus(`Downloading Library "${libraryName}"...`);

                        // 1. Process Library Rules
                        const rulesUrl = `https://reactor.adobe.io/libraries/${libraryId}/rules`;
                        await fetchAndSaveRules(rulesUrl, headers, targetDir);

                        // 2. Process Library Components
                        await fetchAndSaveComponents({
                            "data_elements": `https://reactor.adobe.io/libraries/${libraryId}/data_elements`,
                            "extensions": `https://reactor.adobe.io/libraries/${libraryId}/extensions`
                        }, headers, targetDir);
                    } else {
                        console.log(`Skipping Library Export for ${prop.name}: No builds found.`);
                    }
                } else {
                    console.log(`Skipping Library Export for ${prop.name}: No Production Environment found.`);
                }
            }
        }
        return `Export Complete! Files saved to: ${baseDir}`;
    } catch (error) {
        console.error(error);
        // [FIX] Return the specific error to the UI
        throw new Error(`Failed: ${error.message} (URL: ${error.config ? error.config.url : 'Unknown'})`);
    }
});

// --- RESTORED FETCHERS (Fixed: Removed swallowing) ---

async function fetchAndSaveComponents(endpoints, headers, outputDir) {
    for (const [componentType, url] of Object.entries(endpoints)) {
        const componentDir = path.join(outputDir, componentType);
        if (!fs.existsSync(componentDir)) fs.mkdirSync(componentDir, { recursive: true });

        // [FIX] No try/catch here. If this fails, we want the whole export to stop/alert.
        const response = await axios.get(url, { headers, httpsAgent: proxyAgent });
        const items = response.data.data;

        for (const item of items) {
            if (item.attributes.enabled === false) continue;
            const filePath = path.join(componentDir, `${item.id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
        }
    }
}

async function fetchAndSaveRules(url, headers, outputDir) {
    const rulesBaseDir = path.join(outputDir, 'rules');
    if (!fs.existsSync(rulesBaseDir)) fs.mkdirSync(rulesBaseDir, { recursive: true });

    // [FIX] No try/catch. Let errors bubble up.
    const response = await axios.get(url, { headers, httpsAgent: proxyAgent });
    const rules = response.data.data;

    if (!rules || rules.length === 0) return; // Nothing to do

    for (const rule of rules) {
        if (rule.attributes.enabled === false) continue;

        // 1. Create Folder for this Rule
        const ruleFolderName = sanitizeFolderName(rule.attributes.name);
        const specificRuleDir = path.join(rulesBaseDir, ruleFolderName);
        if (!fs.existsSync(specificRuleDir)) fs.mkdirSync(specificRuleDir, { recursive: true });

        // 2. Save Rule Settings
        fs.writeFileSync(path.join(specificRuleDir, 'settings.json'), JSON.stringify(rule, null, 2));

        // 3. Fetch Components for this Rule
        try {
            const compUrl = `https://reactor.adobe.io/rules/${rule.id}/rule_components?page[size]=100`;
            const compRes = await axios.get(compUrl, { headers, httpsAgent: proxyAgent });
            const components = compRes.data.data;

            // Prepare subfolders
            ['events', 'conditions', 'actions'].forEach(sub => {
                const subDir = path.join(specificRuleDir, sub);
                if (!fs.existsSync(subDir)) fs.mkdirSync(subDir);
            });

            // 4. Sort Components into Folders
            for (const comp of components) {
                const descriptor = comp.attributes.delegate_descriptor_id || "";
                let targetSubfolder = null;

                if (descriptor.includes('events')) targetSubfolder = 'events';
                else if (descriptor.includes('conditions')) targetSubfolder = 'conditions';
                else if (descriptor.includes('actions')) targetSubfolder = 'actions';

                if (targetSubfolder) {
                    const filename = `${comp.id}.json`;
                    fs.writeFileSync(path.join(specificRuleDir, targetSubfolder, filename), JSON.stringify(comp, null, 2));
                }
            }

        } catch (compErr) {
            // We DO swallow errors here specifically because one bad rule shouldn't stop the whole property.
            // But we will log it so you can see it in terminal if needed.
            console.error(`Warning: Failed to fetch components for rule "${rule.attributes.name}": ${compErr.message}`);
        }
    }
}