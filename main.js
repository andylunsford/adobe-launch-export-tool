const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const reactorCore = require('./lib/reactor-core');
const { listAll, latestSucceededBuild, latestSucceededBuilds, latestSucceededLibraryBuild } = reactorCore.api;
const { diffSets } = reactorCore.compareBuilds;
const { listArchiveWork, archiveItem, markDeletions } = reactorCore.archive;
const { rebuildNameLinks } = reactorCore.nameLinks;
const syncLib = reactorCore.sync;
const db = require('./lib/db');

// --- TLS ---
// Corporate proxies that inspect TLS re-sign traffic with an internal CA that
// Node does not trust, which is why this agent originally disabled verification
// outright. That silently accepted any certificate on every machine, so
// verification is now ON by default and the bypass is an explicit per-machine
// opt-in persisted alongside the rest of the config.
let apiAgent = new https.Agent();

// Node/OpenSSL codes that mean "the chain did not validate" rather than a
// network failure. Used to tell the user a proxy is likely the cause.
const TLS_TRUST_ERROR_CODES = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_UNTRUSTED',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID'
]);

function isTlsTrustError(err) {
    return TLS_TRUST_ERROR_CODES.has(err?.code) ||
           TLS_TRUST_ERROR_CODES.has(err?.cause?.code);
}

/**
 * Rebuilds the shared agent from the persisted setting. Called at startup and
 * whenever the setting changes, so a toggle takes effect without a restart.
 */
function refreshApiAgent() {
    const insecure = loadVariables().allow_insecure_tls === true;
    apiAgent = new https.Agent({ rejectUnauthorized: !insecure });
    if (insecure) {
        console.warn('[tls] Certificate verification is DISABLED by user setting.');
    }
    return insecure;
}

const VARS_PATH = path.join(app.getPath('userData'), 'reactor_vars.json');

function createWindow() {
    const win = new BrowserWindow({
        width: 1100,
        height: 850,
        webPreferences: {
            // The renderer displays data returned by the Reactor API (rule names,
            // data element values, extension settings). Isolating it means an
            // unescaped string from that data cannot reach Node.
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    win.loadFile('index.html');
}

app.whenReady().then(() => {
    try { db.initDb(); }
    catch (e) { console.error('[DB] initDb failed (cache disabled):', e.message); }
    // Must run after app is ready - reads the persisted config from userData.
    refreshApiAgent();
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

// The `get` that the lib/reactor-core/api helpers take: resolves to the body.
function reactorGet(headers) {
    return (url) => axios.get(url, { headers, httpsAgent: apiAgent }).then(res => res.data);
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

// --- SHELL ---
// The renderer no longer has `shell`, so these proxy it. openExternal hands a
// string to the OS handler, so anything but http/https is refused here rather
// than trusted from the renderer.
ipcMain.handle('open-external', async (event, url) => {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { success: false, error: 'Malformed URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        console.warn(`[shell] refused openExternal for scheme: ${parsed.protocol}`);
        return { success: false, error: 'Only http and https URLs may be opened' };
    }
    await shell.openExternal(parsed.href);
    return { success: true };
});

ipcMain.handle('open-path', async (event, targetPath) => {
    const err = await shell.openPath(targetPath);
    return err ? { success: false, error: err } : { success: true };
});

ipcMain.handle('get-saved-config', () => loadVariables());

ipcMain.handle('save-config-field', (event, { key, value }) => {
    const vars = loadVariables();
    vars[key] = value;
    saveVariables(vars);
    // Rebuild the agent so a TLS toggle applies without restarting the app.
    if (key === 'allow_insecure_tls') refreshApiAgent();
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
            httpsAgent: apiAgent
        });

        const vars = loadVariables();
        vars.credentials = creds;
        saveVariables(vars);

        return { success: true, token: response.data.access_token };
    } catch (error) {
        // A trust failure here almost always means a TLS-inspecting corporate
        // proxy rather than bad credentials. Say so, instead of surfacing an
        // opaque OpenSSL code the user cannot act on.
        if (isTlsTrustError(error)) {
            return {
                success: false,
                tlsTrustError: true,
                error: 'Could not verify the server certificate. If you are on a ' +
                       'corporate network that inspects HTTPS traffic, enable ' +
                       '"Allow untrusted certificates" in the credentials panel ' +
                       `and try again. (${error.code ?? error.cause?.code})`
            };
        }
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-companies', async (event, { token, creds }) => {
    const get = reactorGet(getHeaders(token, creds));
    return listAll(get, "https://reactor.adobe.io/companies");
});

ipcMain.handle('get-properties', async (event, { token, creds, companyId }) => {
    const get = reactorGet(getHeaders(token, creds));
    return listAll(get, `https://reactor.adobe.io/companies/${companyId}/properties`);
});

ipcMain.handle('get-libraries', async (event, { token, creds, propertyId }) => {
    const get = reactorGet(getHeaders(token, creds));
    return listAll(get, `https://reactor.adobe.io/properties/${propertyId}/libraries`);
});

ipcMain.handle('get-environments', async (event, { token, creds, propertyId }) => {
    const get = reactorGet(getHeaders(token, creds));
    return listAll(get, `https://reactor.adobe.io/properties/${propertyId}/environments`);
});

ipcMain.handle('get-environment-library', async (event, { token, creds, environmentId }) => {
    try {
        const headers = getHeaders(token, creds);

        // What the environment runs: its newest succeeded build
        const latestBuild = await latestSucceededBuild(reactorGet(headers), environmentId);

        if (latestBuild) {
            const libraryId = latestBuild.relationships.library.data.id;

            // Get the library details
            const libRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}`, {
                headers,
                httpsAgent: apiAgent
            });

            return {
                libraryId: libraryId,
                libraryName: libRes.data.data.attributes.name,
                buildId: latestBuild.id,
                buildDate: latestBuild.attributes.updated_at
            };
        }

        return null; // No builds found
    } catch (error) {
        console.error('Error fetching environment library:', error.message);
        return null;
    }
});

ipcMain.handle('perform-environment-comparison', async (event, { token, creds, envAId, envBId, mode, useCache, propertyId }) => {
    try {
        const get = reactorGet(getHeaders(token, creds));

        // Component timeouts and delays only take effect when the property runs
        // rule components in sequence, so only then do they count as changes.
        // Unknown counts as on, which reports more rather than less.
        const sequencing = propertyId
            ? get(`https://reactor.adobe.io/properties/${propertyId}`)
                .then(body => body.data.attributes.rule_component_sequencing_enabled !== false, () => true)
            : Promise.resolve(true);

        // A build's effective set. Rule components are fetched later, and only
        // for rules whose revision differs between the two sides.
        async function fetchBuildContents(buildId) {
            const [rules, data_elements, extensions] = await Promise.all([
                listAll(get, `https://reactor.adobe.io/builds/${buildId}/rules`),
                listAll(get, `https://reactor.adobe.io/builds/${buildId}/data_elements`),
                listAll(get, `https://reactor.adobe.io/builds/${buildId}/extensions`)
            ]);
            return { rules, data_elements, extensions, buildId };
        }

        // Helper function to fetch build data for an environment OR library
        async function fetchEnvironmentData(entityId) {
            if (entityId.startsWith('LB')) {
                // A library's own lists hold only its changes. The release is
                // its newest succeeded build, which holds everything upstream too.
                const build = await latestSucceededLibraryBuild(get, entityId);
                if (!build) {
                    const library = await get(`https://reactor.adobe.io/libraries/${entityId}`);
                    throw new Error(`Library "${library.data.attributes.name}" has no successful build yet, so there is nothing to compare. Build it first.`);
                }
                return await fetchBuildContents(build.id);
            } else {
                // It's an Environment -> what it runs is its newest succeeded build
                const build = await latestSucceededBuild(get, entityId);
                if (!build) return { rules: [], data_elements: [], extensions: [], buildId: null };

                return await fetchBuildContents(build.id);
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

        // The cache stores library own lists, which aren't what a library
        // compare reads any more, so only environment mode may use it.
        if (useCache && mode === 'environments') {
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
                // envAId is the Environment ID. Only succeeded builds count:
                // a failed or pending build never ran.
                const builds = await latestSucceededBuilds(get, envAId, 2);

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

        // A rule revision's components, fetched only for rules on different
        // revisions: the same revision on both sides is the same rule.
        const loadComponents = (rule) => rule.rule_components
            ? Promise.resolve(rule.rule_components)
            : listAll(get, `https://reactor.adobe.io/rules/${rule.id}/rule_components`);

        const comparison = await diffSets(envAData, envBData, { loadComponents, sequencing: await sequencing });

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
        const response = await axios.get(`https://reactor.adobe.io/extension_packages/${id}`, { headers, httpsAgent: apiAgent });
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
    const get = reactorGet(headers);

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
                const rules = await listAll(get, `https://reactor.adobe.io/properties/${prop.id}/rules`);
                try { db.upsertRules(rules, prop.id); }
                catch (e) { console.error('[DB] upsertRules:', e.message); }
                for (const rule of rules) {
                    await reactorCore.toFiles(rule, targetDir, fetchPkg);
                }

                sendStatus(`Fetching Data Elements & Extensions for ${prop.name}...`);

                const dataElements = await listAll(get, `https://reactor.adobe.io/properties/${prop.id}/data_elements`);
                try { db.upsertDataElements(dataElements, prop.id); }
                catch (e) { console.error('[DB] upsertDataElements:', e.message); }
                for (const de of dataElements) {
                    await reactorCore.toFiles(de, targetDir, fetchPkg);
                }

                const extensions = await listAll(get, `https://reactor.adobe.io/properties/${prop.id}/extensions`);
                try { db.upsertExtensions(extensions, prop.id); }
                catch (e) { console.error('[DB] upsertExtensions:', e.message); }
                for (const ext of extensions) {
                    await reactorCore.toFiles(ext, targetDir, fetchPkg);
                }

                // 4. Rule Components (Per-Rule Strategy to avoid 403s)
                sendStatus(`Fetching Rule Components for ${rules.length} rules...`);

                // Fetch components for all rules in parallel (chunked)
                const CHUNK_SIZE = 5;
                const ruleComponents = [];
                let componentsComplete = true;

                for (let j = 0; j < rules.length; j += CHUNK_SIZE) {
                    const chunk = rules.slice(j, j + CHUNK_SIZE);
                    await Promise.all(chunk.map(async (rule) => {
                        try {
                            const components = await listAll(get, `https://reactor.adobe.io/rules/${rule.id}/rule_components`);
                            try { db.upsertRuleComponents(components, rule.id, prop.id); }
                            catch (e) { console.error('[DB] upsertRuleComponents:', e.message); }
                            for (const rc of components) {
                                await reactorCore.toFiles(rc, targetDir, fetchPkg);
                            }
                            ruleComponents.push(...components);
                        } catch (rcErr) {
                            componentsComplete = false;
                            console.error(`Failed to fetch components for rule ${rule.attributes.name}:`, rcErr.message);
                        }
                    }));
                }

                // Name links, one per item. A partial component list would
                // drop the links of the components it missed.
                rebuildNameLinks(path.join(targetDir, 'rules'), rules);
                rebuildNameLinks(path.join(targetDir, 'data_elements'), dataElements);
                rebuildNameLinks(path.join(targetDir, 'extensions'), extensions);
                if (componentsComplete) rebuildNameLinks(path.join(targetDir, 'rule_components'), ruleComponents);
            }

            // --- OPTION 2: Library Export ---
            if (types.includes('library')) {
                try { db.upsertProperty(prop); }
                catch (e) { console.error('[DB] upsertProperty:', e.message); }

                sendStatus(`Locating Production Library for ${prop.name}...`);

                const environments = await listAll(get, `https://reactor.adobe.io/properties/${prop.id}/environments`);
                const prodEnv = environments.find(e => e.attributes.stage === 'production');

                if (prodEnv) {
                    // The live build is production's newest succeeded build
                    const latestBuild = await latestSucceededBuild(get, prodEnv.id);

                    if (latestBuild) {
                        const libraryId = latestBuild.relationships.library.data.id;

                        // Get Library Name
                        const libRes = await axios.get(`https://reactor.adobe.io/libraries/${libraryId}`, { headers, httpsAgent: apiAgent });
                        const libraryName = libRes.data.data.attributes.name;
                        const libSafeName = sanitizeFolderName(libraryName);

                        const targetDir = path.join(propBaseDir, "Library Export", libSafeName);
                        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                        sendStatus(`Downloading Library "${libraryName}"...`);

                        // Rules
                        const rules = await listAll(get, `https://reactor.adobe.io/libraries/${libraryId}/rules`);
                        try { db.upsertLibrary(libRes.data.data, prop.id); }
                        catch (e) { console.error('[DB] library upsertLibrary:', e.message); }
                        try { db.upsertRules(rules, prop.id); }
                        catch (e) { console.error('[DB] library upsertRules:', e.message); }
                        try { db.linkLibraryRules(libraryId, rules); }
                        catch (e) { console.error('[DB] library linkLibraryRules:', e.message); }
                        for (const r of rules) await reactorCore.toFiles(r, targetDir, fetchPkg);

                        // Data Elements
                        const dataElements = await listAll(get, `https://reactor.adobe.io/libraries/${libraryId}/data_elements`);
                        try { db.upsertDataElements(dataElements, prop.id); }
                        catch (e) { console.error('[DB] library upsertDataElements:', e.message); }
                        try { db.linkLibraryDataElements(libraryId, dataElements); }
                        catch (e) { console.error('[DB] library linkLibraryDataElements:', e.message); }
                        for (const d of dataElements) await reactorCore.toFiles(d, targetDir, fetchPkg);

                        // Extensions
                        const extensions = await listAll(get, `https://reactor.adobe.io/libraries/${libraryId}/extensions`);
                        try { db.upsertExtensions(extensions, prop.id); }
                        catch (e) { console.error('[DB] library upsertExtensions:', e.message); }
                        try { db.linkLibraryExtensions(libraryId, extensions); }
                        catch (e) { console.error('[DB] library linkLibraryExtensions:', e.message); }
                        for (const e of extensions) await reactorCore.toFiles(e, targetDir, fetchPkg);

                        // Rule Components
                        const ruleComponents = await listAll(get, `https://reactor.adobe.io/libraries/${libraryId}/rule_components`);
                        try {
                            const byRule = {};
                            for (const rc of ruleComponents) {
                                const ruleId = rc.relationships?.rule?.data?.id ?? 'unknown';
                                if (!byRule[ruleId]) byRule[ruleId] = [];
                                byRule[ruleId].push(rc);
                            }
                            for (const [ruleId, rcs] of Object.entries(byRule)) {
                                db.upsertRuleComponents(rcs, ruleId, prop.id);
                            }
                        } catch (e) { console.error('[DB] library RC cache:', e.message); }
                        for (const rc of ruleComponents) await reactorCore.toFiles(rc, targetDir, fetchPkg);

                        rebuildNameLinks(path.join(targetDir, 'rules'), rules);
                        rebuildNameLinks(path.join(targetDir, 'data_elements'), dataElements);
                        rebuildNameLinks(path.join(targetDir, 'extensions'), extensions);
                        rebuildNameLinks(path.join(targetDir, 'rule_components'), ruleComponents);

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
    const get = reactorGet(headers);

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

        // 2. List everything, then write it (lib/reactor-core/sync.js)
        sendLog(`Fetching Rules, Data Elements, Extensions and Rule Components...`);
        const listing = await syncLib.listProperty(get, property.id);
        listing.failed.forEach(rule => sendLog(`Error fetching components for ${rule.name}: ${rule.message}`));

        try { db.upsertRules(listing.rules, property.id); }
        catch (e) { console.error('[DB] sync upsertRules:', e.message); }
        try { db.upsertDataElements(listing.data_elements, property.id); }
        catch (e) { console.error('[DB] sync upsertDataElements:', e.message); }
        try { db.upsertExtensions(listing.extensions, property.id); }
        catch (e) { console.error('[DB] sync upsertExtensions:', e.message); }
        for (const rule of listing.rules) {
            const components = listing.rule_components.filter(rc => listing.ruleOf.get(rc.id) === rule.id);
            try { db.upsertRuleComponents(components, rule.id, property.id); }
            catch (e) { console.error('[DB] sync upsertRuleComponents:', e.message); }
        }

        sendLog(`Writing files...`);
        return await syncLib.writeDownload({ targetDir, listing, fetchPkg });
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
    const get = reactorGet(headers);

    // List functions for the Diff Runner, rule components included
    const api = syncLib.syncApi(get, propertyId);

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
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/rules?page[size]=1`, { headers, httpsAgent: apiAgent });
            counts.rules = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.rules;
        }
        if (types.includes('data_elements')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/data_elements?page[size]=1`, { headers, httpsAgent: apiAgent });
            counts.data_elements = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.data_elements;
        }
        if (types.includes('extensions')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/extensions?page[size]=1`, { headers, httpsAgent: apiAgent });
            counts.extensions = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.extensions;
        }
        // [FIX] Cannot use bulk rule_components (403). Set to N/A.
        if (types.includes('rule_components')) {
            counts.rule_components = "N/A (Scanned via Rules)"; 
        }
        // [NEW] Environments
        if (types.includes('environments')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/environments?page[size]=1`, { headers, httpsAgent: apiAgent });
            counts.environments = res.data.meta?.pagination?.total_count || res.data.meta?.pagination?.total || 0;
            counts.total += counts.environments;
        }
        // [NEW] Libraries
        if (types.includes('libraries')) {
            const res = await axios.get(`https://reactor.adobe.io/properties/${propertyId}/libraries?page[size]=1`, { headers, httpsAgent: apiAgent });
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
        return axios.get(url, { headers, httpsAgent: apiAgent });
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
 * The archive's `get(url)` for lib/reactor-core/archive: the rate-limited GET,
 * resolving to the response body, so a 429 pauses the archive.
 */
function archiveGet(headers, sendUpdate) {
    return (url) => rateLimitedGet(url, headers, sendUpdate).then(res => res.data);
}

/**
 * Process a work queue from startIndex onwards, in chunks of ARCHIVE_CHUNK_SIZE.
 * Returns { processedItems, totalItems } on success.
 * Throws Error('RATE_LIMIT_EXHAUSTED') with .resumeIndex set to the failing chunk's start.
 */
async function runArchiveQueue({ workQueue, startIndex, processedItems, totalItems, targetDir, headers, sendUpdate }) {
    let processed = processedItems;
    const get = archiveGet(headers, sendUpdate);

    for (let i = startIndex; i < workQueue.length; i += ARCHIVE_CHUNK_SIZE) {
        const chunk = workQueue.slice(i, i + ARCHIVE_CHUNK_SIZE);

        // Collect any RATE_LIMIT_EXHAUSTED thrown inside the chunk's items
        let rateLimitHit = null;
        await Promise.all(chunk.map(async ({ type, item }) => {
            const folderName = sanitizeFolderName(item.attributes.name || item.attributes.display_name || 'unnamed');
            try {
                await archiveItem({ type, item, folderName, targetDir, get });
            } catch (itemErr) {
                if (itemErr.message === 'RATE_LIMIT_EXHAUSTED') {
                    rateLimitHit = itemErr;  // bubble up after all items settle
                } else {
                    console.error(`Failed to archive ${type} ${item.id}:`, itemErr.message);
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
        const get = archiveGet(headers, sendUpdate);
        let workQueue, liveIds;
        try {
            ({ workQueue, liveIds } = await listArchiveWork({
                propertyId, types, get, onProgress: (msg) => sendUpdate(msg, 0)
            }));
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

        // ----------------------------------------------------------------
        // Phase 3: Mark items Launch no longer lists. Only a run that listed
        // and archived everything without a pause gets here, and only types
        // listed completely are checked, so no live item is marked.
        // ----------------------------------------------------------------
        try {
            let marked = 0;
            for (const [type, ids] of Object.entries(liveIds)) {
                sendUpdate(`Checking for deleted ${type}...`, 100);
                marked += (await markDeletions({ targetDir, type, liveIds: ids, get })).marked.length;
            }
            if (marked > 0) sendUpdate(`Marked ${marked} deleted items with _deleted.json.`, 100);
        } catch (e) {
            sendUpdate(e.message === 'RATE_LIMIT_EXHAUSTED'
                ? '⚠ Rate limited while checking for deleted items. The next run will finish the check.'
                : `⚠ Check for deleted items failed: ${e.message}`, 100);
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
