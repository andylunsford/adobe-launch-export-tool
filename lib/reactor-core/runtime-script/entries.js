'use strict';

// Writes the container entry for a data element, extension or rule from its
// revision and extension package, in the key order Launch uses (reverse-engineer-launch
// docs/07, findings 5, 7, 8 and 12). Where that is not known, the entry is written
// the best way and a warning says so.

const { getNested, setNested, expandPath } = require('../transforms');
const { functionStub } = require('./print');

// Which attribute of an extension package lists each kind of delegate. The kind is
// the middle part of a descriptor: core::dataElements::custom-code.
const PACKAGE_LIST = { dataElements: 'data_elements', events: 'events', conditions: 'conditions', actions: 'actions' };
const LIBRARY_LOADED = 'core::events::library-loaded';

const originOf = (revision) => revision.relationships?.origin?.data?.id;
const parseSettings = (text) => (text ? JSON.parse(text) : {});
const kindOf = (descriptor) => descriptor.split('::')[1];

/** What the package says about a delegate: its code's path, and the transforms for its settings. */
function delegateFor(descriptor, pkg) {
    const def = pkg.attributes[PACKAGE_LIST[kindOf(descriptor)]]?.find(delegate => delegate.id === descriptor);
    if (!def) throw new Error(`${descriptor} isn't in ${pkg.attributes.name} ${pkg.attributes.version}`);
    return def;
}

const modulePathOf = (descriptor, def) => `${descriptor.split('::')[0]}/${def.libPath}`;

/** A transform the entry writers can't apply as Launch would, so the entry would be written wrongly. */
class UnsupportedTransform extends Error {
    constructor(type, propertyPath) {
        super(`${type} transform on ${propertyPath} isn't supported`);
        this.name = 'UnsupportedTransform';
    }
}

/**
 * Applies an extension package's transforms to settings, in place. A function
 * transform turns code into a function stub, a customCode transform hands the code to
 * onCustomCode, and remove and add (originId) change the settings. Any other transform
 * would change the settings in a way this can't, so it throws: an add for anything but
 * the origin id, and any other type where the settings hold a value for it.
 * @param {Object} settings
 * @param {Array<{ type: string, propertyPath: string }>} transforms
 * @param {{ originId?: string, onCustomCode?: (parts: string[], code: string) => void }} [options]
 *   onCustomCode is told where the code is and what it is, and changes the settings itself
 * @returns {Object} settings
 * @throws {UnsupportedTransform}
 */
function applyTransforms(settings, transforms, { originId, onCustomCode } = {}) {
    for (const transform of transforms) {
        for (const propertyPath of expandPath(transform.propertyPath, settings)) {
            const parts = propertyPath.split('.');
            const value = getNested(settings, parts);
            if (transform.type === 'remove') {
                const parent = getNested(settings, parts.slice(0, -1));
                if (parent && typeof parent === 'object') delete parent[parts[parts.length - 1]];
            } else if (transform.type === 'add') {
                // An add puts a value there, so whether one is there already doesn't matter
                if (transform.reservedKey !== 'originId') throw new UnsupportedTransform(transform.type, propertyPath);
                setNested(settings, parts, originId);
            } else if (transform.type === 'function') {
                if (typeof value === 'string') setNested(settings, parts, functionStub(transform.parameters, value));
            } else if (transform.type === 'customCode') {
                if (typeof value === 'string') onCustomCode?.(parts, value);
            } else if (value !== undefined) {
                throw new UnsupportedTransform(transform.type, propertyPath);
            }
        }
    }
    return settings;
}

/**
 * A data element revision's entry, with its optional fields first.
 * @returns {{ name: string, entry: Object, warnings: string[] }}
 */
function dataElementEntry(revision, pkg) {
    const { name, delegate_descriptor_id: descriptor, default_value, force_lower_case, clean_text, storage_duration } = revision.attributes;
    const def = delegateFor(descriptor, pkg);
    const warnings = [];
    const entry = {};
    if (default_value) entry.defaultValue = default_value;
    if (force_lower_case) entry.forceLowerCase = true;
    if (clean_text) {
        entry.cleanText = true;
        warnings.push(`${name}: cleanText's place in the entry is unverified`);
    }
    if (storage_duration) {
        entry.storageDuration = storage_duration;
        if (default_value || force_lower_case) warnings.push(`${name}: storageDuration's place next to other fields is unverified`);
    }
    entry.modulePath = modulePathOf(descriptor, def);
    entry.settings = applyTransforms(parseSettings(revision.attributes.settings), def.transforms || [], { originId: originOf(revision) });
    return { name, entry, warnings };
}

/**
 * An extension revision's entry, around the modules the container already has.
 * @param {Object} modules - the entry's modules, as they are
 * @returns {{ name: string, entry: Object }}
 */
function extensionEntry(revision, pkg, modules) {
    const settings = applyTransforms(parseSettings(revision.attributes.settings), pkg.attributes.configuration?.transforms || [], { originId: originOf(revision) });
    const entry = {
        displayName: revision.attributes.display_name,
        hostedLibFilesBaseUrl: `https://assets.adobedtm.com/extensions/${pkg.id}/`
    };
    if (Object.keys(settings).length > 0) entry.settings = settings;
    entry.modules = modules;
    return { name: pkg.attributes.name, entry };
}

/** One of a rule's events, conditions or actions. */
function componentEntry(kind, attributes, descriptor, base) {
    switch (kind) {
        case 'events':
            return { ...base, ruleOrder: attributes.rule_order };
        case 'conditions':
            return { ...base, ...(attributes.negate && { negate: true }), timeout: attributes.timeout };
        case 'actions':
            return { ...base, ...(attributes.delay_next && { timeout: attributes.timeout, delayNext: true }) };
        default:
            throw new Error(`${descriptor} isn't an event, condition or action`);
    }
}

/**
 * A rule revision's entry, from its components.
 *
 * Custom code in a Library Loaded rule stays in the entry. Elsewhere Launch
 * moves it to a file, so the entry holds the file's URL (and `isExternal`) and the
 * code is returned in `files`, unless inlineMovedCode keeps it in the entry.
 * @param {Object} revision
 * @param {Array<{ component: Object, pkg: Object }>} components - each with its extension package
 * @param {{ customCodeUrl: (componentId: string) => string, sequencing: boolean, inlineMovedCode: boolean }} options
 * @returns {{ entry: Object, files: Array<{ url: string, code: string }>, warnings: string[] }}
 */
function ruleEntry(revision, components, { customCodeUrl, sequencing, inlineMovedCode }) {
    const rule = revision.attributes.name;
    const libraryLoaded = components.some(({ component }) => component.attributes.delegate_descriptor_id === LIBRARY_LOADED);
    const entry = { id: revision.id, name: rule, events: [], conditions: [], actions: [] };
    const files = [];
    // A rule with several custom code actions shouldn't repeat itself
    const warnings = new Set();

    const inOrder = [...components].sort((a, b) => a.component.attributes.order - b.component.attributes.order);
    for (const { component, pkg } of inOrder) {
        const descriptor = component.attributes.delegate_descriptor_id;
        const def = delegateFor(descriptor, pkg);
        const settings = parseSettings(component.attributes.settings);

        const onCustomCode = (parts, code) => {
            if (libraryLoaded) {
                if (!sequencing) warnings.add(`${rule}: custom code in a Library Loaded rule with sequencing off is unverified`);
            } else if (inlineMovedCode) {
                warnings.add(`${rule}: custom code kept inline; Launch would load it from a file`);
            } else {
                const url = customCodeUrl(component.id);
                setNested(settings, parts, url);
                settings.isExternal = true;
                files.push({ url, code });
                if (settings.language === 'html') warnings.add(`${rule}: HTML custom code moved to a file is unverified`);
            }
        };
        applyTransforms(settings, def.transforms || [], { originId: originOf(component), onCustomCode });

        const kind = kindOf(descriptor);
        const written = componentEntry(kind, component.attributes, descriptor, { modulePath: modulePathOf(descriptor, def), settings });
        entry[kind].push(written);
    }
    return { entry, files, warnings: [...warnings] };
}

/** Revision ids in the order the container lists them: by code unit, not by locale. */
const byRevisionId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

module.exports = { applyTransforms, dataElementEntry, extensionEntry, ruleEntry, byRevisionId, originOf, UnsupportedTransform };
