'use strict';

const { fingerprint } = require('../lib/reactor-core/diff/normalize');

// A data element as the API returns it, bookkeeping fields included.
function dataElement(attributes = {}) {
    return {
        id: 'DE00000000000000000000000000000001',
        type: 'data_elements',
        attributes: {
            name: 'Page Name',
            enabled: true,
            delegate_descriptor_id: 'core::dataElements::custom-code',
            settings: JSON.stringify({ source: 'return 1;\nreturn 2;', options: { a: 1, b: [1, 2] } }),
            default_value: null,
            force_lower_case: false,
            clean_text: false,
            storage_duration: null,
            published: false,
            published_at: null,
            dirty: false,
            review_status: 'unsubmitted',
            revision_number: 0,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-11-01T00:00:00.000Z',
            deleted_at: null,
            created_by_email: 'someone@example.com',
            created_by_display_name: 'Someone',
            updated_by_email: 'someone@example.com',
            updated_by_display_name: 'Someone',
            ...attributes
        }
    };
}

describe('fingerprint', () => {
    test('ignores what a library publish or another person changes', () => {
        const published = dataElement({
            published: true,
            published_at: '2026-11-02T00:00:00.000Z',
            dirty: true,
            review_status: 'submitted',
            revision_number: 4,
            updated_at: '2026-11-02T00:00:00.000Z',
            updated_by_email: 'other@example.com',
            updated_by_display_name: 'Other'
        });
        expect(fingerprint(published)).toBe(fingerprint(dataElement()));
    });

    test('ignores CRLF line endings in settings', () => {
        const crlf = dataElement({ settings: JSON.stringify({ source: 'return 1;\r\nreturn 2;', options: { a: 1, b: [1, 2] } }) });
        expect(fingerprint(crlf)).toBe(fingerprint(dataElement()));
    });

    test('ignores key order in settings at every level', () => {
        const reordered = dataElement({ settings: JSON.stringify({ options: { b: [1, 2], a: 1 }, source: 'return 1;\nreturn 2;' }) });
        expect(fingerprint(reordered)).toBe(fingerprint(dataElement()));
    });

    test('keeps array order', () => {
        const swapped = dataElement({ settings: JSON.stringify({ source: 'return 1;\nreturn 2;', options: { a: 1, b: [2, 1] } }) });
        expect(fingerprint(swapped)).not.toBe(fingerprint(dataElement()));
    });

    test.each([
        ['name', { name: 'Renamed' }],
        ['enabled', { enabled: false }],
        ['settings', { settings: JSON.stringify({ source: 'return 3;', options: { a: 1, b: [1, 2] } }) }],
        ['default_value', { default_value: 'x' }],
        ['storage_duration', { storage_duration: 'session' }]
    ])('changes when %s changes', (_, attributes) => {
        expect(fingerprint(dataElement(attributes))).not.toBe(fingerprint(dataElement()));
    });

    test('compares settings that are not JSON as text', () => {
        const text = (settings) => fingerprint(dataElement({ settings }));
        expect(text('not json')).toBe(text('not json'));
        expect(text('not json\r\n')).toBe(text('not json\n'));
        expect(text('not json')).not.toBe(text('other'));
    });

    test('compares each type on its own attributes', () => {
        const rule = (attributes) => ({ id: 'RL1', type: 'rules', attributes: { name: 'Rule', enabled: true, ...attributes } });
        expect(fingerprint(rule({ revision_number: 9 }))).toBe(fingerprint(rule()));
        expect(fingerprint(rule({ enabled: false }))).not.toBe(fingerprint(rule()));

        const component = (attributes) => ({
            id: 'RC1', type: 'rule_components',
            attributes: { name: 'Code', order: 0, rule_order: 50, timeout: 2000, delay_next: true, negate: false, settings: '{}', ...attributes }
        });
        expect(fingerprint(component({ order: 1 }))).not.toBe(fingerprint(component()));
        expect(fingerprint(component({ negate: true }))).not.toBe(fingerprint(component()));

        // An extension's name and display name come from its package; an
        // upgrade shows up as a new version.
        const extension = (attributes) => ({
            id: 'EX1', type: 'extensions',
            attributes: { name: 'core', display_name: 'Core', enabled: true, version: '3.4.0', settings: '{}', ...attributes }
        });
        expect(fingerprint(extension({ display_name: 'Core (renamed)' }))).toBe(fingerprint(extension()));
        expect(fingerprint(extension({ version: '3.5.0' }))).not.toBe(fingerprint(extension()));
    });

    test('treats a missing attribute as null', () => {
        const item = dataElement();
        delete item.attributes.storage_duration;
        expect(fingerprint(item)).toBe(fingerprint(dataElement()));
    });
});
