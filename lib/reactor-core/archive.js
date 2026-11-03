'use strict';

/**
 * Writes the History Archive. Each item gets one folder, `<name>_<id>`, under
 * its type. Rules, data elements and extensions keep every revision as
 * `rev_<id>.json`; their head (revision 0) carries the item's own id and is its
 * current state. Other types keep their record as `<type>_<id>.json`.
 *
 * Each function takes `get(url)`, an async GET resolving to the parsed response
 * body, as in ./api. The archive passes its rate-limited one, which throws
 * `RATE_LIMIT_EXHAUSTED` to pause the run.
 *
 * What this keeps right, found by checking an archive against live Launch
 * (reverse-engineer-launch handoff/history-archive-drift):
 * - Files are rewritten whenever their content changed. A revision's content is
 *   fixed, but its `published` flags and `meta` are not, and the head changes
 *   with every edit.
 * - A folder is found by its id, so a rename moves it instead of starting a
 *   second one.
 * - Items Launch no longer lists get a `_deleted.json` marker.
 */

const fs = require('fs');
const path = require('path');
const { listAll } = require('./api');

const REACTOR_URL = 'https://reactor.adobe.io';
const RATE_LIMIT_EXHAUSTED = 'RATE_LIMIT_EXHAUSTED';
const REVISION_TYPES = ['rules', 'data_elements', 'extensions'];
const DELETED_MARKER = '_deleted.json';
// Folders that earlier runs duplicated are moved here, never deleted.
const SUPERSEDED_DIR = '_superseded';

// Reactor ids are a two-letter type prefix and 32 hex digits.
const ID_PATTERN = /^[A-Z]{2}[0-9a-f]{32}$/;

function folderId(folderName) {
    const id = folderName.slice(folderName.lastIndexOf('_') + 1);
    return ID_PATTERN.test(id) ? id : null;
}

const headFile = (type, id) => REVISION_TYPES.includes(type) ? `rev_${id}.json` : `${type}_${id}.json`;

// Writes only when the content differs, so file dates show when something changed.
function writeIfChanged(file, record) {
    const json = JSON.stringify(record, null, 2);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === json) return false;
    fs.writeFileSync(file, json);
    return true;
}

function latestWrite(dir) {
    return Math.max(0, ...fs.readdirSync(dir).map(name => fs.statSync(path.join(dir, name)).mtimeMs));
}

function setAside(targetDir, type, folder) {
    const dir = path.join(targetDir, SUPERSEDED_DIR, type);
    fs.mkdirSync(dir, { recursive: true });
    let destination = path.join(dir, folder);
    for (let n = 2; fs.existsSync(destination); n++) destination = path.join(dir, `${folder} (${n})`);
    fs.renameSync(path.join(targetDir, type, folder), destination);
}

/**
 * The item's folder, named for its current name. An existing folder is found by
 * id and renamed. Where earlier renames left several, the one with the current
 * name (or else the most recently written) is kept and the others are set aside.
 */
function itemFolder(targetDir, type, itemId, folderName) {
    const typeDir = path.join(targetDir, type);
    const wanted = `${folderName}_${itemId}`;
    fs.mkdirSync(typeDir, { recursive: true });

    const existing = fs.readdirSync(typeDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && folderId(entry.name) === itemId)
        .map(entry => entry.name);
    if (existing.length === 0) {
        fs.mkdirSync(path.join(typeDir, wanted));
        return path.join(typeDir, wanted);
    }

    const keep = existing.includes(wanted) ? wanted
        : existing.reduce((a, b) => latestWrite(path.join(typeDir, b)) > latestWrite(path.join(typeDir, a)) ? b : a);
    existing.filter(folder => folder !== keep).forEach(folder => setAside(targetDir, type, folder));
    if (keep !== wanted) fs.renameSync(path.join(typeDir, keep), path.join(typeDir, wanted));
    return path.join(typeDir, wanted);
}

/**
 * Lists what to archive for a property. `liveIds` has an entry for a type only
 * when its listing completed, since only a complete listing shows what was deleted.
 */
async function listArchiveWork({ propertyId, types, get, onProgress = () => {} }) {
    const workQueue = [];
    const liveIds = {};
    const queue = (type, items) => workQueue.push(...items.map(item => ({ type, item })));

    for (const type of ['rules', 'data_elements', 'extensions', 'environments', 'libraries']) {
        if (!types.includes(type)) continue;
        onProgress(`Fetching ${type} list...`);
        try {
            const items = await listAll(get, `${REACTOR_URL}/properties/${propertyId}/${type}`);
            queue(type, items);
            liveIds[type] = new Set(items.map(item => item.id));
        } catch (err) {
            if (err.message === RATE_LIMIT_EXHAUSTED) throw err;
            console.error(`Failed to list ${type}:`, err.message);
        }
    }

    // Builds (via Libraries)
    if (types.includes('builds')) {
        onProgress('Fetching Libraries for Build scan...');
        let libraries = workQueue.filter(job => job.type === 'libraries').map(job => job.item);
        if (libraries.length === 0) libraries = await listAll(get, `${REACTOR_URL}/properties/${propertyId}/libraries`);
        for (const library of libraries) {
            try {
                queue('builds', await listAll(get, `${REACTOR_URL}/libraries/${library.id}/builds`));
            } catch (err) {
                if (err.message === RATE_LIMIT_EXHAUSTED) throw err;
                /* ignore — library may have no builds */
            }
        }
    }

    // Rule Components (via Rules)
    if (types.includes('rule_components')) {
        onProgress('Fetching Rules to find Components...');
        let rules = workQueue.filter(job => job.type === 'rules').map(job => job.item);
        if (rules.length === 0) rules = await listAll(get, `${REACTOR_URL}/properties/${propertyId}/rules`);
        const componentIds = new Set();
        let complete = true;
        for (const rule of rules) {
            try {
                const components = await listAll(get, `${REACTOR_URL}/rules/${rule.id}/rule_components`);
                queue('rule_components', components);
                components.forEach(component => componentIds.add(component.id));
            } catch (err) {
                if (err.message === RATE_LIMIT_EXHAUSTED) throw err;
                complete = false;
            }
        }
        if (complete) liveIds.rule_components = componentIds;
    }

    return { workQueue, liveIds };
}

/**
 * Archives one listed item into its folder, writing only files whose content changed.
 * @param {string} folderName  the item's name made safe for a folder
 */
async function archiveItem({ type, item, folderName, targetDir, get }) {
    const dir = itemFolder(targetDir, type, item.id, folderName);
    if (!REVISION_TYPES.includes(type)) {
        writeIfChanged(path.join(dir, headFile(type, item.id)), item);
        return;
    }

    // The list holds the head and every revision, so all are refreshed.
    const revisions = await listAll(get, `${REACTOR_URL}/${type}/${item.id}/revisions`);
    revisions.forEach(rev => writeIfChanged(path.join(dir, `rev_${rev.id}.json`), rev));

    if (type === 'extensions') {
        try {
            const pkg = (await get(`${REACTOR_URL}/extensions/${item.id}/extension_package`)).data;
            if (pkg) writeIfChanged(path.join(dir, `package_${pkg.id}.json`), pkg);
        } catch (err) {
            if (err.message === RATE_LIMIT_EXHAUSTED) throw err;
            console.error(`Failed to fetch package for extension ${item.id}:`, err.message);
        }
    }
}

// How an item Launch no longer lists was deleted, or null if it still exists.
async function deletionOf(type, id, get) {
    let record;
    try {
        record = (await get(`${REACTOR_URL}/${type}/${id}`)).data;
    } catch (err) {
        // Libraries are deleted outright rather than marked
        if (err.response?.status === 404) return { marker: { status: 404 } };
        throw err;
    }
    if (record.attributes?.deleted_at) return { record, marker: { deleted_at: record.attributes.deleted_at } };

    // A component goes with its rule, though its own record may not say so.
    if (type === 'rule_components') {
        const rules = await listAll(get, `${REACTOR_URL}/rule_components/${id}/rules`);
        const deletedRule = rules.find(rule => rule.attributes?.deleted_at);
        if (deletedRule) return { record, marker: { deleted_at: deletedRule.attributes.deleted_at, rule_id: deletedRule.id } };
    }
    return null;
}

/**
 * Marks the folders of items a complete listing left out: `_deleted.json` holds
 * when Launch deleted the item (or the 404 it now returns) and when this found
 * out, and the head is refreshed to its deleted state. Call it only with a type
 * `listArchiveWork` listed completely, or live items would be marked.
 * Throws `RATE_LIMIT_EXHAUSTED` to stop; any other failed lookup leaves the item unmarked.
 * @returns {Promise<{marked: string[], failed: string[]}>} item ids
 */
async function markDeletions({ targetDir, type, liveIds, get, now = () => new Date().toISOString() }) {
    const typeDir = path.join(targetDir, type);
    const result = { marked: [], failed: [] };
    if (!fs.existsSync(typeDir)) return result;

    const unlisted = new Map();
    for (const entry of fs.readdirSync(typeDir, { withFileTypes: true })) {
        const id = entry.isDirectory() && folderId(entry.name);
        if (!id || liveIds.has(id) || fs.existsSync(path.join(typeDir, entry.name, DELETED_MARKER))) continue;
        unlisted.set(id, [...(unlisted.get(id) || []), entry.name]);
    }

    for (const [id, folders] of unlisted) {
        let deletion;
        try {
            deletion = await deletionOf(type, id, get);
        } catch (err) {
            if (err.message === RATE_LIMIT_EXHAUSTED) throw err;
            console.error(`Failed to check whether ${type} ${id} was deleted:`, err.message);
            result.failed.push(id);
            continue;
        }
        if (!deletion) continue;
        for (const folder of folders) {
            const dir = path.join(typeDir, folder);
            if (deletion.record) writeIfChanged(path.join(dir, headFile(type, id)), deletion.record);
            writeIfChanged(path.join(dir, DELETED_MARKER), { ...deletion.marker, detected_at: now() });
        }
        result.marked.push(id);
    }
    return result;
}

module.exports = { listArchiveWork, archiveItem, markDeletions };
