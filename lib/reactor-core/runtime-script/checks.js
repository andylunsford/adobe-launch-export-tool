'use strict';

// Checks run against production before a test build is written: that the script
// prints back as it was, that the entry writers give production's own entries
// from production's own revisions, and that no library revision is older than
// production's. A test build that passes them differs from production only in
// what the user chose to change.

const { printScript, printValue } = require('./print');
const { dataElementEntry, extensionEntry, ruleEntry } = require('./entries');

const originOf = (revision) => revision.relationships?.origin?.data?.id;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isContainer = (value) => value !== null && typeof value === 'object';
// The order the container lists them in
const TYPES = ['data_elements', 'extensions', 'rules'];

const isHighSurrogate = (code) => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF;

/**
 * Whether production's script prints back exactly as it came.
 * @param {string} text - the script as production serves it
 * @param {{ container: Object, turbine: string }} parsed - parseScript(text)
 * @returns {string|null} null when it matches, else where it first differs
 */
function checkRoundTrip(text, parsed) {
    const printed = printScript(parsed);
    if (printed === text) return null;
    const shorter = Math.min(text.length, printed.length);
    let at = 0;
    while (at < shorter && text[at] === printed[at]) at++;
    // Two characters can share their first UTF-16 unit; the difference starts with the character
    if (at < shorter && isLowSurrogate(text.charCodeAt(at)) && isHighSurrogate(text.charCodeAt(at - 1))) at--;
    const byte = new TextEncoder().encode(text.slice(0, at)).length;
    return `Production's script doesn't print back exactly (first difference at byte ${byte})`;
}

/** The keys leading to the first difference between two values, [] where they differ here, null if they are equal. */
function differenceAt(a, b) {
    if (a === b) return null;
    if (!isContainer(a) || !isContainer(b) || Array.isArray(a) !== Array.isArray(b)) return [];
    // An array's keys are its indexes, so this walks arrays by index
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    for (let i = 0; i < Math.max(keysA.length, keysB.length); i++) {
        const [keyA, keyB] = [keysA[i], keysB[i]];
        if (keyA === keyB) {
            const inner = differenceAt(a[keyA], b[keyA]);
            if (inner !== null) return [keyA, ...inner];
        } else if (keyA !== undefined && !hasOwn(b, keyA)) {
            return [keyA];
        } else if (keyB !== undefined && !hasOwn(a, keyB)) {
            return [keyB];
        } else {
            // Both have both keys, in a different order
            return [keyA];
        }
    }
    return null;
}

/**
 * The path to the first difference between two values, like `actions.0.settings.source`.
 * Key order counts, because it changes how a value prints.
 * @returns {string|null} null when they are equal
 */
function firstDifference(a, b) {
    return differenceAt(a, b)?.join('.') ?? null;
}

/** The extension package a revision was written with. */
function packageFor(revision, relationship, packages) {
    const id = revision.relationships?.[relationship]?.data?.id;
    const pkg = packages.get(id);
    if (!pkg) throw new Error(`${revision.id} needs extension package ${id}, which isn't in the packages`);
    return pkg;
}

/**
 * Writes every entry in production's container again from its production revision,
 * and reports each one that prints differently.
 * @param {Object} input
 * @param {Object} input.container - production's parsed container
 * @param {{ rules: Object[], data_elements: Object[], extensions: Object[] }} input.revisions - production's revisions
 * @param {Map<string, Object[]>} input.components - each rule revision's component revisions, by rule revision id
 * @param {Map<string, Object>} input.packages - extension packages, by id
 * @param {(componentId: string) => string} input.customCodeUrl
 * @returns {string[]} one problem for each entry that differs or has no revision
 */
function checkProductionEntries({ container, revisions, components, packages, customCodeUrl }) {
    const sequencing = Boolean(container.property?.settings?.ruleComponentSequencingEnabled);
    const problems = [];

    const check = (type, name, production, revision, write) => {
        if (!revision) {
            problems.push(`${type} ${name}: no production revision to check`);
            return;
        }
        const written = write(revision);
        if (printValue(production) === printValue(written)) return;
        problems.push(`${type} ${name}: differs from production at ${firstDifference(production, written) || '(printed text)'}`);
    };
    const byName = (type) => new Map(revisions[type].map(revision => [revision.attributes.name, revision]));

    const dataElements = byName('data_elements');
    for (const [name, production] of Object.entries(container.dataElements)) {
        check('data_elements', name, production, dataElements.get(name),
            revision => dataElementEntry(revision, packageFor(revision, 'updated_with_extension_package', packages)).entry);
    }

    const extensions = byName('extensions');
    for (const [name, production] of Object.entries(container.extensions)) {
        check('extensions', name, production, extensions.get(name),
            revision => extensionEntry(revision, packageFor(revision, 'extension_package', packages), production.modules).entry);
    }

    const rules = new Map(revisions.rules.map(revision => [revision.id, revision]));
    for (const production of container.rules) {
        const revision = rules.get(production.id);
        check('rules', revision?.attributes.name ?? production.name, production, revision, (rule) => {
            const withPackages = (components.get(rule.id) ?? [])
                .map(component => ({ component, pkg: packageFor(component, 'updated_with_extension_package', packages) }));
            return ruleEntry(rule, withPackages, { customCodeUrl, sequencing, inlineMovedCode: false }).entry;
        });
    }
    return problems;
}

/**
 * Finds library revisions older than the ones production runs. A library item
 * production doesn't have yet is not behind.
 * @param {{ rules: Array<{ revision: Object }>, data_elements: Array<{ revision: Object }>, extensions: Array<{ revision: Object }> }} library
 * @param {{ rules: Object[], data_elements: Object[], extensions: Object[] }} productionRevisions
 * @returns {string[]}
 */
function checkBehindProduction(library, productionRevisions) {
    const problems = [];
    for (const type of TYPES) {
        const production = new Map(productionRevisions[type].map(revision => [originOf(revision), revision]));
        for (const { revision } of library[type]) {
            const running = production.get(originOf(revision));
            if (running && revision.attributes.revision_number < running.attributes.revision_number) {
                problems.push(`${type} ${revision.attributes.name}: the library holds revision ${revision.attributes.revision_number}, production runs ${running.attributes.revision_number}`);
            }
        }
    }
    return problems;
}

module.exports = { checkRoundTrip, checkProductionEntries, firstDifference, checkBehindProduction };
