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
const ALLOY_UNREADABLE = "adobe-alloy: can't read its datastreams, so test traffic could reach production";
const INSTANCE_UNREADABLE = (index) => `adobe-alloy instance ${index}: can't read its datastreams, so test traffic could reach production`;
const NO_REPORT_SUITES = 'adobe-analytics: no development report suites, so test traffic would reach production';
const PRODUCTION_REPORT_SUITE = "adobe-analytics: a development report suite is production's";
const REPORT_SUITES_UNREADABLE = "adobe-analytics: can't read its report suites, so test traffic could reach production";

// Web SDK overrides, on an instance or on a rule component
const OVERRIDES_UNREADABLE = (where) => `${where}: can't read its overrides, so test traffic could reach production`;
const OVERRIDE_DATASTREAM = (where) => `${where}: the development datastream override is production's`;
const OVERRIDE_REPORT_SUITE = (where) => `${where}: a development report suite override is production's`;
const SEND_EVENT = 'adobe-alloy/dist/lib/actions/sendEvent/index.js';
const sendEvent = (edgeConfigOverrides) => ({ modulePath: SEND_EVENT, settings: { instanceName: 'alloy', edgeConfigOverrides } });
const customCode = { modulePath: 'core/src/lib/actions/customCode.js', settings: { source: 'console.log(1);' } };
const domReady = { modulePath: 'core/src/lib/events/domReady.js', settings: {} };
const rule = (name, { events = [domReady], conditions = [], actions = [] }) => ({ id: `RL-${name}`, name, events, conditions, actions });
const overriding = (edgeConfigOverrides, ids = ['prod-datastream', 'dev-datastream']) => ({ ...instance(...ids), edgeConfigOverrides });
const PRODUCTION_ALLOY = { 'adobe-alloy': alloy(instance('prod-datastream', 'dev-datastream')) };
/** The check on a container with these rules, and production's one alloy instance unless other extensions are given. */
const checkRules = (rules, extensions = PRODUCTION_ALLOY) => checkStageDestinations({ ...container(extensions), rules });
const actionAt = (name, index) => `rule ${name}: adobe-alloy action ${index}`;

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

        test('a development datastream that is only blank stops', () => {
            expect(check({ 'adobe-alloy': alloy(instance('prod-datastream', ' \t ')) }).problems).toEqual([NO_DATASTREAM(0)]);
        });

        test('alloy with the production datastream as development stops', () => {
            expect(check({ 'adobe-alloy': alloy(instance('prod-datastream', 'prod-datastream')) }).problems).toEqual([PRODUCTION_DATASTREAM(0)]);
        });

        test('the same datastream in a different case or with spaces around it is the same datastream', () => {
            expect(check({ 'adobe-alloy': alloy(instance('Prod-Datastream', ' prod-datastream ')) }).problems).toEqual([PRODUCTION_DATASTREAM(0)]);
            expect(check({ 'adobe-alloy': alloy(instance(' prod-datastream', 'PROD-DATASTREAM\n')) }).problems).toEqual([PRODUCTION_DATASTREAM(0)]);
        });

        test("another instance's production datastream as development stops", () => {
            const instances = [instance('prod-a', 'dev-a'), instance('prod-b', 'prod-a')];
            expect(check({ 'adobe-alloy': alloy(...instances) }).problems).toEqual([PRODUCTION_DATASTREAM(1)]);
        });

        test('each alloy instance is checked, counted from 0', () => {
            const instances = [instance('a', 'dev-a'), instance('b', ''), instance('c', 'dev-c'), instance('d', 'd')];
            expect(check({ 'adobe-alloy': alloy(...instances) }).problems).toEqual([NO_DATASTREAM(1), PRODUCTION_DATASTREAM(3)]);
        });

        test('alloy with an empty list of instances has nothing to stop', () => {
            expect(check({ 'adobe-alloy': alloy() })).toEqual({ problems: [], unaware: [] });
        });

        test.each([
            ['no settings', {}],
            ['empty settings', { settings: {} }],
            ['a null entry', null],
            ['settings that are one instance, not a list of them', { settings: { edgeConfigId: 'prod-datastream', developmentEdgeConfigId: 'dev-datastream' } }],
            ['instances that are an object', { settings: { instances: { 0: instance('prod-datastream', 'dev-datastream') } } }],
            ['instances that are a string', { settings: { instances: 'prod-datastream' } }],
            ['null instances', { settings: { instances: null } }],
        ])('alloy with %s can\'t be read, so it stops', (_, extension) => {
            expect(check({ 'adobe-alloy': extension }).problems).toEqual([ALLOY_UNREADABLE]);
        });

        test.each([
            ['null', null],
            ['a string', 'prod-datastream'],
            ['a list', [instance('prod-datastream', 'dev-datastream')]],
        ])('an alloy instance that is %s can\'t be read, so it stops', (_, unreadable) => {
            const instances = [instance('a', 'dev-a'), unreadable, instance('c', 'dev-c')];
            expect(check({ 'adobe-alloy': alloy(...instances) }).problems).toEqual([INSTANCE_UNREADABLE(1)]);
        });

        test.each([
            ['a production datastream that is a number', instance(123, 'dev-datastream')],
            ['a development datastream that is a number', instance('prod-datastream', 123)],
            ['a development datastream that is null', instance('prod-datastream', null)],
            ['a development datastream that is a list', instance('prod-datastream', ['dev-datastream'])],
            ['a production datastream that is an object', instance({ id: 'prod-datastream' }, 'dev-datastream')],
        ])('an alloy instance with %s can\'t be read, so it stops', (_, unreadable) => {
            expect(check({ 'adobe-alloy': alloy(unreadable) }).problems).toEqual([INSTANCE_UNREADABLE(0)]);
        });

        test.each([
            ['the development datastream', instance('prod-datastream', '%devDatastream%')],
            ['the production datastream', instance('%prodDatastream%', 'dev-datastream')],
            ['part of the development datastream', instance('prod-datastream', 'datastream-%env%')],
        ])('a data element reference in %s can\'t be resolved, so it stops', (_, unresolved) => {
            expect(check({ 'adobe-alloy': alloy(unresolved) }).problems).toEqual([INSTANCE_UNREADABLE(0)]);
        });

        test('an instance that can\'t be read does not hide a problem in another', () => {
            const instances = [instance('prod-a', 123), instance('prod-b', ''), instance('prod-c', 'prod-c')];
            expect(check({ 'adobe-alloy': alloy(...instances) }).problems).toEqual([INSTANCE_UNREADABLE(0), NO_DATASTREAM(1), PRODUCTION_DATASTREAM(2)]);
        });
    });

    describe('adobe-analytics', () => {
        test('analytics with a development report suite of its own passes', () => {
            const accounts = { production: ['prod-suite'], staging: ['staging-suite'], development: ['dev-suite'] };
            expect(check({ 'adobe-analytics': analytics(accounts) })).toEqual({ problems: [], unaware: [] });
        });

        test('analytics without production report suites passes when it has development ones', () => {
            expect(check({ 'adobe-analytics': analytics({ development: ['dev-suite'] }) }).problems).toEqual([]);
        });

        test('blank entries are ignored', () => {
            const accounts = { production: ['', 'prod-suite'], development: ['  ', 'dev-suite', ''] };
            expect(check({ 'adobe-analytics': analytics(accounts) }).problems).toEqual([]);
        });

        test.each([
            ['an empty list', { production: ['prod-suite'], development: [] }],
            ['no development key', { production: ['prod-suite'] }],
            ['only blank entries', { production: ['prod-suite'], development: ['', '  ', '\t'] }],
            ['no accounts', undefined],
        ])('analytics with no development report suites stops: %s', (_, accounts) => {
            expect(check({ 'adobe-analytics': analytics(accounts) }).problems).toEqual([NO_REPORT_SUITES]);
        });

        test.each([
            ['no settings', {}],
            ['no library code', { settings: {} }],
            ['no accounts', { settings: { libraryCode: {} } }],
            ['a null entry', null],
        ])('analytics with %s counts as no development report suites', (_, extension) => {
            expect(check({ 'adobe-analytics': extension }).problems).toEqual([NO_REPORT_SUITES]);
        });

        test('analytics sharing a production report suite stops', () => {
            const accounts = { production: ['prod-suite', 'other-prod-suite'], development: ['dev-suite', 'other-prod-suite'] };
            expect(check({ 'adobe-analytics': analytics(accounts) }).problems).toEqual([PRODUCTION_REPORT_SUITE]);
        });

        test('the same report suite in a different case or with spaces around it is the same report suite', () => {
            expect(check({ 'adobe-analytics': analytics({ production: ['Prod-Suite'], development: [' prod-suite '] }) }).problems).toEqual([PRODUCTION_REPORT_SUITE]);
            expect(check({ 'adobe-analytics': analytics({ production: [' prod-suite\n'], development: ['PROD-SUITE'] }) }).problems).toEqual([PRODUCTION_REPORT_SUITE]);
        });

        test.each([
            ['production as a string, which would match by its letters', { production: 'rs', development: ['rs'] }],
            ['production as a number', { production: 7, development: ['dev-suite'] }],
            ['production as null', { production: null, development: ['dev-suite'] }],
            ['production as an object', { production: { 0: 'prod-suite' }, development: ['dev-suite'] }],
            ['development as a string', { production: ['prod-suite'], development: 'dev-suite' }],
            ['development as null', { production: ['prod-suite'], development: null }],
            ['development as an object', { production: ['prod-suite'], development: { 0: 'dev-suite' } }],
            ['a number among the development report suites', { production: ['prod-suite'], development: ['dev-suite', 7] }],
            ['a null among the production report suites', { production: ['prod-suite', null], development: ['dev-suite'] }],
            ['a list among the development report suites', { production: ['prod-suite'], development: [['dev-suite']] }],
            ['a data element reference among the development report suites', { production: ['prod-suite'], development: ['%devSuite%'] }],
            ['a data element reference among the production report suites', { production: ['prod-%env%'], development: ['dev-suite'] }],
        ])('analytics with %s can\'t be read, so it stops', (_, accounts) => {
            expect(check({ 'adobe-analytics': analytics(accounts) }).problems).toEqual([REPORT_SUITES_UNREADABLE]);
        });

        // AppMeasurement tags every report suite in a comma-separated account
        test('a report suite inside a comma-joined entry is a report suite', () => {
            expect(check({ 'adobe-analytics': analytics({ production: ['prodrs'], development: ['devrs, prodrs'] }) }).problems).toEqual([PRODUCTION_REPORT_SUITE]);
            expect(check({ 'adobe-analytics': analytics({ production: ['otherrs,PRODRS'], development: ['prodrs'] }) }).problems).toEqual([PRODUCTION_REPORT_SUITE]);
        });

        test('a comma-joined entry of distinct report suites passes', () => {
            expect(check({ 'adobe-analytics': analytics({ production: ['prodrs, rolluprs'], development: ['devrs,devrollup'] }) }).problems).toEqual([]);
        });

        test('an entry of only commas and spaces is blank', () => {
            expect(check({ 'adobe-analytics': analytics({ production: ['prodrs'], development: [' , ,'] }) }).problems).toEqual([NO_REPORT_SUITES]);
        });
    });

    describe('Web SDK overrides', () => {
        test('a Send event action whose development datastream is an instance\'s production datastream stops', () => {
            const rules = [rule('Send', { actions: [sendEvent({ development: { datastreamId: 'prod-datastream' } })] })];
            expect(checkRules(rules).problems).toEqual([OVERRIDE_DATASTREAM(actionAt('Send', 0))]);
        });

        test("a development datastream that is another action's production override stops", () => {
            const rules = [
                rule('Checkout', { actions: [sendEvent({ production: { datastreamId: 'checkout-prod' }, development: { datastreamId: 'checkout-dev' } })] }),
                rule('Send', { actions: [customCode, sendEvent({ development: { datastreamId: ' Checkout-Prod ' } })] })
            ];
            expect(checkRules(rules).problems).toEqual([OVERRIDE_DATASTREAM(actionAt('Send', 1))]);
        });

        test("an instance's development datastream that is an override's production datastream stops", () => {
            const rules = [rule('Send', { actions: [sendEvent({ production: { datastreamId: 'dev-datastream' } })] })];
            expect(checkRules(rules).problems).toEqual([PRODUCTION_DATASTREAM(0)]);
        });

        test('a distinct development datastream override passes', () => {
            const rules = [rule('Send', { actions: [sendEvent({ production: { datastreamId: 'prod-other' }, development: { datastreamId: 'dev-other' } })] })];
            expect(checkRules(rules)).toEqual({ problems: [], unaware: [] });
        });

        test('a blank development datastream override sends where the instance does, so it passes', () => {
            const rules = [rule('Send', { actions: [sendEvent({ development: { datastreamId: '  ' } }), sendEvent({ development: { datastreamId: '' } })] })];
            expect(checkRules(rules).problems).toEqual([]);
        });

        test('staging and production overrides with no development key pass', () => {
            const overrides = { staging: { datastreamId: 'staging-other' }, production: { datastreamId: 'prod-other', com_adobe_analytics: { reportSuites: ['prodrs'] } } };
            expect(checkRules([rule('Send', { actions: [sendEvent(overrides)] })]).problems).toEqual([]);
        });

        test('a disabled development override that names production\'s datastream still stops', () => {
            const overrides = { development: { enabled: false, datastreamId: 'prod-datastream' } };
            expect(checkRules([rule('Send', { actions: [sendEvent(overrides)] })]).problems).toEqual([OVERRIDE_DATASTREAM(actionAt('Send', 0))]);
        });

        // With no stage keys, the runtime uses the whole object in every stage, production included
        test('an override for every stage that names report suites stops', () => {
            const overrides = { com_adobe_analytics: { reportSuites: ['globalrs'] } };
            expect(checkRules([rule('Send', { actions: [sendEvent(overrides)] })]).problems).toEqual([OVERRIDE_REPORT_SUITE(actionAt('Send', 0))]);
        });

        test('an override for every stage that names a datastream stops', () => {
            const overrides = { enabled: true, datastreamId: 'other-datastream' };
            expect(checkRules([rule('Send', { actions: [sendEvent(overrides)] })]).problems).toEqual([OVERRIDE_DATASTREAM(actionAt('Send', 0))]);
        });

        test('an override for every stage that names neither passes', () => {
            const overrides = { com_adobe_identity: { idSyncContainerId: 30793 } };
            expect(checkRules([rule('Send', { actions: [sendEvent(overrides)] })]).problems).toEqual([]);
        });

        test("development report suites that share one with another override's production report suites stop", () => {
            const rules = [
                rule('Checkout', { actions: [sendEvent({ production: { com_adobe_analytics: { reportSuites: ['prodrs', 'rolluprs'] } } })] }),
                rule('Send', { actions: [sendEvent({ development: { com_adobe_analytics: { reportSuites: ['devrs', 'RollupRS'] } } })] })
            ];
            expect(checkRules(rules).problems).toEqual([OVERRIDE_REPORT_SUITE(actionAt('Send', 0))]);
        });

        test('a shared report suite inside a comma-joined entry stops', () => {
            const rules = [
                rule('Checkout', { actions: [sendEvent({ production: { com_adobe_analytics: { reportSuites: ['prodrs,rolluprs'] } } })] }),
                rule('Send', { actions: [sendEvent({ development: { com_adobe_analytics: { reportSuites: ['devrs, rolluprs'] } } })] })
            ];
            expect(checkRules(rules).problems).toEqual([OVERRIDE_REPORT_SUITE(actionAt('Send', 0))]);
        });

        test("an instance's development report suite override that is the Analytics extension's production report suite stops", () => {
            const extensions = {
                'adobe-alloy': alloy(overriding({ development: { com_adobe_analytics: { reportSuites: ['devrs', 'prodrs'] } } })),
                'adobe-analytics': analytics({ production: ['prodrs'], development: ['devrs'] })
            };
            expect(checkRules([], extensions).problems).toEqual([OVERRIDE_REPORT_SUITE('adobe-alloy instance 0')]);
        });

        test("the Analytics extension's development report suite that is an override's production report suite stops", () => {
            const extensions = {
                'adobe-alloy': alloy(overriding({ production: { com_adobe_analytics: { reportSuites: ['devrs'] } } })),
                'adobe-analytics': analytics({ production: ['prodrs'], development: ['devrs'] })
            };
            expect(checkRules([], extensions).problems).toEqual([PRODUCTION_REPORT_SUITE]);
        });

        test("an instance's development datastream override that is production's stops", () => {
            const instances = [instance('prod-a', 'dev-a'), overriding({ development: { datastreamId: 'PROD-A' } }, ['prod-b', 'dev-b'])];
            expect(checkRules([], { 'adobe-alloy': alloy(...instances) }).problems).toEqual([OVERRIDE_DATASTREAM('adobe-alloy instance 1')]);
        });

        test("an instance's problem with its own datastream comes before its overrides'", () => {
            const overrides = { development: { datastreamId: 'prod-datastream', com_adobe_analytics: { reportSuites: ['prodrs'] } }, production: { com_adobe_analytics: { reportSuites: ['prodrs'] } } };
            const extensions = { 'adobe-alloy': alloy(overriding(overrides, ['prod-datastream', ''])) };
            expect(checkRules([], extensions).problems).toEqual([
                NO_DATASTREAM(0), OVERRIDE_DATASTREAM('adobe-alloy instance 0'), OVERRIDE_REPORT_SUITE('adobe-alloy instance 0')
            ]);
        });

        test.each([
            ['a string', '%overrides%'],
            ['a list', [{ development: { datastreamId: 'dev-other' } }]],
            ['a number', 7],
            ['a development override that is a string', { development: 'dev-other' }],
            ['a production override that is a list', { production: [{ datastreamId: 'prod-other' }] }],
            ['a staging override that is a number', { staging: 1 }],
            ['a data element reference as the development datastream', { development: { datastreamId: '%devDatastream%' } }],
            ['a data element reference as the production datastream', { production: { datastreamId: 'prod-%env%' } }],
            ['a data element reference as the datastream for every stage', { datastreamId: '%datastream%' }],
            ['a development datastream that is a number', { development: { datastreamId: 7 } }],
            ['a development datastream that is null', { development: { datastreamId: null } }],
            ['Analytics overrides that are a string', { development: { com_adobe_analytics: 'devrs' } }],
            ['Analytics overrides that are null', { development: { com_adobe_analytics: null } }],
            ['report suites that are a string', { development: { com_adobe_analytics: { reportSuites: 'devrs' } } }],
            ['a number among the report suites', { production: { com_adobe_analytics: { reportSuites: ['prodrs', 7] } } }],
            ['a data element reference among the report suites', { development: { com_adobe_analytics: { reportSuites: ['%rs%'] } } }],
        ])('a Send event action with %s can\'t be read, so it stops', (_, overrides) => {
            expect(checkRules([rule('Send', { actions: [sendEvent(overrides)] })]).problems).toEqual([OVERRIDES_UNREADABLE(actionAt('Send', 0))]);
        });

        test("an instance's overrides that can't be read stop", () => {
            const instances = [instance('prod-a', 'dev-a'), overriding('%overrides%', ['prod-b', 'dev-b'])];
            expect(checkRules([], { 'adobe-alloy': alloy(...instances) }).problems).toEqual([OVERRIDES_UNREADABLE('adobe-alloy instance 1')]);
        });

        test('no overrides, or null ones, have nothing to stop', () => {
            const rules = [rule('Send', { actions: [sendEvent(undefined), sendEvent(null), { modulePath: SEND_EVENT }] })];
            const extensions = { 'adobe-alloy': alloy(overriding(null), overriding(undefined, ['prod-b', 'dev-b'])) };
            expect(checkRules(rules, extensions)).toEqual({ problems: [], unaware: [] });
        });

        test('every adobe-alloy event, condition and action is read, and only those', () => {
            const unreadable = { modulePath: 'adobe-alloy/dist/lib/conditions/anything/index.js', settings: { edgeConfigOverrides: 'x' } };
            const notAlloy = { modulePath: 'other-extension/src/actions/send.js', settings: { edgeConfigOverrides: 'x' } };
            const rules = [rule('Send', {
                events: [domReady, { ...unreadable, modulePath: 'adobe-alloy/dist/lib/events/anything/index.js' }],
                conditions: [notAlloy, unreadable],
                actions: [notAlloy, customCode, sendEvent('x')]
            })];
            expect(checkRules(rules).problems).toEqual([
                OVERRIDES_UNREADABLE('rule Send: adobe-alloy event 1'),
                OVERRIDES_UNREADABLE('rule Send: adobe-alloy condition 1'),
                OVERRIDES_UNREADABLE('rule Send: adobe-alloy action 2')
            ]);
        });

        test('problems come for the extensions first, then each rule in container order', () => {
            const rules = [
                rule('B', { actions: [sendEvent({ development: { datastreamId: 'prod-datastream' } })] }),
                rule('A', { actions: [sendEvent('%overrides%')] })
            ];
            const extensions = { 'adobe-analytics': analytics({ development: [] }), 'adobe-alloy': alloy(instance('prod-datastream', '')) };
            expect(checkRules(rules, extensions)).toEqual({
                problems: [NO_REPORT_SUITES, NO_DATASTREAM(0), OVERRIDE_DATASTREAM(actionAt('B', 0)), OVERRIDES_UNREADABLE(actionAt('A', 0))],
                unaware: []
            });
        });

        test("a rule's overrides are checked even without the alloy extension", () => {
            const overrides = { datastreamId: 'other-datastream' };
            expect(checkRules([rule('Send', { actions: [sendEvent(overrides)] })], {}).problems).toEqual([OVERRIDE_DATASTREAM(actionAt('Send', 0))]);
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

        test('a null entry for an extension that is not stage-aware is just unaware', () => {
            expect(check({ 'facebook-pixel': null })).toEqual({ problems: [], unaware: ['facebook-pixel'] });
        });
    });

    test('a container without extensions has nothing to stop', () => {
        expect(checkStageDestinations({})).toEqual({ problems: [], unaware: [] });
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
