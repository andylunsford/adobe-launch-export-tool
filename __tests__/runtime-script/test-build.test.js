'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    PREFIX, parseScript, printScript, extensionEntry, urlToPath, generateTestBuild, TestBuildStop
} = require('../../lib/reactor-core/runtime-script');
const { writeDownload, bindFolder } = require('../../lib/reactor-core/sync');
const FIXTURE = require('../fixtures/runtime-script/launch-fixture');
const { PACKAGE, PRODUCTION, revision, component, reactorId } = require('../fixtures/runtime-script/fixture-data');

const NOW = new Date('2026-11-03T12:00:00.123Z');
const T = '2026-11-03T00:00:00.000Z';
const PROPERTY = reactorId('PR', 1);
const LIBRARY = reactorId('LB', 1);
const BUILD = reactorId('BL', 1);
const STAGING_ENV = reactorId('EN', 2);
const PRODUCTION_ENV = reactorId('EN', 3);
const DEVELOPMENT_ENV = reactorId('EN', 1);
const OTHER_DEVELOPMENT_ENV = reactorId('EN', 4);
const CHOOSE_FOLDER = 'Choose an overrides folder to write the test build to';

// An environment as the Reactor API lists it, with the script URLs of its embed code
const ORIGIN = 'https://assets.adobedtm.com/0000aaaa/1111bbbb';
const environment = (n, stage, suffix) => ({
    id: reactorId('EN', n),
    type: 'environments',
    attributes: { name: `${stage} ${n}`, stage },
    meta: { script_sources: [{ minified: `${ORIGIN}/launch-a1b2c3d4e5f6${suffix}.min.js`, debug: `${ORIGIN}/launch-a1b2c3d4e5f6${suffix}.js` }] }
});
const ENVIRONMENTS = [
    environment(1, 'development', '-development'),
    environment(2, 'staging', '-staging'),
    environment(3, 'production', ''),
    environment(4, 'development', '-development-2')
];
const SCRIPT_URLS = ENVIRONMENTS.flatMap(env => env.meta.script_sources.flatMap(source => [source.minified, source.debug]));
const PRODUCTION_DEBUG_URL = `${ORIGIN}/launch-a1b2c3d4e5f6.js`;

// Production's newest succeeded build. Its script is the min.js name; the debug script has the .js name.
const ARTIFACT_URL = `${PRODUCTION.buildBaseUrl}launch-a1b2c3d4e5f6.min.js`;
const DEBUG_SCRIPT_URL = `${PRODUCTION.buildBaseUrl}launch-a1b2c3d4e5f6.js`;
const BUILD_RECORD = {
    id: BUILD,
    type: 'builds',
    attributes: { status: 'succeeded', created_at: '2026-11-01T10:00:00.000Z' },
    meta: { direct_artifact_url: ARTIFACT_URL }
};

const json = (value) => JSON.stringify(value);
const customCode = (code) => json({ source: code, language: 'javascript' });
const clickRule = PRODUCTION.revisions.rules[1];
const clickComponents = PRODUCTION.components.get(clickRule.id);

/** A library holding a new revision of Click, with new component revisions and this custom code. */
function editedClick(code = 'console.log("changed");', attributes = {}) {
    const [event, condition, action] = clickComponents;
    const rule = revision('rules', 13, { name: 'Click', revision_number: 2, ...attributes }, reactorId('RL', 2));
    const components = [component(26, event.attributes), component(27, condition.attributes), component(28, { ...action.attributes, settings: customCode(code) })];
    return { rules: [rule], data_elements: [], extensions: [], components: new Map([[rule.id, components]]) };
}

/** A library that also holds a new data element, which a data element listing in Launch can differ from. */
function withVisitor(library, settings = { path: 'visitor.id' }) {
    const visitor = revision('data_elements', 35, {
        name: 'Visitor', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json(settings)
    }, reactorId('DE', 9));
    return { ...library, data_elements: [visitor] };
}

/**
 * Production with these extensions added: the script that serves them, and the revisions
 * and packages that make the entry writer give the same entries. An extension can list
 * the modules production loads and the delegates its package has.
 */
function withExtensions(added) {
    const parsed = parseScript(FIXTURE);
    const extensions = [];
    const packages = [];
    added.forEach(({ name, settings, modules = {}, delegates = {} }, i) => {
        const pkg = { id: reactorId('EP', i + 2), type: 'extension_packages', attributes: { name, version: '1.0.0', configuration: {}, ...delegates } };
        const extension = revision('extensions', 42 + i, { name, display_name: name, settings: json(settings) }, reactorId('EX', i + 2));
        extension.relationships.extension_package.data.id = pkg.id;
        parsed.container.extensions[name] = extensionEntry(extension, pkg, modules).entry;
        extensions.push(extension);
        packages.push(pkg);
    });
    return {
        script: printScript(parsed),
        revisions: { ...PRODUCTION.revisions, extensions: [...PRODUCTION.revisions.extensions, ...extensions] },
        packages: [PACKAGE, ...packages]
    };
}

// Production with the Web SDK, its Send event module loaded, and one instance with a datastream per stage
const SEND_EVENT = { id: 'adobe-alloy::actions::send-event', name: 'send-event', displayName: 'Send event', libPath: 'dist/lib/actions/sendEvent/index.js' };
const withAlloy = () => withExtensions([{
    name: 'adobe-alloy',
    settings: { instances: [{ name: 'alloy', edgeConfigId: 'prod-datastream', developmentEdgeConfigId: 'dev-datastream' }] },
    modules: { [`adobe-alloy/${SEND_EVENT.libPath}`]: { name: SEND_EVENT.name, displayName: SEND_EVENT.displayName } },
    delegates: { actions: [SEND_EVENT] }
}]);

/** A library holding a new rule, Send, whose Web SDK Send event action has these overrides. */
function sendEventRule(edgeConfigOverrides) {
    const rule = revision('rules', 14, { name: 'Send' }, reactorId('RL', 3));
    const event = component(29, { name: 'DOM Ready', delegate_descriptor_id: 'core::events::dom-ready', order: 0, rule_order: 50 });
    const send = component(30, {
        name: 'Send event', delegate_descriptor_id: SEND_EVENT.id, order: 1, settings: json({ instanceName: 'alloy', edgeConfigOverrides })
    });
    // withAlloy's package
    send.relationships.updated_with_extension_package.data.id = reactorId('EP', 2);
    return { rules: [rule], data_elements: [], extensions: [], components: new Map([[rule.id, [event, send]]]) };
}

/**
 * Launch and the CDN, as fakes. `library` is what Launch lists for the library.
 * Only what a test generation asks for is there; anything else fails the test.
 */
function launch({ library = editedClick(), libraryEnvironment = DEVELOPMENT_ENV, script = FIXTURE, build = BUILD_RECORD,
    environments = ENVIRONMENTS, revisions = PRODUCTION.revisions, packages = [PACKAGE] } = {}) {
    const libraryRecord = {
        id: LIBRARY,
        type: 'libraries',
        attributes: { name: 'Fixture Library', state: 'development' },
        relationships: { environment: { data: libraryEnvironment && { id: libraryEnvironment, type: 'environments' } } }
    };
    const get = jest.fn(async (url) => {
        const [, kind, id, child] = new URL(url).pathname.split('/');
        const list = (data) => ({ data });
        if (kind === 'properties' && id === PROPERTY && child === 'environments') return list(environments);
        if (kind === 'environments' && id === PRODUCTION_ENV && child === 'builds') return list(build ? [build] : []);
        if (kind === 'builds' && id === BUILD && ['rules', 'data_elements', 'extensions'].includes(child)) return list(revisions[child]);
        if (kind === 'rules' && child === 'rule_components') return list(PRODUCTION.components.get(id) ?? library.components.get(id) ?? []);
        if (kind === 'libraries' && id === LIBRARY && !child) return { data: libraryRecord };
        if (kind === 'libraries' && id === LIBRARY && ['rules', 'data_elements', 'extensions'].includes(child)) return list(library[child]);
        throw new Error(`unexpected GET ${url}`);
    });
    const getText = jest.fn(async () => script);
    const fetchPkg = jest.fn(async (id) => packages.find(pkg => pkg.id === id));
    return { get, getText, fetchPkg };
}

/** The TestBuildStop a run throws. */
async function stopped(run) {
    try {
        await run;
    } catch (e) {
        return e;
    }
    throw new Error("the test build didn't stop");
}

describe('generateTestBuild', () => {
    let root;
    let syncDir;
    let overridesDir;
    let log;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-build-'));
        syncDir = path.join(root, 'sync');
        overridesDir = path.join(root, 'overrides');
        fs.mkdirSync(syncDir);
        fs.mkdirSync(overridesDir);
        log = jest.fn();
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    /** Binds the sync folder to the library and writes what a library download would. */
    async function download(library = editedClick()) {
        bindFolder(syncDir, { propertyId: PROPERTY, propertyName: 'Fixture Property', orgId: 'org@AdobeOrg', libraryId: LIBRARY, libraryName: 'Fixture Library' });
        const ruleOf = new Map();
        for (const [ruleId, list] of library.components) list.forEach(c => ruleOf.set(c.id, ruleId));
        const listing = { ...library, rule_components: [...library.components.values()].flat(), ruleOf, failed: [] };
        await writeDownload({ targetDir: syncDir, listing, fetchPkg: async () => PACKAGE, now: () => T });
    }

    const generate = (fakes, options = {}) => generateTestBuild({
        syncDir, overridesDir, ...fakes, now: NOW, log, ...options
    });
    const manifestFile = () => path.join(syncDir, '.reactor-sync', 'test-build.json');
    const cacheFile = (name) => path.join(syncDir, '.reactor-sync', 'builds', BUILD, name);
    const buildRequests = (fakes) => fakes.get.mock.calls.filter(([url]) => url.includes(`/builds/${BUILD}/`)).length;

    test('generates and writes the test build', async () => {
        await download();
        const fakes = launch();
        const { report, written, removed } = await generate(fakes);

        expect(report).toEqual({
            replaced: ['rule Click'], added: [], dropped: [],
            warnings: ['Click: custom code kept inline; Launch would load it from a file']
        });
        expect(removed).toEqual([]);

        // The one script goes to the minified and debug URL of every environment
        expect([...written].sort()).toEqual(SCRIPT_URLS.map(url => path.resolve(urlToPath(overridesDir, url))).sort());
        const script = fs.readFileSync(urlToPath(overridesDir, PRODUCTION_DEBUG_URL), 'utf8');
        expect(script.startsWith(PREFIX)).toBe(true);
        const { container } = parseScript(script);
        expect(container.environment).toEqual({ id: DEVELOPMENT_ENV, stage: 'development' });
        expect(container.buildInfo.buildDate).toBe('2026-11-03T12:00:00Z');
        expect(container.rules.map(rule => rule.id)).toEqual([reactorId('RL', 11), reactorId('RL', 13)]);
        expect(container.rules[1].actions[0].settings.source).toBe('console.log("changed");');
        for (const url of SCRIPT_URLS) expect(fs.readFileSync(urlToPath(overridesDir, url), 'utf8')).toBe(script);

        const manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
        expect(manifest).toEqual({
            generatedAt: '2026-11-03T12:00:00.123Z', buildId: BUILD, library: { id: LIBRARY, name: 'Fixture Library' }, report, files: written
        });

        // Production's script and revisions are kept for the next run. The script is downloaded by its debug name.
        expect(fakes.getText.mock.calls).toEqual([[DEBUG_SCRIPT_URL]]);
        expect(fs.readFileSync(cacheFile('script.js'), 'utf8')).toBe(FIXTURE);
        expect(fs.existsSync(cacheFile('revisions.json'))).toBe(true);
        // Each extension package is fetched once, however many items use it
        expect(fakes.fetchPkg.mock.calls).toEqual([[PACKAGE.id]]);

        expect(log.mock.calls.length).toBeGreaterThan(1);
        expect(log.mock.calls.at(-1)).toEqual([
            `Chrome applies Local Overrides only while DevTools is open. In DevTools, open Sources → Overrides and select ${overridesDir}`
        ]);
    });

    test('reuses the downloaded script for the same build', async () => {
        await download();
        const fakes = launch();
        await generate(fakes);
        // Load is only production's, so its components are asked for only when production's are
        const loadComponentRequests = () => fakes.get.mock.calls.filter(([url]) => url.includes(`/rules/${PRODUCTION.revisions.rules[0].id}/`)).length;
        const [requests, componentRequests] = [buildRequests(fakes), loadComponentRequests()];
        expect(requests).toBeGreaterThan(0);
        expect(componentRequests).toBeGreaterThan(0);

        const second = await generate(fakes);
        expect(fakes.getText).toHaveBeenCalledTimes(1);
        // Its revisions and rule components are kept as well
        expect(buildRequests(fakes)).toBe(requests);
        expect(loadComponentRequests()).toBe(componentRequests);
        expect(second.report.replaced).toEqual(['rule Click']);
    });

    test.each([
        ['cut short', '{"revisions": '],
        ['missing their components', json({ revisions: { rules: [], data_elements: [], extensions: [] } })]
    ])('fetches the revisions again when the saved ones are %s', async (_, saved) => {
        await download();
        const fakes = launch();
        await generate(fakes);
        const requests = buildRequests(fakes);
        fs.writeFileSync(cacheFile('revisions.json'), saved);

        await generate(fakes);
        expect(buildRequests(fakes)).toBe(requests * 2);
        expect(JSON.parse(fs.readFileSync(cacheFile('revisions.json'), 'utf8')).revisions.rules).toHaveLength(2);
    });

    test('fetches the revisions again when the saved ones lack the components of a production rule', async () => {
        await download();
        const fakes = launch();
        await generate(fakes);
        const requests = buildRequests(fakes);
        const saved = JSON.parse(fs.readFileSync(cacheFile('revisions.json'), 'utf8'));
        saved.components = saved.components.filter(([ruleId]) => ruleId !== PRODUCTION.revisions.rules[0].id);
        fs.writeFileSync(cacheFile('revisions.json'), json(saved));

        await generate(fakes);
        expect(buildRequests(fakes)).toBe(requests * 2);
        const healed = JSON.parse(fs.readFileSync(cacheFile('revisions.json'), 'utf8'));
        expect(healed.components.map(([ruleId]) => ruleId)).toEqual(PRODUCTION.revisions.rules.map(rule => rule.id));
    });

    test('stops when production has no build', async () => {
        await download();
        const fakes = launch({ build: null });
        const error = await stopped(generate(fakes));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['Production has no successful build yet']);
        expect(fakes.getText).not.toHaveBeenCalled();
        expect(fs.readdirSync(overridesDir)).toEqual([]);
    });

    test('stops when the property has no production environment', async () => {
        await download();
        const error = await stopped(generate(launch({ environments: ENVIRONMENTS.filter(env => env.attributes.stage !== 'production') })));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['The property has no production environment']);
    });

    test('stops when the production build has no script to download', async () => {
        await download();
        const error = await stopped(generate(launch({ build: { ...BUILD_RECORD, meta: {} } })));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(["Production's build has no script URL to download"]);
    });

    test("stops when the folder isn't a library sync", async () => {
        const isNot = ["This folder isn't a library sync. Download a library first."];
        const fakes = launch();

        // A property sync
        bindFolder(syncDir, { propertyId: PROPERTY, propertyName: 'Fixture Property', orgId: 'org@AdobeOrg' });
        let error = await stopped(generate(fakes));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(isNot);

        // No sync at all
        fs.rmSync(path.join(syncDir, '.reactor-settings.json'));
        error = await stopped(generate(fakes));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(isNot);

        expect(fakes.get).not.toHaveBeenCalled();
    });

    test.each([['empty', ''], ['blank', '  '], ['missing', undefined]])('stops before any request when the overrides folder is %s', async (_, folder) => {
        await download();
        const fakes = launch();
        const error = await stopped(generate(fakes, { overridesDir: folder }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual([CHOOSE_FOLDER]);
        expect(fakes.get).not.toHaveBeenCalled();
        expect(fakes.getText).not.toHaveBeenCalled();
    });

    test("stops and writes nothing when the script doesn't round-trip", async () => {
        await download();
        const extraSpace = FIXTURE.replace('"stage": "production"', '"stage":  "production"');
        const at = extraSpace.indexOf('"stage":  ') + '"stage": '.length;
        const fakes = launch({ script: extraSpace });

        const error = await stopped(generate(fakes));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual([`Production's script doesn't print back exactly (first difference at byte ${at})`]);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
        expect(fs.existsSync(manifestFile())).toBe(false);
        // Nothing past the first check was asked for
        expect(buildRequests(fakes)).toBe(0);
    });

    test('keeps no script that fails the first check, so the next run downloads it again', async () => {
        await download();
        const fakes = launch({ script: '<html>Blocked by the proxy</html>' });
        await stopped(generate(fakes));
        expect(fs.existsSync(cacheFile('script.js'))).toBe(false);

        fakes.getText.mockResolvedValue(FIXTURE);
        await generate(fakes);
        expect(fakes.getText).toHaveBeenCalledTimes(2);
        expect(fs.readFileSync(cacheFile('script.js'), 'utf8')).toBe(FIXTURE);
    });

    describe('with a saved script that is cut short', () => {
        const saveCutShort = () => {
            fs.mkdirSync(path.dirname(cacheFile('script.js')), { recursive: true });
            fs.writeFileSync(cacheFile('script.js'), FIXTURE.slice(0, 500));
        };

        test('downloads it again, once, and keeps the new one', async () => {
            await download();
            saveCutShort();
            const fakes = launch();

            const { report } = await generate(fakes);
            expect(fakes.getText.mock.calls).toEqual([[DEBUG_SCRIPT_URL]]);
            expect(fs.readFileSync(cacheFile('script.js'), 'utf8')).toBe(FIXTURE);
            expect(report.replaced).toEqual(['rule Click']);
        });

        test("stops, and keeps nothing, when the download isn't a script either", async () => {
            await download();
            saveCutShort();
            const fakes = launch({ script: '<html>Blocked by the proxy</html>' });

            const error = await stopped(generate(fakes));
            expect(error).toBeInstanceOf(TestBuildStop);
            expect(error.problems).toEqual(['Not a Launch debug script: it does not start with the container assignment']);
            expect(fakes.getText).toHaveBeenCalledTimes(1);
            expect(fs.existsSync(cacheFile('script.js'))).toBe(false);
            expect(fs.readdirSync(overridesDir)).toEqual([]);
        });
    });

    test("stops when the script isn't a Launch script", async () => {
        await download();
        const error = await stopped(generate(launch({ script: '<html>Access denied</html>' })));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['Not a Launch debug script: it does not start with the container assignment']);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
    });

    test("stops and writes nothing when production's entries don't match their revisions", async () => {
        await download();
        const [title, section] = PRODUCTION.revisions.data_elements;
        const revisions = {
            ...PRODUCTION.revisions,
            data_elements: [title, { ...section, attributes: { ...section.attributes, default_value: null } }]
        };
        const error = await stopped(generate(launch({ revisions })));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['data_elements Site Section: differs from production at defaultValue']);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
        expect(fs.existsSync(manifestFile())).toBe(false);
    });

    test('stops when a library revision is behind production', async () => {
        const library = editedClick('console.log("changed");', { revision_number: 0 });
        await download(library);
        const error = await stopped(generate(launch({ library })));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['rules Click: the library holds revision 0, production runs 1']);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
    });

    test('warns about library items that changed in Launch since the sync', async () => {
        const downloaded = withVisitor(editedClick());
        await download(downloaded);
        // Edited here: the data element's settings
        const settingsFile = path.join(syncDir, 'data_elements', downloaded.data_elements[0].id, 'settings.json');
        fs.writeFileSync(settingsFile, json({ path: 'visitor.local' }));
        // In Launch since: the same data element edited there, and another one added to the library
        const other = revision('data_elements', 36, {
            name: 'Other', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'other' })
        }, reactorId('DE', 10));
        const remote = withVisitor(editedClick(), { path: 'visitor.remote' });
        remote.data_elements.push(other);

        const { report } = await generate(launch({ library: remote }));
        expect(report.warnings).toEqual([
            'data element Other: new or changed in Launch since the sync. Sync the library again.',
            'data element Visitor: changed locally and in Launch. Sync the library again.',
            'Click: custom code kept inline; Launch would load it from a file'
        ]);
        // The local edit is what the build has
        const script = fs.readFileSync(urlToPath(overridesDir, PRODUCTION_DEBUG_URL), 'utf8');
        expect(parseScript(script).container.dataElements.Visitor.settings).toEqual({ path: 'visitor.local' });
    });

    test("warns when the library couldn't be checked against Launch, and still builds", async () => {
        await download();
        const fakes = launch();
        const listed = fakes.get.getMockImplementation();
        fakes.get.mockImplementation(async (url) => {
            if (url.includes(`/libraries/${LIBRARY}/data_elements`)) throw new Error('Request failed with status code 503');
            return listed(url);
        });

        const { report } = await generate(fakes);
        expect(report.warnings).toEqual([
            "Couldn't check the library against Launch: Couldn't list data_elements: Request failed with status code 503. Sync the library again.",
            'Click: custom code kept inline; Launch would load it from a file'
        ]);
        expect(report.replaced).toEqual(['rule Click']);
        expect(fs.existsSync(manifestFile())).toBe(true);
    });

    test('stops when a stage-aware extension has no development destination', async () => {
        await download();
        const alloy = withExtensions([{ name: 'adobe-alloy', settings: { instances: [{ edgeConfigId: 'prod-datastream', developmentEdgeConfigId: '' }] } }]);
        const fakes = launch(alloy);

        const error = await stopped(generate(fakes));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['adobe-alloy instance 0: no development datastream, so test traffic would reach production']);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
        expect(fs.existsSync(manifestFile())).toBe(false);

        // With a development datastream, the same production builds. It is a different script under
        // the build's id, so the one kept for that build has to go.
        fs.rmSync(path.join(syncDir, '.reactor-sync', 'builds'), { recursive: true });
        const fixed = withExtensions([{ name: 'adobe-alloy', settings: { instances: [{ edgeConfigId: 'prod-datastream', developmentEdgeConfigId: 'dev-datastream' }] } }]);
        const { report } = await generate(launch(fixed));
        expect(report.warnings).toEqual(['Click: custom code kept inline; Launch would load it from a file']);
    });

    test("stops and writes nothing when a library Send event action's development datastream is production's", async () => {
        const library = sendEventRule({ development: { datastreamId: 'prod-datastream' } });
        await download(library);

        const error = await stopped(generate(launch({ ...withAlloy(), library })));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(["rule Send: adobe-alloy action 0: the development datastream override is production's"]);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
        expect(fs.existsSync(manifestFile())).toBe(false);
    });

    test('builds a library Send event action whose development datastream override is its own', async () => {
        const library = sendEventRule({ development: { datastreamId: 'dev-other' }, production: { datastreamId: 'prod-other' } });
        await download(library);

        const { report } = await generate(launch({ ...withAlloy(), library }));
        expect(report).toEqual({ replaced: [], added: ['rule Send'], dropped: [], warnings: [] });
        const script = fs.readFileSync(urlToPath(overridesDir, PRODUCTION_DEBUG_URL), 'utf8');
        expect(parseScript(script).container.rules.at(-1).actions[0].settings.edgeConfigOverrides.development).toEqual({ datastreamId: 'dev-other' });
    });

    test("warns which extensions don't choose a destination by stage", async () => {
        await download();
        const tags = withExtensions([{ name: 'tag-a', settings: {} }, { name: 'tag-b', settings: { id: 1 } }]);
        const { report } = await generate(launch(tags));
        expect(report.warnings).toEqual([
            'Click: custom code kept inline; Launch would load it from a file',
            "These extensions don't choose a destination by stage and send where they always do: tag-a, tag-b"
        ]);
    });

    test('uses environmentId when the library has no environment', async () => {
        await download();
        const fakes = launch({ libraryEnvironment: null });
        await generate(fakes, { environmentId: OTHER_DEVELOPMENT_ENV });
        const script = fs.readFileSync(urlToPath(overridesDir, PRODUCTION_DEBUG_URL), 'utf8');
        expect(parseScript(script).container.environment).toEqual({ id: OTHER_DEVELOPMENT_ENV, stage: 'development' });
    });

    test("the library's environment wins over environmentId", async () => {
        await download();
        await generate(launch(), { environmentId: OTHER_DEVELOPMENT_ENV });
        const script = fs.readFileSync(urlToPath(overridesDir, PRODUCTION_DEBUG_URL), 'utf8');
        expect(parseScript(script).container.environment.id).toBe(DEVELOPMENT_ENV);
    });

    test('stops when neither the library nor the caller names an environment', async () => {
        await download();
        const error = await stopped(generate(launch({ libraryEnvironment: null })));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['Pick a development environment for this library']);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
    });

    // The assembler writes the development stage whatever id it is given, so the id has to be a development environment's
    test("uses environmentId when the library's environment isn't a development environment", async () => {
        await download();
        await generate(launch({ libraryEnvironment: STAGING_ENV }), { environmentId: OTHER_DEVELOPMENT_ENV });
        const script = fs.readFileSync(urlToPath(overridesDir, PRODUCTION_DEBUG_URL), 'utf8');
        expect(parseScript(script).container.environment).toEqual({ id: OTHER_DEVELOPMENT_ENV, stage: 'development' });
    });

    test.each([
        ['an environmentId that is a staging environment', null, STAGING_ENV],
        ['an environmentId that is the production environment', null, PRODUCTION_ENV],
        ['an environmentId that isn\'t one of the property\'s environments', null, reactorId('EN', 9)],
        ['a library environment that is a staging environment, and no environmentId', STAGING_ENV, undefined],
        ['a staging environment as both', STAGING_ENV, STAGING_ENV]
    ])('stops with %s', async (_, libraryEnvironment, environmentId) => {
        await download();
        const error = await stopped(generate(launch({ libraryEnvironment }), { environmentId }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['Pick a development environment for this library']);
        expect(fs.readdirSync(overridesDir)).toEqual([]);
    });

    test("adds the overrides folder's warnings to the report", async () => {
        await download();
        fs.mkdirSync(path.dirname(manifestFile()), { recursive: true });
        fs.writeFileSync(manifestFile(), 'not json');

        const { report } = await generate(launch());
        expect(report.warnings).toEqual([
            'Click: custom code kept inline; Launch would load it from a file',
            `The previous test build's manifest (${manifestFile()}) couldn't be read, so the files it listed were left in place`
        ]);
    });
});
