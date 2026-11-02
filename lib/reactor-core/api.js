// Reactor API list and build lookups. Each function takes `get(url)`, an async
// GET resolving to the parsed response body, so the caller picks the HTTP
// client (the archive passes its rate-limited one).

const REACTOR_URL = 'https://reactor.adobe.io';

// The API silently clamps page[size] to 100: asking for 1000 returns 100 rows
// and no error, so anything bigger truncates.
const PAGE_SIZE = 100;

/**
 * Fetches every page of a list endpoint.
 * @param {Function} get - async (url) => parsed response body
 * @param {string} url - the list URL, without page[...] parameters
 */
async function listAll(get, url) {
    const sep = url.includes('?') ? '&' : '?';
    const rows = [];
    for (let page = 1; ; page++) {
        const body = await get(`${url}${sep}page[size]=${PAGE_SIZE}&page[number]=${page}`);
        const data = body.data || [];
        rows.push(...data);
        // An empty page ends the walk even if next_page is still set, so a
        // misbehaving response cannot loop forever.
        if (!body.meta?.pagination?.next_page || data.length === 0) return rows;
    }
}

const isSucceeded = (build) => build.attributes?.status === 'succeeded';
const newestFirst = (a, b) => b.attributes.created_at.localeCompare(a.attributes.created_at);

/**
 * The newest `limit` succeeded builds of an environment, newest first.
 *
 * What an environment runs is its newest succeeded build: a pending or failed
 * build deploys nothing, and the environment's own `library` link is cleared by
 * a publish, so the build is the only record of what is deployed.
 */
async function latestSucceededBuilds(get, environmentId, limit = 1) {
    const base = `${REACTOR_URL}/environments/${environmentId}/builds`;
    const body = await get(`${base}?filter[status]=EQ%20succeeded&sort=-created_at&page[size]=${limit}`);
    const builds = body.data || [];
    if (builds.every(isSucceeded)) return builds;
    // The API drops filters it does not understand instead of rejecting them.
    // If this one was dropped, filter and sort the full list here.
    return (await listAll(get, base)).filter(isSucceeded).sort(newestFirst).slice(0, limit);
}

async function latestSucceededBuild(get, environmentId) {
    const [build] = await latestSucceededBuilds(get, environmentId, 1);
    return build ?? null;
}

/**
 * A library's own lists hold only its changes; its newest succeeded build holds
 * the effective set, upstream included, so that is what a release compare
 * reads. A library keeps only a few builds (about three per environment), so
 * the whole list is read and sorted here rather than trusting the filter and
 * sort on this endpoint, which haven't been checked live.
 */
async function latestSucceededLibraryBuild(get, libraryId) {
    const builds = await listAll(get, `${REACTOR_URL}/libraries/${libraryId}/builds`);
    return builds.filter(isSucceeded).sort(newestFirst)[0] ?? null;
}

module.exports = { listAll, latestSucceededBuilds, latestSucceededBuild, latestSucceededLibraryBuild };
