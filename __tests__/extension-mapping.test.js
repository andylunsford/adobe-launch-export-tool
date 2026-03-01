'use strict';

const mapping = require('../extension-mapping');

// ─── getFriendlyName ──────────────────────────────────────────────────────────

describe('getFriendlyName', () => {
    test('returns known extension name for known key', () => {
        expect(mapping.getFriendlyName('core::events::library-loaded')).toBe('Core');
        expect(mapping.getFriendlyName('adobe-analytics::actions::set-variables')).toBe('Adobe Analytics');
        expect(mapping.getFriendlyName('adobe-alloy::actions::send-event')).toBe('Adobe Experience Platform Web SDK');
    });

    test('formats unknown extension key as Title Case words', () => {
        expect(mapping.getFriendlyName('my-custom-extension::events::click')).toBe('My Custom Extension');
    });

    test('returns falsy input unchanged', () => {
        expect(mapping.getFriendlyName(null)).toBeNull();
        expect(mapping.getFriendlyName(undefined)).toBeUndefined();
        expect(mapping.getFriendlyName('')).toBe('');
    });

    test('handles descriptor with no :: separator (single-part id)', () => {
        // Should capitalize first char of the single part
        expect(mapping.getFriendlyName('core')).toBe('Core');
    });
});

// ─── getFriendlyComponentType ─────────────────────────────────────────────────

describe('getFriendlyComponentType', () => {
    test('returns known component type label', () => {
        expect(mapping.getFriendlyComponentType('core::events::custom-code')).toBe('Custom Code');
        expect(mapping.getFriendlyComponentType('adobe-alloy::actions::send-event')).toBe('Send Event');
        expect(mapping.getFriendlyComponentType('core::events::dom-ready')).toBe('DOM Ready');
    });

    test('formats unknown component type key as Title Case', () => {
        expect(mapping.getFriendlyComponentType('ext::actions::my-action-type')).toBe('My Action Type');
    });

    test('returns empty string for falsy input', () => {
        expect(mapping.getFriendlyComponentType(null)).toBe('');
        expect(mapping.getFriendlyComponentType('')).toBe('');
        expect(mapping.getFriendlyComponentType(undefined)).toBe('');
    });
});

// ─── getComponentType ─────────────────────────────────────────────────────────

describe('getComponentType', () => {
    test('identifies events', () => {
        expect(mapping.getComponentType('core::events::library-loaded')).toBe('events');
    });

    test('identifies conditions', () => {
        expect(mapping.getComponentType('core::conditions::value-comparison')).toBe('conditions');
    });

    test('identifies actions', () => {
        expect(mapping.getComponentType('adobe-analytics::actions::set-variables')).toBe('actions');
    });

    test('returns unknown for unrecognised pattern', () => {
        expect(mapping.getComponentType('core::other::something')).toBe('unknown');
        expect(mapping.getComponentType('no-separator')).toBe('unknown');
    });

    test('returns unknown for falsy input', () => {
        expect(mapping.getComponentType(null)).toBe('unknown');
        expect(mapping.getComponentType(undefined)).toBe('unknown');
        expect(mapping.getComponentType('')).toBe('unknown');
    });
});
