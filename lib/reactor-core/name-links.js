const fs = require('fs');
const path = require('path');
const { sanitizeName } = require('./utils');

/**
 * Replaces the `_<name>` links in a type folder with one per item, each
 * pointing at the item's id folder, so links follow renames and deletions.
 * Names that collide, compared ignoring case as Windows does, get the id
 * appended. Only symlinks are removed; a folder starting with `_` is kept.
 *
 * Windows needs Developer Mode or admin to make symlinks. Without them the
 * folder is left with no links.
 * @param {string} typeDir - e.g. <property>/rules
 * @param {Array<Object>} items - the type's items, each with an id folder in typeDir
 */
function rebuildNameLinks(typeDir, items) {
    if (!fs.existsSync(typeDir)) return;

    for (const entry of fs.readdirSync(typeDir)) {
        const entryPath = path.join(typeDir, entry);
        if (entry.startsWith('_') && fs.lstatSync(entryPath).isSymbolicLink()) fs.unlinkSync(entryPath);
    }

    const named = items
        .map(item => ({ id: item.id, name: sanitizeName(item.attributes?.name || '') }))
        .filter(item => item.name);
    const uses = new Map();
    for (const { name } of named) uses.set(name.toLowerCase(), (uses.get(name.toLowerCase()) || 0) + 1);

    for (const { id, name } of named) {
        const linkName = uses.get(name.toLowerCase()) > 1 ? `_${name}_${id}` : `_${name}`;
        try {
            fs.symlinkSync(id, path.join(typeDir, linkName), 'dir');
        } catch (e) { /* no symlink permission */ }
    }
}

module.exports = { rebuildNameLinks };
