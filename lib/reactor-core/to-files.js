const fs = require('fs');
const path = require('path');
const { checkCreateDir } = require('./utils');
const { transformsFor, transformFiles, getNested, isSettingsFile } = require('./transforms');

/**
 * Transforms a Reactor resource JSON into local files: data.json, settings.json
 * and one settings.<path>.js file per setting that holds code. Files an earlier
 * write left that this one doesn't produce are removed, so the folder matches
 * the item. Name links are made separately, for a whole list (name-links.js).
 * @param {Object} data - The resource JSON object (e.g. a rule, extension, etc.)
 * @param {string} baseDir - The root directory for the property export.
 * @param {Function} fetchExtensionPackage - Async function(id) returning the extension package JSON.
 * @returns {Promise<{ files: string[], removed: string[] }>} the code files written, and the settings files removed
 */
module.exports = async (data, baseDir, fetchExtensionPackage) => {
    const localPath = path.join(baseDir, data.type, data.id); // e.g. /rules/RULE_ID
    checkCreateDir(localPath);

    fs.writeFileSync(
        path.join(localPath, 'data.json'),
        JSON.stringify(data, null, 2)
    );

    // Settings that aren't JSON can't be split into files and stay in data.json
    let settings;
    let hasSettings = false;
    if (data.attributes.settings) {
        try {
            settings = JSON.parse(data.attributes.settings);
            hasSettings = true;
        } catch (e) { /* not JSON */ }
    }

    const files = [];
    if (hasSettings) {
        fs.writeFileSync(
            path.join(localPath, 'settings.json'),
            JSON.stringify(settings, null, 2)
        );

        const transforms = await transformsFor(data, fetchExtensionPackage);
        for (const { transform, path: propertyPath, file } of transformFiles(transforms, settings)) {
            const value = getNested(settings, propertyPath);
            if (value === undefined || value === null) continue;

            const targetFile = path.join(localPath, file);
            if (transform.type === 'function') {
                // Wrap function code
                const args = transform.parameters ? transform.parameters.join(', ') : '';
                const content = `//==== START TRANSFORM CODE - DO NOT REMOVE ====
function (${args}) {
//==== END TRANSFORM CODE ====
${value}
//==== START TRANSFORM CODE - DO NOT REMOVE ====
}
//==== END TRANSFORM CODE ====`;
                fs.writeFileSync(targetFile, content);
            } else {
                // 'file' and 'customCode': direct write
                fs.writeFileSync(targetFile, value);
            }
            files.push(file);
        }
    }

    const keep = new Set(hasSettings ? ['settings.json', ...files] : files);
    const removed = fs.readdirSync(localPath).filter(file => isSettingsFile(file) && !keep.has(file));
    removed.forEach(file => fs.rmSync(path.join(localPath, file)));

    return { files, removed };
};
