// Developer Sync: listing a property and writing it to a local folder that
// mirrors Launch. Each function takes `get(url)`, an async GET resolving to the
// parsed response body, so the caller picks the HTTP client.

const fs = require('fs');
const path = require('path');
const { listAll } = require('./api');
const toFiles = require('./to-files');
const fromFile = require('./from-file');
const { rebuildNameLinks } = require('./name-links');
const { fingerprint } = require('./diff/normalize');
const { readBase, writeBase, baseEntry, baseOf } = require('./diff/base');

const REACTOR_URL = 'https://reactor.adobe.io';
const SYNC_TYPES = ['rules', 'data_elements', 'extensions', 'rule_components'];
const TYPE_PREFIXES = { rules: 'RL', data_elements: 'DE', extensions: 'EX', rule_components: 'RC' };
// Folders of items deleted in Launch are moved here, never deleted
const SET_ASIDE_DIR = '_deleted';
const CHUNK_SIZE = 5;

/**
 * Lists every rule's components. There is no property-wide list (it returns
 * 403), so this goes rule by rule, five at a time.
 * @returns {Promise<{ components, ruleOf: Map, failed: Array<{ id, name, message }> }>}
 *   ruleOf maps each component to its rule; failed holds the rules whose list failed
 */
async function listRuleComponents(get, rules) {
    const components = [];
    const ruleOf = new Map();
    const failed = [];
    for (let i = 0; i < rules.length; i += CHUNK_SIZE) {
        const chunk = rules.slice(i, i + CHUNK_SIZE);
        const lists = await Promise.all(chunk.map(rule =>
            listAll(get, `${REACTOR_URL}/rules/${rule.id}/rule_components`).catch(e => {
                failed.push({ id: rule.id, name: rule.attributes?.name, message: e.message });
                return [];
            })));
        chunk.forEach((rule, j) => lists[j].forEach(c => {
            components.push(c);
            ruleOf.set(c.id, rule.id);
        }));
    }
    return { components, ruleOf, failed };
}

/** The diff runner's api for a property: one list function per synced type. */
function syncApi(get, propertyId) {
    const list = (type) => listAll(get, `${REACTOR_URL}/properties/${propertyId}/${type}`);
    let rules;
    const getRules = () => (rules ??= list('rules'));
    return {
        getRules,
        getDataElements: () => list('data_elements'),
        getExtensions: () => list('extensions'),
        getRuleComponents: async () => {
            const { components, failed } = await listRuleComponents(get, await getRules());
            if (failed.length) throw new Error(`the components of ${failed.length} rule(s) couldn't be listed`);
            return components;
        }
    };
}

/**
 * Lists everything a download writes. A failed rules, data element or
 * extension list throws; a rule whose components fail goes in `failed`.
 */
async function listProperty(get, propertyId) {
    const api = syncApi(get, propertyId);
    const rules = await api.getRules();
    const dataElements = await api.getDataElements();
    const extensions = await api.getExtensions();
    const { components, ruleOf, failed } = await listRuleComponents(get, rules);
    return { rules, data_elements: dataElements, extensions, rule_components: components, ruleOf, failed };
}

const localIds = (targetDir, type) => {
    const typeDir = path.join(targetDir, type);
    if (!fs.existsSync(typeDir)) return [];
    return fs.readdirSync(typeDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith(TYPE_PREFIXES[type]))
        .map(entry => entry.name);
};

async function localFingerprint(folder, fetchPkg) {
    try {
        return fingerprint(await fromFile(folder, fetchPkg));
    } catch (e) {
        return null;
    }
}

function nameIn(folder) {
    try {
        return JSON.parse(fs.readFileSync(path.join(folder, 'data.json'), 'utf8')).attributes.name;
    } catch (e) {
        return null;
    }
}

function setAside(targetDir, type, id) {
    const parent = path.join(targetDir, SET_ASIDE_DIR, type);
    fs.mkdirSync(parent, { recursive: true });
    let target = path.join(parent, id);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(parent, `${id} (${n})`);
    fs.renameSync(path.join(targetDir, type, id), target);
}

/**
 * Writes a listed property into targetDir so it mirrors Launch, and records
 * what was written in the download record.
 *
 * - An item edited locally (its folder differs from both the record and
 *   Launch) is kept as it is. To take Launch's version, delete its folder and
 *   download again.
 * - For each type listed completely, the folders of items Launch no longer
 *   lists are moved to _deleted/<type>/, unless they have local edits or the
 *   record doesn't know them; then the name links are rebuilt.
 * - Code files an item no longer has are removed (to-files.js).
 *
 * @param {Object} args.listing - from listProperty
 * @returns {Promise<Object>} what happened, for the log: { written, removedFiles,
 *   keptLocal, setAside, keptUnlisted, incomplete }, the lists holding { type, id, name }
 */
async function writeDownload({ targetDir, listing, fetchPkg, now = () => new Date().toISOString() }) {
    const base = readBase(targetDir);
    const items = { ...base?.items };
    const summary = {
        written: 0,
        removedFiles: 0,
        keptLocal: [],
        setAside: [],
        keptUnlisted: [],
        incomplete: listing.failed.length ? ['rule_components'] : []
    };

    try {
        for (const type of SYNC_TYPES) {
            for (const item of listing[type]) {
                const folder = path.join(targetDir, type, item.id);
                const entry = baseOf(base, folder, item.id);
                if (fs.existsSync(folder)) {
                    const local = await localFingerprint(folder, fetchPkg);
                    if (local && local !== fingerprint(item) && local !== entry?.hash) {
                        if (entry) items[item.id] = entry;
                        summary.keptLocal.push({ type, id: item.id, name: entry?.name ?? item.attributes.name });
                        continue;
                    }
                }
                const { files, removed } = await toFiles(item, targetDir, fetchPkg);
                const rule = type === 'rule_components' ? { rule_id: listing.ruleOf.get(item.id) } : {};
                items[item.id] = baseEntry(item, { files, ...rule });
                summary.written++;
                summary.removedFiles += removed.length;
            }
        }

        for (const type of SYNC_TYPES) {
            if (summary.incomplete.includes(type)) continue;
            const live = new Set(listing[type].map(item => item.id));

            for (const id of localIds(targetDir, type)) {
                if (live.has(id)) continue;
                const folder = path.join(targetDir, type, id);
                const entry = baseOf(base, folder, id);
                const name = entry?.name ?? nameIn(folder);
                if (entry && await localFingerprint(folder, fetchPkg) === entry.hash) {
                    setAside(targetDir, type, id);
                    summary.setAside.push({ type, id, name });
                } else {
                    if (entry) items[id] = entry;
                    summary.keptUnlisted.push({ type, id, name });
                }
            }
            // An entry for an item gone from Launch whose folder is gone too
            // (set aside above, or removed by hand) has nothing left to compare.
            for (const [id, entry] of Object.entries(items)) {
                if (entry.type === type && !live.has(id) && !fs.existsSync(path.join(targetDir, type, id))) delete items[id];
            }
            rebuildNameLinks(path.join(targetDir, type), listing[type]);
        }
    } finally {
        writeBase(targetDir, { version: 1, downloaded_at: now(), items });
    }

    return summary;
}

module.exports = { listRuleComponents, syncApi, listProperty, writeDownload, readBase, SET_ASIDE_DIR };
