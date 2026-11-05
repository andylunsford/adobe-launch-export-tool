'use strict';

// The revisions the Reactor API would give for the build in launch-fixture.js,
// with the core extension package. Writing entries from these must give back
// the fixture's entries exactly.

const reactorId = (prefix, n) => prefix + String(n).padStart(32, '0');

const PREFIX = { rules: 'RL', data_elements: 'DE', extensions: 'EX', rule_components: 'RC' };
const PACKAGE_RELATIONSHIP = { data_elements: 'updated_with_extension_package', rule_components: 'updated_with_extension_package', extensions: 'extension_package' };
// Booleans are false and every other field null, until a revision says otherwise
const DEFAULTS = {
    rules: { name: null },
    data_elements: { name: null, delegate_descriptor_id: null, settings: null, default_value: null, force_lower_case: false, clean_text: false, storage_duration: null },
    extensions: { name: null, display_name: null, delegate_descriptor_id: null, settings: null },
    rule_components: { name: null, delegate_descriptor_id: null, settings: null, order: null, rule_order: null, negate: false, delay_next: false, timeout: null }
};

const delegate = (kind, name, displayName, libPath, transforms) => ({
    id: `core::${kind}::${name}`, name, displayName, libPath, ...(transforms && { transforms })
});

const PACKAGE = {
    id: reactorId('EP', 1),
    type: 'extension_packages',
    attributes: {
        name: 'core',
        version: '3.4.1',
        data_elements: [
            delegate('dataElements', 'custom-code', 'Custom Code', 'src/lib/dataElements/customCode.js',
                [{ type: 'function', propertyPath: 'source', parameters: ['event'] }]),
            delegate('dataElements', 'javascript-variable', 'JavaScript Variable', 'src/lib/dataElements/javascriptVariable.js')
        ],
        events: [
            delegate('events', 'library-loaded', 'Library Loaded (Page Top)', 'src/lib/events/libraryLoaded.js'),
            delegate('events', 'dom-ready', 'DOM Ready', 'src/lib/events/domReady.js')
        ],
        conditions: [
            delegate('conditions', 'path', 'Path Without Query String', 'src/lib/conditions/path.js')
        ],
        actions: [
            delegate('actions', 'custom-code', 'Custom Code', 'src/lib/actions/customCode.js',
                [{ type: 'customCode', propertyPath: 'source' }])
        ],
        configuration: {}
    }
};

/** A revision with the attributes a revision of that type has, and its package and origin. */
function revision(type, n, attributes, origin) {
    const packageRelationship = PACKAGE_RELATIONSHIP[type];
    return {
        id: reactorId(PREFIX[type], n),
        type,
        attributes: { ...DEFAULTS[type], enabled: true, revision_number: 1, ...attributes },
        relationships: {
            ...(packageRelationship && { [packageRelationship]: { data: { id: PACKAGE.id, type: 'extension_packages' } } }),
            origin: { data: { id: origin, type } }
        }
    };
}

/** A rule component revision. Entries don't use a component's origin. */
const component = (n, attributes) => revision('rule_components', n, attributes);

const json = (value) => JSON.stringify(value);
const customCode = (code) => json({ source: code, language: 'javascript' });

const loadRule = revision('rules', 11, { name: 'Load' }, reactorId('RL', 1));
const clickRule = revision('rules', 12, { name: 'Click' }, reactorId('RL', 2));

const PRODUCTION = {
    revisions: {
        rules: [loadRule, clickRule],
        data_elements: [
            revision('data_elements', 31, {
                name: 'Page Title', delegate_descriptor_id: 'core::dataElements::custom-code', settings: json({ source: 'return document.title;' })
            }, reactorId('DE', 1)),
            revision('data_elements', 32, {
                name: 'Site Section', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: json({ path: 'site.section' }),
                default_value: 'home', force_lower_case: true
            }, reactorId('DE', 2))
        ],
        extensions: [
            revision('extensions', 41, { name: 'core', display_name: 'Core' }, reactorId('EX', 1))
        ]
    },
    // Each rule's components, by rule revision id
    components: new Map([
        [loadRule.id, [
            component(21, { delegate_descriptor_id: 'core::events::library-loaded', order: 0, rule_order: 50 }),
            component(23, { delegate_descriptor_id: 'core::actions::custom-code', order: 1, settings: customCode('console.log("inline");'), delay_next: false, timeout: 2000 })
        ]],
        [clickRule.id, [
            component(24, { delegate_descriptor_id: 'core::events::dom-ready', order: 0, rule_order: 50 }),
            component(25, { delegate_descriptor_id: 'core::conditions::path', order: 1, negate: true, timeout: 2000, settings: json({ paths: [{ value: '/checkout' }] }) }),
            component(22, { delegate_descriptor_id: 'core::actions::custom-code', order: 2, delay_next: true, timeout: 2000, settings: customCode('console.log("external");') })
        ]]
    ]),
    buildBaseUrl: 'https://assets.adobedtm.com/0000aaaa/1111bbbb/a1b2c3d4e5f6/'
};

module.exports = { PACKAGE, PRODUCTION, revision, component, reactorId };
