'use strict';

// Makes a test build end to end: production's current build, the library synced
// into a folder (with its local edits) applied to it, written where Chrome's Local
// Overrides serves it. The steps run in a fixed order, and every check passes
// before anything goes into the overrides folder. This only reads from Launch.

const fs = require('fs');
const path = require('path');
const { listAll, latestSucceededBuild } = require('../api');
const diff = require('../diff/runner');
const { readConfig, librarySyncApi, listRuleComponents } = require('../sync');
const { parseScript } = require('./parse');
const { printScript } = require('./print');
const { checkRoundTrip, checkProductionEntries, checkBehindProduction, checkStageDestinations } = require('./checks');
const { readLibraryItems } = require('./library-items');
const { assembleTestBuild, TestBuildStop } = require('./assemble');
const { scriptUrls, writeOverrides, longPath } = require('./overrides');

const REACTOR_URL = 'https://reactor.adobe.io';
const REVISION_TYPES = ['rules', 'data_elements', 'extensions'];
const ITEM_LABELS = { rules: 'rule', data_elements: 'data element', extensions: 'extension', rule_components: 'rule component' };

/** Stops the test build with one problem. */
function stop(problem) {
    throw new TestBuildStop([problem]);
}

function readIfThere(file) {
    try {
        return fs.readFileSync(longPath(file), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

function save(file, text) {
    fs.mkdirSync(longPath(path.dirname(file)), { recursive: true });
    fs.writeFileSync(longPath(file), text, 'utf8');
}

/**
 * Production's revisions and rule components as an earlier run kept them, or null if it
 * kept none that can be read, or none with the components of every rule.
 */
function readSavedRevisions(file) {
    const text = readIfThere(file);
    if (text === null) return null;
    try {
        const { revisions, components } = JSON.parse(text);
        if (REVISION_TYPES.every(type => Array.isArray(revisions?.[type])) && Array.isArray(components)) {
            const byRule = new Map(components);
            if (revisions.rules.every(rule => byRule.has(rule.id))) return { revisions, components: byRule };
        }
    } catch (err) {
        // Fetched again below
    }
    return null;
}

/**
 * Production's revisions: the build's rules, data elements and extensions, and each
 * rule's components. A build never changes, so they are kept in the sync folder
 * (the components take one request for each rule).
 * @returns {Promise<{ revisions: { rules: Object[], data_elements: Object[], extensions: Object[] }, components: Map<string, Object[]> }>}
 */
async function productionRevisions({ get, buildId, file, log }) {
    const saved = readSavedRevisions(file);
    if (saved) return saved;

    log("Fetching production's rules, data elements and extensions...");
    const lists = await Promise.all(REVISION_TYPES.map(type => listAll(get, `${REACTOR_URL}/builds/${buildId}/${type}`)));
    const revisions = Object.fromEntries(REVISION_TYPES.map((type, i) => [type, lists[i]]));

    log("Fetching the components of production's rules...");
    const listed = await listRuleComponents(get, revisions.rules);
    if (listed.failed.length > 0) {
        throw new Error(`Couldn't list the components of ${listed.failed.length} production rule(s): ${listed.failed[0].message}`);
    }
    const components = new Map(revisions.rules.map(rule => [rule.id, []]));
    for (const component of listed.components) components.get(listed.ruleOf.get(component.id)).push(component);

    save(file, JSON.stringify({ revisions, components: [...components] }));
    return { revisions, components };
}

const packageIdOf = (revision, relationship) => revision.relationships?.[relationship]?.data?.id;

/** The ids of the extension packages these revisions were written with. */
function packageIds({ dataElements, extensions, components }) {
    return [
        ...[...dataElements, ...components].map(revision => packageIdOf(revision, 'updated_with_extension_package')),
        ...extensions.map(revision => packageIdOf(revision, 'extension_package'))
    ].filter(Boolean);
}

/** Adds the packages that are missing from `packages`, one request each. */
async function loadPackages(ids, packages, fetchPkg) {
    for (const id of new Set(ids)) {
        if (packages.has(id)) continue;
        const pkg = await fetchPkg(id);
        if (!pkg) throw new Error(`Couldn't fetch extension package ${id}`);
        packages.set(id, pkg);
    }
}

/**
 * Warnings from the diff of the sync folder against Launch: the library's items that
 * changed in Launch since the sync, and each check that couldn't be made (which would
 * otherwise read as nothing having changed).
 */
function driftWarnings({ behind, conflict, errors }) {
    const named = ({ type, name, rule_name: ruleName }) => `${ITEM_LABELS[type]} ${name}${ruleName ? ` (rule ${ruleName})` : ''}`;
    return [
        ...behind.map(item => `${named(item)}: new or changed in Launch since the sync. Sync the library again.`),
        ...conflict.map(item => `${named(item)}: ${item.details?.reason}. Sync the library again.`),
        ...errors.map(({ message }) => `Couldn't check the library against Launch: ${message}. Sync the library again.`)
    ];
}

/** Production's script as parsed, or the problem that stops the build: it isn't a Launch script, or doesn't print back as it was. */
function checkScript(text) {
    let parsed;
    try {
        parsed = parseScript(text);
    } catch (err) {
        return { problem: err.message };
    }
    const problem = checkRoundTrip(text, parsed);
    return problem ? { problem } : { parsed };
}

/**
 * Makes a test build from the library a sync folder holds and writes it to the overrides folder.
 * It runs in this order, and stops at the first check that fails: the folder's library,
 * production's build and script, check 1 (production's script prints back as it was),
 * production's revisions, check 2 (the entry writers give production's entries), the
 * library, check 3 (no library revision is behind production), the development
 * environment, the assembly (which is check 4: nothing the library holds is unsupported),
 * check 5 (no test traffic to production), then the write.
 * @param {Object} input
 * @param {string} input.syncDir - a folder written by a library download
 * @param {string} input.overridesDir - Chrome's Local Overrides folder
 * @param {(url: string) => Promise<Object>} input.get - an async GET of a Reactor API URL, resolving to the parsed body
 * @param {(url: string) => Promise<string>} input.getText - an async GET of the script, resolving to its text
 * @param {(id: string) => Promise<Object>} input.fetchPkg - an extension package, by id
 * @param {string} [input.environmentId] - the development environment to build for if the library's own isn't one of the property's development environments
 * @param {Date} input.now - becomes buildInfo.buildDate and the manifest's time
 * @param {(message: string) => void} [input.log] - told each step
 * @returns {Promise<{ report: { replaced: string[], added: string[], dropped: string[], warnings: string[] },
 *   written: string[], removed: string[] }>} the paths are absolute
 * @throws {TestBuildStop} naming what stopped it
 */
async function generateTestBuild({ syncDir, overridesDir, get, getText, fetchPkg, environmentId, now, log = () => {} }) {
    // writeOverrides refuses one too, but only after every request
    if (typeof overridesDir !== 'string' || overridesDir.trim() === '') stop('Choose an overrides folder to write the test build to');

    // Each package is fetched once, however many items use it
    const fetched = new Map();
    const fetchOnce = (id) => {
        if (!fetched.has(id)) fetched.set(id, fetchPkg(id));
        return fetched.get(id);
    };

    const config = readConfig(syncDir);
    if (!config?.libraryId) stop("This folder isn't a library sync. Download a library first.");

    log("Finding production's current build...");
    const environments = await listAll(get, `${REACTOR_URL}/properties/${config.propertyId}/environments`);
    const production = environments.find(environment => environment.attributes?.stage === 'production');
    if (!production) stop('The property has no production environment');
    const build = await latestSucceededBuild(get, production.id);
    if (!build) stop('Production has no successful build yet');
    const artifactUrl = build.meta?.direct_artifact_url;
    if (!artifactUrl) stop("Production's build has no script URL to download");
    const buildBaseUrl = artifactUrl.slice(0, artifactUrl.lastIndexOf('/') + 1);
    const buildDir = path.join(syncDir, '.reactor-sync', 'builds', build.id);

    const scriptFile = path.join(buildDir, 'script.js');
    const saved = readIfThere(scriptFile);
    let parsed;
    if (saved !== null) {
        log("Checking the saved copy of production's script...");
        ({ parsed } = checkScript(saved));
        if (!parsed) {
            // Cut short or damaged: the build's script is downloaded once more
            log('The saved copy is damaged. Downloading it again...');
            fs.rmSync(longPath(scriptFile), { force: true });
        }
    }
    if (!parsed) {
        log("Downloading production's script...");
        // The debug script is served under the minified name's .js twin
        const text = await getText(artifactUrl.replace(/\.min\.js$/, '.js'));
        log("Checking that production's script prints back exactly...");
        const checked = checkScript(text);
        if (checked.problem) stop(checked.problem);
        // Kept only once it passes, so a bad download (a proxy's error page, say) is fetched again next time
        save(scriptFile, text);
        parsed = checked.parsed;
    }

    const { revisions, components } = await productionRevisions({ get, buildId: build.id, file: path.join(buildDir, 'revisions.json'), log });
    const packages = new Map();
    await loadPackages(packageIds({
        dataElements: revisions.data_elements, extensions: revisions.extensions, components: [...components.values()].flat()
    }), packages, fetchOnce);

    log("Checking that production's entries are written as Launch writes them...");
    const notReproduced = checkProductionEntries({
        container: parsed.container, revisions, components, packages, customCodeUrl: (id) => `${buildBaseUrl}${id}-source.js`
    });
    if (notReproduced.length > 0) throw new TestBuildStop(notReproduced);

    log("Reading the library's files...");
    const library = await readLibraryItems(syncDir, fetchOnce);
    log('Checking the library against Launch...');
    const launchChanges = driftWarnings(await diff(syncDir, librarySyncApi(get, config.libraryId), fetchOnce));
    const behind = checkBehindProduction(library, revisions);
    if (behind.length > 0) throw new TestBuildStop(behind);

    const libraryRecord = await get(`${REACTOR_URL}/libraries/${config.libraryId}`);
    // The assembler writes the development stage whatever id it is given, so the id has to be a development environment's
    const developmentIds = new Set(environments.filter(environment => environment.attributes?.stage === 'development').map(environment => environment.id));
    const developmentId = [libraryRecord.data?.relationships?.environment?.data?.id, environmentId].find(id => developmentIds.has(id));
    if (!developmentId) stop('Pick a development environment for this library');

    log('Building the test build...');
    await loadPackages(packageIds({
        dataElements: library.data_elements.map(item => item.revision),
        extensions: library.extensions.map(item => item.revision),
        components: library.rules.flatMap(rule => rule.components)
    }), packages, fetchOnce);
    const { container, files, report } = assembleTestBuild({
        production: { container: parsed.container, revisions, components, buildBaseUrl },
        library: { ...library, warnings: [...library.warnings, ...launchChanges] },
        environmentId: developmentId,
        packages,
        now
    });

    log('Checking that no test traffic can reach production...');
    const stage = checkStageDestinations(container);
    if (stage.problems.length > 0) throw new TestBuildStop(stage.problems);
    if (stage.unaware.length > 0) {
        report.warnings.push(`These extensions don't choose a destination by stage and send where they always do: ${stage.unaware.join(', ')}`);
    }

    log('Writing the test build...');
    const wrote = writeOverrides({
        overridesDir,
        syncDir,
        scriptText: printScript({ container, turbine: parsed.turbine }),
        scriptUrls: scriptUrls(environments),
        files,
        manifest: { generatedAt: now.toISOString(), buildId: build.id, library: { id: config.libraryId, name: config.libraryName }, report }
    });
    log(`Chrome applies Local Overrides only while DevTools is open. In DevTools, open Sources → Overrides and select ${overridesDir}`);
    return { report: { ...report, warnings: [...report.warnings, ...wrote.warnings] }, written: wrote.written, removed: wrote.removed };
}

module.exports = { generateTestBuild };
