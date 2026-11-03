const fs = require('fs');
const path = require('path');
const { readFile } = require('./utils');
const { transformsFor, transformFiles, setNested } = require('./transforms');

const FUNCTION_WRAPPER = /\s?\/\/==== START TRANSFORM CODE - DO NOT REMOVE ====[\s\S]*?\/\/==== END TRANSFORM CODE ====\s?/gm;

/**
 * Reconstructs the API payload from local files.
 * @param {string} localPath - Path to the resource directory (e.g. /rules/RULE_ID)
 * @param {Function} fetchExtensionPackage - Async function(id) returning extension package JSON.
 */
module.exports = async (localPath, fetchExtensionPackage) => {
    let stats;
    try {
        stats = fs.statSync(localPath);
    } catch (e) {
        throw new Error(`${localPath} does not exist.`);
    }

    if (!stats.isDirectory()) {
        throw new Error(`${localPath} is not a directory.`);
    }

    const dataPath = path.join(localPath, 'data.json');
    const settingsPath = path.join(localPath, 'settings.json');

    // 1. Read Base Data
    const data = readFile(dataPath);

    // 2. Read Settings & overlay the code files of the item's current transforms.
    // A file that matches none of them (an older transform, or an array index
    // the settings don't have) is ignored.
    if (fs.existsSync(settingsPath)) {
        const settings = readFile(settingsPath);
        const transforms = await transformsFor(data, fetchExtensionPackage);

        for (const { transform, path: propertyPath, file } of transformFiles(transforms, settings)) {
            const filePath = path.join(localPath, file);
            if (!fs.existsSync(filePath)) continue;

            // CRLF → LF, so a file saved by a Windows editor or checked out with
            // core.autocrlf reads as the same code
            let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
            if (transform.type === 'function') {
                content = content.replace(FUNCTION_WRAPPER, '');
            }
            // 'file' and 'customCode' have no wrapper
            setNested(settings, propertyPath, content);
        }

        // 3. Pack settings back into data
        data.attributes.settings = JSON.stringify(settings);
    }

    return data;
};
