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