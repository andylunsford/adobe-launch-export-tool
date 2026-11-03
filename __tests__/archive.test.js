'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { archiveItem, listArchiveWork, markDeletions } = require('../lib/reactor-core/archive');

// The cases follow the History Archive drift check (reverse-engineer-launch
// handoff/history-archive-drift) with made-up names and ids: heads written in
// March and never refreshed, folders duplicated by renames, deleted rules and a
// hard-deleted library.

const reactorId = (prefix, n) => prefix + n.toString(16).padStart(32, '0');
const PR = reactorId('PR', 1);
const RL1 = reactorId('RL', 1);
const RL2 = reactorId('RL', 2);
const DE1 = reactorId('DE', 1);
const EX1 = reactorId('EX', 1);
const RC1 = reactorId('RC', 1);
const RC2 = reactorId('RC', 2);
const LB1 = reactorId('LB', 1);

const MARCH = new Date('2026-03-18T12:00:00Z');
const NOVEMBER = new Date('2026-11-03T12:00:00Z');

// A head (revision 0, carrying the item's own id) as `GET /{type}/{id}` and the
// revisions list return it.
function head(type, id, latest, attributes = {}) {
    return {
        id,
        type,
        attributes: { name: 'email_type', revision_number: 0, enabled: true, published: false, deleted_at: null, ...attributes },
        relationships: { origin: { data: { id, type } } },
        meta: { latest_revision_number: latest }
    };
}

// Revision n of an item: its own id, its head's id under `origin`.
function revision(type, origin, n, attributes = {}) {
    return {
        id: `${origin}r${n}`,
        type,
        attributes: { name: 'email_type', revision_number: n, enabled: true, published: false, ...attributes },
        relationships: { origin: { data: { id: origin, type } } },
        meta: { latest_revision_number: n }
    };
}

// A stand-in for the Reactor API: list endpoints and records by path, a 500 for
// paths in `failing`, and a 404 for anything else, as for a hard-deleted library.
function fakeReactor({ lists = {}, records = {}, failing = [] } = {}) {
    const fail = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
    const get = jest.fn(async (url) => {
        const { pathname } = new URL(url);
        if (failing.includes(pathname)) throw fail(500);
        if (lists[pathname]) return { data: lists[pathname], meta: { pagination: { next_page: null } } };
        if (records[pathname]) return { data: records[pathname] };
        throw fail(404);
    });
    get.paths = () => get.mock.calls.map(([url]) => new URL(url).pathname);
    return get;
}

let root;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
});

// A folder as an earlier run left it, its files dated `when`.
function archived(type, folder, files, when = MARCH) {
    const dir = path.join(root, type, folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, record] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(record, null, 2));
        fs.utimesSync(path.join(dir, name), when, when);
    }
}

const read = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));
const folders = (type) => fs.readdirSync(path.join(root, type)).sort();
const filesIn = (...parts) => fs.readdirSync(path.join(root, ...parts)).sort();

function allFiles(dir = root) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

// ─── fix A: heads and revisions ───────────────────────────────────────────────

describe('archiveItem: heads and revisions', () => {
    test('an existing folder with an outdated head gets the live head and the new revision', async () => {
        const folder = `emailtype_${DE1}`;
        archived('data_elements', folder, {
            [`rev_${DE1}.json`]: head('data_elements', DE1, 1),
            [`rev_${DE1}r1.json`]: revision('data_elements', DE1, 1)
        });
        const live = head('data_elements', DE1, 2, { settings: '{"source":"two"}', updated_at: '2026-07-29T18:14:14.075Z' });
        const get = fakeReactor({ lists: {
            [`/data_elements/${DE1}/revisions`]: [live, revision('data_elements', DE1, 1), revision('data_elements', DE1, 2)]
        } });

        await archiveItem({ type: 'data_elements', item: live, folderName: 'emailtype', targetDir: root, get });

        expect(read('data_elements', folder, `rev_${DE1}.json`)).toEqual(live);
        expect(read('data_elements', folder, `rev_${DE1}r2.json`).attributes.revision_number).toBe(2);
    });

    test('a revision whose published flag changed is rewritten, and an unchanged head keeps its date', async () => {
        const folder = `emailtype_${DE1}`;
        archived('data_elements', folder, {
            [`rev_${DE1}.json`]: head('data_elements', DE1, 1),
            [`rev_${DE1}r1.json`]: revision('data_elements', DE1, 1, { published: false })
        });
        const get = fakeReactor({ lists: {
            [`/data_elements/${DE1}/revisions`]: [head('data_elements', DE1, 1), revision('data_elements', DE1, 1, { published: true })]
        } });

        await archiveItem({ type: 'data_elements', item: head('data_elements', DE1, 1), folderName: 'emailtype', targetDir: root, get });

        expect(read('data_elements', folder, `rev_${DE1}r1.json`).attributes.published).toBe(true);
        expect(fs.statSync(path.join(root, 'data_elements', folder, `rev_${DE1}.json`)).mtime).toEqual(MARCH);
    });

    test('a second run with nothing changed in Launch rewrites nothing', async () => {
        const extension = head('extensions', EX1, 1, { name: 'core', display_name: 'Core' });
        const library = { id: LB1, type: 'libraries', attributes: { name: 'Release 1', state: 'published' } };
        const get = fakeReactor({
            lists: { [`/extensions/${EX1}/revisions`]: [extension, revision('extensions', EX1, 1)] },
            records: { [`/extensions/${EX1}/extension_package`]: { id: reactorId('EP', 1), type: 'extension_packages', attributes: { version: '3.4.2' } } }
        });
        const run = async () => {
            await archiveItem({ type: 'extensions', item: extension, folderName: 'Core', targetDir: root, get });
            await archiveItem({ type: 'libraries', item: library, folderName: 'Release 1', targetDir: root, get });
        };

        await run();
        const written = allFiles();
        written.forEach(file => fs.utimesSync(file, MARCH, MARCH));
        await run();

        expect(written).toHaveLength(4); // head, revision 1, package, library
        expect(written.map(file => fs.statSync(file).mtime)).toEqual(written.map(() => MARCH));
    });
});

// ─── fix B: one folder per item ───────────────────────────────────────────────

describe('archiveItem: folders', () => {
    const renamed = (latest) => head('data_elements', DE1, latest, { name: 'ACDL : br_language' });
    const revisionsUpTo = (n) => Array.from({ length: n }, (_, i) => revision('data_elements', DE1, i + 1));

    test('a renamed item moves its folder instead of starting a second one', async () => {
        archived('data_elements', `brlanguage_${DE1}`, {
            [`rev_${DE1}.json`]: head('data_elements', DE1, 2, { name: 'br_language' }),
            [`rev_${DE1}r1.json`]: revision('data_elements', DE1, 1),
            [`rev_${DE1}r2.json`]: revision('data_elements', DE1, 2)
        });
        const get = fakeReactor({ lists: { [`/data_elements/${DE1}/revisions`]: [renamed(3), ...revisionsUpTo(3)] } });

        await archiveItem({ type: 'data_elements', item: renamed(3), folderName: 'ACDL  brlanguage', targetDir: root, get });

        expect(folders('data_elements')).toEqual([`ACDL  brlanguage_${DE1}`]);
        expect(filesIn('data_elements', `ACDL  brlanguage_${DE1}`))
            .toEqual([`rev_${DE1}.json`, `rev_${DE1}r1.json`, `rev_${DE1}r2.json`, `rev_${DE1}r3.json`]);
    });

    test('folders an earlier rename duplicated become one, and the older is set aside, not deleted', async () => {
        archived('data_elements', `brlanguage_${DE1}`, {
            [`rev_${DE1}.json`]: head('data_elements', DE1, 2, { name: 'br_language' }),
            [`rev_${DE1}r1.json`]: revision('data_elements', DE1, 1)
        }, MARCH);
        archived('data_elements', `ACDL  brlanguage_${DE1}`, { [`rev_${DE1}.json`]: renamed(3) }, NOVEMBER);
        const get = fakeReactor({ lists: { [`/data_elements/${DE1}/revisions`]: [renamed(3), ...revisionsUpTo(3)] } });

        await archiveItem({ type: 'data_elements', item: renamed(3), folderName: 'ACDL  brlanguage', targetDir: root, get });

        expect(folders('data_elements')).toEqual([`ACDL  brlanguage_${DE1}`]);
        expect(filesIn('_superseded', 'data_elements', `brlanguage_${DE1}`)).toEqual([`rev_${DE1}.json`, `rev_${DE1}r1.json`]);
    });

    test('when no folder has the current name, the newest one is kept and renamed', async () => {
        archived('data_elements', `brlanguage_${DE1}`, { [`rev_${DE1}.json`]: head('data_elements', DE1, 2, { name: 'br_language' }) }, MARCH);
        archived('data_elements', `ACDL  brlanguage_${DE1}`, { [`rev_${DE1}.json`]: renamed(3) }, NOVEMBER);
        const current = head('data_elements', DE1, 4, { name: 'Consent : br_language' });
        const get = fakeReactor({ lists: { [`/data_elements/${DE1}/revisions`]: [current, ...revisionsUpTo(4)] } });

        await archiveItem({ type: 'data_elements', item: current, folderName: 'Consent  brlanguage', targetDir: root, get });

        expect(folders('data_elements')).toEqual([`Consent  brlanguage_${DE1}`]);
        expect(folders(path.join('_superseded', 'data_elements'))).toEqual([`brlanguage_${DE1}`]);
    });
});

// ─── fix C: deletions ─────────────────────────────────────────────────────────

describe('listArchiveWork: complete listings', () => {
    test('a type whose list call fails is not offered for the deletion check', async () => {
        const get = fakeReactor({
            lists: { [`/properties/${PR}/data_elements`]: [head('data_elements', DE1, 1)] },
            failing: [`/properties/${PR}/rules`]
        });

        const { workQueue, liveIds } = await listArchiveWork({ propertyId: PR, types: ['rules', 'data_elements'], get });

        expect(workQueue.map(job => job.item.id)).toEqual([DE1]);
        expect(Object.keys(liveIds)).toEqual(['data_elements']);
        expect([...liveIds.data_elements]).toEqual([DE1]);
    });

    test('rule components count as listed only when every rule\'s components were listed', async () => {
        const rules = [head('rules', RL1, 1), head('rules', RL2, 1)];
        const lists = {
            [`/properties/${PR}/rules`]: rules,
            [`/rules/${RL1}/rule_components`]: [head('rule_components', RC1, 1)],
            [`/rules/${RL2}/rule_components`]: [head('rule_components', RC2, 1)]
        };

        const complete = await listArchiveWork({ propertyId: PR, types: ['rules', 'rule_components'], get: fakeReactor({ lists }) });
        const partial = await listArchiveWork({
            propertyId: PR, types: ['rules', 'rule_components'],
            get: fakeReactor({ lists, failing: [`/rules/${RL2}/rule_components`] })
        });

        expect([...complete.liveIds.rule_components]).toEqual([RC1, RC2]);
        expect(partial.workQueue.filter(job => job.type === 'rule_components').map(job => job.item.id)).toEqual([RC1]);
        expect(Object.keys(partial.liveIds)).toEqual(['rules']);
    });
});

describe('markDeletions', () => {
    const now = () => '2026-11-03T00:00:00.000Z';

    test('an item missing from a complete listing is marked deleted and its head refreshed', async () => {
        archived('rules', `Full Funnel Campaign_${RL1}`, { [`rev_${RL1}.json`]: head('rules', RL1, 3) });
        archived('rules', `Page Load_${RL2}`, { [`rev_${RL2}.json`]: head('rules', RL2, 1) });
        archived('rules', 'notes', { 'todo.json': {} });
        const deleted = head('rules', RL1, 3, { deleted_at: '2026-07-15T14:02:11.000Z' });
        const get = fakeReactor({ records: { [`/rules/${RL1}`]: deleted } });

        const result = await markDeletions({ targetDir: root, type: 'rules', liveIds: new Set([RL2]), get, now });

        expect(result.marked).toEqual([RL1]);
        expect(read('rules', `Full Funnel Campaign_${RL1}`, '_deleted.json'))
            .toEqual({ deleted_at: '2026-07-15T14:02:11.000Z', detected_at: '2026-11-03T00:00:00.000Z' });
        expect(read('rules', `Full Funnel Campaign_${RL1}`, `rev_${RL1}.json`)).toEqual(deleted);
        expect(exists('rules', `Page Load_${RL2}`, '_deleted.json')).toBe(false);
        expect(get.paths()).toEqual([`/rules/${RL1}`]);
    });

    test('a library that returns 404 is marked with the status', async () => {
        archived('libraries', `SVRS-1_${LB1}`, { [`libraries_${LB1}.json`]: { id: LB1, type: 'libraries', attributes: { name: 'SVRS-1' } } });

        await markDeletions({ targetDir: root, type: 'libraries', liveIds: new Set(), get: fakeReactor(), now });

        expect(read('libraries', `SVRS-1_${LB1}`, '_deleted.json')).toEqual({ status: 404, detected_at: '2026-11-03T00:00:00.000Z' });
    });

    test('a component of a deleted rule is marked with the rule\'s deletion', async () => {
        archived('rule_components', `cac-form-start_${RC1}`, { [`rule_components_${RC1}.json`]: head('rule_components', RC1, 3) });
        const get = fakeReactor({
            records: { [`/rule_components/${RC1}`]: head('rule_components', RC1, 3) },
            lists: { [`/rule_components/${RC1}/rules`]: [head('rules', RL1, 3, { deleted_at: '2026-07-15T14:02:11.000Z' })] }
        });

        await markDeletions({ targetDir: root, type: 'rule_components', liveIds: new Set(), get, now });

        expect(read('rule_components', `cac-form-start_${RC1}`, '_deleted.json')).toEqual({
            deleted_at: '2026-07-15T14:02:11.000Z', rule_id: RL1, detected_at: '2026-11-03T00:00:00.000Z'
        });
    });

    test('an item Launch still returns as live is not marked', async () => {
        archived('data_elements', `emailtype_${DE1}`, { [`rev_${DE1}.json`]: head('data_elements', DE1, 1) });
        const get = fakeReactor({ records: { [`/data_elements/${DE1}`]: head('data_elements', DE1, 2) } });

        const result = await markDeletions({ targetDir: root, type: 'data_elements', liveIds: new Set(), get, now });

        expect(result.marked).toEqual([]);
        expect(exists('data_elements', `emailtype_${DE1}`, '_deleted.json')).toBe(false);
    });

    test('an item an earlier run marked is not looked up again', async () => {
        archived('libraries', `SVRS-1_${LB1}`, { '_deleted.json': { status: 404, detected_at: '2026-11-03T00:00:00.000Z' } });
        const get = fakeReactor();

        await markDeletions({ targetDir: root, type: 'libraries', liveIds: new Set(), get, now });

        expect(get).not.toHaveBeenCalled();
    });

    test('a lookup that fails leaves the item unmarked', async () => {
        archived('rules', `Page Load_${RL1}`, { [`rev_${RL1}.json`]: head('rules', RL1, 1) });
        const get = fakeReactor({ failing: [`/rules/${RL1}`] });

        const result = await markDeletions({ targetDir: root, type: 'rules', liveIds: new Set(), get, now });

        expect(result).toEqual({ marked: [], failed: [RL1] });
        expect(exists('rules', `Page Load_${RL1}`, '_deleted.json')).toBe(false);
    });

    test('a rate limit stops the check', async () => {
        archived('rules', `Page Load_${RL1}`, { [`rev_${RL1}.json`]: head('rules', RL1, 1) });
        const get = jest.fn(async () => { throw new Error('RATE_LIMIT_EXHAUSTED'); });

        await expect(markDeletions({ targetDir: root, type: 'rules', liveIds: new Set(), get, now }))
            .rejects.toThrow('RATE_LIMIT_EXHAUSTED');
        expect(exists('rules', `Page Load_${RL1}`, '_deleted.json')).toBe(false);
    });
});
