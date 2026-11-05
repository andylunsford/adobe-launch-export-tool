'use strict';

const { parseScript, checkRoundTrip, checkProductionEntries, firstDifference, checkBehindProduction } = require('../../lib/reactor-core/runtime-script');
const FIXTURE = require('../fixtures/runtime-script/launch-fixture');
const { PACKAGE, PRODUCTION, revision, reactorId } = require('../fixtures/runtime-script/fixture-data');

const parsed = parseScript(FIXTURE);
const packages = new Map([[PACKAGE.id, PACKAGE]]);
const customCodeUrl = (id) => `${PRODUCTION.buildBaseUrl}${id}-source.js`;
const run = (overrides) => checkProductionEntries({ container: parsed.container, revisions: PRODUCTION.revisions, components: PRODUCTION.components, packages, customCodeUrl, ...overrides });
const roundTripMessage = (byte) => `Production's script doesn't print back exactly (first difference at byte ${byte})`;
const replaceAt = (text, i, char) => text.slice(0, i) + char + text.slice(i + 1);

describe('checkRoundTrip', () => {
    test('round trip passes on the fixture', () => {
        expect(checkRoundTrip(FIXTURE, parsed)).toBeNull();
    });

    test('round trip reports the first differing byte', () => {
        const at = FIXTURE.indexOf('turbineVersion');
        expect(checkRoundTrip(replaceAt(FIXTURE, at, 'X'), parsed)).toBe(roundTripMessage(at));
    });

    test('the byte is a UTF-8 offset, not a character index', () => {
        const accented = FIXTURE.replace('Fixture Property', 'Fixtüre Property');
        // After the accented name, so one more byte than characters come before it
        const at = accented.indexOf('undefinedVarsReturnEmpty');
        expect(checkRoundTrip(replaceAt(accented, at, 'X'), parseScript(accented))).toBe(roundTripMessage(at + 1));
    });

    test('a character split in two by its surrogate pair is reported where it starts', () => {
        const withEmoji = (emoji) => FIXTURE.replace('Fixture Property', `Fixture ${emoji} Property`);
        const at = withEmoji('😀').indexOf('😀');
        // The two emoji share their first UTF-16 unit and differ in the second
        expect(checkRoundTrip(withEmoji('😁'), parseScript(withEmoji('😀')))).toBe(roundTripMessage(at));
    });

    test('a text that is a prefix of the other differs where the shorter one ends', () => {
        expect(checkRoundTrip(FIXTURE.slice(0, 100), parsed)).toBe(roundTripMessage(100));
        expect(checkRoundTrip(`${FIXTURE}x`, parsed)).toBe(roundTripMessage(FIXTURE.length));
    });
});

describe('checkProductionEntries', () => {
    test('production entries all match on the fixture data', () => {
        expect(run()).toEqual([]);
    });

    test('a changed revision is reported with its path', () => {
        const click = PRODUCTION.revisions.rules[1];
        const changed = PRODUCTION.components.get(click.id).map(c => (c.id === reactorId('RC', 25) ? { ...c, attributes: { ...c.attributes, negate: false } } : c));
        const components = new Map(PRODUCTION.components).set(click.id, changed);
        expect(run({ components })).toEqual(['rules Click: differs from production at conditions.0.negate']);
    });

    test('a data element or extension that changed is reported with its path', () => {
        const [title, section] = PRODUCTION.revisions.data_elements;
        const [core] = PRODUCTION.revisions.extensions;
        const revisions = {
            ...PRODUCTION.revisions,
            data_elements: [title, { ...section, attributes: { ...section.attributes, default_value: null } }],
            extensions: [{ ...core, attributes: { ...core.attributes, display_name: 'Core 2' } }]
        };
        expect(run({ revisions })).toEqual([
            'data_elements Site Section: differs from production at defaultValue',
            'extensions core: differs from production at displayName'
        ]);
    });

    test('custom code moved to a file is checked through its URL', () => {
        expect(run({ customCodeUrl: (id) => `https://elsewhere.example/${id}.js` }))
            .toEqual(['rules Click: differs from production at actions.0.settings.source']);
    });

    test('an entry with no production revision is a problem', () => {
        const revisions = { ...PRODUCTION.revisions, data_elements: PRODUCTION.revisions.data_elements.slice(1) };
        expect(run({ revisions })).toEqual(['data_elements Page Title: no production revision to check']);
    });

    test('problems come in container order: data elements, extensions, rules', () => {
        const revisions = { rules: [], data_elements: [], extensions: [] };
        expect(run({ revisions })).toEqual([
            'data_elements Page Title: no production revision to check',
            'data_elements Site Section: no production revision to check',
            'extensions core: no production revision to check',
            'rules Load: no production revision to check',
            'rules Click: no production revision to check'
        ]);
    });

    test('a difference only in the printed text is reported as such', () => {
        const container = parseScript(FIXTURE).container;
        // JSON.stringify prints this entry as something else; its keys are untouched
        Object.defineProperty(container.dataElements['Site Section'], 'toJSON', { value: () => 'changed' });
        expect(run({ container })).toEqual(['data_elements Site Section: differs from production at (printed text)']);
    });

    test("an entry whose package has a transform the writers can't apply is a problem, not a crash", () => {
        const fileTransform = {
            ...PACKAGE,
            attributes: { ...PACKAGE.attributes, actions: PACKAGE.attributes.actions.map(def => ({ ...def, transforms: [{ type: 'file', propertyPath: 'source' }] })) }
        };
        expect(run({ packages: new Map([[PACKAGE.id, fileTransform]]) })).toEqual([
            "rules Load: file transform on source isn't supported",
            "rules Click: file transform on source isn't supported"
        ]);
    });

    test('an extension package that is missing is an error naming the revision', () => {
        expect(() => run({ packages: new Map() })).toThrow(`${PRODUCTION.revisions.data_elements[0].id} needs extension package ${PACKAGE.id}, which isn't in the packages`);
    });
});

describe('firstDifference', () => {
    test('is null for equal values', () => {
        expect(firstDifference({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 2 }] })).toBeNull();
    });

    test('joins keys and array indexes with dots', () => {
        expect(firstDifference({ a: 1, b: [1, { c: 2 }] }, { a: 1, b: [1, { c: 3 }] })).toBe('b.1.c');
    });

    test('a key one side lacks ends the path', () => {
        expect(firstDifference({ x: 1, y: 2 }, { x: 1 })).toBe('y');
        expect(firstDifference({ x: 1 }, { x: 1, y: 2 })).toBe('y');
        expect(firstDifference({ a: 1, c: 3 }, { a: 1, b: 2, c: 3 })).toBe('b');
        expect(firstDifference({ a: 1, b: 2, c: 3 }, { a: 1, c: 3 })).toBe('b');
    });

    test('keys in a different order end the path at the first side\'s key', () => {
        expect(firstDifference({ x: 1, y: 2 }, { y: 2, x: 1 })).toBe('x');
    });

    test('arrays differ by index, and a different type or primitive ends the path where it is', () => {
        expect(firstDifference({ list: [1, 2] }, { list: [1, 2, 3] })).toBe('list.2');
        expect(firstDifference({ v: [] }, { v: {} })).toBe('v');
        expect(firstDifference({ v: null }, { v: {} })).toBe('v');
        expect(firstDifference({ v: 1 }, { v: 2 })).toBe('v');
    });
});

describe('checkBehindProduction', () => {
    const clickRevision = (revisionNumber) => revision('rules', 90, { name: 'Click', revision_number: revisionNumber }, reactorId('RL', 2));
    const library = (rules) => ({ rules: rules.map(r => ({ revision: r })), data_elements: [], extensions: [] });

    test('behind production', () => {
        expect(checkBehindProduction(library([clickRevision(0)]), PRODUCTION.revisions))
            .toEqual(['rules Click: the library holds revision 0, production runs 1']);
        expect(checkBehindProduction(library([clickRevision(2)]), PRODUCTION.revisions)).toEqual([]);
    });

    test('as new as production is not behind', () => {
        expect(checkBehindProduction(library([clickRevision(1)]), PRODUCTION.revisions)).toEqual([]);
    });

    test('an item production does not have is not behind', () => {
        const added = revision('rules', 91, { name: 'Added', revision_number: 0 }, reactorId('RL', 99));
        expect(checkBehindProduction(library([added]), PRODUCTION.revisions)).toEqual([]);
    });

    test('problems come data elements first, then extensions, then rules, named by the library revision', () => {
        const behind = (type, n, name, origin) => ({ revision: revision(type, n, { name, revision_number: 0 }, origin) });
        const items = {
            rules: [behind('rules', 90, 'Click', reactorId('RL', 2))],
            data_elements: [behind('data_elements', 91, 'Page Title', reactorId('DE', 1))],
            extensions: [behind('extensions', 92, 'core', reactorId('EX', 1))]
        };
        expect(checkBehindProduction(items, PRODUCTION.revisions)).toEqual([
            'data_elements Page Title: the library holds revision 0, production runs 1',
            'extensions core: the library holds revision 0, production runs 1',
            'rules Click: the library holds revision 0, production runs 1'
        ]);
    });
});
