'use strict';

const { checkStageDestinations } = require('../../lib/reactor-core/runtime-script');

// Containers built by hand: only the parts the check reads
const container = (extensions) => ({ extensions: { core: { settings: {} }, ...extensions } });
const alloy = (...instances) => ({ settings: { instances } });
const instance = (edgeConfigId, developmentEdgeConfigId) => ({ edgeConfigId, stagingEdgeConfigId: 'staging-datastream', developmentEdgeConfigId });
const analytics = (accounts) => ({ settings: { libraryCode: { accounts } } });
const check = (extensions) => checkStageDestinations(container(extensions));

const NO_DATASTREAM = (index) => `adobe-alloy instance ${index}: no development datastream, so test traffic would reach production`;
const PRODUCTION_DATASTREAM = (index) => `adobe-alloy instance ${index}: the development datastream is production's`;
const NO_REPORT_SUITES = 'adobe-analytics: no development report suites, so test traffic would reach production';
const PRODUCTION_REPORT_SUITE = "adobe-analytics: a development report suite is production's";

describe('checkStageDestinations', () => {
    describe('adobe-alloy', () => {
        test('alloy with a development datastream passes', () => {
            expect(check({ 'adobe-alloy': alloy(instance('prod-datastream', 'dev-datastream')) })).toEqual({ problems: [], unaware: [] });
        });

        test('alloy with an empty development datastream stops', () => {
            expect(check({ 'adobe-alloy': alloy(instance('prod-datastream', '')) }).problems).toEqual([NO_DATASTREAM(0)]);
        });

        test('alloy with no development datastream at all stops', () => {
            const missing = { edgeConfigId: 'prod-datastream', stagingEdgeConfigId: 'staging-datastream' };
            expect(check({ 'adobe-alloy': alloy(missing) }).problems).toEqual([NO_DATASTREAM(0)]);
        });

        test('alloy with the production datastream as development stops', () => {
            expect(check({ 'adobe-alloy': alloy(instance('prod-datastream', 'prod-datastream')) }).problems).toEqual([PRODUCTION_DATASTREAM(0)]);
        });

        test('each alloy instance is checked, counted from 0', () => {
            const instances = [instance('a', 'dev-a'), instance('b', ''), instance('c', 'dev-c'), instance('d', 'd')];
            expect(check({ 'adobe-alloy': alloy(...instances) }).problems).toEqual([NO_DATASTREAM(1), PRODUCTION_DATASTREAM(3)]);
        });

        test('alloy with no instances has nothing to stop', () => {
            expect(check({ 'adobe-alloy': {} })).toEqual({ problems: [], unaware: [] });
            expect(check({ 'adobe-alloy': { settings: {} } })).toEqual({ problems: [], unaware: [] });
            expect(check({ 'adobe-alloy': alloy() })).toEqual({ problems: [], unaware: [] });
        });
    });

    describe('adobe-analytics', () => {
        test('analytics with a development report suite of its own passes', () => {
            const accounts = { production: ['prod-suite'], staging: ['staging-suite'], development: ['dev-suite'] };
            expect(check({ 'adobe-analytics': analytics(accounts) })).toEqual({ problems: [], unaware: [] });
        });

        test.each([
            ['an empty list', { production: ['prod-suite'], development: [] }],
            ['no development key', { production: ['prod-suite'] }],
            ['no accounts', undefined],
        ])('analytics with no development report suites stops: %s', (_, accounts) => {
            expect(check({ 'adobe-analytics': analytics(accounts) }).problems).toEqual([NO_REPORT_SUITES]);
        });

        test.each([
            ['no settings', {}],
            ['no library code', { settings: {} }],
            ['no accounts', { settings: { libraryCode: {} } }],
        ])('analytics with %s counts as no development report suites', (_, extension) => {
            expect(check({ 'adobe-analytics': extension }).problems).toEqual([NO_REPORT_SUITES]);
        });

        test('analytics sharing a production report suite stops', () => {
            const accounts = { production: ['prod-suite', 'other-prod-suite'], development: ['dev-suite', 'other-prod-suite'] };
            expect(check({ 'adobe-analytics': analytics(accounts) }).problems).toEqual([PRODUCTION_REPORT_SUITE]);
        });
    });

    describe('other extensions', () => {
        test('other extensions are listed as unaware', () => {
            const result = check({ 'adobe-alloy': alloy(instance('prod-datastream', 'dev-datastream')), 'facebook-pixel': { settings: {} } });
            expect(result).toEqual({ problems: [], unaware: ['facebook-pixel'] });
        });

        test('core is not listed as unaware', () => {
            expect(check({})).toEqual({ problems: [], unaware: [] });
        });

        test('a stage-aware extension is not listed as unaware, even when it stops', () => {
            const result = check({ 'adobe-alloy': alloy(instance('prod-datastream', '')), 'adobe-analytics': analytics({ development: [] }) });
            expect(result.unaware).toEqual([]);
            expect(result.problems).toEqual([NO_DATASTREAM(0), NO_REPORT_SUITES]);
        });

        test('an extension named like an Object property is unaware', () => {
            expect(check({ constructor: {}, toString: {} }).unaware).toEqual(['constructor', 'toString']);
        });
    });

    test('problems and unaware follow the container order', () => {
        const extensions = {
            'facebook-pixel': {},
            'adobe-analytics': analytics({ development: [] }),
            'google-ads': {},
            'adobe-alloy': alloy(instance('prod-datastream', '')),
        };
        expect(check(extensions)).toEqual({
            problems: [NO_REPORT_SUITES, NO_DATASTREAM(0)],
            unaware: ['facebook-pixel', 'google-ads'],
        });
    });
});
