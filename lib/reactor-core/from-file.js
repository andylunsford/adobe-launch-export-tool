const fs = require('fs');
const path = require('path');
const { readFile } = require('./utils');

// Helper to safely set nested properties
function setNestedValue(pathStr, obj, value) {
    const parts = pathStr.split('.');
    let current = obj;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
            current[part] = value;
        } else {
            current[part] = current[part] || {};
            current = current[part];
        }
    }
}

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

    // 2. Identify Transforms (Same logic as toFiles, but inverted goal)
    let transforms = null;

    if (data.type === 'data_elements') {
        if (data.relationships.updated_with_extension_package?.data?.id) {
            const pkg = await fetchExtensionPackage(data.relationships.updated_with_extension_package.data.id);
            const items = pkg.attributes.data_elements || [];
            const def = items.find(item => item.id === data.attributes.delegate_descriptor_id);
            if (def) transforms = def.transforms;
        }
    } else if (data.type === 'extensions') {
        if (data.relationships.extension_package?.data?.id) {
            const pkg = await fetchExtensionPackage(data.relationships.extension_package.data.id);
            if (pkg.attributes.configuration?.transforms) {
                transforms = pkg.attributes.configuration.transforms;
            }
        }
    } else if (data.type === 'rule_components') {
        if (data.relationships.updated_with_extension_package?.data?.id) {
            const pkg = await fetchExtensionPackage(data.relationships.updated_with_extension_package.data.id);
            const descriptor = data.attributes.delegate_descriptor_id;
            let items = [];
            if (descriptor.includes('::actions::')) items = pkg.attributes.actions || [];
            else if (descriptor.includes('::events::')) items = pkg.attributes.events || [];
            else if (descriptor.includes('::conditions::')) items = pkg.attributes.conditions || [];

            const def = items.find(item => item.id === descriptor);
            if (def) transforms = def.transforms;
        }
    }

    // 3. Read Settings & Overlays
    if (fs.existsSync(settingsPath)) {
        const settings = readFile(settingsPath);
        
        // Read all files in directory
        const files = fs.readdirSync(localPath);

        files.forEach(file => {
            if (file === 'data.json' || file === 'settings.json') return;
            
            // We only care about files that match a transform
            if (transforms) {
                // Find matching transform for this file
                // Expected filename: settings.{propertyPath}.js
                const transform = transforms.find(t => file === `settings.${t.propertyPath}.js`);
                
                if (transform) {
                    const filePath = path.join(localPath, file);
                    let content = fs.readFileSync(filePath, 'utf8');

                    // Clean up wrappers
                    if (transform.type === 'function') {
                        content = content.replace(/\s?\/\/==== START TRANSFORM CODE - DO NOT REMOVE ====[\s\S]*?\/\/==== END TRANSFORM CODE ====\s?/gm, '');
                    }
                    // 'file' and 'customCode' types don't have wrappers usually, or just raw content.
                    
                    // Apply back to settings object
                    setNestedValue(transform.propertyPath, settings, content);
                }
            }
        });

        // 4. Pack settings back into data
        data.attributes.settings = JSON.stringify(settings);
    }

    return data;
};
