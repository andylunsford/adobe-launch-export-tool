'use strict';

// Checks run against production before a test build is written: that the script
// prints back as it was, that the entry writers give production's own entries
// from production's own revisions, and that no library revision is older than
// production's. A test build that passes them differs from production only in
// what the user chose to change. A last check stops a test build whose
// development stage would send traffic to production's destinations.

const { printScript, printValue } = require('./print');
const { dataElementEntry, extensionEntry, ruleEntry, originOf } = require('./entries');

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isContainer = (value) => value !== null && typeof value === 'object';
const isPlainObject = (value) => isContainer(value) && !Array.isArray(value);
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

/** Whether the property runs rule components in sequence, which ruleEntry needs to know. */
const sequencingOf = (container) => Boolean(container.property?.settings?.ruleComponentSequencingEnabled);

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
    const sequencing = sequencingOf(container);
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

// Extensions that pick where to send data by environment stage. A test build runs
// with the development stage, so each lists what would make development reach
// production: a development destination that is missing (the extension falls back
// to production's) or the same as production's. Anything it can't read stops too:
// a destination that is not a string, or that holds a data element reference
// (%name%) the check can't resolve, could be production's.
const isReadableId = (id) => typeof id === 'string' && !id.includes('%');
// Ids match as the extension would see them, however they were typed
const normalize = (id) => id.trim().toLowerCase();

const STAGE_AWARE = {
    // Each instance names one datastream per stage
    'adobe-alloy': (settings) => {
        const instances = settings?.instances;
        if (!Array.isArray(instances)) return ["adobe-alloy: can't read its datastreams, so test traffic could reach production"];
        // Development can point at any instance's production datastream
        const production = new Set(instances.map(instance => instance?.edgeConfigId).filter(isReadableId).map(normalize));
        return instances.flatMap((instance, index) => {
            // An id that is absent is for the checks below; one that is there must be readable
            const readable = isPlainObject(instance)
                && [instance.edgeConfigId, instance.developmentEdgeConfigId].every(id => id === undefined || isReadableId(id));
            if (!readable) return [`adobe-alloy instance ${index}: can't read its datastreams, so test traffic could reach production`];
            const development = instance.developmentEdgeConfigId?.trim();
            if (!development) return [`adobe-alloy instance ${index}: no development datastream, so test traffic would reach production`];
            if (production.has(normalize(development))) return [`adobe-alloy instance ${index}: the development datastream is production's`];
            return [];
        });
    },
    // One set of report suite ids per stage
    'adobe-analytics': (settings) => {
        const { development, production } = settings?.libraryCode?.accounts ?? {};
        const lists = [development, production].filter(list => list !== undefined);
        if (!lists.every(list => Array.isArray(list) && list.every(isReadableId))) {
            return ["adobe-analytics: can't read its report suites, so test traffic could reach production"];
        }
        // Blank entries are what an empty field leaves behind, not report suites
        const ids = (list = []) => list.map(normalize).filter(id => id !== '');
        const developmentIds = ids(development);
        if (developmentIds.length === 0) return ['adobe-analytics: no development report suites, so test traffic would reach production'];
        const productionIds = new Set(ids(production));
        return developmentIds.some(id => productionIds.has(id)) ? ["adobe-analytics: a development report suite is production's"] : [];
    }
};

/**
 * Finds stage-aware extensions whose development settings would send test traffic
 * to production, or that the check can't read. Other extensions can't be checked,
 * so they are listed for the user.
 * @param {Object} container - the parsed Launch container
 * @returns {{ problems: string[], unaware: string[] }} problems for the stage-aware extensions that would
 *   or could reach production; unaware lists every other extension but core. Both follow the container's order.
 */
function checkStageDestinations(container) {
    const problems = [];
    const unaware = [];
    for (const [name, extension] of Object.entries(container.extensions ?? {})) {
        if (hasOwn(STAGE_AWARE, name)) problems.push(...STAGE_AWARE[name](extension?.settings));
        else if (name !== 'core') unaware.push(name);
    }
    return { problems, unaware };
}

module.exports = {
    checkRoundTrip, checkProductionEntries, firstDifference, checkBehindProduction, checkStageDestinations,
    packageFor, sequencingOf, hasOwn
};
