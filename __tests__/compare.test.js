'use strict';

const compare = require('../lib/reactor-core/diff/compare');
const { fingerprint } = require('../lib/reactor-core/diff/normalize');

function rule(attributes = {}) {
    return {
        id: 'RL00000000000000000000000000000001',
        type: 'rules',
        attributes: { name: 'Rule', enabled: true, published: false, updated_at: '2026-11-01T00:00:00.000Z', ...attributes }
    };
}

// The base is what the download recorded: the item's fingerprint then.
const downloaded = rule();
const base = { hash: fingerprint(downloaded) };

describe('compare – against the download record', () => {
    test('nothing changed → unchanged', () => {
        expect(compare(rule(), rule(), base).result).toBe('unchanged');
    });

    test('only bookkeeping changed in Launch (a library publish) → unchanged', () => {
        const remote = rule({ published: true, updated_at: '2026-11-02T00:00:00.000Z' });
        expect(compare(rule(), remote, base).result).toBe('unchanged');
    });

    test('changed locally only → modified (push)', () => {
        const result = compare(rule({ name: 'Renamed' }), rule(), base);
        expect(result.result).toBe('modified');
        expect(result.details.attributes.name).toEqual({ local: 'Renamed', remote: 'Rule' });
    });

    test('changed in Launch only → behind (pull)', () => {
        const remote = rule({ enabled: false, updated_at: '2026-11-02T00:00:00.000Z' });
        expect(compare(rule(), remote, base).result).toBe('behind');
    });

    test('changed locally and in Launch → conflict, whatever the dates say', () => {
        const local = rule({ name: 'Mine' });
        const remote = rule({ name: 'Theirs', updated_at: '2026-11-02T00:00:00.000Z' });
        const result = compare(local, remote, base);
        expect(result.result).toBe('conflict');
        expect(result.details.reason).toMatch(/locally and in Launch/);
    });

    test('the same change made on both sides → unchanged', () => {
        expect(compare(rule({ name: 'Same' }), rule({ name: 'Same' }), base).result).toBe('unchanged');
    });

    test('gone from Launch, unchanged locally → deletedInLaunch', () => {
        expect(compare(rule(), null, base).result).toBe('deletedInLaunch');
    });

    test('gone from Launch, changed locally → conflict', () => {
        const result = compare(rule({ name: 'Mine' }), null, base);
        expect(result.result).toBe('conflict');
        expect(result.details.reason).toMatch(/deleted in Launch/);
    });

    test('removed locally, unchanged in Launch → deleted (push as a delete)', () => {
        expect(compare(null, rule(), base).result).toBe('deleted');
    });

    test('removed locally, changed in Launch → conflict', () => {
        const result = compare(null, rule({ name: 'Theirs' }), base);
        expect(result.result).toBe('conflict');
        expect(result.details.reason).toMatch(/deleted locally/);
    });
});

describe('compare – with no download record', () => {
    test('local only → added (new locally)', () => {
        expect(compare(rule(), null, null).result).toBe('added');
    });

    test('remote only → behind (new in Launch)', () => {
        expect(compare(null, rule(), null).result).toBe('behind');
    });

    test('both sides the same → unchanged', () => {
        expect(compare(rule(), rule({ published: true }), null).result).toBe('unchanged');
    });

    test('both sides differ → conflict, since which side changed is unknown', () => {
        const result = compare(rule({ name: 'A' }), rule({ name: 'B' }), null);
        expect(result.result).toBe('conflict');
        expect(result.details.reason).toMatch(/no download record/);
    });
});
