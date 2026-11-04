'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    parseScript, printScript, printValue, assembleTestBuild, readLibraryItems, TestBuildStop, INLINE_MOVED_CODE
} = require('../../lib/reactor-core/runtime-script');
const { writeDownload } = require('../../lib/reactor-core/sync');
const FIXTURE = require('../fixtures/runtime-script/launch-fixture');
const { PACKAGE, PRODUCTION, revision, component, reactorId } = require('../fixtures/runtime-script/fixture-data');

const parsed = parseScript(FIXTURE);
const production = { container: parsed.container, revisions: PRODUCTION.revisions, components: PRODUCTION.components, buildBaseUrl: PRODUCTION.buildBaseUrl };
const packages = new Map([[PACKAGE.id, PACKAGE]]);
const NOW = new Date('2026-11-03T12:00:00.123Z');
const NOTHING_TO_APPLY = "Nothing to apply: the test build is production's script on the development environment";

const json = (value) => JSON.stringify(value);
const customCode = (code) => json({ source: code, language: 'javascript' });

/** Assembles production with a library holding these items. */
const assemble = (library = {}, options = {}) => assembleTestBuild({
    production,
    library: { rules: [], data_elements: [], extensions: [], warnings: [], ...library },
    environmentId: reactorId('EN', 1),
    packages,
    now: NOW,
    ...options
});

/** The TestBuildStop a run throws. */
function stopped(run) {
    try {
        run();
    } catch (e) {
        return e;
    }
    throw new Error("the test build didn't stop");
}

const [loadRule, clickRule] = PRODUCTION.revisions.rules;
const clickComponents = PRODUCTION.components.get(clickRule.id);

/** A new library revision of Click (origin RL…02), with new component revisions and this custom code. */
function freshClick(n, code = 'console.log("external");') {
    const [event, condition, action] = clickComponents;
    return {
        revision: revision('rules', n, { name: 'Click' }, reactorId('RL', 2)),
        components: [component(26, event.attributes), component(27, condition.attributes), component(28, { ...action.attributes, settings: customCode(code) })]
    };
}
/** A new library revision of Click, with its custom code action changed. */
const editedClick = (n) => freshClick(n, 'console.log("changed");');

// The core package with delegates production's script doesn't load
const NOT_LOADED = {
    ...PACKAGE,
    attributes: {
        ...PACKAGE.attributes,
        data_elements: [...PACKAGE.attributes.data_elements,
            { id: 'core::dataElements::cookie', name: 'cookie', displayName: 'Cookie', libPath: 'src/lib/dataElements/cookie.js' }],
        events: [...PACKAGE.attributes.events,
            { id: 'core::events::click', name: 'click', displayName: 'Click', libPath: 'src/lib/events/click.js' }]
    }
};
const clickEventRule = () => ({
    revision: revision('rules', 13, { name: 'Click' }, reactorId('RL', 2)),
    components: [component(29, { delegate_descriptor_id: 'core::events::click', order: 0, rule_order: 50 })]
});

describe('assembleTestBuild', () => {
    test('a library rule revision replaces production\'s entry and moves to revision id order', () => {
        const { container, report } = assemble({ rules: [editedClick(13)] });
        expect(container.rules.map(r => r.id)).toEqual([reactorId('RL', 11), reactorId('RL', 13)]);
        expect(container.rules[1].actions[0].settings.source).toBe('console.log("changed");');
        expect(report.replaced).toEqual(['rule Click']);

        // A revision id below Load's puts Click first
        expect(assemble({ rules: [editedClick(10)] }).container.rules.map(r => r.id)).toEqual([reactorId('RL', 10), reactorId('RL', 11)]);
    });

    test('renamed data element replaces the old key', () => {
        const section = (n) => ({
            revision: revision('data_elements', n, {
                name: 'Section', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'site.section' }),
                default_value: 'home', force_lower_case: true
            }, reactorId('DE', 2))
        });
        const { container, report } = assemble({ data_elements: [section(34)] });
        expect(Object.keys(container.dataElements)).toEqual(['Page Title', 'Section']);
        expect(printValue(container.dataElements.Section)).toBe(printValue(parsed.container.dataElements['Site Section']));
        expect(report.replaced).toEqual(['data element Section']);

        // A revision id below Page Title's puts Section first
        expect(Object.keys(assemble({ data_elements: [section(30)] }).container.dataElements)).toEqual(['Section', 'Page Title']);
    });

    test('a new library data element is added', () => {
        const visitor = revision('data_elements', 35, {
            name: 'Visitor', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'visitor.id' })
        }, reactorId('DE', 9));
        const { container, report } = assemble({ data_elements: [{ revision: visitor }] });
        expect(Object.keys(container.dataElements)).toEqual(['Page Title', 'Site Section', 'Visitor']);
        expect(container.dataElements.Visitor).toEqual({ modulePath: 'core/src/lib/dataElements/javascriptVariable.js', settings: { path: 'visitor.id' } });
        expect(report).toEqual({ replaced: [], added: ['data element Visitor'], dropped: [], warnings: [] });
    });

    test('a library extension replaces production\'s entry and keeps its modules', () => {
        const core = revision('extensions', 43, { name: 'core', display_name: 'Core 2' }, reactorId('EX', 1));
        const { container, report } = assemble({ extensions: [{ revision: core }] });
        expect(container.extensions.core.displayName).toBe('Core 2');
        expect(printValue(container.extensions.core.modules)).toBe(printValue(parsed.container.extensions.core.modules));
        expect(report.replaced).toEqual(['extension core']);
    });

    test('a disabled library rule drops production\'s entry', () => {
        const disabled = revision('rules', 13, { name: 'Click', enabled: false }, reactorId('RL', 2));
        const { container, report } = assemble({ rules: [{ revision: disabled, components: [] }] });
        expect(container.rules.map(r => r.id)).toEqual([reactorId('RL', 11)]);
        expect(report.dropped).toEqual(['rule Click']);
    });

    test('a disabled library item production doesn\'t have is left out', () => {
        const disabled = revision('data_elements', 35, {
            name: 'Visitor', enabled: false, delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'visitor.id' })
        }, reactorId('DE', 9));
        const { container, report } = assemble({ data_elements: [{ revision: disabled }] });
        expect(Object.keys(container.dataElements)).toEqual(['Page Title', 'Site Section']);
        expect(report).toEqual({ replaced: [], added: [], dropped: [], warnings: [NOTHING_TO_APPLY] });
    });

    test('a delegate production doesn\'t load stops', () => {
        const error = stopped(() => assemble({ rules: [clickEventRule()] }, { packages: new Map([[PACKAGE.id, NOT_LOADED]]) }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(["rule Click: core/src/lib/events/click.js isn't loaded by production"]);
    });

    test("library items whose delegates have a transform the writers can't apply stop", () => {
        // The core package with a file transform on custom code
        const toFile = (def) => (/custom-code$/.test(def.id) ? { ...def, transforms: [{ type: 'file', propertyPath: 'source' }] } : def);
        const fileTransform = {
            ...PACKAGE,
            attributes: { ...PACKAGE.attributes, data_elements: PACKAGE.attributes.data_elements.map(toFile), actions: PACKAGE.attributes.actions.map(toFile) }
        };
        const script = revision('data_elements', 35, {
            name: 'Script', delegate_descriptor_id: 'core::dataElements::custom-code', settings: json({ source: 'return 1;' })
        }, reactorId('DE', 9));

        const error = stopped(() => assemble({ rules: [editedClick(13)], data_elements: [{ revision: script }] }, { packages: new Map([[PACKAGE.id, fileTransform]]) }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual([
            "data element Script: file transform on source isn't supported",
            "rule Click: file transform on source isn't supported"
        ]);
    });

    test("library items with no origin stop: they aren't library revisions", () => {
        const withoutOrigin = (item) => {
            delete item.revision.relationships.origin;
            return item;
        };
        const visitor = withoutOrigin({
            revision: revision('data_elements', 35, {
                name: 'Visitor', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'visitor.id' })
            }, reactorId('DE', 9))
        });
        // Two of them, which have no origin to share
        const click = withoutOrigin(editedClick(13));
        const other = withoutOrigin({ ...freshClick(14), revision: revision('rules', 14, { name: 'Other' }, reactorId('RL', 3)) });

        const error = stopped(() => assemble({ rules: [click, other], data_elements: [visitor] }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual([
            "data element Visitor: has no origin, so it isn't a library revision",
            "rule Click: has no origin, so it isn't a library revision",
            "rule Other: has no origin, so it isn't a library revision"
        ]);
    });

    test('an extension on another package version stops', () => {
        const core = revision('extensions', 43, { name: 'core', display_name: 'Core' }, reactorId('EX', 1));
        core.relationships.extension_package.data.id = reactorId('EP', 2);
        const error = stopped(() => assemble({ extensions: [{ revision: core }] }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['extension core: production runs another version of this extension']);
    });

    test('every problem is collected before stopping, data elements first, then extensions, then rules', () => {
        const cookie = revision('data_elements', 35, { name: 'Cookie', delegate_descriptor_id: 'core::dataElements::cookie' }, reactorId('DE', 9));
        const alloy = revision('extensions', 44, { name: 'adobe-alloy', display_name: 'Web SDK' }, reactorId('EX', 2));
        alloy.relationships.extension_package.data.id = reactorId('EP', 3);
        const error = stopped(() => assemble(
            { rules: [clickEventRule()], data_elements: [{ revision: cookie }], extensions: [{ revision: alloy }] },
            { packages: new Map([[PACKAGE.id, NOT_LOADED]]) }
        ));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual([
            "data element Cookie: core/src/lib/dataElements/cookie.js isn't loaded by production",
            "extension adobe-alloy: production doesn't load this extension",
            "rule Click: core/src/lib/events/click.js isn't loaded by production"
        ]);
        expect(error.message).toBe(error.problems.join('\n'));
    });

    test('environment is the development one and buildDate is now', () => {
        const { container } = assemble();
        expect(container.environment).toEqual({ id: reactorId('EN', 1), stage: 'development' });
        expect(container.buildInfo.buildDate).toBe('2026-11-03T12:00:00Z');
        // The other keys, and the key order, are production's
        expect(printValue(container.buildInfo)).toBe(printValue({ ...parsed.container.buildInfo, buildDate: '2026-11-03T12:00:00Z' }));
    });

    test('custom code files use production\'s build folder', () => {
        const { container, files } = assemble({ rules: [editedClick(13)] }, { inlineMovedCode: false });
        const url = 'https://assets.adobedtm.com/0000aaaa/1111bbbb/a1b2c3d4e5f6/RC00000000000000000000000000000028-source.js';
        expect(container.rules[1].actions[0].settings).toEqual({ source: url, language: 'javascript', isExternal: true });
        expect(files).toEqual([{
            url,
            text: String.raw`_satellite.__registerScript('https://assets.adobedtm.com/0000aaaa/1111bbbb/a1b2c3d4e5f6/RC00000000000000000000000000000028-source.js', "console.log(\"changed\");");`
        }]);
    });

    test('custom code Launch would move to a file stays inline by default', () => {
        expect(INLINE_MOVED_CODE).toBe(true);
        const { container, files, report } = assemble({ rules: [editedClick(13)] });
        expect(container.rules[1].actions[0].settings).toEqual({ source: 'console.log("changed");', language: 'javascript' });
        expect(files).toEqual([]);
        expect(report.warnings).toEqual(['Click: custom code kept inline; Launch would load it from a file']);
    });

    test('warnings collect the library\'s, then the entry writers\'', () => {
        const tidy = revision('data_elements', 35, {
            name: 'Tidy', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'x' }), clean_text: true
        }, reactorId('DE', 9));
        const { report } = assemble({ data_elements: [{ revision: tidy }], warnings: ['from the library'] });
        expect(report.warnings).toEqual(['from the library', "Tidy: cleanText's place in the entry is unverified"]);
    });

    test('production\'s container is left as it was', () => {
        assemble({ rules: [editedClick(10)], data_elements: [{ revision: revision('data_elements', 30, { name: 'Gone', enabled: false }, reactorId('DE', 1)) }] });
        expect(printScript(parsed)).toBe(FIXTURE);
    });

    test('a production entry with no production revision is an error', () => {
        const revisions = { ...PRODUCTION.revisions, data_elements: PRODUCTION.revisions.data_elements.slice(1) };
        expect(() => assemble({}, { production: { ...production, revisions } })).toThrow('data element Page Title: no production revision');
    });

    test('a new rule revision that does what production\'s does isn\'t replaced, whatever its ids', () => {
        const inline = assemble({ rules: [freshClick(13)] });
        expect(inline.report).toEqual({
            replaced: [], added: [], dropped: [],
            warnings: ['Click: custom code kept inline; Launch would load it from a file', NOTHING_TO_APPLY]
        });

        // The entry loads the code from a file named by the new component revision id
        const moved = assemble({ rules: [freshClick(13)] }, { inlineMovedCode: false });
        expect(moved.container.rules[1].actions[0].settings.source).toBe(`${PRODUCTION.buildBaseUrl}${reactorId('RC', 28)}-source.js`);
        expect(moved.report).toEqual({ replaced: [], added: [], dropped: [], warnings: [NOTHING_TO_APPLY] });
    });

    test('a new rule revision with its custom code edited is replaced, whether the code is inline or moved', () => {
        expect(assemble({ rules: [editedClick(13)] }).report.replaced).toEqual(['rule Click']);
        expect(assemble({ rules: [editedClick(13)] }, { inlineMovedCode: false }).report.replaced).toEqual(['rule Click']);
    });

    test('a rule whose production components aren\'t known counts as changed', () => {
        const components = new Map([[loadRule.id, PRODUCTION.components.get(loadRule.id)]]);
        const { report } = assemble({ rules: [freshClick(13)] }, { production: { ...production, components } });
        expect(report.replaced).toEqual(['rule Click']);
    });

    test('two library revisions of one item stop', () => {
        const siteSection = (n, name) => ({
            revision: revision('data_elements', n, {
                name, delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'site.section' })
            }, reactorId('DE', 2))
        });
        const error = stopped(() => assemble({ data_elements: [siteSection(34, 'Section'), siteSection(33, 'Site Section')] }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual([
            'data element Site Section: the sync folder holds more than one revision of it (DE00000000000000000000000000000033, DE00000000000000000000000000000034); delete all but one'
        ]);
    });

    test('a library data element renamed onto a name production keeps stops', () => {
        const renamed = revision('data_elements', 34, {
            name: 'Page Title', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'site.section' })
        }, reactorId('DE', 2));
        const error = stopped(() => assemble({ data_elements: [{ revision: renamed }] }));
        expect(error).toBeInstanceOf(TestBuildStop);
        expect(error.problems).toEqual(['data element Page Title: another data element already has this name']);
    });

    test('extensions stay in revision id order', () => {
        // Production with a second extension, after core
        const container = structuredClone(parsed.container);
        container.extensions.tools = { displayName: 'Tools', hostedLibFilesBaseUrl: `https://assets.adobedtm.com/extensions/${reactorId('EP', 2)}/`, modules: {} };
        const tools = revision('extensions', 42, { name: 'tools', display_name: 'Tools' }, reactorId('EX', 2));
        const withTools = { ...production, container, revisions: { ...PRODUCTION.revisions, extensions: [...PRODUCTION.revisions.extensions, tools] } };

        // Below tools' EX…42, so core stays first only because of its revision id
        const core = revision('extensions', 40, { name: 'core', display_name: 'Core' }, reactorId('EX', 1));
        const { container: built } = assemble({ extensions: [{ revision: core }] }, { production: withTools });
        expect(Object.keys(built.extensions)).toEqual(['core', 'tools']);
    });
});

describe('with a library sync folder', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-items-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const fetchPkg = async (id) => packages.get(id);
    const T = '2026-11-03T00:00:00.000Z';

    /** Writes a library holding these revisions into the folder, as Developer Sync downloads it. */
    function download({ rules = [], data_elements = [], extensions = [], components = new Map() }) {
        const ruleOf = new Map();
        for (const [ruleId, list] of components) list.forEach(c => ruleOf.set(c.id, ruleId));
        const listing = { rules, data_elements, extensions, rule_components: [...components.values()].flat(), ruleOf, failed: [] };
        return writeDownload({ targetDir: dir, listing, fetchPkg, now: () => T });
    }
    // A library holding production's own revisions
    const downloadProduction = () => download({ ...PRODUCTION.revisions, components: PRODUCTION.components });
    const folderOf = (type, id) => path.join(dir, type, id);
    const settingsOf = (item) => JSON.parse(item.revision.attributes.settings);

    test('warns when the library changes nothing', async () => {
        await downloadProduction();
        const { container, report } = assemble(await readLibraryItems(dir, fetchPkg), { inlineMovedCode: false });
        expect(report).toEqual({ replaced: [], added: [], dropped: [], warnings: [NOTHING_TO_APPLY] });
        // Only the environment and the marker differ from production
        const { buildInfo, environment } = parsed.container;
        expect(printValue({ ...container, buildInfo, environment })).toBe(printValue(parsed.container));
    });

    test('a library rule whose folder was deleted keeps production\'s entry', async () => {
        await downloadProduction();
        fs.rmSync(folderOf('rules', clickRule.id), { recursive: true });

        const library = await readLibraryItems(dir, fetchPkg);
        expect(library.rules.map(r => r.revision.id)).toEqual([loadRule.id]);

        const { container, report } = assemble(library);
        expect(container.rules.map(r => r.id)).toEqual([reactorId('RL', 11), reactorId('RL', 12)]);
        expect(printValue(container.rules[1])).toBe(printValue(parsed.container.rules[1]));
        expect([...report.replaced, ...report.added, ...report.dropped]).toEqual([]);
    });

    test('readLibraryItems gives each type\'s revisions, and each rule its components', async () => {
        await downloadProduction();
        const library = await readLibraryItems(dir, fetchPkg);
        expect(library.rules.map(({ revision: r, components }) => [r.id, components.map(c => c.id)])).toEqual([
            [loadRule.id, [reactorId('RC', 21), reactorId('RC', 23)]],
            [clickRule.id, [reactorId('RC', 22), reactorId('RC', 24), reactorId('RC', 25)]]
        ]);
        expect(library.data_elements.map(item => item.revision.id)).toEqual([reactorId('DE', 31), reactorId('DE', 32)]);
        expect(library.extensions.map(item => item.revision.id)).toEqual([reactorId('EX', 41)]);
        expect(library.warnings).toEqual([]);
    });

    test('readLibraryItems leaves out a deleted component', async () => {
        await downloadProduction();
        fs.rmSync(folderOf('rule_components', reactorId('RC', 25)), { recursive: true });

        const { rules } = await readLibraryItems(dir, fetchPkg);
        const click = rules.find(r => r.revision.id === clickRule.id);
        expect(click.components.map(c => c.id)).toEqual([reactorId('RC', 22), reactorId('RC', 24)]);
    });

    test('readLibraryItems leaves out a component the download record has no rule for, with a warning', async () => {
        const path25 = component(25, { ...clickComponents[1].attributes, name: 'Checkout Path' });
        await download({ rules: [clickRule], components: new Map([[clickRule.id, [clickComponents[0], path25, clickComponents[2]]]]) });
        const baseFile = path.join(dir, '.reactor-sync', 'base.json');
        const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
        delete base.items[path25.id].rule_id;
        fs.writeFileSync(baseFile, JSON.stringify(base));

        const { rules, warnings } = await readLibraryItems(dir, fetchPkg);
        expect(rules[0].components.map(c => c.id)).toEqual([reactorId('RC', 22), reactorId('RC', 24)]);
        expect(warnings).toEqual([
            "rule component Checkout Path (RC00000000000000000000000000000025) left out: the download record doesn't say which rule it belongs to"
        ]);
    });

    test('readLibraryItems warns about a component whose rule revision it didn\'t read', async () => {
        const path25 = component(25, { ...clickComponents[1].attributes, name: 'Checkout Path' });
        await download({ rules: [loadRule, clickRule], components: new Map([[loadRule.id, []], [clickRule.id, [path25]]]) });
        // Taken out of the library: the rule's folder is gone, its component's isn't
        fs.rmSync(folderOf('rules', clickRule.id), { recursive: true });

        const { rules, warnings } = await readLibraryItems(dir, fetchPkg);
        expect(rules.map(r => r.revision.id)).toEqual([loadRule.id]);
        expect(warnings).toEqual([
            "rule component Checkout Path (RC00000000000000000000000000000025) left out: its rule revision RL00000000000000000000000000000012 isn't in the sync folder"
        ]);
    });

    test('readLibraryItems skips revisions set aside in _deleted', async () => {
        await downloadProduction();
        // The next download no longer lists Click, so its folders are set aside
        await download({ ...PRODUCTION.revisions, rules: [loadRule], components: new Map([[loadRule.id, PRODUCTION.components.get(loadRule.id)]]) });
        expect(fs.existsSync(path.join(dir, '_deleted', 'rules', clickRule.id))).toBe(true);

        const { rules } = await readLibraryItems(dir, fetchPkg);
        expect(rules.map(r => r.revision.id)).toEqual([loadRule.id]);
    });

    test('readLibraryItems keeps stored code that differs only by line endings', async () => {
        const lines = revision('data_elements', 36, {
            name: 'Lines', delegate_descriptor_id: 'core::dataElements::custom-code', settings: json({ source: 'var a = 1;\r\nreturn a;' })
        }, reactorId('DE', 6));
        await download({ data_elements: [lines], rules: [clickRule], components: new Map([[clickRule.id, clickComponents]]) });
        // A real edit, saved with Windows line endings
        fs.writeFileSync(path.join(folderOf('rule_components', reactorId('RC', 22)), 'settings.source.js'), 'console.log("edited");\r\nconsole.log("twice");');

        const library = await readLibraryItems(dir, fetchPkg);
        // The file reads back with LF, but says what data.json says
        expect(settingsOf(library.data_elements[0]).source).toBe('var a = 1;\r\nreturn a;');
        const action = library.rules[0].components.find(c => c.id === reactorId('RC', 22));
        expect(JSON.parse(action.attributes.settings).source).toBe('console.log("edited");\nconsole.log("twice");');
    });
});
