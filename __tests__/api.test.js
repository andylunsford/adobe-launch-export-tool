'use strict';

const { listAll, latestSucceededBuild, latestSucceededBuilds } = require('../lib/reactor-core/api');

// A stand-in for a Reactor list endpoint that behaves as observed: page[size] is
// silently clamped to 100, meta.pagination.next_page is null on the last page,
// and filter[status] / sort are applied only when `honoursFilters` is set (the
// API ignores filters it does not understand rather than rejecting them).
function fakeReactor(rows, { honoursFilters = true } = {}) {
    const requests = [];
    const get = async (url) => {
        requests.push(url);
        const q = new URL(url).searchParams;
        let result = [...rows];
        if (honoursFilters && q.get('filter[status]') === 'EQ succeeded') {
            result = result.filter(r => r.attributes.status === 'succeeded');
        }
        if (honoursFilters && q.get('sort') === '-created_at') {
            result.sort((a, b) => b.attributes.created_at.localeCompare(a.attributes.created_at));
        }
        const size = Math.min(Number(q.get('page[size]') ?? 25), 100);
        const number = Number(q.get('page[number]') ?? 1);
        const totalPages = Math.max(1, Math.ceil(result.length / size));
        return {
            data: result.slice((number - 1) * size, number * size),
            meta: {
                pagination: {
                    current_page: number,
                    next_page: number < totalPages ? number + 1 : null,
                    prev_page: number > 1 ? number - 1 : null,
                    total_pages: totalPages,
                    total_count: result.length
                }
            }
        };
    };
    return { get, requests };
}

const rule = (n) => ({ id: `RL${n}`, type: 'rules', attributes: { name: `Rule ${n}` } });

const build = (id, status, createdAt) => ({
    id,
    type: 'builds',
    attributes: { status, created_at: createdAt, updated_at: createdAt },
    relationships: {
        library: { data: { id: 'LB1', type: 'libraries' } },
        environment: { data: { id: 'ENabc', type: 'environments' } }
    }
});

// ─── listAll ──────────────────────────────────────────────────────────────────

describe('listAll', () => {
    test('returns every row of a list longer than one page', async () => {
        const rows = Array.from({ length: 250 }, (_, i) => rule(i + 1));
        const api = fakeReactor(rows);

        const result = await listAll(api.get, 'https://reactor.adobe.io/properties/PR1/rules');

        expect(result.map(r => r.id)).toEqual(rows.map(r => r.id));
        expect(api.requests).toHaveLength(3); // 100 + 100 + 50
    });

    test('keeps an existing query string when adding paging', async () => {
        const rows = Array.from({ length: 150 }, (_, i) => rule(i + 1));
        const api = fakeReactor(rows);

        const result = await listAll(api.get, 'https://reactor.adobe.io/properties/PR1/rules?filter[name]=CONTAINS%20consent');

        expect(result).toHaveLength(150);
        expect(api.requests).toHaveLength(2);
        for (const url of api.requests) {
            expect(new URL(url).searchParams.get('filter[name]')).toBe('CONTAINS consent');
        }
    });

    test('returns the rows of a response without pagination meta after one request', async () => {
        const requests = [];
        const get = async (url) => { requests.push(url); return { data: [rule(1), rule(2)] }; };

        const result = await listAll(get, 'https://reactor.adobe.io/companies');

        expect(result.map(r => r.id)).toEqual(['RL1', 'RL2']);
        expect(requests).toHaveLength(1);
    });

    test('stops at an empty page even when next_page is still set', async () => {
        const requests = [];
        const get = async (url) => {
            requests.push(url);
            const number = Number(new URL(url).searchParams.get('page[number]'));
            return { data: number === 1 ? [rule(1)] : [], meta: { pagination: { next_page: number + 1 } } };
        };

        const result = await listAll(get, 'https://reactor.adobe.io/properties/PR1/rules');

        expect(result.map(r => r.id)).toEqual(['RL1']);
        expect(requests).toHaveLength(2);
    });
});

// ─── latestSucceededBuild(s) ──────────────────────────────────────────────────

describe('latestSucceededBuild', () => {
    const builds = [
        build('BL4', 'pending', '2026-10-30T04:00:00.000Z'),
        build('BL3', 'failed', '2026-10-30T03:00:00.000Z'),
        build('BL2', 'succeeded', '2026-10-30T02:00:00.000Z'),
        build('BL1', 'succeeded', '2026-10-30T01:00:00.000Z')
    ];

    test('skips newer pending and failed builds, in one request', async () => {
        const api = fakeReactor(builds);

        const result = await latestSucceededBuild(api.get, 'ENabc');

        expect(result.id).toBe('BL2');
        expect(api.requests).toHaveLength(1);
        expect(new URL(api.requests[0]).pathname).toBe('/environments/ENabc/builds');
    });

    test('returns null when the environment has no succeeded build', async () => {
        const api = fakeReactor([build('BL1', 'failed', '2026-10-30T01:00:00.000Z')]);

        expect(await latestSucceededBuild(api.get, 'ENabc')).toBeNull();
    });

    test('filters and sorts by hand when the API ignores the status filter', async () => {
        // Newest first, as the API's default order is, but the older succeeded
        // build comes before the newer one, so an unsorted fallback picks BL1.
        const unordered = [builds[0], builds[3], builds[2], builds[1]];
        const api = fakeReactor(unordered, { honoursFilters: false });

        const result = await latestSucceededBuild(api.get, 'ENabc');

        expect(result.id).toBe('BL2');
    });
});

describe('latestSucceededBuilds', () => {
    test('returns the newest succeeded builds, newest first', async () => {
        const api = fakeReactor([
            build('BL4', 'failed', '2026-10-30T04:00:00.000Z'),
            build('BL3', 'succeeded', '2026-10-30T03:00:00.000Z'),
            build('BL2', 'succeeded', '2026-10-30T02:00:00.000Z'),
            build('BL1', 'succeeded', '2026-10-30T01:00:00.000Z')
        ]);

        const result = await latestSucceededBuilds(api.get, 'ENabc', 2);

        expect(result.map(b => b.id)).toEqual(['BL3', 'BL2']);
    });
});
