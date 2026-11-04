'use strict';

const { parseScript, printValue, dataElementEntry, extensionEntry, ruleEntry, applyTransforms, byRevisionId } = require('../../lib/reactor-core/runtime-script');
const FIXTURE = require('../fixtures/runtime-script/launch-fixture');
const { PACKAGE, PRODUCTION, revision, component } = require('../fixtures/runtime-script/fixture-data');

const real = parseScript(FIXTURE).container;
const opts = { customCodeUrl: id => `${PRODUCTION.buildBaseUrl}${id}-source.js`, sequencing: true, inlineMovedCode: false };
const withPkg = (cs) => cs.map(c => ({ component: c, pkg: PACKAGE }));
const ruleAt = (i) => PRODUCTION.revisions.rules[i];

test('data element entries match the fixture, optional fields first', () => {
    for (const rev of PRODUCTION.revisions.data_elements) {
        const { name, entry } = dataElementEntry(rev, PACKAGE);
        expect(printValue(entry)).toBe(printValue(real.dataElements[name]));
    }
});

test('extension entry leaves out empty settings and keeps the given modules', () => {
    const { name, entry } = extensionEntry(PRODUCTION.revisions.extensions[0], PACKAGE, real.extensions.core.modules);
    expect(name).toBe('core');
    expect(printValue(entry)).toBe(printValue(real.extensions.core));
});

test('rule entries match: Library Loaded code inline, other custom code moved to a file', () => {
    for (const rev of PRODUCTION.revisions.rules) {
        const { entry, files } = ruleEntry(rev, withPkg(PRODUCTION.components.get(rev.id)), opts);
        expect(printValue(entry)).toBe(printValue(real.rules.find(r => r.id === rev.id)));
        if (rev.id.endsWith('12')) expect(files).toEqual([{ url: `${PRODUCTION.buildBaseUrl}RC00000000000000000000000000000022-source.js`, code: 'console.log("external");' }]);
    }
});

test('actions get timeout and delayNext only when delay_next is true', () => {
    const { entry } = ruleEntry(ruleAt(0), withPkg(PRODUCTION.components.get(ruleAt(0).id)), opts);
    expect(entry.actions[0]).not.toHaveProperty('timeout');
});

test('inlineMovedCode keeps custom code inline with a warning', () => {
    const { entry, files, warnings } = ruleEntry(ruleAt(1), withPkg(PRODUCTION.components.get(ruleAt(1).id)), { ...opts, inlineMovedCode: true });
    expect(entry.actions[0].settings).toEqual({ source: 'console.log("external");', language: 'javascript' });
    expect(files).toEqual([]);
    expect(warnings[0]).toMatch(/Launch would load it from a file/);
});

test('HTML custom code outside Library Loaded is moved, with a warning', () => {
    const html = component(26, { delegate_descriptor_id: 'core::actions::custom-code', order: 2, settings: JSON.stringify({ source: '<b>x</b>', language: 'html' }) });
    const { warnings } = ruleEntry(ruleAt(1), withPkg([...PRODUCTION.components.get(ruleAt(1).id).slice(0, 2), html]), opts);
    expect(warnings.some(w => /HTML custom code/.test(w))).toBe(true);
});

test('custom code in a Library Loaded rule with sequencing off gets a warning', () => {
    const { warnings } = ruleEntry(ruleAt(0), withPkg(PRODUCTION.components.get(ruleAt(0).id)), { ...opts, sequencing: false });
    expect(warnings.some(w => /sequencing off/.test(w))).toBe(true);
});

test('cleanText, and storageDuration with another optional field, get a warning', () => {
    const rev = revision('data_elements', 33, { name: 'X', delegate_descriptor_id: 'core::dataElements::javascript-variable', settings: '{"path":"x"}', clean_text: true, storage_duration: 'session', default_value: 'a' });
    expect(dataElementEntry(rev, PACKAGE).warnings).toHaveLength(2);
});

test('transforms: remove deletes, add originId sets, [] expands', () => {
    const settings = { instances: [{ a: 1, cb: 'x' }, { a: 2 }], sandbox: 's', id: null };
    applyTransforms(settings, [{ type: 'remove', propertyPath: 'sandbox' }, { type: 'add', propertyPath: 'id', reservedKey: 'originId' }, { type: 'function', propertyPath: 'instances[].cb', parameters: ['e'] }], { originId: 'DE1' });
    expect(settings.sandbox).toBeUndefined();
    expect(settings.id).toBe('DE1');
    expect(settings.instances[0].cb.$function).toBe(true);
});

test('byRevisionId is code-unit order', () => {
    expect(['RLb', 'RLa', 'RL0'].sort(byRevisionId)).toEqual(['RL0', 'RLa', 'RLb']);
});

test('components are written in order, whatever order they are given in', () => {
    const [load] = PRODUCTION.revisions.rules;
    const reversed = withPkg([...PRODUCTION.components.get(load.id)].reverse());
    const { entry } = ruleEntry(load, reversed, opts);
    expect(printValue(entry)).toBe(printValue(real.rules[0]));
});

test('a delegate the package does not have is an error naming the package', () => {
    const rev = revision('data_elements', 33, { name: 'X', delegate_descriptor_id: 'core::dataElements::nope' });
    expect(() => dataElementEntry(rev, PACKAGE)).toThrow("core::dataElements::nope isn't in core 3.4.1");
});

test('a rule with several custom code actions warns once for each problem', () => {
    const code = (n, order) => component(n, { delegate_descriptor_id: 'core::actions::custom-code', order, settings: JSON.stringify({ source: 'x', language: 'javascript' }) });
    const { files, warnings } = ruleEntry(ruleAt(1), withPkg([code(27, 0), code(28, 1)]), { ...opts, inlineMovedCode: true });
    expect(files).toEqual([]);
    expect(warnings).toHaveLength(1);
});
