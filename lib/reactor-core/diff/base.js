// The download record: what each item was when it was last downloaded, kept in
// <property>/.reactor-sync/base.json. A diff compares both the local folder and
// Launch against it, which is how it tells a local edit from a Launch edit.
//
// Shape: { version: 1, downloaded_at, items: { <id>: entry } }, where an entry is
// { type, name, updated_at, revision_number, hash, files, rule_id? }. It holds
// no settings and no created_by/updated_by fields.

const fs = require('fs');
const path = require('path');
const { fingerprint } = require('./normalize');

const BASE_FILE = path.join('.reactor-sync', 'base.json');

/** The property folder's download record, or null if it has none yet. */
function readBase(propertyDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(propertyDir, BASE_FILE), 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

function writeBase(propertyDir, base) {
    const file = path.join(propertyDir, BASE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(base, null, 2));
}

/** A record entry for an item as Launch returned it. */
function baseEntry(item, extra = {}) {
    return {
        type: item.type,
        name: item.attributes?.name ?? null,
        updated_at: item.attributes?.updated_at ?? null,
        revision_number: item.attributes?.revision_number ?? null,
        hash: fingerprint(item),
        ...extra
    };
}

/**
 * What an item was when it was downloaded: its entry in the record. A folder
 * downloaded before there was a record is judged against its own data.json,
 * which holds the item as downloaded (edits go to settings.json and the code
 * files, so only an edit to data.json itself goes unseen).
 * @returns {Object|null} an entry, or null if there's nothing to go on
 */
function baseOf(base, folder, id) {
    if (base) return base.items[id] ?? null;
    try {
        return baseEntry(JSON.parse(fs.readFileSync(path.join(folder, 'data.json'), 'utf8')));
    } catch (e) {
        return null;
    }
}

module.exports = { BASE_FILE, readBase, writeBase, baseEntry, baseOf };
