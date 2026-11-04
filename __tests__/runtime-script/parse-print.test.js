'use strict';

const FIXTURE = require('../fixtures/runtime-script/launch-fixture');
const { parseScript, printScript, printValue, functionStub, isModuleStub } = require('../../lib/reactor-core/runtime-script');

test('round trip gives back the fixture byte for byte', () => {
    expect(printScript(parseScript(FIXTURE))).toBe(FIXTURE);
});

test('function stubs keep their source', () => {
    const { container } = parseScript(FIXTURE);
    const stub = container.dataElements['Page Title'].settings.source;
    expect(stub).toEqual({ $function: true, params: ['event'], source: 'function(event) {\n  return document.title;\n}' });
    expect(isModuleStub(container.extensions.core.modules['core/src/lib/helpers/once.js'].script)).toBe(true);
});

test('the external URL parses to a plain string and turbine is the rest', () => {
    const { container, turbine } = parseScript(FIXTURE);
    expect(container.rules[1].actions[0].settings.source).toMatch(/^https:\/\/assets\.adobedtm\.com\/.+-source\.js$/);
    expect(turbine.startsWith('var _satellite = (function () {')).toBe(true);
});

test('functionStub prints the transform format', () => {
    expect(printValue({ a: functionStub(['event'], 'return 1;') })).toBe('{\n  "a": function(event) {\n  return 1;\n}\n}');
});

test('rejects text that is not a debug script', () => {
    expect(() => parseScript('var x = 1;')).toThrow(/Not a Launch debug script/);
});
