const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const reactorCore = require('./lib/reactor-core');
const db = require('./lib/db');

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

app.whenReady().then(() => {
    try { db.initDb(); }
    catch (e) { console.error('[DB] initDb failed (cache disabled):', e.message); }
    createWindow();
});

// --- HELPER FUNCTIONS ---

function sanitizeFolderName(name) {
    if (!name) return "Untitled";
    return name.replace(/[^a-zA-Z0-9\- ]/g, '').trim();
}

function getHeaders(token, creds) {
    return {
        "Authorization": `Bearer ${token}`,
        "x-api-key": creds.client_id,
        "x-gw-ims-org-id": creds.organization_id,
        "Accept": "application/vnd.api+json;revision=1"
    };
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
    const headers = getHeaders(token, creds);
    const response = await axios.get("https://reactor.adobe.io/companies", {
        headers,
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-properties', async (event, { token, creds, companyId }) => {
    const headers = getHeaders(token, creds);
    const response = await axios.get(`https://reactor.adobe.io/companies/${companyId}/properties?page[size]=500`, {
        headers,
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-libraries', async (event, { token, creds, propertyId }) => {
    const headers = getHeaders(token, creds);
    const response = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/libraries?page[size]=100`, {
        headers,
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-environments', async (event, { token, creds, propertyId }) => {
    const headers = getHeaders(token, creds);
    const response = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/environments`, {
        headers,
        httpsAgent: proxyAgent
    });
    return response.data.data;
});

ipcMain.handle('get-environment-library', async (event, { token, creds, environmentId }) => {
    try {
        const headers = getHeaders(token, creds);

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

ipcMain.handle('perform-environment-comparison', async (event, { token, creds, envAId, envBId, mode, useCache }) => {
    try {
        const headers = getHeaders(token, creds);

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

        // Helper to fetch build contents
        async function fetchBuildContents(buildId) {
            const [rules, data_elements, extensions] = await Promise.all([
                fetchAllPages(`https://reactor.adobe.io/builds/${buildId}/rules`, headers),
                fetchAllPages(`https://reactor.adobe.io/builds/${buildId}/data_elements`, headers),
                fetchAllPages(`https://reactor.adobe.io/builds/${buildId}/extensions`, headers)
            ]);

            const rulesWithComponents = await Promise.all(rules.map(async (rule) => {
                try {
                    const ruleComponentsUrl = rule.relationships?.rule_components?.links?.related;
                    if (ruleComponentsUrl) {
                        const components = await fetchAllPages(ruleComponentsUrl, headers);
                        return { ...rule, rule_components: components };
                    }
                    return rule;
                } catch (error) {
                    console.error(`Error fetching components for rule ${rule.id}:`, error.message);
                    return rule;
                }
            }));

            return { rules: rulesWithComponents, data_elements, extensions, buildId };
        }

        // Helper function to fetch build data for an environment OR library
        async function fetchEnvironmentData(entityId) {
            if (entityId.startsWith('LB')) {
                // It's a Library
                const [rules, data_elements, extensions] = await Promise.all([
                    fetchAllPages(`https://reactor.adobe.io/libraries/${entityId}/rules`, headers),
                    fetchAllPages(`https://reactor.adobe.io/libraries/${entityId}/data_elements`, headers),
                    fetchAllPages(`https://reactor.adobe.io/libraries/${entityId}/extensions`, headers)
                ]);
                
                const rulesWithComponents = await Promise.all(rules.map(async (rule) => {
                    try {
                        const compUrl = `https://reactor.adobe.io/rules/${rule.id}/rule_components?page[size]=100`;
                        const res = await axios.get(compUrl, { headers, httpsAgent: proxyAgent });
                        return { ...rule, rule_components: res.data.data };
                    } catch (e) { return rule; }
                }));

                return { rules: rulesWithComponents, data_elements, extensions, buildId: entityId };
            } else {
                // It's an Environment -> Get latest build
                const buildRes = await axios.get(`https://reactor.adobe.io/environments/${entityId}/builds?page[size]=1`, { headers, httpsAgent: proxyAgent });
                if (!buildRes.data.data || buildRes.data.data.length === 0) return { rules: [], data_elements: [], extensions: [], buildId: null };
                
                return await fetchBuildContents(buildRes.data.data[0].id);
            }
        }

        function fetchFromCache(entityId) {
            try {
                const libId = entityId.startsWith('LB') ? entityId
                    : db.getLatestBuildForEnvironment(entityId)?.relationships?.library?.data?.id;
                if (!libId || !db.hasCachedLibrary(libId)) return null;
                return {
                    rules: db.getRulesForLibrary(libId),
                    data_elements: db.getDataElementsForLibrary(libId),
                    extensions: db.getExtensionsForLibrary(libId),
                    libraryId: libId
                };
            } catch (e) {
                console.error('[DB] fetchFromCache:', e.message);
                return null;
            }
        }

        let fromCache = false;
        let envAData, envBData;

        if (useCache && mode !== 'history') {
            const cA = fetchFromCache(envAId);
            const cB = fetchFromCache(envBId);
            if (cA && cB) {
                envAData = cA;
                envBData = cB;
                fromCache = true;
            }
        }

        if (!fromCache) {
            if (mode === 'history') {
                // HISTORY MODE: Compare Build N (Latest) vs Build N-1 (Previous)
                // envAId is the Environment ID
                const buildRes = await axios.get(`https://reactor.adobe.io/environments/${envAId}/builds?page[size]=2`, { headers, httpsAgent: proxyAgent });
                const builds = buildRes.data.data;

                if (builds.length < 2) {
                    throw new Error("Not enough build history (need at least 2 builds) to compare.");
                }

                // builds[0] is Latest (New/B), builds[1] is Previous (Old/A)
                console.log(`Comparing Build ${builds[1].id} (Old) vs ${builds[0].id} (New)`);

                // Parallel fetch
                [envAData, envBData] = await Promise.all([
                    fetchBuildContents(builds[1].id), // Old
                    fetchBuildContents(builds[0].id)  // New
                ]);

            } else {
                // STANDARD COMPARISON
                [envAData, envBData] = await Promise.all([
                    fetchEnvironmentData(envAId),
                    fetchEnvironmentData(envBId)
                ]);
            }
        }

        // Write-through: cache the comparison data for next time
        if (!fromCache && mode !== 'history') {
            try {
                const writeThrough = (data) => {
                    const libId = data.buildId?.startsWith('LB') ? data.buildId : null;
                    if (!libId) return;
                    // propertyId is null here — comparison data is keyed by libraryId (junction tables),
                    // not by property. Stats and scoped-clear won't see this data, which is acceptable.
                    db.upsertRules(data.rules, null);
                    db.linkLibraryRules(libId, data.rules);
                    // Write rule components for each rule
                    for (const rule of data.rules) {
                        if (rule.rule_components && rule.rule_components.length > 0) {
                            db.upsertRuleComponents(rule.rule_components, rule.id, null);
                        }
                    }
                    db.upsertDataElements(data.data_elements, null);
                    db.linkLibraryDataElements(libId, data.data_elements);
                    db.upsertExtensions(data.extensions, null);
                    db.linkLibraryExtensions(libId, data.extensions);
                };
                writeThrough(envAData);
                writeThrough(envBData);
            } catch (e) { console.error('[DB] post-comparison cache write:', e.message); }
        }

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
                        name: itemA.attributes.name || itemA.attributes.display_name,
                        revisionNumber: itemA.attributes.revision_number,
                        item: itemA
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
                        const nameA = itemA.attributes.name || itemA.attributes.display_name;
                        const nameB = itemB.attributes.name || itemB.attributes.display_name;
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

                                    const nameA = compA.attributes.name || compA.attributes.delegate_descriptor_id;
                                    const nameB = compB.attributes.name || compB.attributes.delegate_descriptor_id;
                                    const renamed = nameA !== nameB;

                                    if (settingsCompA !== settingsCompB || renamed) {
                                        componentDiffs.push({
                                            type: 'modified',
                                            componentType: compB.attributes.delegate_descriptor_id,
                                            name: nameB,
                                            oldName: renamed ? nameA : null,
                                            newName: renamed ? nameB : null,
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
                        name: itemB.attributes.name || itemB.attributes.display_name,
                        revisionNumber: itemB.attributes.revision_number,
                        item: itemB // Store full item for detailed view
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

        return { ...comparison, fromCache };
    } catch (error) {
        console.error('Comparison error:', error);
        throw new Error(`Failed to compare environments: ${error.message}`);
    }
});

ipcMain.handle('get-cache-stats', (event, { propertyId }) => {
    try { return db.getCacheStats(propertyId); }
    catch (e) { console.error('[DB]', e.message); return null; }
});

ipcMain.handle('clear-cache', (event, { propertyId }) => {
    try {
        propertyId ? db.clearPropertyCache(propertyId) : db.clearAllCache();
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// --- EXPORT LOGIC ---

// Cache for extension packages to avoid redundant network calls
const extensionPackageCache = new Map();

async function getExtensionPackage(id, headers) {
    if (extensionPackageCache.has(id)) return extensionPackageCache.get(id);

    // Try DB cache before hitting the API
    try {
        const cached = db.getExtensionPackage(id);
        if (cached) {
            extensionPackageCache.set(id, cached);
            return cached;
        }
    } catch (e) { /* non-fatal */ }

    try {
        const response = await axios.get(`https://reactor.adobe.io/extension_packages/${id}`, { headers, httpsAgent: proxyAgent });
        const pkg = response.data.data;
        extensionPackageCache.set(id, pkg);
        try { db.upsertExtensionPackage(pkg); } catch (e) { /* non-fatal */ }
        return pkg;
    } catch (e) {
        console.error(`Failed to fetch extension package ${id}:`, e.message);
        return null;
    }
}

ipcMain.handle('perform-export', async (event, args) => {
    const { types, properties, token, creds } = args;

    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select Export Folder',
        properties: ['openDirectory']
    });

    if (canceled || filePaths.length === 0) return { targetDir: null };
    const baseDir = filePaths[0];

    const headers = getHeaders(token, creds);

    // Helper to send updates to UI
    const sendStatus = (msg) => event.sender.send('export-progress', msg);
    // Prepare the fetcher callback for reactor-core
    const fetchPkg = (id) => getExtensionPackage(id, headers);

    try {
        for (let i = 0; i < properties.length; i++) {
            const prop = properties[i];
            
            const currentCount = i + 1;
            const totalCount = properties.length;
            const progressMsg = `Exporting ${prop.name} (${currentCount}/${totalCount})...`;
            
            console.log(progressMsg);
            sendStatus(progressMsg);

            const propSafeName = sanitizeFolderName(prop.name);
            const propBaseDir = path.join(baseDir, propSafeName);

            // --- OPTION 1: Full Export ---
            if (types.includes('full')) {
                const targetDir = path.join(propBaseDir, "Full Export");
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                try { db.upsertProperty(prop); }
                catch (e) { console.error('[DB] upsertProperty:', e.message); }

                sendStatus(`Fetching Rules for ${prop.name}...`);
                const rulesRes = await axios.get(`https://reactor.adobe.io/properties/${prop.id}/rules?page[size]=1000`, { headers, httpsAgent: proxyAgent });
                try { db.upsertRules(rulesRes.data.data, prop.id); }
                catch (e) { console.error('[DB] upsertRules:', e.message); }
                for (const rule of rulesRes.data.data) {
                    await reactorCore.toFiles(rule, targetDir, fetchPkg);
                }

                sendStatus(`Fetching Data Elements & Extensions for ${prop.name}...`);

                const deRes = await axios.get(`https://reactor.adobe.io/properties/${prop.id}/data_elements?page[size]=1000`, { headers, httpsAgent: proxyAgent });
                try { db.upsertDataElements(deRes.data.data, prop.id); }
                catch (e) { console.error('[DB] upsertDataElements:', e.message); }
                for (const de of deRes.data.data) {
                    await reactorCore.toFiles(de, targetDir, fetchPkg);
                }

                const extRes = await axios.get(`https://reactor.adobe.io/properties/${prop.id}/extensions?page[size]=1000`, { headers, httpsAgent: proxyAgent });
                try { db.upsertExtensions(extRes.data.data, prop.id); }
                catch (e) { console.error('[DB] upsertExtensions:', e.message); }
                for (const ext of extRes.data.data) {
                    await reactorCore.toFiles(ext, targetDir, fetchPkg);
                }

                // 4. Rule Components (Per-Rule Strategy to avoid 403s)
                sendStatus(`Fetching Rule Components for ${rulesRes.data.data.length} rules...`);
                
                // Fetch components for all rules in parallel (chunked)
                const rules = rulesRes.data.data;
                const CHUNK_SIZE = 5;
                
                for (let j = 0; j < rules.length; j += CHUNK_SIZE) {
                    const chunk = rules.slice(j, j + CHUNK_SIZE);
                    await Promise.all(chunk.map(async (rule) => {
                        try {
                            const compUrl = `https://reactor.adobe.io/rules/${rule.id}/rule_components?page[size]=100`;
                            const compRes = await axios.get(compUrl, { headers, httpsAgent: proxyAgent });
                            try { db.upsertRuleComponents(compRes.data.data, rule.id, prop.id); }
                            catch (e) { console.error('[DB] upsertRuleComponents:', e.message); }
                            for (const rc of compRes.data.data) {
                                await reactorCore.toFiles(rc, targetDir, fetchPkg);
                            }
                        } catch (rcErr) {
                            console.error(`Failed to fetch components for rule ${rule.attributes.name}:`, rcErr.message);
                        }
                    }));
                }
            }

            // --- OPTION 2: Library Export ---
            if (types.includes('library')) {
                try { db.upsertProperty(prop); }
                catch (e) { console.error('[DB] upsertProperty:', e.message); }

                sendStatus(`Locating Production Library for ${prop.name}...`);

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

                        const targetDir = path.join(propBaseDir, "Library Export", libSafeName);
                        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                        sendStatus(`Downloading Library "${libraryName}"...`);

                        // Rules
                        const rulesRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}/rules`, { headers, httpsAgent: proxyAgent });
                        try { db.upsertLibrary(libRes.data.data, prop.id); }
                        catch (e) { console.error('[DB] library upsertLibrary:', e.message); }
                        try { db.upsertRules(rulesRes.data.data, prop.id); }
                        catch (e) { console.error('[DB] library upsertRules:', e.message); }
                        try { db.linkLibraryRules(libraryId, rulesRes.data.data); }
                        catch (e) { console.error('[DB] library linkLibraryRules:', e.message); }
                        for (const r of rulesRes.data.data) await reactorCore.toFiles(r, targetDir, fetchPkg);

                        // Data Elements
                        const deRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}/data_elements`, { headers, httpsAgent: proxyAgent });
                        try { db.upsertDataElements(deRes.data.data, prop.id); }
                        catch (e) { console.error('[DB] library upsertDataElements:', e.message); }
                        try { db.linkLibraryDataElements(libraryId, deRes.data.data); }
                        catch (e) { console.error('[DB] library linkLibraryDataElements:', e.message); }
                        for (const d of deRes.data.data) await reactorCore.toFiles(d, targetDir, fetchPkg);

                        // Extensions
                        const extRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}/extensions`, { headers, httpsAgent: proxyAgent });
                        try { db.upsertExtensions(extRes.data.data, prop.id); }
                        catch (e) { console.error('[DB] library upsertExtensions:', e.message); }
                        try { db.linkLibraryExtensions(libraryId, extRes.data.data); }
                        catch (e) { console.error('[DB] library linkLibraryExtensions:', e.message); }
                        for (const e of extRes.data.data) await reactorCore.toFiles(e, targetDir, fetchPkg);

                        // Rule Components
                        const rcRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}/rule_components`, { headers, httpsAgent: proxyAgent });
                        try {
                            const byRule = {};
                            for (const rc of rcRes.data.data) {
                                const ruleId = rc.relationships?.rule?.data?.id ?? 'unknown';
                                if (!byRule[ruleId]) byRule[ruleId] = [];
                                byRule[ruleId].push(rc);
                            }
                            for (const [ruleId, rcs] of Object.entries(byRule)) {
                                db.upsertRuleComponents(rcs, ruleId, prop.id);
                            }
                        } catch (e) { console.error('[DB] library RC cache:', e.message); }
                        for (const rc of rcRes.data.data) await reactorCore.toFiles(rc, targetDir, fetchPkg);

                    } else {
                        console.log(`Skipping Library Export for ${prop.name}: No builds found.`);
                    }
                } else {
                    console.log(`Skipping Library Export for ${prop.name}: No Production Environment found.`);
                }
            }
        }
        return { targetDir: baseDir };
    } catch (error) {
        console.error(error);
        throw new Error(`Failed: ${error.message} (URL: ${error.config ? error.config.url : 'Unknown'})`);
    }
});

// --- DEVELOPER SYNC LOGIC ---

ipcMain.handle('select-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select Project Folder',
        properties: ['openDirectory', 'createDirectory']
    });
    return canceled ? null : filePaths[0];
});

ipcMain.handle('save-file', async (event, { content, defaultName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Release Notes',
        defaultPath: defaultName || 'release-notes.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    
    if (canceled || !filePath) return false;
    
    fs.writeFileSync(filePath, content);
    return true;
});

ipcMain.handle('perform-sync-download', async (event, args) => {
    const { property, targetDir, token, creds } = args;
    const headers = getHeaders(token, creds);

    const sendLog = (msg) => event.sender.send('sync-log', msg);
    const fetchPkg = (id) => getExtensionPackage(id, headers);

    try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        try { db.upsertProperty(property); }
        catch (e) { console.error('[DB] upsertProperty:', e.message); }

        // 1. Save .reactor-settings.json (Config file for the project)
        fs.writeFileSync(path.join(targetDir, '.reactor-settings.json'), JSON.stringify({
            propertyId: property.id,
            propertyName: property.name,
            orgId: creds.organization_id
        }, null, 2));
        sendLog(`Created project config at ${targetDir}`);

        // 2. Fetch & Save Everything
        sendLog(`Fetching Rules...`);
        const rulesRes = await axios.get(`https://reactor.adobe.io/properties/${property.id}/rules?page[size]=1000`, { headers, httpsAgent: proxyAgent });
        try { db.upsertRules(rulesRes.data.data, property.id); }
        catch (e) { console.error('[DB] sync upsertRules:', e.message); }
        for (const rule of rulesRes.data.data) {
            await reactorCore.toFiles(rule, targetDir, fetchPkg);
        }

        sendLog(`Fetching Data Elements...`);
        const deRes = await axios.get(`https://reactor.adobe.io/properties/${property.id}/data_elements?page[size]=1000`, { headers, httpsAgent: proxyAgent });
        try { db.upsertDataElements(deRes.data.data, property.id); }
        catch (e) { console.error('[DB] sync upsertDataElements:', e.message); }
        for (const de of deRes.data.data) {
            await reactorCore.toFiles(de, targetDir, fetchPkg);
        }

        sendLog(`Fetching Extensions...`);
        const extRes = await axios.get(`https://reactor.adobe.io/properties/${property.id}/extensions?page[size]=1000`, { headers, httpsAgent: proxyAgent });
        try { db.upsertExtensions(extRes.data.data, property.id); }
        catch (e) { console.error('[DB] sync upsertExtensions:', e.message); }
        for (const ext of extRes.data.data) {
            await reactorCore.toFiles(ext, targetDir, fetchPkg);
        }

        sendLog(`Fetching Rule Components...`);
        const rules = rulesRes.data.data;
        const CHUNK_SIZE = 5;
        for (let j = 0; j < rules.length; j += CHUNK_SIZE) {
            const chunk = rules.slice(j, j + CHUNK_SIZE);
            await Promise.all(chunk.map(async (rule) => {
                try {
                    const compUrl = `https://reactor.adobe.io/rules/${rule.id}/rule_components?page[size]=100`;
                    const compRes = await axios.get(compUrl, { headers, httpsAgent: proxyAgent });
                    try { db.upsertRuleComponents(compRes.data.data, rule.id, property.id); }
                    catch (e) { console.error('[DB] sync upsertRuleComponents:', e.message); }
                    for (const rc of compRes.data.data) {
                        await reactorCore.toFiles(rc, targetDir, fetchPkg);
                    }
                } catch (rcErr) {
                    sendLog(`Error fetching components for ${rule.attributes.name}: ${rcErr.message}`);
                }
            }));
        }

        return "Download Complete!";
    } catch (error) {
        console.error(error);
        throw new Error(`Sync Download Failed: ${error.message}`);
    }
});

ipcMain.handle('perform-sync-diff', async (event, args) => {
    const { targetDir, token, creds } = args;
    
    // Read config to find Property ID
    const configPath = path.join(targetDir, '.reactor-settings.json');
    if (!fs.existsSync(configPath)) throw new Error("No .reactor-settings.json found. Please run 'Initialize' first.");
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const propertyId = config.propertyId;

    const headers = getHeaders(token, creds);

    // Define API Fetchers for the Diff Runner
    const api = {
        getRules: async () => {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/rules?page[size]=1000`, { headers, httpsAgent: proxyAgent });
            return res.data.data;
        },
        getDataElements: async () => {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/data_elements?page[size]=1000`, { headers, httpsAgent: proxyAgent });
            return res.data.data;
        },
        getExtensions: async () => {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/extensions?page[size]=1000`, { headers, httpsAgent: proxyAgent });
            return res.data.data;
        }
    };
    
    const fetchPkg = (id) => getExtensionPackage(id, headers);

    try {
        const result = await reactorCore.diff(targetDir, api, fetchPkg);
        return result;
    } catch (error) {
        console.error(error);
        throw new Error(`Diff Failed: ${error.message}`);
    }
});

ipcMain.handle('perform-archive-scan', async (event, { propertyId, types, token, creds }) => {
    const headers = getHeaders(token, creds);

    const counts = { total: 0 };

    try {
        if (types.includes('rules')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/rules?page[size]=1`, { headers, httpsAgent: proxyAgent });
            counts.rules = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.rules;
        }
        if (types.includes('data_elements')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/data_elements?page[size]=1`, { headers, httpsAgent: proxyAgent });
            counts.data_elements = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.data_elements;
        }
        if (types.includes('extensions')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/extensions?page[size]=1`, { headers, httpsAgent: proxyAgent });
            counts.extensions = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.extensions;
        }
        // [FIX] Cannot use bulk rule_components (403). Set to N/A.
        if (types.includes('rule_components')) {
            counts.rule_components = "N/A (Scanned via Rules)"; 
        }
        // [NEW] Environments
        if (types.includes('environments')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/environments?page[size]=1`, { headers, httpsAgent: proxyAgent });
            counts.environments = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.environments;
        }
        // [NEW] Libraries
        if (types.includes('libraries')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/libraries?page[size]=1`, { headers, httpsAgent: proxyAgent });
            counts.libraries = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.libraries;
        }

        return counts;
    } catch (e) {
        console.error("Scan Error Details:", e.response?.data || e.message);
        throw new Error(`Scan failed: ${e.message}`);
    }
});

// ---------------------------------------------------------------------------
// Archive: module-level helpers and state
// ---------------------------------------------------------------------------

const ARCHIVE_CHUNK_SIZE = 5;

let pendingArchive = null;
// Shape when set:
// {
//   workQueue: Array<{ type, item }>,
//   resumeIndex: number,        // chunk-aligned start of failed chunk
//   processedItems: number,
//   totalItems: number,
//   propertyId: string,
//   targetDir: string,
//   types: string[],
//   token: string,
//   creds: object
// }

/**
 * Wraps axios.get with rate-limit handling.
 *   First 429  → wait Retry-After (or 60 s), send countdown, retry once
 *   Second 429 → throw Error('RATE_LIMIT_EXHAUSTED')
 *   Other err  → re-throw unchanged
 */
async function rateLimitedGet(url, headers, sendUpdate) {
    async function attempt() {
        return axios.get(url, { headers, httpsAgent: proxyAgent });
    }

    let res;
    try {
        res = await attempt();
    } catch (e) {
        if (e.response?.status !== 429) throw e;
        // First 429 — countdown then retry
        const retryAfter = parseInt(e.response.headers['retry-after'], 10) || 60;
        for (let remaining = retryAfter; remaining > 0; remaining--) {
            sendUpdate?.(`⏸ Rate limited — retrying in ${remaining}s…`, null);
            await new Promise(r => setTimeout(r, 1000));
        }
        try {
            res = await attempt();
        } catch (e2) {
            if (e2.response?.status === 429) throw new Error('RATE_LIMIT_EXHAUSTED');
            throw e2;
        }
    }
    return res;
}

/**
 * Module-scoped fetchList — used by both perform-archive-run and runArchiveQueue.
 * Replaces the identical local function that was inside perform-archive-run.
 */
async function archiveFetchList(url, headers, sendUpdate) {
    let all = [];
    let next = url;
    while (next) {
        const res = await rateLimitedGet(next, headers, sendUpdate);
        all = all.concat(res.data.data);
        next = res.data.links?.next;
    }
    return all;
}

/**
 * Process a work queue from startIndex onwards, in chunks of ARCHIVE_CHUNK_SIZE.
 * Returns { processedItems, totalItems } on success.
 * Throws Error('RATE_LIMIT_EXHAUSTED') with .resumeIndex set to the failing chunk's start.
 */
async function runArchiveQueue({ workQueue, startIndex, processedItems, totalItems, targetDir, headers, sendUpdate }) {
    let processed = processedItems;

    for (let i = startIndex; i < workQueue.length; i += ARCHIVE_CHUNK_SIZE) {
        const chunk = workQueue.slice(i, i + ARCHIVE_CHUNK_SIZE);

        // Collect any RATE_LIMIT_EXHAUSTED thrown inside the chunk's items
        let rateLimitHit = null;
        await Promise.all(chunk.map(async (job) => {
            const { type, item } = job;
            const itemId = item.id;
            const safeName = sanitizeFolderName(item.attributes.name || item.attributes.display_name || 'unnamed');

            const itemDir = path.join(targetDir, type, `${safeName}_${itemId}`);
            if (!fs.existsSync(itemDir)) fs.mkdirSync(itemDir, { recursive: true });

            try {
                const noRevisionTypes = ['builds', 'libraries', 'environments', 'rule_components'];

                if (noRevisionTypes.includes(type)) {
                    fs.writeFileSync(path.join(itemDir, `${type}_${itemId}.json`), JSON.stringify(item, null, 2));
                } else {
                    const revisionsUrl = `https://reactor.adobe.io/${type}/${itemId}/revisions`;
                    const revisions = await archiveFetchList(revisionsUrl, headers, sendUpdate);

                    revisions.forEach(rev => {
                        const revPath = path.join(itemDir, `rev_${rev.id}.json`);
                        if (!fs.existsSync(revPath)) {
                            fs.writeFileSync(revPath, JSON.stringify(rev, null, 2));
                        }
                    });

                    if (type === 'extensions') {
                        try {
                            const pkgUrl = `https://reactor.adobe.io/extensions/${itemId}/extension_package`;
                            const pkgRes = await rateLimitedGet(pkgUrl, headers, sendUpdate);
                            const pkg = pkgRes.data.data;
                            if (pkg) {
                                fs.writeFileSync(path.join(itemDir, `package_${pkg.id}.json`), JSON.stringify(pkg, null, 2));
                            }
                        } catch (pkgErr) {
                            if (pkgErr.message === 'RATE_LIMIT_EXHAUSTED') throw pkgErr;
                            console.error(`Failed to fetch package for extension ${itemId}:`, pkgErr.message);
                        }
                    }
                }
            } catch (itemErr) {
                if (itemErr.message === 'RATE_LIMIT_EXHAUSTED') {
                    rateLimitHit = itemErr;  // bubble up after all items settle
                } else {
                    console.error(`Failed to archive ${type} ${itemId}:`, itemErr.message);
                }
            }
        }));

        if (rateLimitHit) {
            const err = new Error('RATE_LIMIT_EXHAUSTED');
            err.resumeIndex = i;
            err.processedItems = processed;
            throw err;
        }

        processed += chunk.length;
        const pct = Math.round((processed / totalItems) * 100);
        sendUpdate(`Archived ${processed}/${totalItems} items...`, pct);
    }

    return { processedItems: processed, totalItems };
}

ipcMain.handle('perform-archive-run', async (event, { propertyId, targetDir, types, token, creds }) => {
    // Clear any stale pending state from a previous run
    pendingArchive = null;

    const headers = getHeaders(token, creds);
    const sendUpdate = (msg, progress, extra = {}) =>
        event.sender.send('archive-progress', { msg, progress, ...extra });

    try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        // ----------------------------------------------------------------
        // Phase 1: Build work queue (list-fetching phase)
        // ----------------------------------------------------------------
        const workQueue = [];

        const queueType = async (type, endpoint) => {
            if (types.includes(type)) {
                sendUpdate(`Fetching ${type} list...`, 0);
                try {
                    const items = await archiveFetchList(
                        `https://reactor.adobe.io/properties/${propertyId}/${endpoint}?page[size]=100`,
                        headers, sendUpdate
                    );
                    workQueue.push(...items.map(item => ({ type, item })));
                } catch (err) {
                    if (err.message === 'RATE_LIMIT_EXHAUSTED') throw err;
                    console.error(`Failed to list ${type}:`, err.message);
                }
            }
        };

        try {
            await queueType('rules', 'rules');
            await queueType('data_elements', 'data_elements');
            await queueType('extensions', 'extensions');
            await queueType('environments', 'environments');
            await queueType('libraries', 'libraries');

            // Builds (via Libraries)
            if (types.includes('builds')) {
                sendUpdate('Fetching Libraries for Build scan...', 0);
                let libsForBuilds = workQueue.filter(i => i.type === 'libraries').map(i => i.item);
                if (libsForBuilds.length === 0) {
                    libsForBuilds = await archiveFetchList(
                        `https://reactor.adobe.io/properties/${propertyId}/libraries?page[size]=100`,
                        headers, sendUpdate
                    );
                }
                for (const lib of libsForBuilds) {
                    try {
                        const builds = await archiveFetchList(
                            `https://reactor.adobe.io/libraries/${lib.id}/builds?page[size]=100`,
                            headers, sendUpdate
                        );
                        workQueue.push(...builds.map(b => ({ type: 'builds', item: b })));
                    } catch (e) {
                        if (e.message === 'RATE_LIMIT_EXHAUSTED') throw e;
                        /* ignore — library may have no builds */
                    }
                }
            }

            // Rule Components (via Rules)
            if (types.includes('rule_components')) {
                sendUpdate('Fetching Rules to find Components...', 0);
                let rulesForComps = workQueue.filter(i => i.type === 'rules').map(i => i.item);
                if (rulesForComps.length === 0) {
                    rulesForComps = await archiveFetchList(
                        `https://reactor.adobe.io/properties/${propertyId}/rules?page[size]=100`,
                        headers, sendUpdate
                    );
                }
                for (const r of rulesForComps) {
                    try {
                        const comps = await archiveFetchList(
                            `https://reactor.adobe.io/rules/${r.id}/rule_components?page[size]=100`,
                            headers, sendUpdate
                        );
                        workQueue.push(...comps.map(c => ({ type: 'rule_components', item: c })));
                    } catch (e) {
                        if (e.message === 'RATE_LIMIT_EXHAUSTED') throw e;
                        /* ignore */
                    }
                }
            }
        } catch (listErr) {
            if (listErr.message === 'RATE_LIMIT_EXHAUSTED') {
                throw new Error('Archive paused: rate limited twice during list setup. Please wait and try again.');
            }
            throw listErr;
        }

        const totalItems = workQueue.length;
        sendUpdate(`Found ${totalItems} items to archive. Starting...`, 0);

        // ----------------------------------------------------------------
        // Phase 2: Process queue
        // ----------------------------------------------------------------
        try {
            await runArchiveQueue({
                workQueue, startIndex: 0, processedItems: 0, totalItems,
                targetDir, headers, sendUpdate
            });
        } catch (queueErr) {
            if (queueErr.message === 'RATE_LIMIT_EXHAUSTED') {
                const pct = totalItems ? Math.round((queueErr.processedItems / totalItems) * 100) : 0;
                pendingArchive = {
                    workQueue,
                    resumeIndex: queueErr.resumeIndex,
                    processedItems: queueErr.processedItems,
                    totalItems,
                    propertyId, targetDir, types, token, creds
                };
                sendUpdate('⛔ Rate limited twice. Click Resume when ready.', pct, { rateLimited: true });
                return { rateLimited: true };
            }
            throw queueErr;
        }

        pendingArchive = null;
        return { success: true };

    } catch (e) {
        throw new Error(`Archive Run Failed: ${e.message}`);
    }
});

ipcMain.handle('resume-archive-run', async (event) => {
    if (!pendingArchive) {
        return { success: false, error: 'No paused archive in this session' };
    }

    const { workQueue, resumeIndex, processedItems, totalItems,
            targetDir, token, creds } = pendingArchive;
    const headers = getHeaders(token, creds);
    const sendUpdate = (msg, progress, extra = {}) =>
        event.sender.send('archive-progress', { msg, progress, ...extra });

    try {
        await runArchiveQueue({
            workQueue, startIndex: resumeIndex, processedItems, totalItems,
            targetDir, headers, sendUpdate
        });
        pendingArchive = null;
        return { success: true };
    } catch (e) {
        if (e.message === 'RATE_LIMIT_EXHAUSTED') {
            const pct = Math.round((e.processedItems / totalItems) * 100);
            pendingArchive.resumeIndex = e.resumeIndex;
            pendingArchive.processedItems = e.processedItems;
            sendUpdate('⛔ Rate limited twice. Click Resume when ready.', pct, { rateLimited: true });
            return { rateLimited: true };
        }
        return { success: false, error: e.message };
    }
});
