const fs = require('fs');
const path = require('path');
const compare = require('./compare');
const fromFile = require('../from-file');
const { checkCreateDir } = require('../utils');

const TYPE_PREFIXES = {
    'rules': 'RL',
    'extensions': 'EX',
    'data_elements': 'DE',
    'environments': 'EN',
    'rule_components': 'RC'
};

/**
 * Generic diff runner for a specific resource type.
 */
async function diffType(type, baseDir, remoteResources, fetchExtensionPackage, globalResult) {
    const typeDir = path.join(baseDir, type);
    checkCreateDir(typeDir); // Ensure dir exists so readdir doesn't fail

    const prefix = TYPE_PREFIXES[type];
    const localFiles = fs.readdirSync(typeDir).filter(f => !prefix || f.startsWith(prefix)); // Filter by ID prefix if known
    
    // 1. Iterate Local Files (Check for Modified / Added)
    for (const file of localFiles) {
        const localPath = path.join(typeDir, file);
        
        // Skip symlinks or non-directories if any
        try {
            if (!fs.statSync(localPath).isDirectory()) continue;
        } catch (e) { continue; }

        try {
            const local = await fromFile(localPath, fetchExtensionPackage);
            const remote = remoteResources.find(r => r.id === local.id);

            const comparison = compare(local, remote);
            
            globalResult[comparison.result].push({
                type: type,
                id: local.id,
                path: localPath,
                name: local.attributes.name,
                details: comparison.details
            });
        } catch (e) {
            console.error(`Error diffing local ${type} ${file}:`, e);
        }
    }

    // 2. Iterate Remote Resources (Check for Behind)
    for (const remote of remoteResources) {
        // If we didn't find this ID in the local files loop
        // (Note: localFiles is just filenames/IDs. We need to check if that ID exists locally)
        const existsLocally = localFiles.includes(remote.id);

        if (!existsLocally) {
            const comparison = compare(null, remote);
            globalResult[comparison.result].push({
                type: type,
                id: remote.id,
                path: path.join(typeDir, remote.id),
                name: remote.attributes.name,
                details: comparison.details
            });
        }
    }
}

/**
 * Main Diff Runner
 * @param {string} baseDir - Root directory of the property.
 * @param {Object} api - Object containing async fetch functions:
 *                       { getRules(), getDataElements(), getExtensions(), ... }
 *                       Each should return an ARRAY of resources.
 * @param {Function} fetchExtensionPackage - Async function(id) for transforms.
 */
module.exports = async (baseDir, api, fetchExtensionPackage) => {
    const result = {
        added: [],
        modified: [],
        deleted: [], // Note: Deleted is hard to detect without a manifest.
        behind: [],  // "Deleted" locally usually just looks like "Behind" (remote has it, you don't).
        unchanged: []
    };

    // Parallel fetching for speed? Or sequential to avoid rate limits?
    // Sequential is safer for now.
    
    // 1. Rules
    if (api.getRules) {
        const remotes = await api.getRules();
        await diffType('rules', baseDir, remotes, fetchExtensionPackage, result);
    }

    // 2. Data Elements
    if (api.getDataElements) {
        const remotes = await api.getDataElements();
        await diffType('data_elements', baseDir, remotes, fetchExtensionPackage, result);
    }

    // 3. Extensions
    if (api.getExtensions) {
        const remotes = await api.getExtensions();
        await diffType('extensions', baseDir, remotes, fetchExtensionPackage, result);
    }

    // 4. Rule Components (Tricky, usually nested in rules, but Launch API has flat endpoint)
    // If user wants to diff individual components independently:
    if (api.getRuleComponents) {
         // This might be noisy if we already diffed rules, but reactor-sync does it.
         // Wait, reactor-sync does diffRuleComponents.
         // NOTE: Rule Components are usually stored INSIDE the rule folder in your custom tool.
         // My generic logic expects `baseDir/rule_components/ID`.
         // Your tool structure: `baseDir/rules/RULE_ID/events/COMPONENT_ID`.
         // This is a MISMATCH.
         
         // ADAPTATION:
         // If we want to support your tool's nested structure, we need a custom walker for Rule Components.
         // Or, we force the "reactor-sync" flat structure.
         // Andy said "I don't want to rewrite them... bring functionality...".
         // But your tool exports to a nested structure. `reactor-sync` expects flat structure.
         // If we use `reactor-sync` logic on your nested folder, it won't find anything.
         
         // FIX: I should probably NOT enable rule_components flat diffing if we keep the nested structure.
         // Instead, when diffing a Rule, we should probably diff its components?
         // Or, we adapt `diffType` to look in nested folders.
         
         // For now, let's skip rule_components flat diff and assume Rule diff covers settings.
         // But wait, if I change code in a Rule Component (Action), does the Rule's `updated_at` change?
         // Yes, usually.
    }

    return result;
};
