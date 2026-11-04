'use strict';

// Reads a library sync folder: the library's revisions with the local edits in
// their files, for assembleTestBuild. A folder deleted locally is a revision taken
// out of the library, and one set aside in _deleted/ is gone from it, so neither
// is read.

const path = require('path');
const fromFile = require('../from-file');
const { readFile } = require('../utils');
const { readBase } = require('../diff/base');
const { localIds } = require('../sync');
const { transformsFor, transformFiles, getNested, setNested } = require('../transforms');
const { byRevisionId } = require('./entries');

const toLF = (text) => text.replace(/\r\n/g, '\n');

function parseSettings(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/**
 * A revision as its folder has it. from-file.js reads code files with LF line
 * endings; where that is the only difference from the code data.json stores, the
 * stored code is kept, so an unedited item is written exactly as Launch has it.
 */
async function readRevision(folder, fetchPkg) {
    const item = await fromFile(folder, fetchPkg);
    const settings = parseSettings(item.attributes.settings);
    const stored = parseSettings(readFile(path.join(folder, 'data.json')).attributes.settings);
    if (!settings || !stored) return item;

    let changed = false;
    for (const { path: parts } of transformFiles(await transformsFor(item, fetchPkg), settings)) {
        const code = getNested(settings, parts);
        const storedCode = getNested(stored, parts);
        if (typeof code === 'string' && typeof storedCode === 'string' && code !== storedCode && toLF(code) === toLF(storedCode)) {
            setNested(settings, parts, storedCode);
            changed = true;
        }
    }
    if (changed) item.attributes.settings = JSON.stringify(settings);
    return item;
}

/** Every revision of a type in the folder, in revision id order. */
async function readType(syncDir, type, fetchPkg) {
    const revisions = [];
    for (const id of localIds(syncDir, type).sort(byRevisionId)) {
        revisions.push(await readRevision(path.join(syncDir, type, id), fetchPkg));
    }
    return revisions;
}

/**
 * The library's revisions in a sync folder, with local edits. Rule components
 * go with the rule the download record says they belong to; one it doesn't say
 * is left out, with a warning.
 * @param {string} syncDir - a folder written by a library download
 * @param {Function} fetchPkg - async (id) => extension package
 * @returns {Promise<{ rules: Array<{ revision: Object, components: Object[] }>, data_elements: Array<{ revision: Object }>,
 *   extensions: Array<{ revision: Object }>, warnings: string[] }>} each list in revision id order
 */
async function readLibraryItems(syncDir, fetchPkg) {
    const base = readBase(syncDir);
    const warnings = [];

    const componentsOf = new Map();
    for (const component of await readType(syncDir, 'rule_components', fetchPkg)) {
        const ruleId = base?.items[component.id]?.rule_id;
        if (!ruleId) {
            warnings.push(`rule component ${component.attributes.name} (${component.id}) left out: the download record doesn't say which rule it belongs to`);
            continue;
        }
        if (!componentsOf.has(ruleId)) componentsOf.set(ruleId, []);
        componentsOf.get(ruleId).push(component);
    }

    const rules = (await readType(syncDir, 'rules', fetchPkg)).map(revision => ({ revision, components: componentsOf.get(revision.id) ?? [] }));
    const dataElements = (await readType(syncDir, 'data_elements', fetchPkg)).map(revision => ({ revision }));
    const extensions = (await readType(syncDir, 'extensions', fetchPkg)).map(revision => ({ revision }));
    return { rules, data_elements: dataElements, extensions, warnings };
}

module.exports = { readLibraryItems };
