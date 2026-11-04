'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    syncApi, librarySyncApi, listProperty, listLibrary, writeDownload, readBase, readConfig, bindFolder
} = require('../lib/reactor-core/sync');
const runner = require('../lib/reactor-core/diff/runner');
const toFiles = require('../lib/reactor-core/to-files');

// core's custom code: a function transform for data elements, plain code for actions
const PACKAGES = {
    EPcore: {
        attributes: {
            data_elements: [{ id: 'core::dataElements::custom-code', transforms: [{ type: 'function', propertyPath: 'source', parameters: ['event'] }] }],
            actions: [{ id: 'core::actions::custom-code', transforms: [{ type: 'customCode', propertyPath: 'source' }] }],
            events: [],
            conditions: []
        }
    }
};
const fetchPkg = async (id) => PACKAGES[id];

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-02T00:00:00.000Z';
const reactorId = (prefix, n) => prefix + String(n).padStart(32, '0');
const bookkeeping = { published: false, published_at: null, dirty: false, review_status: 'unsubmitted', revision_number: 0, updated_at: T0, updated_by_email: 'someone@example.com' };
const corePackage = { updated_with_extension_package: { data: { id: 'EPcore', type: 'extension_packages' } } };

const rule = (n, attributes = {}) => ({
    id: reactorId('RL', n), type: 'rules',
    attributes: { name: `Rule ${n}`, enabled: true, ...bookkeeping, ...attributes },
    relationships: {}
});
const dataElement = (n, source, attributes = {}) => ({
    id: reactorId('DE', n), type: 'data_elements',
    attributes: {
        name: `Data Element ${n}`, enabled: true, delegate_descriptor_id: 'core::dataElements::custom-code',
        settings: JSON.stringify({ source, language: 'javascript' }), ...bookkeeping, ...attributes
    },
    relationships: corePackage
});
const component = (n, source, attributes = {}) => ({
    id: reactorId('RC', n), type: 'rule_components',
    attributes: {
        name: 'Custom Code', delegate_descriptor_id: 'core::actions::custom-code', order: 0, rule_order: 50,
        settings: JSON.stringify({ source }), ...bookkeeping, ...attributes
    },
    relationships: corePackage
});

// What listProperty returns. `components` maps a rule to its components.
function listing({ rules = [], dataElements = [], extensions = [], components = new Map(), failed = [] } = {}) {
    const ruleOf = new Map();
    for (const [ruleItem, list] of components) list.forEach(c => ruleOf.set(c.id, ruleItem.id));
    return {
        rules, data_elements: dataElements, extensions,
        rule_components: [...components.values()].flat(), ruleOf, failed
    };
}
// The diff runner's view of the same lists.
const apiFor = (l) => ({
    getRules: async () => l.rules,
    getDataElements: async () => l.data_elements,
    getExtensions: async () => l.extensions,
    getRuleComponents: async () => l.rule_components
});

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const download = (l) => writeDownload({ targetDir: dir, listing: l, fetchPkg, now: () => T1 });
const diff = (l) => runner(dir, apiFor(l), fetchPkg);
const folderOf = (item) => path.join(dir, item.type, item.id);
const editFile = (item, file, edit) => {
    const filePath = path.join(folderOf(item), file);
    fs.writeFileSync(filePath, edit(fs.readFileSync(filePath, 'utf8')));
};
const states = (result) => Object.fromEntries(Object.entries(result)
    .filter(([state, list]) => Array.isArray(list) && list.length && state !== 'errors')
    .map(([state, list]) => [state, list.map(entry => entry.id)]));

// A property with one of each kind of item, as Launch lists it.
const rule1 = rule(1);
const de1 = dataElement(1, 'return 1;\nreturn 2;');
const rc1 = component(1, 'console.log(1);');
const live = (overrides = {}) => listing({
    rules: [rule1],
    dataElements: [de1],
    components: new Map([[rule1, [rc1]]]),
    ...overrides
});

// A GET that serves one page per route, keyed by pathname, and fails on any other URL.
function fakeGet(routes) {
    return async (url) => {
        const { pathname } = new URL(url);
        const route = routes[pathname];
        if (route instanceof Error) throw route;
        if (!route) throw new Error(`unexpected ${pathname}`);
        return { data: route, meta: { pagination: { next_page: null } } };
    };
}

describe('listing a property', () => {
    const rule2 = rule(2);
    const routes = {
        '/properties/PR1/rules': [rule1, rule2],
        '/properties/PR1/data_elements': [de1],
        '/properties/PR1/extensions': [],
        [`/rules/${rule1.id}/rule_components`]: [rc1],
        [`/rules/${rule2.id}/rule_components`]: [component(2, 'x')]
    };

    test('lists components rule by rule and records each one\'s rule', async () => {
        const result = await listProperty(fakeGet(routes), 'PR1');
        expect(result.rule_components.map(c => c.id)).toEqual([rc1.id, reactorId('RC', 2)]);
        expect(result.ruleOf.get(reactorId('RC', 2))).toBe(rule2.id);
        expect(result.failed).toEqual([]);
    });

    test('a rule whose components can\'t be listed leaves the list incomplete', async () => {
        const failing = fakeGet({ ...routes, [`/rules/${rule2.id}/rule_components`]: new Error('500') });
        const result = await listProperty(failing, 'PR1');
        expect(result.failed.map(f => f.id)).toEqual([rule2.id]);
        await expect(syncApi(failing, 'PR1').getRuleComponents()).rejects.toThrow(/couldn't be listed/);
    });
});

describe('download record', () => {
    test('records each item downloaded, with each component\'s rule, and no emails', async () => {
        await download(live());
        const base = readBase(dir);
        expect(base.downloaded_at).toBe(T1);
        expect(Object.keys(base.items).sort()).toEqual([de1.id, rc1.id, rule1.id].sort());
        expect(base.items[rc1.id]).toMatchObject({ type: 'rule_components', rule_id: rule1.id, files: ['settings.source.js'] });
        expect(base.items[de1.id]).toMatchObject({ type: 'data_elements', name: 'Data Element 1', updated_at: T0 });
        expect(fs.readFileSync(path.join(dir, '.reactor-sync', 'base.json'), 'utf8')).not.toContain('@');
    });

    test('a diff right after a download finds everything in sync, components included', async () => {
        await download(live());
        const result = await diff(live());
        expect(states(result)).toEqual({ unchanged: expect.arrayContaining([rule1.id, de1.id, rc1.id]) });
        expect(result.unchanged).toHaveLength(3);
        expect(result.hasBase).toBe(true);
    });
});

// The hand-off's eight cases, each after a download.
describe('diff after a download', () => {
    beforeEach(() => download(live()));

    test('1. nothing changed → in sync', async () => {
        expect(states(await diff(live()))).toEqual({ unchanged: expect.any(Array) });
    });

    test('2. a library was published (published, published_at and dirty flip) → in sync', async () => {
        const published = { published: true, published_at: T1, dirty: true, review_status: 'approved', updated_at: T1 };
        const l = live({ rules: [rule(1, published)], dataElements: [dataElement(1, 'return 1;\nreturn 2;', published)] });
        expect(states(await diff(l))).toEqual({ unchanged: expect.any(Array) });
    });

    test('3. edited in Launch → behind (pull)', async () => {
        const l = live({ dataElements: [dataElement(1, 'return 3;', { updated_at: T1 })] });
        expect(states(await diff(l))).toMatchObject({ behind: [de1.id] });
    });

    test('4. the same code saved with CRLF line endings → in sync', async () => {
        editFile(de1, 'settings.source.js', text => text.replace(/\n/g, '\r\n'));
        expect(states(await diff(live()))).toEqual({ unchanged: expect.any(Array) });
    });

    test('5. settings.json with its keys reordered → in sync', async () => {
        editFile(de1, 'settings.json', text => {
            const { source, language } = JSON.parse(text);
            return JSON.stringify({ language, source }, null, 2);
        });
        expect(states(await diff(live()))).toEqual({ unchanged: expect.any(Array) });
    });

    test('6. edited locally and in Launch → conflict', async () => {
        editFile(de1, 'settings.source.js', text => text.replace('return 2;', 'return 22;'));
        const l = live({ dataElements: [dataElement(1, 'return 3;', { updated_at: T1 })] });
        const result = await diff(l);
        expect(states(result)).toMatchObject({ conflict: [de1.id] });
        expect(result.conflict[0].details.reason).toMatch(/locally and in Launch/);
    });

    test('7. deleted in Launch, folder still here → deletedInLaunch', async () => {
        expect(states(await diff(live({ dataElements: [] })))).toMatchObject({ deletedInLaunch: [de1.id] });
    });

    test('8. a rule component\'s code edited locally → modified (push), with its rule', async () => {
        editFile(rc1, 'settings.source.js', () => 'console.log(2);');
        const result = await diff(live());
        expect(states(result)).toMatchObject({ modified: [rc1.id] });
        expect(result.modified[0]).toMatchObject({ type: 'rule_components', rule_id: rule1.id, rule_name: 'Rule 1' });
    });

    test('a folder removed locally → deleted (push as a delete)', async () => {
        fs.rmSync(folderOf(rule1), { recursive: true });
        expect(states(await diff(live()))).toMatchObject({ deleted: [rule1.id] });
    });

    test('a type whose list fails is reported and not diffed', async () => {
        const api = { ...apiFor(live()), getRuleComponents: async () => { throw new Error('500'); } };
        const result = await runner(dir, api, fetchPkg);
        expect(result.errors).toEqual([expect.objectContaining({ type: 'rule_components' })]);
        expect(states(result)).toEqual({ unchanged: [rule1.id, de1.id] });
    });
});

describe('diff of a folder downloaded before there was a download record', () => {
    // The older download wrote the same files, with no record.
    beforeEach(async () => {
        for (const item of [rule1, rule(2), de1]) await toFiles(item, dir, fetchPkg);
    });

    test('compares each folder against its own data.json', async () => {
        editFile(de1, 'settings.source.js', text => text.replace('return 2;', 'return 22;'));
        const l = live({ dataElements: [dataElement(1, 'return 3;', { updated_at: T1 })], components: new Map() });
        const result = await diff(l);
        expect(result.hasBase).toBe(false);
        expect(states(result)).toEqual({
            unchanged: [rule1.id],
            deletedInLaunch: [reactorId('RL', 2)],
            conflict: [de1.id]
        });
    });
});

describe('downloading again', () => {
    beforeEach(() => download(live()));

    test('keeps local edits and writes what changed only in Launch', async () => {
        editFile(de1, 'settings.source.js', text => text.replace('return 2;', 'return 22;'));
        const l = live({ rules: [rule(1, { name: 'Renamed in Launch', updated_at: T1 })] });

        const summary = await download(l);

        expect(summary.keptLocal).toEqual([{ type: 'data_elements', id: de1.id, name: 'Data Element 1' }]);
        expect(fs.readFileSync(path.join(folderOf(de1), 'settings.source.js'), 'utf8')).toContain('return 22;');
        expect(states(await diff(l))).toEqual({ modified: [de1.id], unchanged: [rule1.id, rc1.id] });
    });

    test('an item edited locally and in Launch stays a conflict', async () => {
        editFile(de1, 'settings.source.js', text => text.replace('return 2;', 'return 22;'));
        const l = live({ dataElements: [dataElement(1, 'return 3;', { updated_at: T1 })] });
        await download(l);
        expect(states(await diff(l))).toMatchObject({ conflict: [de1.id] });
    });

    test('sets aside the folders of items deleted in Launch', async () => {
        const summary = await download(live({ rules: [], components: new Map() }));

        expect(summary.setAside.map(item => item.id).sort()).toEqual([rc1.id, rule1.id].sort());
        expect(fs.existsSync(folderOf(rule1))).toBe(false);
        expect(fs.existsSync(path.join(dir, '_deleted', 'rules', rule1.id, 'data.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, '_deleted', 'rule_components', rc1.id, 'data.json'))).toBe(true);
        expect(Object.keys(readBase(dir).items)).toEqual([de1.id]);
        expect(states(await diff(live({ rules: [], components: new Map() })))).toEqual({ unchanged: [de1.id] });
    });

    test('keeps the folder of a deleted item that has local edits', async () => {
        editFile(de1, 'settings.source.js', text => text.replace('return 2;', 'return 22;'));
        const l = live({ dataElements: [] });

        const summary = await download(l);

        expect(summary.keptUnlisted).toEqual([{ type: 'data_elements', id: de1.id, name: 'Data Element 1' }]);
        expect(fs.existsSync(folderOf(de1))).toBe(true);
        const result = await diff(l);
        expect(states(result)).toMatchObject({ conflict: [de1.id] });
        expect(result.conflict[0].details.reason).toMatch(/deleted in Launch/);
    });

    test('keeps a folder it has no record of', async () => {
        const mine = rule(7);
        await toFiles(mine, dir, fetchPkg);
        const summary = await download(live());
        expect(summary.keptUnlisted).toEqual([{ type: 'rules', id: mine.id, name: 'Rule 7' }]);
        expect(states(await diff(live()))).toMatchObject({ added: [mine.id] });
    });

    test('sets aside nothing for a type whose list is incomplete', async () => {
        const incomplete = live({ rules: [rule1], components: new Map(), failed: [{ id: rule1.id }] });
        const summary = await download(incomplete);
        expect(summary.incomplete).toEqual(['rule_components']);
        expect(fs.existsSync(folderOf(rc1))).toBe(true);
        expect(readBase(dir).items[rc1.id]).toBeDefined();
    });

    test('restores a folder removed locally', async () => {
        fs.rmSync(folderOf(rule1), { recursive: true });
        await download(live());
        expect(fs.existsSync(path.join(folderOf(rule1), 'data.json'))).toBe(true);
    });
});

describe('first download into a folder from before there was a download record', () => {
    test('sets aside leftovers and keeps local edits, judged against each data.json', async () => {
        const leftover = rule(2);
        for (const item of [rule1, leftover, de1]) await toFiles(item, dir, fetchPkg);
        editFile(de1, 'settings.source.js', text => text.replace('return 2;', 'return 22;'));

        const summary = await download(live());

        expect(summary.setAside.map(item => item.id)).toEqual([leftover.id]);
        expect(summary.keptLocal.map(item => item.id)).toEqual([de1.id]);
        expect(states(await diff(live()))).toEqual({ modified: [de1.id], unchanged: [rule1.id, rc1.id] });
    });
});

// A library holds revisions: copies of items with ids of their own, not the head items.
describe('library sync', () => {
    const ruleRev1 = rule(11, { revision_number: 3 });
    const ruleRev2 = rule(12, { revision_number: 1 });
    const deRev = dataElement(11, 'return 1;', { revision_number: 2 });
    const rcRev1 = component(11, 'console.log(1);', { revision_number: 4 });
    const rcRev2 = component(12, 'console.log(2);');
    const routes = {
        '/libraries/LB1/rules': [ruleRev1, ruleRev2],
        '/libraries/LB1/data_elements': [deRev],
        '/libraries/LB1/extensions': [],
        [`/rules/${ruleRev1.id}/rule_components`]: [rcRev1],
        [`/rules/${ruleRev2.id}/rule_components`]: [rcRev2]
    };
    const get = fakeGet(routes);
    const everyRevision = [ruleRev1, ruleRev2, deRev, rcRev1, rcRev2];

    test('listLibrary lists the library\'s revisions and each rule revision\'s components', async () => {
        const result = await listLibrary(get, 'LB1');
        expect(result.rules.map(r => r.id)).toEqual([ruleRev1.id, ruleRev2.id]);
        expect(result.data_elements.map(d => d.id)).toEqual([deRev.id]);
        expect(result.extensions).toEqual([]);
        expect(result.rule_components.map(c => c.id)).toEqual([rcRev1.id, rcRev2.id]);
        expect(result.ruleOf.get(rcRev1.id)).toBe(ruleRev1.id);
        expect(result.ruleOf.get(rcRev2.id)).toBe(ruleRev2.id);
        expect(result.failed).toEqual([]);
    });

    test('a rule revision whose components can\'t be listed leaves the list incomplete', async () => {
        const failing = fakeGet({ ...routes, [`/rules/${ruleRev2.id}/rule_components`]: new Error('500') });
        const result = await listLibrary(failing, 'LB1');
        expect(result.failed.map(f => f.id)).toEqual([ruleRev2.id]);
        await expect(librarySyncApi(failing, 'LB1').getRuleComponents()).rejects.toThrow(/couldn't be listed/);
    });

    test('writeDownload of a library listing writes folders by revision id, and the diff compares against the library', async () => {
        await download(await listLibrary(get, 'LB1'));

        for (const item of everyRevision) expect(fs.existsSync(path.join(folderOf(item), 'data.json'))).toBe(true);
        expect(readBase(dir).items[rcRev1.id]).toMatchObject({ type: 'rule_components', rule_id: ruleRev1.id });

        const result = await runner(dir, librarySyncApi(get, 'LB1'), fetchPkg);
        expect(states(result)).toEqual({ unchanged: expect.arrayContaining(everyRevision.map(item => item.id)) });
        expect(result.unchanged).toHaveLength(everyRevision.length);
    });

    test('a revision removed from the library is set aside on the next download', async () => {
        await download(await listLibrary(get, 'LB1'));
        const smaller = fakeGet({ ...routes, '/libraries/LB1/rules': [ruleRev1] });

        const summary = await download(await listLibrary(smaller, 'LB1'));

        expect(summary.setAside.map(item => item.id).sort()).toEqual([rcRev2.id, ruleRev2.id].sort());
        expect(fs.existsSync(folderOf(ruleRev2))).toBe(false);
        expect(fs.existsSync(path.join(dir, '_deleted', 'rules', ruleRev2.id, 'data.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, '_deleted', 'rule_components', rcRev2.id, 'data.json'))).toBe(true);
        const result = await runner(dir, librarySyncApi(smaller, 'LB1'), fetchPkg);
        expect(states(result)).toEqual({ unchanged: [ruleRev1.id, deRev.id, rcRev1.id] });
    });

    describe('the folder\'s config', () => {
        const property = { propertyId: 'PR1', propertyName: 'Property One', orgId: 'ORG1@AdobeOrg' };
        const forLibrary = (id, name) => ({ ...property, libraryId: id, libraryName: name });
        const configFile = () => path.join(dir, '.reactor-settings.json');
        const holdsLibrary = (name) => new Error(`This folder holds library "${name}". Sync another library into its own folder.`);

        test('readConfig is null for a folder with no config', () => {
            expect(readConfig(dir)).toBeNull();
        });

        test("readConfig names a config that isn't valid JSON", () => {
            fs.writeFileSync(configFile(), '{ "propertyId": "PR1", ');
            expect(() => readConfig(dir)).toThrow(`${configFile()} isn't valid JSON: `);
            // So does everything that reads it first
            expect(() => bindFolder(dir, property)).toThrow(`${configFile()} isn't valid JSON: `);
        });

        test('bindFolder writes the config, which readConfig reads back', () => {
            const config = forLibrary('LB1', 'Release 1');
            bindFolder(dir, config);
            expect(readConfig(dir)).toEqual(config);
            expect(fs.readFileSync(configFile(), 'utf8')).toBe(JSON.stringify(config, null, 2));
        });

        test('bindFolder lets the same library sync into its folder again, with its current name', async () => {
            bindFolder(dir, forLibrary('LB1', 'Release 1'));
            await download(await listLibrary(get, 'LB1'));
            bindFolder(dir, forLibrary('LB1', 'Release 1 (renamed)'));
            expect(readConfig(dir).libraryName).toBe('Release 1 (renamed)');
        });

        test('bindFolder lets a library sync into a folder that was only initialized', () => {
            bindFolder(dir, property);
            bindFolder(dir, forLibrary('LB1', 'Release 1'));
            expect(readConfig(dir)).toEqual(forLibrary('LB1', 'Release 1'));
        });

        test('bindFolder refuses a folder bound to another library', () => {
            bindFolder(dir, forLibrary('LB1', 'Release 1'));
            expect(() => bindFolder(dir, forLibrary('LB2', 'Release 2'))).toThrow(holdsLibrary('Release 1'));
            expect(readConfig(dir)).toEqual(forLibrary('LB1', 'Release 1'));
        });

        test('bindFolder refuses a whole-property download into a library folder', () => {
            bindFolder(dir, forLibrary('LB1', 'Release 1'));
            expect(() => bindFolder(dir, property)).toThrow(holdsLibrary('Release 1'));
            expect(readConfig(dir)).toEqual(forLibrary('LB1', 'Release 1'));
        });

        test('bindFolder refuses a whole-property folder', async () => {
            bindFolder(dir, property);
            await download(live());
            expect(() => bindFolder(dir, forLibrary('LB1', 'Release 1'))).toThrow(new Error('This folder holds the whole property'));
            expect(readConfig(dir)).toEqual(property);
        });
    });
});