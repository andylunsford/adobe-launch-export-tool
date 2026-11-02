'use strict';

/**
 * Diffs two effective sets, that is two builds' rules, data elements and
 * extensions, deciding what changed the way the Data Collection UI's Compare
 * Revisions view does (reverse-engineer-launch docs/08 and docs/09):
 *
 * - Items pair by `origin`, so every revision of one item lines up.
 * - The same revision id on both sides is the same item, with nothing to fetch.
 * - Otherwise attributes are compared without the bookkeeping every revision
 *   gets (number, timestamps, authorship, publish flags, order), and
 *   `settings` as parsed JSON, so key order and spacing don't count.
 * - A new revision with no difference left is "revised", not "modified".
 *   Revising a rule revises every one of its components, so this is common.
 * - Relationships aren't compared: a component re-pinned to another extension
 *   revision still runs the build's extension.
 */

const TYPES = ['rules', 'data_elements', 'extensions'];

// Attributes Compare Revisions never compares (docs/08 section 4).
const IGNORED = ['created_at', 'updated_at', 'revision_number', 'order', 'dirty', 'published', 'published_at',
    'created_by_email', 'created_by_display_name', 'updated_by_email', 'updated_by_display_name'];
// These only take effect when the property runs rule components in sequence.
const SEQUENCING_ONLY = ['timeout', 'delay_next'];

const originId = (item) => item.relationships?.origin?.data?.id || item.id;
const nameOf = (item) => item.attributes.name || item.attributes.display_name;

function isEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    return keysA.length === Object.keys(b).length && keysA.every(k => Object.hasOwn(b, k) && isEqual(a[k], b[k]));
}

// Settings arrive as a JSON string; compare and report the parsed value.
function comparable(field, value) {
    if (field !== 'settings' || typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
}

function attributeDiffs(attrsA, attrsB, ignored) {
    const diffs = [];
    for (const field of new Set([...Object.keys(attrsA), ...Object.keys(attrsB)])) {
        if (ignored.includes(field)) continue;
        const oldValue = comparable(field, attrsA[field]);
        const newValue = comparable(field, attrsB[field]);
        if (!isEqual(oldValue, newValue)) diffs.push({ field, oldValue, newValue });
    }
    return diffs;
}

function componentDiffs(componentsA, componentsB, ignored) {
    const mapA = new Map(componentsA.map(c => [originId(c), c]));
    const mapB = new Map(componentsB.map(c => [originId(c), c]));
    const entry = (type, c, extra) => ({ type, name: nameOf(c), componentType: c.attributes.delegate_descriptor_id, ...extra });
    const diffs = [];

    for (const [origin, a] of mapA) {
        const b = mapB.get(origin);
        if (!b) { diffs.push(entry('removed', a)); continue; }
        const changes = attributeDiffs(a.attributes, b.attributes, ignored);
        if (changes.length) diffs.push(entry('modified', b, { attributeDiffs: changes }));
        else if (a.attributes.order !== b.attributes.order) diffs.push(entry('reordered', b));
    }
    for (const [origin, b] of mapB) {
        if (!mapA.has(origin)) diffs.push(entry('added', b));
    }
    return diffs;
}

async function comparePair(a, b, loadComponents, ignored) {
    const nameA = nameOf(a);
    const nameB = nameOf(b);
    const components = loadComponents
        ? componentDiffs(...await Promise.all([loadComponents(a), loadComponents(b)]), ignored)
        : [];
    return {
        id: b.id,
        name: nameA !== nameB ? `${nameA} → ${nameB}` : nameB,
        oldName: nameA,
        newName: nameB,
        revisionNumberA: a.attributes.revision_number,
        revisionNumberB: b.attributes.revision_number,
        attributeDiffs: attributeDiffs(a.attributes, b.attributes, ignored),
        componentDiffs: components
    };
}

async function diffType(itemsA, itemsB, loadComponents, ignored) {
    const mapA = new Map(itemsA.map(item => [originId(item), item]));
    const mapB = new Map(itemsB.map(item => [originId(item), item]));
    const single = (item) => ({ id: item.id, name: nameOf(item), revisionNumber: item.attributes.revision_number, item });
    const result = { onlyInA: [], onlyInB: [], modified: [], revised: [], identical: [] };
    const pairs = [];

    for (const [origin, a] of mapA) {
        const b = mapB.get(origin);
        if (!b) result.onlyInA.push(single(a));
        else if (a.id === b.id) result.identical.push({ id: a.id, name: nameOf(a), revisionNumber: a.attributes.revision_number });
        else pairs.push([a, b]);
    }
    for (const [origin, b] of mapB) {
        if (!mapA.has(origin)) result.onlyInB.push(single(b));
    }

    // Only pairs on different revisions are compared, so only their rules' components are fetched.
    for (const pair of await Promise.all(pairs.map(([a, b]) => comparePair(a, b, loadComponents, ignored)))) {
        const changed = pair.attributeDiffs.length > 0 || pair.componentDiffs.length > 0;
        (changed ? result.modified : result.revised).push(pair);
    }
    return result;
}

/**
 * @param {{rules, data_elements, extensions}} setsA  the base side's effective set
 * @param {{rules, data_elements, extensions}} setsB  the compared side's effective set
 * @param {Object} [options]
 * @param {(rule) => Promise<Array>} [options.loadComponents]  a rule revision's components;
 *        called only for rules whose revision differs between the two sides
 * @param {boolean} [options.sequencing=true]  the property's rule_component_sequencing_enabled
 * @returns {Promise<Object>} per type: onlyInA, onlyInB, modified, revised, identical
 */
async function diffSets(setsA, setsB, { loadComponents, sequencing = true } = {}) {
    const ignored = sequencing ? IGNORED : [...IGNORED, ...SEQUENCING_ONLY];
    const result = {};
    for (const type of TYPES) {
        result[type] = await diffType(setsA[type] || [], setsB[type] || [],
            type === 'rules' ? loadComponents : null, ignored);
    }
    return result;
}

module.exports = { diffSets, originId };
