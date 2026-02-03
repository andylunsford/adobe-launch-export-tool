const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const https = require('https');
const { toFiles } = require('./lib/reactor-core');

const PROPERTY_ID = process.argv[2];
if (!PROPERTY_ID) {
    console.error("Usage: node run-export.js <PROPERTY_ID>");
    process.exit(1);
}

// Global cache for extension packages
const extensionPackageCache = new Map();

// --- Main execution ---
async function main() {
    console.log("--- Starting Export Process ---");

    // 1. Load Credentials
    console.log("Loading credentials...");
    const creds = await loadCredentials();
    if (!creds) {
        console.error("Failed to load credentials.");
        return;
    }

    // 2. Authenticate
    console.log("Authenticating with Adobe IMS...");
    const token = await getAccessToken(creds);
    if (!token) {
        console.error("Failed to get access token.");
        return;
    }
    console.log("Authentication successful.");

    // 3. Set up headers and helpers
    const headers = getHeaders(token, creds);
    const fetchExtensionPackage = (id) => getExtensionPackage(id, headers);

    // 4. Define export directory
    const exportDir = path.join(__dirname, 'export', sanitizeFolderName(PROPERTY_ID));
    await fs.mkdir(exportDir, { recursive: true });
    console.log(`Exporting to: ${exportDir}`);

    // 5. Fetch all resources and export
    const resourceTypes = ['rules', 'data_elements', 'extensions', 'environments'];
    for (const type of resourceTypes) {
        console.log(`Fetching ${type}...`);
        const items = await fetchAllPages(`https://reactor.adobe.io/properties/${PROPERTY_ID}/${type}?page[size]=100`, headers);
        console.log(`Found ${items.length} ${type}. Exporting...`);
        for (const item of items) {
            await toFiles(item, exportDir, fetchExtensionPackage);
        }

        // Special handling for rule_components
        if (type === 'rules') {
            console.log(`Fetching rule components for ${items.length} rules...`);
            const allRuleComponents = await fetchRuleComponents(items, headers);
            console.log(`Found ${allRuleComponents.length} total rule components. Exporting...`);
            for (const rc of allRuleComponents) {
                await toFiles(rc, exportDir, fetchExtensionPackage);
            }
        }
        // Special handling for environments (to fetch builds and download files)
        if (type === 'environments') {
            console.log(`Fetching builds for ${items.length} environments...`);
            for (const env of items) {
                const builds = await fetchAllPages(`https://reactor.adobe.io/environments/${env.id}/builds?page[size]=50`, headers);
                console.log(`Found ${builds.length} builds for environment ${env.attributes.name}. Exporting...`);
                for (const build of builds) {
                    await toFiles(build, exportDir, fetchExtensionPackage);
                }

                // Download actual library files if available in the environment meta
                if (env.meta && env.meta.script_sources) {
                    for (const source of env.meta.script_sources) {
                        if (source.minified) {
                            await downloadFile(source.minified, path.join(exportDir, 'environments', env.id, 'library.min.js'));
                        }
                        if (source.debug) {
                            await downloadFile(source.debug, path.join(exportDir, 'environments', env.id, 'library.js'));
                        }
                    }
                }
            }
        }
    }

    console.log("--- Export Process Complete ---");
}

// --- Helper Functions ---

async function downloadFile(url, targetPath) {
    try {
        console.log(`Downloading: ${url}`);
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        await fs.writeFile(targetPath, response.data);
        console.log(`Saved to: ${targetPath}`);
    } catch (e) {
        console.error(`Failed to download file from ${url}:`, e.message);
    }
}

function sanitizeFolderName(name) {
    if (!name) return "Untitled";
    return name.replace(/[^a-zA-Z0-9\- ]/g, '').trim();
}

async function loadCredentials() {
    try {
        const credContent = await fs.readFile(path.join(__dirname, '../memory/adobe_credentials.md'), 'utf8');
        const lines = credContent.split('\n');
        const creds = {};
        lines.forEach(line => {
            if (line.includes('=')) {
                const [key, value] = line.split('=').map(s => s.trim());
                if (key === 'Client ID') creds.client_id = value.replace(/"/g, '');
                if (key === 'Client Secret') creds.client_secret = value.replace(/"/g, '');
                if (key === 'Scopes') creds.scope = value.replace(/"/g, '');
                if (key === 'Organization ID') creds.organization_id = value.replace(/"/g, '');
            }
        });
        // Assume standard IMS endpoint
        creds.ims_endpoint = 'https://ims-na1.adobelogin.com';
        return creds;
    } catch (e) {
        console.error("Error reading credentials file:", e);
        return null;
    }
}

async function getAccessToken(creds) {
    try {
        const response = await axios.post(`${creds.ims_endpoint}/ims/token/v3`, new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            scope: creds.scope
        }));
        return response.data.access_token;
    } catch (error) {
        console.error("IMS Authentication Error:", error.response?.data || error.message);
        return null;
    }
}

function getHeaders(token, creds) {
    return {
        "Authorization": `Bearer ${token}`,
        "x-api-key": creds.client_id,
        "x-gw-ims-org-id": creds.organization_id,
        "Accept": "application/vnd.api+json;revision=1"
    };
}

async function fetchAllPages(url, headers) {
    let allData = [];
    let currentUrl = url;
    while (currentUrl) {
        try {
            const response = await axios.get(currentUrl, { headers, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
            allData = allData.concat(response.data.data || []);
            currentUrl = response.data.links?.next;
        } catch (e) {
            console.error(`Failed to fetch page ${currentUrl}:`, e.message);
            currentUrl = null; // stop pagination on error
        }
    }
    return allData;
}

async function fetchRuleComponents(rules, headers) {
    let allComponents = [];
    const CHUNK_SIZE = 10;
    for (let i = 0; i < rules.length; i += CHUNK_SIZE) {
        const chunk = rules.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (rule) => {
            try {
                const components = await fetchAllPages(`https://reactor.adobe.io/rules/${rule.id}/rule_components?page[size]=100`, headers);
                allComponents = allComponents.concat(components);
            } catch (e) {
                console.error(`Failed to fetch components for rule ${rule.id}:`, e.message);
            }
        }));
        console.log(`Fetched components for rules ${i + 1} through ${Math.min(i + CHUNK_SIZE, rules.length)}`);
    }
    return allComponents;
}

async function getExtensionPackage(id, headers) {
    if (extensionPackageCache.has(id)) return extensionPackageCache.get(id);
    try {
        const response = await axios.get(`https://reactor.adobe.io/extension_packages/${id}`, { headers, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
        const pkg = response.data.data;
        extensionPackageCache.set(id, pkg);
        return pkg;
    } catch (e) {
        console.error(`Failed to fetch extension package ${id}:`, e.message);
        return null;
    }
}


main();
