const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const https = require('https');

// --- Configuration ---
const PROPERTY_ID = process.argv[2];
const ENVA_ID = process.argv[3]; // Base
const ENVB_ID = process.argv[4]; // Compare
const MODE = process.argv[5] || 'environments'; // environments, libraries, or history

if (!PROPERTY_ID || !ENVA_ID || !ENVB_ID) {
    console.error("Usage: node run-compare.js <PROPERTY_ID> <ENVA_ID> <ENVB_ID> [MODE]");
    console.error("Example: node run-compare.js PRd5bc90a99021489ebaf99dfa9065cebe EN31f1765a8042497dab0fbebbfd8494ab EN5b2123fd874e4ce4832bc7fe4d8b0f96");
    process.exit(1);
}

const proxyAgent = new https.Agent({ rejectUnauthorized: false });

// --- Main execution ---
async function main() {
    console.log("--- Starting Comparison Process ---");

    // 1. Load Credentials
    console.log("Loading credentials...");
    const creds = await loadCredentials();
    if (!creds) return;

    // 2. Authenticate
    console.log("Authenticating...");
    const token = await getAccessToken(creds);
    if (!token) return;

    const headers = {
        "Authorization": `Bearer ${token}`,
        "x-api-key": creds.client_id,
        "x-gw-ims-org-id": creds.organization_id,
        "Accept": "application/vnd.api+json;revision=1"
    };

    // 3. Perform Comparison (Simulating perform-environment-comparison handler)
    console.log(`Comparing ${ENVA_ID} vs ${ENVB_ID} (Mode: ${MODE})...`);
    
    try {
        // We'll fetch the entity names first for the report
        const nameA = await getEntityName(ENVA_ID, headers);
        const nameB = await getEntityName(ENVB_ID, headers);

        // Fetch data for both
        const dataA = await fetchEntityData(ENVA_ID, headers);
        const dataB = await fetchEntityData(ENVB_ID, headers);

        // Run Comparison Logic
        const results = {
            rules: compareItems(dataA.rules, dataB.rules),
            data_elements: compareItems(dataA.data_elements, dataB.data_elements),
            extensions: compareItems(dataA.extensions, dataB.extensions)
        };

        // 4. Generate Markdown (Using the logic from downloadComparisonNotes)
        console.log("Generating Release Notes...");
        const markdown = generateMarkdown(nameA, nameB, results);

        // 5. Save to file
        const filename = `release-notes-${nameA}-vs-${nameB}.md`.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const outputPath = path.join(__dirname, 'export', filename);
        await fs.mkdir(path.join(__dirname, 'export'), { recursive: true });
        await fs.writeFile(outputPath, markdown);

        console.log(`\n✅ Comparison Complete!`);
        console.log(`Output saved to: ${outputPath}`);
        console.log("\n--- Preview ---");
        console.log(markdown.substring(0, 500) + "...");

    } catch (e) {
        console.error("Comparison Failed:", e.message);
    }
}

// --- Logic Helpers (Mirrored from main.js / compare.js) ---

function compareItems(itemsA, itemsB) {
    const getStableId = (item) => item.relationships?.origin?.data?.id || item.id;
    const mapA = new Map(itemsA.map(item => [getStableId(item), item]));
    const mapB = new Map(itemsB.map(item => [getStableId(item), item]));

    const onlyInA = [];
    const onlyInB = [];
    const modified = [];

    for (const [stableId, itemA] of mapA) {
        if (!mapB.has(stableId)) {
            onlyInA.push({ name: itemA.attributes.name || itemA.attributes.display_name, item: itemA });
        } else {
            const itemB = mapB.get(stableId);
            const settingsA = JSON.stringify(itemA.attributes);
            const settingsB = JSON.stringify(itemB.attributes);
            
            // Simplified rule component check for this script
            const compA = itemA.rule_components ? JSON.stringify(itemA.rule_components) : null;
            const compB = itemB.rule_components ? JSON.stringify(itemB.rule_components) : null;

            if (settingsA !== settingsB || compA !== compB) {
                const attrDiffs = [];
                const allKeys = new Set([...Object.keys(itemA.attributes), ...Object.keys(itemB.attributes)]);
                for (const key of allKeys) {
                    if (['created_at', 'updated_at', 'published_at', 'dirty', 'published'].includes(key)) continue;
                    if (JSON.stringify(itemA.attributes[key]) !== JSON.stringify(itemB.attributes[key])) {
                        attrDiffs.push({ field: key, oldValue: itemA.attributes[key], newValue: itemB.attributes[key] });
                    }
                }
                modified.push({ 
                    name: itemB.attributes.name || itemB.attributes.display_name, 
                    attributeDiffs: attrDiffs 
                });
            }
        }
    }

    for (const [stableId, itemB] of mapB) {
        if (!mapA.has(stableId)) {
            onlyInB.push({ name: itemB.attributes.name || itemB.attributes.display_name, item: itemB });
        }
    }

    return { onlyInA, onlyInB, modified };
}

function generateMarkdown(nameA, nameB, results) {
    let md = `# Release Notes: ${nameA} vs ${nameB}\n`;
    md += `*Generated via Heimdall CLI on ${new Date().toLocaleString()}*\n\n`;

    const types = [
        { key: 'rules', label: 'Rules' },
        { key: 'data_elements', label: 'Data Elements' },
        { key: 'extensions', label: 'Extensions' }
    ];

    types.forEach(type => {
        const d = results[type.key];
        if (d.onlyInB.length > 0) {
            md += `## Added ${type.label}\n`;
            d.onlyInB.forEach(i => {
                md += `- **${i.name}**\n`;
                md += "  - *Full Configuration:*\n";
                md += "    ```json\n";
                const config = JSON.stringify(i.item.attributes, null, 2).split('\n').map(l => `    ${l}`).join('\n');
                md += `${config}\n`;
                md += "    ```\n";
            });
            md += '\n';
        }
        if (d.onlyInA.length > 0) {
            md += `## Removed ${type.label}\n`;
            d.onlyInA.forEach(i => md += `- **${i.name}**\n`);
            md += '\n';
        }
        if (d.modified.length > 0) {
            md += `## Modified ${type.label}\n`;
            d.modified.forEach(i => {
                md += `- **${i.name}**\n`;
                i.attributeDiffs.forEach(diff => {
                    md += `  - *${diff.field}*: \`${JSON.stringify(diff.oldValue)}\` → \`${JSON.stringify(diff.newValue)}\`\n`;
                });
            });
            md += '\n';
        }
    });
    return md;
}

// --- API Helpers ---

async function getEntityName(id, headers) {
    const type = id.startsWith('PR') ? 'properties' : id.startsWith('EN') ? 'environments' : 'libraries';
    const res = await axios.get(`https://reactor.adobe.io/${type}/${id}`, { headers, httpsAgent: proxyAgent });
    return res.data.data.attributes.name;
}

async function fetchEntityData(id, headers) {
    // If it's an environment, get latest build
    let buildId = id;
    if (id.startsWith('EN')) {
        const buildRes = await axios.get(`https://reactor.adobe.io/environments/${id}/builds?page[size]=1`, { headers, httpsAgent: proxyAgent });
        if (!buildRes.data.data[0]) throw new Error(`No builds found for environment ${id}`);
        buildId = buildRes.data.data[0].id;
    }

    const [rules, data_elements, extensions] = await Promise.all([
        fetchAllPages(`https://reactor.adobe.io/${id.startsWith('LB') ? 'libraries' : 'builds'}/${buildId}/rules`, headers),
        fetchAllPages(`https://reactor.adobe.io/${id.startsWith('LB') ? 'libraries' : 'builds'}/${buildId}/data_elements`, headers),
        fetchAllPages(`https://reactor.adobe.io/${id.startsWith('LB') ? 'libraries' : 'builds'}/${buildId}/extensions`, headers)
    ]);

    return { rules, data_elements, extensions };
}

async function fetchAllPages(url, headers) {
    let allData = [];
    let currentUrl = url;
    while (currentUrl) {
        const response = await axios.get(currentUrl, { headers, httpsAgent: proxyAgent });
        allData = allData.concat(response.data.data || []);
        currentUrl = response.data.links?.next;
    }
    return allData;
}

async function loadCredentials() {
    const content = await fs.readFile(path.join(__dirname, '../memory/adobe_credentials.md'), 'utf8');
    const creds = {};
    content.split('\n').forEach(line => {
        if (!line.includes('=')) return;
        const [k, v] = line.split('=').map(s => s.trim().replace(/"/g, ''));
        if (k === 'Client ID') creds.client_id = v;
        if (k === 'Client Secret') creds.client_secret = v;
        if (k === 'Scopes') creds.scope = v;
        if (k === 'Organization ID') creds.organization_id = v;
    });
    return creds;
}

async function getAccessToken(creds) {
    const res = await axios.post('https://ims-na1.adobelogin.com/ims/token/v3', new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        scope: creds.scope
    }));
    return res.data.access_token;
}

main();
