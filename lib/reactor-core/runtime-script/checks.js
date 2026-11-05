'use strict';

// Checks run against production before a test build is written: that the script
// prints back as it was, that the entry writers give production's own entries
// from production's own revisions, and that no library revision is older than
// production's. A test build that passes them differs from production only in
// what the user chose to change. A last check stops a test build whose
// development stage would send traffic to production's destinations.

const { printScript, printValue } = require('./print');
const { dataElementEntry, extensionEntry, ruleEntry, originOf, UnsupportedTransform } = require('./entries');

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
 * @returns {string[]} one problem for each entry that differs, has no revision, or has a
 *   transform the entry writers can't apply
 */
function checkProductionEntries({ container, revisions, components, packages, customCodeUrl }) {
    const sequencing = sequencingOf(container);
    const problems = [];

    const check = (type, name, production, revision, write) => {
        if (!revision) {
            problems.push(`${type} ${name}: no production revision to check`);
            return;
        }
        let written;
        try {
            written = write(revision);
        } catch (err) {
            if (!(err instanceof UnsupportedTransform)) throw err;
            problems.push(`${type} ${name}: ${err.message}`);
            return;
        }
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
// to production's) or one of production's. Production's destinations are gathered
// first, from the whole test build and from production's own script, so a development
// value is checked against every place production sends to. Anything the check can't read stops too: a destination
// that is not a string, or that holds a data element reference (%name%) the check
// can't resolve, could be production's.
const isReadableId = (id) => typeof id === 'string' && !id.includes('%');
// Ids match as the extension would see them, however they were typed
const normalize = (id) => id.trim().toLowerCase();
// A report suite entry can name several, joined with commas, and each one gets the hit.
// Blank entries are what an empty field leaves behind, not report suites.
const reportSuiteIds = (list = []) => list.flatMap(id => id.split(',')).map(normalize).filter(id => id !== '');

// The Web SDK can send a stage somewhere else with an edgeConfigOverrides object, on an
// instance or on a rule component. The runtime picks a stage's override as Adobe's
// reactor-extension-alloy does in createGetConfigOverrides: the stage's own if it has
// one; none if another stage has one; otherwise the object is the old form, one
// override for every stage.
const STAGES = ['development', 'staging', 'production'];
const NO_OVERRIDE = { datastreams: [], reportSuites: [], datasets: [] };

function overrideIn(overrides, stage) {
    if (overrides[stage]) return overrides[stage];
    return STAGES.some(key => overrides[key]) ? undefined : overrides;
}

/** One id an override names, as a list: empty when it's absent or blank, null if it can't be read. */
function readId(id) {
    // A blank id leaves what the instance or datastream has in place
    if (id === undefined || (typeof id === 'string' && id.trim() === '')) return [];
    return isReadableId(id) ? [normalize(id)] : null;
}

/** The event and profile datasets an override sends to, or null if they can't be read. */
function readDatasets(platform) {
    if (platform === undefined) return [];
    if (!isPlainObject(platform)) return null;
    const { datasets } = platform;
    if (datasets === undefined) return [];
    if (!isPlainObject(datasets)) return null;
    const ids = [];
    for (const dataset of [datasets.event, datasets.profile]) {
        if (dataset === undefined) continue;
        const id = isPlainObject(dataset) ? readId(dataset.datasetId) : null;
        if (!id) return null;
        ids.push(...id);
    }
    return ids;
}

/** The datastream, report suites and datasets one stage's override sends to, or null if it can't be read. */
function readOverride(override) {
    if (override === undefined) return NO_OVERRIDE;
    const { datastreamId, com_adobe_analytics: analytics, com_adobe_experience_platform: platform } = override;
    const datastreams = readId(datastreamId);
    if (!datastreams) return null;
    if (analytics !== undefined && !isPlainObject(analytics)) return null;
    const reportSuites = analytics?.reportSuites;
    if (reportSuites !== undefined && !(Array.isArray(reportSuites) && reportSuites.every(isReadableId))) return null;
    const datasets = readDatasets(platform);
    if (!datasets) return null;
    return { datastreams, reportSuites: reportSuiteIds(reportSuites), datasets };
}

/**
 * Where an edgeConfigOverrides object sends development and production, or null if it
 * can't be read. Its enabled flags are ignored, so a disabled override is checked too:
 * at worst that stops a build the user can fix by fixing the override.
 * @returns {{ development: { datastreams: string[], reportSuites: string[], datasets: string[] }, production: Object }|null}
 */
function readOverrides(overrides) {
    if (overrides === undefined || overrides === null) return { development: NO_OVERRIDE, production: NO_OVERRIDE };
    if (!isPlainObject(overrides) || STAGES.some(stage => overrides[stage] && !isPlainObject(overrides[stage]))) return null;
    const development = readOverride(overrideIn(overrides, 'development'));
    const production = readOverride(overrideIn(overrides, 'production'));
    return development && production ? { development, production } : null;
}

/** What one override would do wrong in development, as problems for `where`. */
function overrideProblems(where, read, production) {
    if (!read) return [`${where}: can't read its overrides, so test traffic could reach production`];
    const problems = [];
    if (read.development.datastreams.some(id => production.datastreams.has(id))) {
        problems.push(`${where}: the development datastream override is production's`);
    }
    if (read.development.reportSuites.some(id => production.reportSuites.has(id))) {
        problems.push(`${where}: a development report suite override is production's`);
    }
    if (read.development.datasets.some(id => production.datasets.has(id))) {
        problems.push(`${where}: a development dataset override is production's`);
    }
    return problems;
}

const RULE_LISTS = [['events', 'event'], ['conditions', 'condition'], ['actions', 'action']];
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * A component's overrides, read. Settings that aren't an object can't be read: Turbine
 * resolves settings that are one data element reference into that data element's value.
 */
function componentOverrides(settings) {
    if (settings === undefined || settings === null) return readOverrides(undefined);
    return isPlainObject(settings) ? readOverrides(settings.edgeConfigOverrides) : null;
}

/**
 * The overrides of every Web SDK event, condition and action, read, in container rule
 * order and, within a rule, events, conditions, then actions. Every module is read, not
 * only Send event, because one the check doesn't know could still send.
 * @returns {Array<{ where: string, read: Object|null }>}
 */
function ruleOverrides(rules) {
    return listOf(rules).flatMap(rule => RULE_LISTS.flatMap(([list, kind]) => listOf(rule?.[list]).flatMap((component, index) => (
        typeof component?.modulePath === 'string' && component.modulePath.startsWith('adobe-alloy/')
            ? [{ where: `rule ${rule.name}: adobe-alloy ${kind} ${index}`, read: componentOverrides(component.settings) }]
            : []
    ))));
}

/** Analytics' report suites by stage, or null if they can't be read. */
function readAccounts(settings) {
    const { development, production } = settings?.libraryCode?.accounts ?? {};
    const lists = [development, production].filter(list => list !== undefined);
    if (!lists.every(list => Array.isArray(list) && list.every(isReadableId))) return null;
    return { development: reportSuiteIds(development), production: reportSuiteIds(production) };
}

/**
 * Every datastream, report suite and dataset production sends to, as far as the check can
 * read them: alloy instances' datastreams, Analytics' production report suites, and what
 * each override that applies in production names, across all the containers given.
 * @returns {{ datastreams: Set<string>, reportSuites: Set<string>, datasets: Set<string> }}
 */
function productionDestinations(containers) {
    const destinations = { datastreams: new Set(), reportSuites: new Set(), datasets: new Set() };
    const add = (kind, ids) => ids.forEach(id => destinations[kind].add(id));
    for (const container of containers) {
        const extensions = container.extensions ?? {};
        const settingsOf = (name) => (hasOwn(extensions, name) ? extensions[name]?.settings : undefined);
        const instances = listOf(settingsOf('adobe-alloy')?.instances);
        add('datastreams', instances.map(instance => instance?.edgeConfigId).filter(isReadableId).map(normalize));
        add('reportSuites', readAccounts(settingsOf('adobe-analytics'))?.production ?? []);
        const overrides = [
            ...instances.filter(isPlainObject).map(instance => readOverrides(instance.edgeConfigOverrides)),
            ...ruleOverrides(container.rules).map(({ read }) => read)
        ].filter(Boolean);
        for (const { production } of overrides) {
            add('datastreams', production.datastreams);
            add('reportSuites', production.reportSuites);
            add('datasets', production.datasets);
        }
    }
    return destinations;
}

const STAGE_AWARE = {
    // Each instance names one datastream per stage, and its overrides can send a stage elsewhere
    'adobe-alloy': (settings, production) => {
        const instances = settings?.instances;
        if (!Array.isArray(instances)) return ["adobe-alloy: can't read its datastreams, so test traffic could reach production"];
        return instances.flatMap((instance, index) => {
            const where = `adobe-alloy instance ${index}`;
            if (!isPlainObject(instance)) return [`${where}: can't read its datastreams, so test traffic could reach production`];
            return [...instanceProblems(instance, where, production), ...overrideProblems(where, readOverrides(instance.edgeConfigOverrides), production)];
        });
    },
    // One set of report suite ids per stage
    'adobe-analytics': (settings, production) => {
        const accounts = readAccounts(settings);
        if (!accounts) return ["adobe-analytics: can't read its report suites, so test traffic could reach production"];
        if (accounts.development.length === 0) return ['adobe-analytics: no development report suites, so test traffic would reach production'];
        return accounts.development.some(id => production.reportSuites.has(id)) ? ["adobe-analytics: a development report suite is production's"] : [];
    }
};

/** An alloy instance's own development datastream: missing, unreadable or production's. */
function instanceProblems(instance, where, production) {
    // An id that is absent is for the checks below; one that is there must be readable
    if (![instance.edgeConfigId, instance.developmentEdgeConfigId].every(id => id === undefined || isReadableId(id))) {
        return [`${where}: can't read its datastreams, so test traffic could reach production`];
    }
    const development = instance.developmentEdgeConfigId?.trim();
    if (!development) return [`${where}: no development datastream, so test traffic would reach production`];
    // Development can point at any instance's production datastream, or any override's
    if (production.datastreams.has(normalize(development))) return [`${where}: the development datastream is production's`];
    return [];
}

/**
 * Finds stage-aware extensions, and Web SDK rule components, whose development settings
 * would send test traffic to production, or that the check can't read. Other extensions
 * can't be checked, so they are listed for the user.
 * @param {Object} container - the parsed Launch container
 * @param {Object} [productionContainer] - production's own container. Production keeps running it while the
 *   test build is tried, so what it sends to counts as production's even where `container` replaced or
 *   dropped the setting that names it. Only its destinations are read; its problems aren't reported.
 * @returns {{ problems: string[], unaware: string[] }} problems for the stage-aware extensions that would
 *   or could reach production, in the container's extension order, then for the rules', in its rule order;
 *   unaware lists every other extension but core, in the container's order.
 */
function checkStageDestinations(container, productionContainer) {
    const rules = ruleOverrides(container.rules);
    const production = productionDestinations(productionContainer ? [container, productionContainer] : [container]);
    const problems = [];
    const unaware = [];
    for (const [name, extension] of Object.entries(container.extensions ?? {})) {
        if (hasOwn(STAGE_AWARE, name)) problems.push(...STAGE_AWARE[name](extension?.settings, production));
        else if (name !== 'core') unaware.push(name);
    }
    problems.push(...rules.flatMap(({ where, read }) => overrideProblems(where, read, production)));
    return { problems, unaware };
}

module.exports = {
    checkRoundTrip, checkProductionEntries, firstDifference, checkBehindProduction, checkStageDestinations,
    packageFor, sequencingOf, hasOwn
};
