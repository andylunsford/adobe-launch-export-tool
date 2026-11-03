// What a sync diff compares: the attributes that say what an item does, in a
// form that ignores line endings and key order.

const crypto = require('crypto');

// The attributes the Reactor API lets you write, plus the ones set in the
// Launch UI but missing from the API's write tables (storage_duration, negate)
// and an extension's version, which changes when it is upgraded. Everything
// else is bookkeeping Launch changes on its own (published, published_at,
// updated_at, dirty, review_status, revision_number, ...) or who made a change,
// so a library publish or another person's save isn't a difference.
const CONTENT_ATTRIBUTES = {
    rules: ['name', 'enabled'],
    data_elements: ['name', 'enabled', 'delegate_descriptor_id', 'settings', 'default_value',
        'force_lower_case', 'clean_text', 'storage_duration'],
    extensions: ['enabled', 'delegate_descriptor_id', 'settings', 'version'],
    rule_components: ['name', 'delegate_descriptor_id', 'settings', 'order', 'rule_order',
        'timeout', 'delay_next', 'negate']
};

// Sorts object keys at every level and converts CRLF to LF in every string, so
// a reordered settings.json or a file saved with Windows line endings compares
// equal. Arrays keep their order.
function canonical(value) {
    if (typeof value === 'string') return value.replace(/\r\n/g, '\n');
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value ?? null;
}

function parseSettings(settings) {
    if (typeof settings !== 'string') return settings;
    try { return JSON.parse(settings); } catch (e) { return settings; }
}

/** The item's content attributes, canonicalized, with settings parsed. */
function contentOf(item) {
    const names = CONTENT_ATTRIBUTES[item.type] || Object.keys(item.attributes);
    return Object.fromEntries(names.map(name => {
        const value = item.attributes[name];
        return [name, canonical(name === 'settings' ? parseSettings(value) : value)];
    }));
}

/** A hash of contentOf(item): equal for two items that do the same thing. */
function fingerprint(item) {
    return crypto.createHash('sha256').update(JSON.stringify(contentOf(item))).digest('hex');
}

module.exports = { CONTENT_ATTRIBUTES, contentOf, fingerprint };
