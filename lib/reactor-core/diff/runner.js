const fs = require('fs');
const path = require('path');
const compare = require('./compare');
const fromFile = require('../from-file');
const { readBase, baseOf } = require('./base');

const TYPE_PREFIXES = {
    'rules': 'RL',
    'extensions': 'EX',
    'data_elements': 'DE',
    'environments': 'EN',
    'rule_components': 'RC'
};

// Each synced type and the api function that lists it. Rule components sit
// flat in rule_components/<id>/, as the download writes them.
const SOURCES = [
    ['rules', 'getRules'],
    ['data_elements', 'getDataElements'],
    ['extensions', 'getExtensions'],
    ['rule_components', 'getRuleComponents']
];

// The item folders of a type. Name links start with `_`, so the prefix skips them.
function localIds(typeDir, prefix) {
    if (!fs.existsSync(typeDir)) return [];
    return fs.readdirSync(typeDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
        .map(entry => entry.name);
}

/**
 * Classifies every item of one type found locally, in Launch, or in the
 * download record.
 */
async function diffType(type, baseDir, remoteResources, fetchExtensionPackage, result, base) {
    const typeDir = path.join(baseDir, type);
    const local = new Set(localIds(typeDir, TYPE_PREFIXES[type]));
    const remotes = new Map(remoteResources.map(remote => [remote.id, remote]));
    const recorded = base ? Object.keys(base.items).filter(id => base.items[id].type === type) : [];

    for (const id of new Set([...local, ...remotes.keys(), ...recorded])) {
        const localPath = path.join(typeDir, id);
        let localItem = null;
        if (local.has(id)) {
            try {
                localItem = await fromFile(localPath, fetchExtensionPackage);
            } catch (e) {
                result.errors.push({ type, id, path: localPath, message: e.message });
                continue;
            }
        }
        const remote = remotes.get(id) ?? null;
        const entry = baseOf(base, localPath, id);
        const comparison = compare(localItem, remote, entry);

        const record = {
            type,
            id,
            path: localPath,
            name: localItem?.attributes.name ?? remote?.attributes.name ?? entry?.name,
            details: comparison.details
        };
        if (entry?.rule_id) {
            record.rule_id = entry.rule_id;
            record.rule_name = base?.items[entry.rule_id]?.name;
        }
        result[comparison.result].push(record);
    }
}

/**
 * Main Diff Runner
 * @param {string} baseDir - Root directory of the property.
 * @param {Object} api - Object containing async fetch functions:
 *                       { getRules(), getDataElements(), getExtensions(), getRuleComponents() }
 *                       Each should return an ARRAY of resources. A type whose
 *                       function is missing isn't diffed; one whose function
 *                       throws goes in `errors` instead, so a failed list never
 *                       reads as everything being deleted in Launch.
 * @param {Function} fetchExtensionPackage - Async function(id) for transforms.
 */
module.exports = async (baseDir, api, fetchExtensionPackage) => {
    const result = {
        added: [],           // new locally (push as new)
        modified: [],        // changed locally (push)
        deleted: [],         // removed locally (push as a delete)
        behind: [],          // new or changed in Launch (pull)
        deletedInLaunch: [], // gone from Launch; the next download sets the folder aside
        conflict: [],        // changed on both sides; details.reason says how
        unchanged: [],
        errors: []
    };

    const base = readBase(baseDir);
    result.hasBase = Boolean(base);

    for (const [type, list] of SOURCES) {
        if (!api[list]) continue;
        let remotes;
        try {
            remotes = await api[list]();
        } catch (e) {
            result.errors.push({ type, message: `Couldn't list ${type}: ${e.message}` });
            continue;
        }
        await diffType(type, baseDir, remotes, fetchExtensionPackage, result, base);
    }

    return result;
};
