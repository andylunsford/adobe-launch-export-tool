'use strict';

const db = require('../lib/db');

// Minimal JSON:API records in the shape the Reactor API returns them.
const property = { id: 'PR1', attributes: { name: 'Property', platform: 'web' } };
const library = { id: 'LB1', type: 'libraries', attributes: { name: 'Release 1', state: 'published' } };
const environment = { id: 'EN1', type: 'environments', attributes: { name: 'Production', stage: 'production' } };

const withOrigin = (id, type, attributes) => ({
    id, type, attributes, relationships: { origin: { data: { id, type } } }
});
const rule = (id, name) => withOrigin(id, 'rules', { name, enabled: true, revision_number: 0 });
const component = (id) => withOrigin(id, 'rule_components', {
    name: 'Custom Code', delegate_descriptor_id: 'core::actions::custom-code', order: 0
});
const dataElement = (id) => withOrigin(id, 'data_elements', {
    name: 'Page Name', delegate_descriptor_id: 'core::dataElements::javascript-variable'
});
const extension = (id) => withOrigin(id, 'extensions', { name: 'core', display_name: 'Core', version: '3.4.1' });

// Each test gets a fresh in-memory database.
beforeEach(() => db.initDb(':memory:'));

describe('cache upserts', () => {
    test('re-saving a property keeps everything cached under it', () => {
        db.upsertProperty(property);
        db.upsertRules([rule('RL1', 'Page Load')], 'PR1');
        db.upsertRuleComponents([component('RC1')], 'RL1', 'PR1');
        db.upsertDataElements([dataElement('DE1')], 'PR1');
        db.upsertExtensions([extension('EX1')], 'PR1');
        db.upsertEnvironment(environment, 'PR1');
        db.upsertLibrary(library, 'PR1');

        db.upsertProperty(property);

        expect(db.getCacheStats('PR1')).toMatchObject({
            rules: 1, rule_components: 1, data_elements: 1, extensions: 1, environments: 1, libraries: 1
        });
    });

    test('re-saving a rule keeps its components and library link', () => {
        db.upsertProperty(property);
        db.upsertLibrary(library, 'PR1');
        db.upsertRules([rule('RL1', 'Page Load')], 'PR1');
        db.upsertRuleComponents([component('RC1')], 'RL1', 'PR1');
        db.linkLibraryRules('LB1', [rule('RL1', 'Page Load')]);

        db.upsertRules([rule('RL1', 'Page Load')], 'PR1');

        const cached = db.getRulesForLibrary('LB1');
        expect(cached.map(r => [r.id, r.rule_components.map(c => c.id)])).toEqual([['RL1', ['RC1']]]);
    });

    test('re-saving a rule stores its new attributes', () => {
        db.upsertProperty(property);
        db.upsertLibrary(library, 'PR1');
        db.upsertRules([rule('RL1', 'Page Load')], 'PR1');
        db.linkLibraryRules('LB1', [rule('RL1', 'Page Load')]);

        db.upsertRules([rule('RL1', 'Page Load (renamed)')], 'PR1');

        expect(db.getRulesForLibrary('LB1').map(r => r.attributes.name)).toEqual(['Page Load (renamed)']);
    });
});
