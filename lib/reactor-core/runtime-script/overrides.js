'use strict';

// Writes a test build where Chrome's Local Overrides serves it: Chrome serves
// {overrides folder}/{host}/{path} in place of https://{host}/{path}. Several sync
// folders may share one overrides folder, so each keeps a manifest of what it wrote
// and removes only that when it writes again. This does file I/O, like
// reactor-core/sync.js, unlike the rest of runtime-script.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ASSETS_ORIGIN = 'https://assets.adobedtm.com';
const MANIFEST_PATH = path.join('.reactor-sync', 'test-build.json');
// Windows file APIs fail on a directory path of this many characters (MAX_PATH less
// 12) or a file path of 260, unless the path has the \\?\ prefix. One limit covers both.
const WINDOWS_PATH_LIMIT = 248;
const LONG_PATH_PREFIX = '\\\\?\\';
// These file systems ignore case by default
const CASE_FOLDING_PLATFORMS = ['win32', 'darwin'];

/**
 * Every script URL of a property's environments: each source's minified and debug
 * URL, else the one from the environment's library_path and library_name and its
 * debug name. An environment with neither adds nothing.
 * @param {Array<Object>} environments - as the Reactor API lists them
 * @returns {string[]} the URLs, once each
 */
function scriptUrls(environments) {
    const urls = new Set();
    for (const environment of environments) {
        if (!environment) continue;
        const attributes = environment.attributes || {};
        const found = (environment.meta?.script_sources || [])
            .flatMap(source => [source?.minified, source?.debug])
            .filter(Boolean);
        if (found.length === 0 && attributes.library_path && attributes.library_name) {
            const minified = `${ASSETS_ORIGIN}/${attributes.library_path}/${attributes.library_name}`;
            found.push(minified, minified.replace(/\.min\.js$/, '.js'));
        }
        for (const url of found) urls.add(url);
    }
    return [...urls];
}

/** Where Chrome looks for a URL in the overrides folder. The query string and fragment don't count. */
function urlToPath(overridesDir, url) {
    const { host, pathname } = new URL(url);
    return path.join(overridesDir, host, ...pathname.split('/').filter(Boolean));
}

/**
 * The path to give fs. On Windows, a path of 248 characters or more only works as an
 * absolute path with the \\?\ prefix. Anywhere else, and for a shorter path, it is as it is.
 */
function longPath(p) {
    if (os.platform() !== 'win32') return p;
    const absolute = path.resolve(p);
    return absolute.length >= WINDOWS_PATH_LIMIT && !absolute.startsWith(LONG_PATH_PREFIX) ? LONG_PATH_PREFIX + absolute : p;
}

const withoutPrefix = (p) => (p.startsWith(LONG_PATH_PREFIX) ? p.slice(LONG_PATH_PREFIX.length) : p);

// Paths that differ only in case are one file where the file system ignores case, so a
// manifest that spells a path another way still means the file this run just wrote
const sameFileKey = (p) => {
    const absolute = path.resolve(p);
    return CASE_FOLDING_PLATFORMS.includes(os.platform()) ? absolute.toLowerCase() : absolute;
};

const isInside = (dir, p) => {
    const relative = path.relative(dir, p);
    return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
};

const isGone = (err) => err.code === 'ENOENT' || err.code === 'ENOTDIR';

/**
 * The files the previous run from this sync folder wrote, as absolute paths. A manifest
 * that isn't there lists none. One that is there but can't be read lists none either, and
 * says so.
 * @returns {{ files: string[], warnings: string[] }}
 */
function previousFiles(manifestPath) {
    try {
        const manifest = JSON.parse(fs.readFileSync(longPath(manifestPath), 'utf8'));
        if (Array.isArray(manifest?.files)) {
            return { files: manifest.files.filter(file => typeof file === 'string' && path.isAbsolute(file)), warnings: [] };
        }
    } catch (err) {
        if (err.code === 'ENOENT') return { files: [], warnings: [] };
    }
    return { files: [], warnings: [`The previous test build's manifest (${manifestPath}) couldn't be read, so the files it listed were left in place`] };
}

/**
 * Removes a file, but never a folder, and never through a link that leads out of the
 * overrides folder. A file that isn't there is not an error.
 * @returns {boolean} whether it removed one
 */
function removeFile(file, overridesDir) {
    try {
        // The native realpath: the JavaScript one can't read a path with the \\?\ prefix
        const folder = withoutPrefix(fs.realpathSync.native(longPath(path.dirname(file))));
        const root = withoutPrefix(fs.realpathSync.native(longPath(overridesDir)));
        if (!isInside(root, folder)) return false;
        if (!fs.lstatSync(longPath(file)).isFile()) return false;
        fs.unlinkSync(longPath(file));
        return true;
    } catch (err) {
        if (isGone(err)) return false;
        throw err;
    }
}

/**
 * Writes the script at every script URL and each custom code file at its own URL,
 * removes the files the previous run from this sync folder wrote and this one didn't,
 * then records what it wrote in syncDir/.reactor-sync/test-build.json.
 *
 * Ownership is by path: two sync folders for one property write the same script URLs,
 * and the later run owns them.
 *
 * A previous manifest can be stale, edited, or from another overrides folder, so a
 * file it lists is removed only if it lies inside overridesDir, and not by way of a link
 * out of it. A run that fails part way still writes the manifest, listing what it wrote
 * and what it didn't get to remove, so no file is left that nothing lists. The error
 * is thrown after that.
 * @param {Object} options
 * @param {string} options.overridesDir
 * @param {string} options.syncDir
 * @param {string} options.scriptText - the test build
 * @param {string[]} options.scriptUrls
 * @param {Array<{ url: string, text: string }>} options.files - the custom code files
 * @param {Object} options.manifest - what to record besides `files`
 * @returns {{ written: string[], removed: string[], warnings: string[] }} the paths are absolute
 */
function writeOverrides({ overridesDir, syncDir, scriptText, scriptUrls, files, manifest }) {
    // An empty folder would put the build in the working directory
    if (typeof overridesDir !== 'string' || overridesDir.trim() === '') throw new Error('Choose an overrides folder to write the test build to');

    const manifestPath = path.join(syncDir, MANIFEST_PATH);
    const previous = previousFiles(manifestPath);
    // The previous run's files that this run hasn't written, removed or left alone yet
    const pending = new Map(previous.files.map(file => [sameFileKey(file), path.resolve(file)]));
    const written = new Set();
    const removed = [];

    const put = (url, text) => {
        const target = path.resolve(urlToPath(overridesDir, url));
        fs.mkdirSync(longPath(path.dirname(target)), { recursive: true });
        // Listed before it's written, so a write that fails part way is still listed
        written.add(target);
        pending.delete(sameFileKey(target));
        fs.writeFileSync(longPath(target), text, 'utf8');
    };

    try {
        for (const url of scriptUrls) put(url, scriptText);
        for (const { url, text } of files) put(url, text);

        // One file that can't be removed shouldn't stop the rest
        const failures = [];
        for (const [key, file] of [...pending]) {
            try {
                if (isInside(overridesDir, file) && removeFile(file, overridesDir)) removed.push(file);
                pending.delete(key);
            } catch (err) {
                failures.push(err);
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, `${failures.length} files couldn't be removed`);
    } finally {
        fs.mkdirSync(longPath(path.dirname(manifestPath)), { recursive: true });
        const recorded = { ...manifest, files: [...written, ...pending.values()] };
        fs.writeFileSync(longPath(manifestPath), `${JSON.stringify(recorded, null, 2)}\n`, 'utf8');
    }
    return { written: [...written], removed, warnings: previous.warnings };
}

module.exports = { scriptUrls, urlToPath, writeOverrides, longPath };
