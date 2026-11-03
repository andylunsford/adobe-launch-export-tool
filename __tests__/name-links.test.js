'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { rebuildNameLinks } = require('../lib/reactor-core/name-links');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'name-links-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Windows needs Developer Mode or admin for symlinks; without them the app
// makes no links, so there is nothing to test.
const canSymlink = (() => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-probe-'));
    try {
        fs.mkdirSync(path.join(probe, 'target'));
        fs.symlinkSync('target', path.join(probe, 'link'), 'dir');
        return true;
    } catch (e) {
        return false;
    } finally {
        fs.rmSync(probe, { recursive: true, force: true });
    }
})();

const item = (id, name) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    return { id, attributes: { name } };
};
const links = () => Object.fromEntries(fs.readdirSync(dir)
    .filter(entry => fs.lstatSync(path.join(dir, entry)).isSymbolicLink())
    .map(entry => [entry, fs.readlinkSync(path.join(dir, entry))]));

(canSymlink ? describe : describe.skip)('rebuildNameLinks', () => {
    test('links each item by its name', () => {
        rebuildNameLinks(dir, [item('RL1', 'Page View'), item('RL2', 'Form: Submit!')]);
        expect(links()).toEqual({ '_Page View': 'RL1', '_Form Submit': 'RL2' });
    });

    test('adds the id to names that collide, ignoring case as Windows does', () => {
        rebuildNameLinks(dir, [
            item('RC1', 'Custom Code'), item('RC2', 'Custom Code'),
            item('DE1', 'Page'), item('DE2', 'page'),
            item('DE3', 'Unique')
        ]);
        expect(links()).toEqual({
            '_Custom Code_RC1': 'RC1', '_Custom Code_RC2': 'RC2',
            '_Page_DE1': 'DE1', '_page_DE2': 'DE2',
            '_Unique': 'DE3'
        });
    });

    test('removes links for old names and missing folders, and keeps anything that isn\'t a link', () => {
        const renamed = item('RL1', 'New Name');
        fs.symlinkSync('RL1', path.join(dir, '_Old Name'), 'dir');
        fs.symlinkSync('RL9', path.join(dir, '_Deleted Rule'), 'dir');
        fs.mkdirSync(path.join(dir, '_notes'));

        rebuildNameLinks(dir, [renamed]);

        expect(links()).toEqual({ '_New Name': 'RL1' });
        expect(fs.readdirSync(dir).sort()).toEqual(['RL1', '_New Name', '_notes']);
    });

    test('makes no link for a name with no usable characters', () => {
        rebuildNameLinks(dir, [item('RL1', '!!!')]);
        expect(links()).toEqual({});
    });
});
