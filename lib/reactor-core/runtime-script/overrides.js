'use strict';

// Writes a test build where Chrome's Local Overrides serves it: Chrome serves
// {overrides folder}/{host}/{path} in place of https://{host}/{path}. Several sync
// folders may share one overrides folder, so each keeps a manifest of what it wrote
// and removes only that when it writes again. This does file I/O, like
// reactor-core/sync.js, unlike the rest of runtime-script.

const fs = require('fs');
const path = require('path');

const ASSETS_ORIGIN = 'https://assets.adobedtm.com';
const MANIFEST_PATH = path.join('.reactor-sync', 'test-build.json');
// Windows file APIs stop at this many characters, unless the path has the \\?\ prefix
const WINDOWS_PATH_LIMIT = 260;
const LONG_PATH_PREFIX = '\\\\?\\';

/**
 * Every script URL of a property's environments: each source's minified and debug
 * URL, else the one from the environment's library_path and library_name and its
 * debug name. An environment with neither adds nothing.
 * @param {Array<Object>} environments - as the Reactor API lists them
 * @returns {string[]} the URLs, once each
 */
function scriptUrls(environments) {
    const urls = new Set();
    for (const { attributes = {}, meta } of environments) {
        const found = (meta?.script_sources || []).flatMap(source => [source.minified, source.debug]).filter(Boolean);
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
 * The path to give fs. On Windows, a path of 260 characters or more only works as an
 * absolute path with the \\?\ prefix. Anywhere else, and for a shorter path, it is as it is.
 */
function longPath(p) {
    if (process.platform !== 'win32') return p;
    const absolute = path.resolve(p);
    return absolute.length >= WINDOWS_PATH_LIMIT && !absolute.startsWith(LONG_PATH_PREFIX) ? LONG_PATH_PREFIX + absolute : p;
}

// Windows paths ignore case, so a path the manifest spells differently is still the same file
const sameFileKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

const isInside = (dir, file) => {
    const relative = path.relative(dir, file);
    return relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
};

/** The files the previous run from this sync folder wrote, as absolute paths. None if its manifest can't be read. */
function previousFiles(manifestPath) {
    try {
        const { files } = JSON.parse(fs.readFileSync(longPath(manifestPath), 'utf8'));
        return Array.isArray(files) ? files.filter(file => typeof file === 'string' && path.isAbsolute(file)) : [];
    } catch {
        return [];
    }
}

/** Removes a file, but never a folder. A file that isn't there is not an error. */
function removeFile(file) {
    let stat;
    try {
        stat = fs.lstatSync(longPath(file));
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
        throw err;
    }
    if (!stat.isFile()) return false;
    fs.unlinkSync(longPath(file));
    return true;
}

/**
 * Writes the script at every script URL and each custom code file at its own URL,
 * removes the files the previous run from this sync folder wrote and this one didn't,
 * then records what it wrote in syncDir/.reactor-sync/test-build.json.
 *
 * A previous manifest can be stale, edited, or from another overrides folder, so a
 * file it lists is removed only if it lies inside overridesDir.
 * @param {Object} options
 * @param {string} options.overridesDir
 * @param {string} options.syncDir
 * @param {string} options.scriptText - the test build
 * @param {string[]} options.scriptUrls
 * @param {Array<{ url: string, text: string }>} options.files - the custom code files
 * @param {Object} options.manifest - what to record besides `files`
 * @returns {{ written: string[], removed: string[] }} absolute paths
 */
function writeOverrides({ overridesDir, syncDir, scriptText, scriptUrls, files, manifest }) {
    const written = new Set();
    const put = (url, text) => {
        const target = path.resolve(urlToPath(overridesDir, url));
        fs.mkdirSync(longPath(path.dirname(target)), { recursive: true });
        fs.writeFileSync(longPath(target), text, 'utf8');
        written.add(target);
    };
    for (const url of scriptUrls) put(url, scriptText);
    for (const { url, text } of files) put(url, text);

    const manifestPath = path.join(syncDir, MANIFEST_PATH);
    const rewritten = new Set([...written].map(sameFileKey));
    const removed = [];
    for (const file of previousFiles(manifestPath)) {
        const absolute = path.resolve(file);
        if (rewritten.has(sameFileKey(absolute)) || !isInside(overridesDir, absolute)) continue;
        if (removeFile(absolute)) removed.push(absolute);
    }

    fs.mkdirSync(longPath(path.dirname(manifestPath)), { recursive: true });
    fs.writeFileSync(longPath(manifestPath), `${JSON.stringify({ ...manifest, files: [...written] }, null, 2)}\n`, 'utf8');
    return { written: [...written], removed };
}

module.exports = { scriptUrls, urlToPath, writeOverrides, longPath };
