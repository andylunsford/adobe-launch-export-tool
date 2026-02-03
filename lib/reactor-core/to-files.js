const fs = require('fs');
const path = require('path');
const { sanitizeName, checkCreateDir } = require('./utils');

// Helper to safely get nested properties
function getNestedValue(pathStr, obj) {
    const parts = pathStr.split('.');
    let value = '';
    let current = obj;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (current && current[part] !== undefined) {
            if (i === parts.length - 1) {
                value = current[part];
            } else {
                current = current[part];
            }
        } else {
            return undefined;
        }
    }
    return value;
}

/**
 * Transforms a Reactor resource JSON into local files.
 * @param {Object} data - The resource JSON object (e.g. a rule, extension, etc.)
 * @param {string} baseDir - The root directory for the property export.
 * @param {Function} fetchExtensionPackage - Async function(id) returning the extension package JSON.
 */
module.exports = async (data, baseDir, fetchExtensionPackage) => {
    // 1. Determine Paths
    const typeDir = path.join(baseDir, data.type);
    const localPath = path.join(typeDir, data.id); // e.g. /rules/RULE_ID
    
    checkCreateDir(localPath);

    // 2. Create Symlink (Friendly Name -> ID)
    // This helps users navigate by name while keeping ID as the source of truth
    if (data.attributes && data.attributes.name) {
        const friendlyName = '_' + sanitizeName(data.attributes.name);
        const linkPath = path.join(typeDir, friendlyName);
        
        // Only create if it doesn't exist to avoid errors
        // Note: Windows requires admin for symlinks usually, so we wrap in try/catch or skip if needed.
        // For now, we attempt it as it's useful.
        try {
            if (!fs.existsSync(linkPath)) {
                // We link to the ID folder. 
                // Target is relative or absolute? fs.symlinkSync(target, path)
                // If we use relative: './ID'
                // But let's verify if 'data.id' is just the folder name. Yes.
                // On Windows 'dir' type is required.
                fs.symlinkSync(data.id, linkPath, 'dir');
            }
        } catch (e) {
            // Ignore symlink errors (common on Windows without perms)
            // console.warn("Could not create symlink:", e.message);
        }
    }

    // 3. Write Main Data JSON
    fs.writeFileSync(
        path.join(localPath, 'data.json'),
        JSON.stringify(data, null, 2)
    );

    // 4. Handle "Transforms" (Extracting JS code to separate files)
    if (data.attributes.settings) {
        let settings;
        try {
            settings = JSON.parse(data.attributes.settings);
        } catch (e) {
            // If settings isn't valid JSON, we can't transform it.
            return;
        }

        // Save settings.json (pretty printed)
        fs.writeFileSync(
            path.join(localPath, 'settings.json'),
            JSON.stringify(settings, null, 2)
        );

        let transforms = null;

        // 4a. Identify Transforms based on Type
        if (data.type === 'data_elements') {
            if (data.relationships.updated_with_extension_package?.data?.id) {
                const pkgId = data.relationships.updated_with_extension_package.data.id;
                const pkg = await fetchExtensionPackage(pkgId);
                const items = pkg.attributes.data_elements || [];
                const def = items.find(item => item.id === data.attributes.delegate_descriptor_id);
                if (def) transforms = def.transforms;
            }
        } else if (data.type === 'extensions') {
            if (data.relationships.extension_package?.data?.id) {
                const pkgId = data.relationships.extension_package.data.id;
                const pkg = await fetchExtensionPackage(pkgId);
                if (pkg.attributes.configuration?.transforms) {
                    transforms = pkg.attributes.configuration.transforms;
                }
            }
        } else if (data.type === 'rule_components') {
            if (data.relationships.updated_with_extension_package?.data?.id) {
                const pkgId = data.relationships.updated_with_extension_package.data.id;
                const pkg = await fetchExtensionPackage(pkgId);
                
                const descriptor = data.attributes.delegate_descriptor_id;
                let items = [];
                if (descriptor.includes('::actions::')) items = pkg.attributes.actions || [];
                else if (descriptor.includes('::events::')) items = pkg.attributes.events || [];
                else if (descriptor.includes('::conditions::')) items = pkg.attributes.conditions || [];

                const def = items.find(item => item.id === descriptor);
                if (def) transforms = def.transforms;
            }
        }

        // 4b. Apply Transforms
        if (transforms && Array.isArray(transforms)) {
            transforms.forEach(transform => {
                let value = getNestedValue(transform.propertyPath, settings);
                if (value === undefined || value === null) return;

                const targetFile = path.join(localPath, `settings.${transform.propertyPath}.js`);

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

                } else if (transform.type === 'file' || transform.type === 'customCode') {
                    // Direct write
                    fs.writeFileSync(targetFile, value);
                }
            });
        }
    }
};
