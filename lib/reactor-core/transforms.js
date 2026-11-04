// Which of an item's settings hold code, and the file each is written to.
// to-files.js and from-file.js both use this, so they agree on file names.

const FILE_TRANSFORMS = ['function', 'file', 'customCode'];

const getNested = (obj, parts) => parts.reduce((current, part) => current?.[part], obj);

function setNested(obj, parts, value) {
    const parent = parts.slice(0, -1).reduce((current, part) => (current[part] = current[part] || {}), obj);
    parent[parts[parts.length - 1]] = value;
}

/** The transforms the item's extension package declares for it. */
async function transformsFor(data, fetchExtensionPackage) {
    const relationship = data.type === 'extensions' ? 'extension_package' : 'updated_with_extension_package';
    const packageId = data.relationships?.[relationship]?.data?.id;
    if (!packageId || !['data_elements', 'extensions', 'rule_components'].includes(data.type)) return [];

    const pkg = await fetchExtensionPackage(packageId);
    if (!pkg) throw new Error(`Couldn't fetch extension package ${packageId}`);
    if (data.type === 'extensions') return pkg.attributes.configuration?.transforms || [];

    const descriptor = data.attributes.delegate_descriptor_id || '';
    let delegates = [];
    if (data.type === 'data_elements') delegates = pkg.attributes.data_elements || [];
    else if (descriptor.includes('::actions::')) delegates = pkg.attributes.actions || [];
    else if (descriptor.includes('::events::')) delegates = pkg.attributes.events || [];
    else if (descriptor.includes('::conditions::')) delegates = pkg.attributes.conditions || [];
    return delegates.find(delegate => delegate.id === descriptor)?.transforms || [];
}

// A propertyPath can hold "[]" for each element of an array, as adobe-alloy's
// "instances[].onBeforeEventSend" does. This expands it to one path per element
// the settings have: "instances.0.onBeforeEventSend", "instances.1...".
function expandPath(propertyPath, settings) {
    const at = propertyPath.indexOf('[]');
    if (at === -1) return [propertyPath];
    const head = propertyPath.slice(0, at);
    const list = getNested(settings, head.split('.'));
    if (!Array.isArray(list)) return [];
    const rest = propertyPath.slice(at + 2);
    return list.flatMap((_, i) => expandPath(`${head}.${i}${rest}`, settings));
}

/**
 * The code files for an item's settings: one per transform path, with "[]"
 * expanded against the settings.
 * @returns {Array<{ transform, path: string[], file: string }>}
 */
function transformFiles(transforms, settings) {
    return transforms
        .filter(transform => FILE_TRANSFORMS.includes(transform.type))
        .flatMap(transform => expandPath(transform.propertyPath, settings).map(propertyPath => ({
            transform,
            path: propertyPath.split('.'),
            file: `settings.${propertyPath}.js`
        })));
}

// The names of every file to-files.js writes besides data.json, so a rewrite
// can remove the ones it no longer writes.
const isSettingsFile = (file) => file === 'settings.json' || /^settings\..+\.js$/.test(file);

module.exports = { transformsFor, transformFiles, getNested, setNested, isSettingsFile };
