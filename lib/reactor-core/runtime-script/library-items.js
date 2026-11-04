'use strict';

// Reads a library sync folder: the library's revisions with the local edits in
// their files, for assembleTestBuild. A folder deleted locally is a revision taken
// out of the library, and one set aside in _deleted/ is gone from it, so neither
// is read.

const fs = require('fs');
const path = require('path');
const fromFile = require('../from-file');
const { readFile } = require('../utils');
const { readBase } = require('../diff/base');
const { localIds } = require('../sync');
const { transformsFor, transformFiles, getNested, setNested } = require('../transforms');
const { byRevisionId } = require('./entries');

const toLF = (text) => text.replace(/\r\n/g, '\n');

// Settings that aren't JSON have no code files to compare
function parseJsonOrNull(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/** A JSON file of an item's folder. One that won't parse is named, which JSON.parse doesn't do. */
function readJson(file) {
    try {
        return readFile(file);
    } catch (err) {
        if (err instanceof SyntaxError) throw new Error(`${file} isn't valid JSON: ${err.message}`);
        throw err;
    }
}

/**
 * A revision as its folder has it. from-file.js reads code files with LF line
 * endings; where that is the only difference from the code data.json stores, the
 * stored code is kept, so an unedited item is written exactly as Launch has it.
 */
async function readRevision(folder, fetchPkg) {
    // Read before fromFile, which reads them too but doesn't say which one won't parse.
    // A hand edit is the likeliest way to break one.
    const data = readJson(path.join(folder, 'data.json'));
    const settingsFile = path.join(folder, 'settings.json');
    if (fs.existsSync(settingsFile)) readJson(settingsFile);

    const item = await fromFile(folder, fetchPkg);
    const settings = parseJsonOrNull(item.attributes.settings);
    const stored = parseJsonOrNull(data.attributes.settings);
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
 * go with the rule the download record says they belong to. One it doesn't
 * say is left out with a warning. So are the components of a rule revision that
 * isn't in the folder (deleting a rule's folder is how it is taken out), with one
 * warning for the rule.
 * @param {string} syncDir - a folder written by a library download
 * @param {Function} fetchPkg - async (id) => extension package
 * @returns {Promise<{ rules: Array<{ revision: Object, components: Object[] }>, data_elements: Array<{ revision: Object }>,
 *   extensions: Array<{ revision: Object }>, warnings: string[] }>} each list in revision id order
 * @throws {Error} naming a JSON file that won't parse
 */
async function readLibraryItems(syncDir, fetchPkg) {
    const base = readBase(syncDir);
    const warnings = [];
    // How many components each rule revision that isn't in the folder had
    const missingRules = new Map();

    const rules = (await readType(syncDir, 'rules', fetchPkg)).map(revision => ({ revision, components: [] }));
    const ruleById = new Map(rules.map(rule => [rule.revision.id, rule]));
    for (const component of await readType(syncDir, 'rule_components', fetchPkg)) {
        const ruleId = base?.items[component.id]?.rule_id;
        if (!ruleId) {
            warnings.push(`rule component ${component.attributes.name} (${component.id}) left out: the download record doesn't say which rule it belongs to`);
        } else if (!ruleById.has(ruleId)) {
            missingRules.set(ruleId, (missingRules.get(ruleId) ?? 0) + 1);
        } else {
            ruleById.get(ruleId).components.push(component);
        }
    }
    for (const ruleId of [...missingRules.keys()].sort(byRevisionId)) {
        const count = missingRules.get(ruleId);
        warnings.push(`rule revision ${ruleId} isn't in the folder; its ${count} ${count === 1 ? 'component was' : 'components were'} left out`);
    }

    const dataElements = (await readType(syncDir, 'data_elements', fetchPkg)).map(revision => ({ revision }));
    const extensions = (await readType(syncDir, 'extensions', fetchPkg)).map(revision => ({ revision }));
    return { rules, data_elements: dataElements, extensions, warnings };
}

module.exports = { readLibraryItems };
