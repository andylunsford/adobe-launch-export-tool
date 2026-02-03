function getResult(resultType, details) {
    return {
        result: resultType,
        details
    };
}

module.exports = (local, remote) => {
    let same = true;
    let details = {};
    let localExists = local && local.attributes;
    let remoteExists = remote && remote.attributes;

    // 1. ADDED: Exists locally, not remote
    if (localExists && !remoteExists) {
        return { result: 'added' };
    }

    // 2. BEHIND (Missing): Exists remote, not locally
    if (!localExists && remoteExists) {
        return { result: 'behind' };
    }

    // 3. COMPARISON: Check attributes
    details.attributes = {};
    
    // We only compare attributes present in local (user intent). 
    // If remote has extra attributes we don't track locally, we ignore them?
    // reactor-sync iterated local.attributes.
    
    for (let attribute in local.attributes) {
        if (!Object.prototype.hasOwnProperty.call(local.attributes, attribute)) continue;
        
        // Skip read-only/system attributes that shouldn't trigger a diff?
        // reactor-sync didn't seem to skip much, but `updated_at` usually differs.
        // Wait, reactor-sync logic compares ALL attributes.
        // `updated_at` WILL differ if I edited locally but didn't update the date.
        // But `updated_at` is usually ignored in the attribute loop? No, it's in there.
        // Let's check the logic:
        // if (localType !== remoteType || serialized(local) !== serialized(remote)) -> same = false.
        
        // Settings special handling
        if (attribute === 'settings') {
            try {
                // Normalize JSON strings
                const localSet = JSON.parse(local.attributes[attribute]);
                const remoteSet = JSON.parse(remote.attributes[attribute]);
                
                if (JSON.stringify(localSet) !== JSON.stringify(remoteSet)) {
                    same = false;
                    details.attributes[attribute] = {
                        local: local.attributes[attribute],
                        remote: remote.attributes[attribute]
                    };
                }
            } catch (e) {
                // If parsing fails, fall back to string comparison
                if (local.attributes[attribute] !== remote.attributes[attribute]) {
                    same = false;
                    details.attributes[attribute] = {
                        local: local.attributes[attribute],
                        remote: remote.attributes[attribute]
                    };
                }
            }
            continue;
        }
        
        // Standard comparison
        if (JSON.stringify(local.attributes[attribute]) !== JSON.stringify(remote.attributes[attribute])) {
            console.log(`[DIFF] Attribute mismatch for ${local.id} [${attribute}]:`, 
                JSON.stringify(local.attributes[attribute]), 
                'vs', 
                JSON.stringify(remote.attributes[attribute])
            );
            same = false;
            details.attributes[attribute] = {
                local: local.attributes[attribute],
                remote: remote.attributes[attribute]
            };
        }
    }

    if (!same) {
        // Conflict Resolution Heuristics
        
        // If the 'settings' or 'script' changed locally, it's 'modified' (user work).
        // But if remote is NEWER, it might be 'behind' (someone else updated).
        
        const localDate = new Date(local.attributes.updated_at);
        const remoteDate = new Date(remote.attributes.updated_at);
        
        console.log(`[DIFF] Dates for ${local.id}: Local=${localDate.toISOString()}, Remote=${remoteDate.toISOString()}`);
        
        // If remote is strictly newer than the file's recorded "last sync" date, we are behind.
        if (remoteDate > localDate) {
            console.log(`[DIFF] Remote is newer -> BEHIND`);
            return getResult('behind', details);
        }
        
        // Otherwise, we assume our local changes are intended overrides.
        console.log(`[DIFF] Local is newer or equal -> MODIFIED`);
        return getResult('modified', details);
    }

    return { result: 'unchanged' };
};
