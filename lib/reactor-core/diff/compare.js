const { contentOf, fingerprint } = require('./normalize');

// The content attributes that differ between local and remote, for display.
function differences(local, remote) {
    const a = contentOf(local);
    const b = contentOf(remote);
    const attributes = {};
    for (const name of Object.keys(a)) {
        if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) {
            attributes[name] = { local: local.attributes[name], remote: remote.attributes[name] };
        }
    }
    return attributes;
}

const conflict = (reason, details = {}) => ({ result: 'conflict', details: { ...details, reason } });

/**
 * Classifies one item by comparing each side against what was downloaded.
 *
 * @param {Object|null} local - the item rebuilt from its folder, or null if there is none
 * @param {Object|null} remote - the item in Launch, or null if Launch no longer lists it
 * @param {Object|null} base - the download record's entry ({ hash }), or null if there is none
 * @returns {{ result: string, details?: Object }} result is one of
 *   unchanged, added (new locally), modified (changed locally), deleted (removed locally),
 *   behind (new or changed in Launch), deletedInLaunch, conflict
 */
module.exports = (local, remote, base) => {
    const localHash = local?.attributes ? fingerprint(local) : null;
    const remoteHash = remote?.attributes ? fingerprint(remote) : null;

    if (localHash && remoteHash) {
        if (localHash === remoteHash) return { result: 'unchanged' };
        const details = { attributes: differences(local, remote) };
        if (!base) return conflict('changed on one side or both; there is no download record to tell which', details);
        const localChanged = localHash !== base.hash;
        const remoteChanged = remoteHash !== base.hash;
        if (localChanged && !remoteChanged) return { result: 'modified', details };
        if (remoteChanged && !localChanged) return { result: 'behind', details };
        return conflict('changed locally and in Launch', details);
    }

    if (localHash) {
        if (!base) return { result: 'added' };
        return localHash === base.hash
            ? { result: 'deletedInLaunch' }
            : conflict('changed locally, deleted in Launch');
    }

    if (remoteHash) {
        if (!base) return { result: 'behind' };
        return remoteHash === base.hash
            ? { result: 'deleted' }
            : conflict('deleted locally, changed in Launch');
    }

    return { result: 'unchanged' };
};
