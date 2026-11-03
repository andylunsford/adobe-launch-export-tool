'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const toFiles = require('../lib/reactor-core/to-files');
const fromFile = require('../lib/reactor-core/from-file');

// Transforms as extension packages declare them: core's custom code, and
// adobe-alloy's callbacks under an array path, one per SDK instance.
const PACKAGES = {
    EPcore: {
        attributes: {
            data_elements: [{ id: 'core::dataElements::custom-code', transforms: [{ type: 'function', propertyPath: 'source', parameters: ['event'] }] }],
            actions: [{ id: 'core::actions::custom-code', transforms: [{ type: 'customCode', propertyPath: 'source' }] }],
            events: [],
            conditions: []
        }
    },
    EPalloy: {
        attributes: {
            configuration: {
                transforms: [
                    { type: 'function', propertyPath: 'instances[].onBeforeEventSend', parameters: ['content'] },
                    { type: 'function', propertyPath: 'instances[].onBeforeLinkClickSend', parameters: ['content'] }
                ]
            }
        }
    }
};
const fetchPkg = async (id) => PACKAGES[id];

function dataElement(descriptor, settings) {
    return {
        id: 'DE00000000000000000000000000000001',
        type: 'data_elements',
        attributes: { name: 'Page Name', delegate_descriptor_id: descriptor, settings: JSON.stringify(settings) },
        relationships: { updated_with_extension_package: { data: { id: 'EPcore', type: 'extension_packages' } } }
    };
}

function alloy(instances) {
    return {
        id: 'EX00000000000000000000000000000001',
        type: 'extensions',
        attributes: { name: 'adobe-alloy', settings: JSON.stringify({ instances }) },
        relationships: { extension_package: { data: { id: 'EPalloy', type: 'extension_packages' } } }
    };
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-files-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const folderOf = (item) => path.join(dir, item.type, item.id);
const settingsOf = async (item) => JSON.parse((await fromFile(folderOf(item), fetchPkg)).attributes.settings);

describe('array-path transforms (Web SDK callbacks)', () => {
    const instances = [
        { name: 'alloy', edgeConfigId: 'a', onBeforeEventSend: 'content.xdm.a = 1;\nreturn true;' },
        { name: 'alloy2', edgeConfigId: 'b' }
    ];

    test('writes each instance\'s callback to its own file', async () => {
        const { files } = await toFiles(alloy(instances), dir, fetchPkg);
        expect(files).toEqual(['settings.instances.0.onBeforeEventSend.js']);
        const code = fs.readFileSync(path.join(folderOf(alloy(instances)), files[0]), 'utf8');
        expect(code).toContain('function (content) {');
        expect(code).toContain('content.xdm.a = 1;\nreturn true;');
    });

    test('reads an edited callback back into the right instance', async () => {
        await toFiles(alloy(instances), dir, fetchPkg);
        const file = path.join(folderOf(alloy(instances)), 'settings.instances.0.onBeforeEventSend.js');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a = 1', 'a = 2'));

        const settings = await settingsOf(alloy(instances));
        expect(settings.instances[0].onBeforeEventSend).toBe('content.xdm.a = 2;\nreturn true;');
        expect(settings.instances[1]).toEqual(instances[1]);
    });

    test('ignores a file for an instance the settings don\'t have', async () => {
        await toFiles(alloy(instances), dir, fetchPkg);
        fs.writeFileSync(path.join(folderOf(alloy(instances)), 'settings.instances.5.onBeforeEventSend.js'), 'x');
        expect((await settingsOf(alloy(instances))).instances).toEqual(instances);
    });
});

describe('reading code files', () => {
    const code = 'var a = 1;\nreturn a;';

    test('an unedited item rebuilds exactly as downloaded', async () => {
        const item = dataElement('core::dataElements::custom-code', { source: code });
        await toFiles(item, dir, fetchPkg);
        expect((await fromFile(folderOf(item), fetchPkg)).attributes.settings).toBe(item.attributes.settings);
    });

    test('a function file saved with CRLF line endings reads as the same code', async () => {
        const item = dataElement('core::dataElements::custom-code', { source: code });
        await toFiles(item, dir, fetchPkg);
        const file = path.join(folderOf(item), 'settings.source.js');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
        expect((await settingsOf(item)).source).toBe(code);
    });
});

describe('rewriting an item', () => {
    test('removes code files the item no longer has, and keeps other files', async () => {
        const before = dataElement('core::dataElements::custom-code', { source: 'return 1;' });
        await toFiles(before, dir, fetchPkg);
        fs.writeFileSync(path.join(folderOf(before), 'notes.md'), 'mine');

        const after = dataElement('core::dataElements::javascript-variable', { path: 'digitalData.page' });
        const { files, removed } = await toFiles(after, dir, fetchPkg);

        expect(files).toEqual([]);
        expect(removed).toEqual(['settings.source.js']);
        expect(fs.readdirSync(folderOf(after)).sort()).toEqual(['data.json', 'notes.md', 'settings.json']);
    });

    test('removes settings.json when the item has no settings', async () => {
        const item = dataElement('core::dataElements::custom-code', { source: 'return 1;' });
        await toFiles(item, dir, fetchPkg);
        await toFiles({ ...item, attributes: { ...item.attributes, settings: null } }, dir, fetchPkg);
        expect(fs.readdirSync(folderOf(item))).toEqual(['data.json']);
    });

    test('makes no name links; those are rebuilt for the whole list', async () => {
        await toFiles(dataElement('core::dataElements::custom-code', { source: 'return 1;' }), dir, fetchPkg);
        expect(fs.readdirSync(path.join(dir, 'data_elements'))).toEqual(['DE00000000000000000000000000000001']);
    });
});
