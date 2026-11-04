'use strict';

// Writes a parsed debug script back out in the layout Launch uses, so a script
// that is parsed and printed unchanged comes back byte for byte. The layout is
// 2-space JSON with these exceptions: functions are spliced in as code, an
// external file's URL is single-quoted, and ruleOrder is written as 50.0.

const { PREFIX, SUFFIX } = require('./parse');

// The parameters of a module's script, which Launch follows with an empty line
const MODULE_PARAMS = ['module', 'exports', 'require', 'turbine'];
// JSON can't write code, single quotes or 50.0, so this marks where each goes until
// the JSON is written. ASCII, so JSON leaves it alone.
const PLACEHOLDER = '@@fn-7d3f9a@@';

const isStub = (value) => value?.$function === true;

/** A function in the format Launch writes: unindented, with the code indented 2 spaces. */
function functionStub(params, code) {
    return { $function: true, params, source: `function(${params.join(', ')}) {\n  ${code}\n}` };
}

/** Whether a stub is the script of a Turbine module. */
const isModuleStub = (stub) => Array.isArray(stub?.params)
    && stub.params.length === MODULE_PARAMS.length
    && stub.params.every((param, i) => param === MODULE_PARAMS[i]);

/**
 * Prints a value as Launch does: 2-space JSON, with a function stub as its
 * source, the source of an external file as a single-quoted string, and an
 * integer ruleOrder with a decimal.
 * @returns {string}
 */
function printValue(value) {
    const texts = [];
    const placeholder = (text) => PLACEHOLDER + (texts.push(text) - 1);
    // `this` is the object holding the value
    const json = JSON.stringify(value, function replacer(key, item) {
        if (isStub(item)) return placeholder(isModuleStub(item) ? `${item.source}\n` : item.source);
        if (key === 'source' && this.isExternal === true && typeof item === 'string') return placeholder(`'${item}'`);
        if (key === 'ruleOrder' && Number.isInteger(item)) return placeholder(item.toFixed(1));
        return item;
    }, 2);
    // A function, because a replacement string would read `$&` in code as a pattern
    return json.replace(new RegExp(`"${PLACEHOLDER}(\\d+)"`, 'g'), (_, index) => texts[index]);
}

/**
 * The inverse of parseScript.
 * @param {{ container: Object, turbine: string }} script
 * @returns {string}
 */
function printScript({ container, turbine }) {
    return PREFIX + printValue(container) + SUFFIX + turbine;
}

module.exports = { printValue, printScript, functionStub, isModuleStub };
