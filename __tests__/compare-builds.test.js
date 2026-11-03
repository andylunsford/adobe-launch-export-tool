'use strict';

const { diffSets } = require('../lib/reactor-core/compare-builds');

// A revision as a build lists it: its own id, its head's id under `origin`, and
// the bookkeeping every new revision gets (number, timestamps, authorship).
function revision(type, origin, n, attributes = {}, relationships = {}) {
    const at = `2026-10-0${n}T00:00:00.000Z`;
    return {
        id: `${origin}r${n}`,
        type,
        attributes: {
            name: `${origin} name`,
            revision_number: n,
            created_at: at,
            updated_at: at,
            published: false,
            published_at: null,
            dirty: false,
            created_by_email: `editor${n}@example.com`,
            created_by_display_name: `Editor ${n}`,
            updated_by_email: `editor${n}@example.com`,
            updated_by_display_name: `Editor ${n}`,
            ...attributes
        },
        relationships: { origin: { data: { id: origin, type } }, ...relationships }
    };
}

const dataElement = (origin, n, attributes) => revision('data_elements', origin, n, {
    delegate_descriptor_id: 'core::dataElements::custom-code',
    settings: '{"source":"return 1;"}',
    ...attributes
}, undefined);

const rule = (origin, n, attributes) => revision('rules', origin, n, { enabled: true, ...attributes });

const component = (origin, n, attributes, relationships) => revision('rule_components', origin, n, {
    delegate_descriptor_id: 'core::actions::custom-code',
    order: 0,
    settings: '{"language":"javascript","source":"run();"}',
    timeout: 2000,
    delay_next: true,
    ...attributes
}, relationships);

const sets = ({ rules = [], data_elements = [], extensions = [] } = {}) => ({ rules, data_elements, extensions });

// Components per rule revision id, as `/rules/{rev}/rule_components` returns them.
function componentLoader(byRuleId) {
    return jest.fn(async (ruleRevision) => byRuleId[ruleRevision.id] ?? []);
}

// ─── data elements and extensions ─────────────────────────────────────────────

describe('diffSets: data elements and extensions', () => {
    test('the same revision on both sides is identical', async () => {
        const de = dataElement('DE1', 2);

        const result = await diffSets(sets({ data_elements: [de] }), sets({ data_elements: [de] }));

        expect(result.data_elements.identical.map(x => x.id)).toEqual(['DE1r2']);
        expect(result.data_elements.modified).toHaveLength(0);
    });

    test('a new revision that changes only bookkeeping is revised, not modified', async () => {
        // Key order and spacing differ too: settings compare as parsed JSON.
        const before = dataElement('DE1', 1, { settings: '{"source":"return 1;","language":"javascript"}' });
        const after = dataElement('DE1', 2, { settings: '{ "language": "javascript", "source": "return 1;" }' });

        const result = await diffSets(sets({ data_elements: [before] }), sets({ data_elements: [after] }));

        expect(result.data_elements.modified).toHaveLength(0);
        expect(result.data_elements.revised).toEqual([
            expect.objectContaining({ id: 'DE1r2', revisionNumberA: 1, revisionNumberB: 2 })
        ]);
    });

    test('a changed setting is a modification, reported with the parsed settings', async () => {
        const before = dataElement('DE1', 1, { settings: '{"source":"return 1;"}' });
        const after = dataElement('DE1', 2, { settings: '{"source":"return 2;"}' });

        const result = await diffSets(sets({ data_elements: [before] }), sets({ data_elements: [after] }));

        expect(result.data_elements.modified).toHaveLength(1);
        expect(result.data_elements.modified[0].attributeDiffs).toEqual([
            { field: 'settings', oldValue: { source: 'return 1;' }, newValue: { source: 'return 2;' } }
        ]);
    });

    test('revisions pair by origin, so a rename modifies one item', async () => {
        const before = dataElement('DE1', 1, { name: 'Page Name' });
        const after = dataElement('DE1', 2, { name: 'Page Title' });

        const result = await diffSets(sets({ data_elements: [before] }), sets({ data_elements: [after] }));

        expect(result.data_elements.onlyInA).toHaveLength(0);
        expect(result.data_elements.onlyInB).toHaveLength(0);
        expect(result.data_elements.modified[0]).toEqual(expect.objectContaining({
            name: 'Page Name → Page Title',
            attributeDiffs: [{ field: 'name', oldValue: 'Page Name', newValue: 'Page Title' }]
        }));
    });

    test('an item on one side only is removed or added', async () => {
        const result = await diffSets(
            sets({ data_elements: [dataElement('DE1', 1)] }),
            sets({ data_elements: [dataElement('DE2', 1)] })
        );

        expect(result.data_elements.onlyInA.map(x => x.id)).toEqual(['DE1r1']);
        expect(result.data_elements.onlyInB.map(x => x.id)).toEqual(['DE2r1']);
    });

    test('an extension upgrade is a modification of its version', async () => {
        const ext = (n, version) => revision('extensions', 'EX1', n, { name: 'core', display_name: 'Core', version, settings: null });

        const result = await diffSets(sets({ extensions: [ext(1, '3.4.1')] }), sets({ extensions: [ext(2, '3.4.2')] }));

        expect(result.extensions.modified[0].attributeDiffs).toEqual([
            { field: 'version', oldValue: '3.4.1', newValue: '3.4.2' }
        ]);
    });
});

// ─── rules ────────────────────────────────────────────────────────────────────

describe('diffSets: rules', () => {
    test('the same rule revision is identical without fetching its components', async () => {
        const loadComponents = componentLoader({});
        const r = rule('RL1', 3);

        const result = await diffSets(sets({ rules: [r] }), sets({ rules: [r] }), { loadComponents });

        expect(result.rules.identical.map(x => x.id)).toEqual(['RL1r3']);
        expect(loadComponents).not.toHaveBeenCalled();
    });

    test('an added rule lists its components, events first, without bookkeeping', async () => {
        const loadComponents = componentLoader({
            RL2r1: [
                component('RC2', 1, { name: 'Send Beacon', order: 0 }),
                component('RC1', 1, { name: 'Page Bottom', delegate_descriptor_id: 'core::events::page-bottom', settings: '{}' })
            ]
        });

        const result = await diffSets(sets(), sets({ rules: [rule('RL2', 1)] }), { loadComponents });

        expect(result.rules.onlyInB[0].components).toEqual([
            { name: 'Page Bottom', componentType: 'core::events::page-bottom',
              attributes: { settings: {}, timeout: 2000, delay_next: true } },
            { name: 'Send Beacon', componentType: 'core::actions::custom-code',
              attributes: { settings: { language: 'javascript', source: 'run();' }, timeout: 2000, delay_next: true } }
        ]);
    });

    test('a removed rule is listed by name, without fetching its components', async () => {
        const loadComponents = componentLoader({});

        const result = await diffSets(sets({ rules: [rule('RL1', 1)] }), sets({ rules: [rule('RL2', 1)] }), { loadComponents });

        expect(result.rules.onlyInA.map(x => x.id)).toEqual(['RL1r1']);
        expect(loadComponents.mock.calls.map(([r]) => r.id)).toEqual(['RL2r1']);
    });

    test('a rule revised with no change is revised, though every component got a new revision', async () => {
        // Revising a rule cuts a revision of each of its components with the rule's number.
        const loadComponents = componentLoader({
            RL1r1: [component('RC1', 1), component('RC2', 1, { order: 1 })],
            RL1r2: [component('RC1', 2), component('RC2', 2, { order: 1 })]
        });

        const result = await diffSets(sets({ rules: [rule('RL1', 1)] }), sets({ rules: [rule('RL1', 2)] }), { loadComponents });

        expect(result.rules.modified).toHaveLength(0);
        expect(result.rules.revised.map(x => x.id)).toEqual(['RL1r2']);
        expect(loadComponents.mock.calls.map(([r]) => r.id).sort()).toEqual(['RL1r1', 'RL1r2']);
    });

    test('a changed component setting modifies the rule and names the component', async () => {
        const loadComponents = componentLoader({
            RL1r1: [component('RC1', 1, { name: 'Track' })],
            RL1r2: [component('RC1', 2, { name: 'Track', settings: '{"language":"javascript","source":"track();"}' })]
        });

        const result = await diffSets(sets({ rules: [rule('RL1', 1)] }), sets({ rules: [rule('RL1', 2)] }), { loadComponents });

        expect(result.rules.modified).toHaveLength(1);
        expect(result.rules.modified[0].attributeDiffs).toEqual([]);
        expect(result.rules.modified[0].componentDiffs).toEqual([{
            type: 'modified',
            name: 'Track',
            componentType: 'core::actions::custom-code',
            attributeDiffs: [{
                field: 'settings',
                oldValue: { language: 'javascript', source: 'run();' },
                newValue: { language: 'javascript', source: 'track();' }
            }]
        }]);
    });

    test('components added, removed and moved are each reported', async () => {
        const loadComponents = componentLoader({
            RL1r1: [component('RC1', 1, { name: 'First', order: 0 }), component('RC2', 1, { name: 'Second', order: 1 }),
                    component('RC3', 1, { name: 'Dropped', order: 2 })],
            RL1r2: [component('RC2', 2, { name: 'Second', order: 0 }), component('RC1', 2, { name: 'First', order: 1 }),
                    component('RC4', 2, { name: 'New', order: 2 })]
        });

        const result = await diffSets(sets({ rules: [rule('RL1', 1)] }), sets({ rules: [rule('RL1', 2)] }), { loadComponents });

        const diffs = result.rules.modified[0].componentDiffs.map(c => [c.type, c.name]);
        expect(diffs).toEqual(expect.arrayContaining([
            ['reordered', 'First'], ['reordered', 'Second'], ['removed', 'Dropped'], ['added', 'New']
        ]));
        expect(diffs).toHaveLength(4);
    });

    test('a component re-pinned to another extension revision is not a change', async () => {
        // What runs is the build's extension revision, not the component's pin.
        const pin = (id) => ({ updated_with_extension: { data: { id, type: 'extensions' } } });
        const loadComponents = componentLoader({
            RL1r1: [component('RC1', 1, {}, pin('EX1r1'))],
            RL1r2: [component('RC1', 2, {}, pin('EX1r2'))]
        });

        const result = await diffSets(sets({ rules: [rule('RL1', 1)] }), sets({ rules: [rule('RL1', 2)] }), { loadComponents });

        expect(result.rules.revised).toHaveLength(1);
        expect(result.rules.modified).toHaveLength(0);
    });

    test('timeout and delay_next count only when rule component sequencing is on', async () => {
        const loadComponents = componentLoader({
            RL1r1: [component('RC1', 1, { timeout: 2000, delay_next: true })],
            RL1r2: [component('RC1', 2, { timeout: 5000, delay_next: false })]
        });
        const before = sets({ rules: [rule('RL1', 1)] });
        const after = sets({ rules: [rule('RL1', 2)] });

        const off = await diffSets(before, after, { loadComponents, sequencing: false });
        const on = await diffSets(before, after, { loadComponents, sequencing: true });

        expect(off.rules.revised).toHaveLength(1);
        expect(on.rules.modified[0].componentDiffs[0].attributeDiffs.map(d => d.field).sort())
            .toEqual(['delay_next', 'timeout']);
    });

    test('disabling a rule is a modification', async () => {
        const loadComponents = componentLoader({ RL1r1: [component('RC1', 1)], RL1r2: [component('RC1', 2)] });

        const result = await diffSets(
            sets({ rules: [rule('RL1', 1, { enabled: true })] }),
            sets({ rules: [rule('RL1', 2, { enabled: false })] }),
            { loadComponents }
        );

        expect(result.rules.modified[0].attributeDiffs).toEqual([{ field: 'enabled', oldValue: true, newValue: false }]);
    });
});
