'use strict';

// Makes a test build's container: production's container with one library's
// revisions applied, by each library item's origin:
//
//   library item         | production has its origin  | production doesn't
//   enabled              | replace production's entry | add an entry
//   disabled             | drop production's entry    | nothing
//   not in the library   | keep production's entry    | nothing
//
// Production's entries are kept as they are. Each type stays in revision id order,
// production's entries by their production revision ids. The build stops on any
// library item it can't apply as Launch would build it:
// - a delegate production's script doesn't load;
// - an extension it doesn't have, or runs another version of;
// - two revisions of one item;
// - two entries with one name.

const { printValue } = require('./print');
const { dataElementEntry, extensionEntry, ruleEntry, byRevisionId, originOf } = require('./entries');
const { packageFor, sequencingOf, hasOwn } = require('./checks');

// Custom code Launch would move to a file stays inline until Chrome is known to run
// a Local Override whose real response is a 404: the CDN has no file for a
// revision production doesn't run. Inline code always runs.
const INLINE_MOVED_CODE = true;
const NOTHING_TO_APPLY = "Nothing to apply: the test build is production's script on the development environment";

/** Stops a test build. `problems` names everything that stopped it. */
class TestBuildStop extends Error {
    constructor(problems) {
        super(problems.join('\n'));
        this.name = 'TestBuildStop';
        this.problems = problems;
    }
}

const packageIdOf = (revision) => revision?.relationships?.extension_package?.data?.id;
// A moved custom code file, as the CDN serves it
const registerScript = ({ url, code }) => ({ url, text: `_satellite.__registerScript('${url}', ${JSON.stringify(code)});` });

/**
 * Production's entries of one type, each with its production revision.
 * @param {Array<[string, Object]>} entries - [name, entry], in container order
 * @param {(name: string, entry: Object) => Object} revisionOf
 * @returns {Array<{ id: string, origin: string, revision: Object, name: string, entry: Object }>}
 */
function productionEntries(label, entries, revisionOf) {
    return entries.map(([name, entry]) => {
        const revision = revisionOf(name, entry);
        // checkProductionEntries stops a build long before this
        if (!revision) throw new Error(`${label} ${name}: no production revision`);
        return { id: revision.id, origin: originOf(revision), revision, name, entry };
    });
}

/**
 * Applies the library's items of one type to production's entries, per the table above.
 * Two library revisions of one item can't both apply, so they are a problem and neither is.
 * @param {Object} how
 * @param {(item: Object) => ({ name: string, entry: Object }|null)} how.write - null when the item
 *   can't be written, having said why in the problems
 * @param {(item: Object, written: Object, current: Object) => boolean} how.same - whether the written
 *   entry does what production's entry for the same origin does
 * @returns {Array<{ id: string, name: string, entry: Object }>} the type's entries, in revision id order
 */
function applyType(label, running, items, { write, same }, { report, problems }) {
    const productionOf = new Map(running.map(entry => [entry.origin, entry]));
    const revisionsOf = new Map();
    for (const { revision } of items) {
        const origin = originOf(revision);
        revisionsOf.set(origin, [...(revisionsOf.get(origin) ?? []), revision]);
    }
    for (const revisions of revisionsOf.values()) {
        if (revisions.length < 2) continue;
        revisions.sort((a, b) => byRevisionId(a.id, b.id));
        const ids = revisions.map(revision => revision.id).join(', ');
        problems.push(`${label} ${revisions[0].attributes.name}: the sync folder holds more than one revision of it (${ids}); delete all but one`);
    }

    const removed = new Set();
    const written = [];
    for (const item of items) {
        const { revision } = item;
        if (revisionsOf.get(originOf(revision)).length > 1) continue;
        const name = `${label} ${revision.attributes.name}`;
        const current = productionOf.get(originOf(revision));
        if (!revision.attributes.enabled) {
            if (current) {
                removed.add(current);
                report.dropped.push(name);
            }
            continue;
        }
        const result = write(item);
        if (!result) continue;
        if (current) {
            removed.add(current);
            if (!same(item, result, current)) report.replaced.push(name);
        } else {
            report.added.push(name);
        }
        written.push({ id: revision.id, name: result.name, entry: result.entry });
    }
    return [...running.filter(entry => !removed.has(entry)), ...written].sort((a, b) => byRevisionId(a.id, b.id));
}

/** A problem for each name two entries share: the container is keyed by name, so it holds one. */
function checkNames(label, entries, problems) {
    const counts = new Map();
    for (const { name } of entries) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, count] of counts) {
        if (count > 1) problems.push(`${label} ${name}: another ${label} already has this name`);
    }
}

// A data element or extension does what production's does when it prints the same, under the same name
const samePrinted = (item, written, current) => written.name === current.name && printValue(written.entry) === printValue(current.entry);

/**
 * A test build: production's container with the library applied, on the
 * library's development environment, and marked with the time it was made.
 * @param {Object} input
 * @param {Object} input.production - production's build:
 *   - container: its parsed container
 *   - revisions: { rules, data_elements, extensions }, the revision of each of its entries
 *   - components: Map<rule revision id, component revisions[]>, each production rule's components
 *   - buildBaseUrl: the URL of its build folder
 * @param {Object} input.library - from readLibraryItems
 * @param {string} input.environmentId - the library's development environment
 * @param {Map<string, Object>} input.packages - extension packages, by id
 * @param {Date} input.now - becomes buildInfo.buildDate
 * @param {boolean} [input.inlineMovedCode] - keep custom code Launch would move to a file inline
 * @returns {{ container: Object, files: Array<{ url: string, text: string }>,
 *   report: { replaced: string[], added: string[], dropped: string[], warnings: string[] } }}
 *   files are the custom code files the library's rules load
 * @throws {TestBuildStop} naming everything in the library the build can't apply
 */
function assembleTestBuild({ production, library, environmentId, packages, now, inlineMovedCode = INLINE_MOVED_CODE }) {
    const container = structuredClone(production.container);
    const report = { replaced: [], added: [], dropped: [], warnings: [...library.warnings] };
    const problems = [];
    const found = { report, problems };
    const files = [];

    const byName = (revisions) => new Map(revisions.map(revision => [revision.attributes.name, revision]));
    const dataElementRevisions = byName(production.revisions.data_elements);
    const extensionRevisions = byName(production.revisions.extensions);
    const ruleRevisions = new Map(production.revisions.rules.map(revision => [revision.id, revision]));
    // A module path starts with its extension's name
    const loaded = (modulePath) => hasOwn(production.container.extensions[modulePath.split('/')[0]]?.modules ?? {}, modulePath);

    const dataElements = applyType('data element',
        productionEntries('data element', Object.entries(container.dataElements), name => dataElementRevisions.get(name)),
        library.data_elements, {
            write: ({ revision }) => {
                const { name, entry, warnings } = dataElementEntry(revision, packageFor(revision, 'updated_with_extension_package', packages));
                report.warnings.push(...warnings);
                if (loaded(entry.modulePath)) return { name, entry };
                problems.push(`data element ${name}: ${entry.modulePath} isn't loaded by production`);
                return null;
            },
            same: samePrinted
        }, found);
    checkNames('data element', dataElements, problems);

    const extensions = applyType('extension',
        productionEntries('extension', Object.entries(container.extensions), name => extensionRevisions.get(name)),
        library.extensions, {
            write: ({ revision }) => {
                const { name } = revision.attributes;
                if (!hasOwn(container.extensions, name)) {
                    problems.push(`extension ${name}: production doesn't load this extension`);
                    return null;
                }
                if (packageIdOf(revision) !== packageIdOf(extensionRevisions.get(name))) {
                    problems.push(`extension ${name}: production runs another version of this extension`);
                    return null;
                }
                return extensionEntry(revision, packageFor(revision, 'extension_package', packages), container.extensions[name].modules);
            },
            same: samePrinted
        }, found);
    checkNames('extension', extensions, problems);

    const options = {
        customCodeUrl: (componentId) => `${production.buildBaseUrl}${componentId}-source.js`,
        sequencing: sequencingOf(container),
        inlineMovedCode
    };
    const withPackages = (components) => components.map(component => ({ component, pkg: packageFor(component, 'updated_with_extension_package', packages) }));
    // What a rule does: its entry with all custom code inline and without the rule's
    // id. A new revision's ids, and the file URLs they name, aren't a change; a code edit is.
    const ruleContent = (revision, components) => {
        const { entry } = ruleEntry(revision, withPackages(components), { ...options, inlineMovedCode: true });
        delete entry.id;
        return printValue(entry);
    };
    const rules = applyType('rule',
        productionEntries('rule', container.rules.map(entry => [entry.name, entry]), (name, entry) => ruleRevisions.get(entry.id)),
        library.rules, {
            write: ({ revision, components }) => {
                const { entry, files: moved, warnings } = ruleEntry(revision, withPackages(components), options);
                report.warnings.push(...warnings);
                // A rule can use one delegate more than once
                const modulePaths = new Set([...entry.events, ...entry.conditions, ...entry.actions].map(written => written.modulePath));
                const missing = [...modulePaths].filter(modulePath => !loaded(modulePath));
                if (missing.length > 0) {
                    problems.push(...missing.map(modulePath => `rule ${entry.name}: ${modulePath} isn't loaded by production`));
                    return null;
                }
                files.push(...moved.map(registerScript));
                return { name: entry.name, entry };
            },
            // A rule whose production components aren't known counts as changed
            same: ({ revision, components }, written, current) => production.components.has(current.id)
                && ruleContent(revision, components) === ruleContent(current.revision, production.components.get(current.id))
        }, found);

    if (problems.length > 0) throw new TestBuildStop(problems);

    // Reassigning a key keeps its place in the container
    container.dataElements = Object.fromEntries(dataElements.map(({ name, entry }) => [name, entry]));
    container.extensions = Object.fromEntries(extensions.map(({ name, entry }) => [name, entry]));
    container.rules = rules.map(({ entry }) => entry);
    container.environment = { id: environmentId, stage: 'development' };
    container.buildInfo.buildDate = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

    if (report.replaced.length + report.added.length + report.dropped.length === 0) report.warnings.push(NOTHING_TO_APPLY);
    return { container, files, report };
}

module.exports = { INLINE_MOVED_CODE, TestBuildStop, assembleTestBuild };
