'use strict';

// Reads a Launch debug runtime script as text. The script is only parsed, never
// run: the container is a JavaScript object literal, so acorn gives its syntax
// tree and this turns that back into values. Functions (custom code) aren't
// values, so each one becomes a stub holding its source text.

const acorn = require('acorn');

// Launch writes the script as an IIFE that assigns the container, then the
// Turbine runtime follows
const PREFIX = '(function() {\n  window._satellite = window._satellite || {};\n  window._satellite.container = ';
const SUFFIX = '\n})();\n\n';
const CONTAINER_TARGET = 'window._satellite.container';

const notLaunch = (reason) => new Error(`Not a Launch debug script: ${reason}`);
const unexpected = (node) => notLaunch(`unexpected ${node.type} at ${node.start}`);

/** The syntax tree node for the object literal assigned to the container. */
function findContainer(text) {
    let program;
    try {
        program = acorn.parse(text, { ecmaVersion: 'latest' });
    } catch (e) {
        throw notLaunch(e.message);
    }
    // body[0] is the IIFE: an expression statement calling a function expression
    const statements = program.body[0]?.expression?.callee?.body?.body ?? [];
    const assignment = statements
        .map(statement => statement.expression)
        .find(node => node?.type === 'AssignmentExpression' && text.slice(node.left.start, node.left.end) === CONTAINER_TARGET);
    if (!assignment) throw notLaunch(`no ${CONTAINER_TARGET} assignment`);
    if (assignment.right.type !== 'ObjectExpression') throw notLaunch(`${CONTAINER_TARGET} is not an object`);
    return assignment.right;
}

/** The value a syntax tree node stands for. Only what Launch writes is accepted. */
function toValue(node, text) {
    switch (node.type) {
        case 'Literal':
            return node.value;
        case 'UnaryExpression':
            if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
                return -node.argument.value;
            }
            throw unexpected(node);
        case 'ArrayExpression':
            return node.elements.map(element => toValue(element, text));
        case 'ObjectExpression':
            // fromEntries, because assigning a "__proto__" key would set the prototype
            return Object.fromEntries(node.properties.map(property => {
                if (property.type !== 'Property' || property.computed || property.key.type !== 'Literal') throw unexpected(property);
                return [property.key.value, toValue(property.value, text)];
            }));
        case 'FunctionExpression': {
            const odd = node.params.find(param => param.type !== 'Identifier');
            if (odd) throw unexpected(odd);
            return { $function: true, params: node.params.map(param => param.name), source: text.slice(node.start, node.end) };
        }
        default:
            throw unexpected(node);
    }
}

/**
 * Splits a debug script into its container and the Turbine runtime after it.
 * Functions in the container come back as stubs, `{ $function, params, source }`,
 * with `source` the whole function text.
 * @param {string} text - the downloaded script
 * @returns {{ container: Object, turbine: string }}
 * @throws {Error} "Not a Launch debug script: <reason>" for anything else
 */
function parseScript(text) {
    if (!text.startsWith(PREFIX)) throw notLaunch('it does not start with the container assignment');
    const node = findContainer(text);
    if (!text.startsWith(SUFFIX, node.end)) throw notLaunch(`the container isn't followed by the end of the wrapper at ${node.end}`);
    return { container: toValue(node, text), turbine: text.slice(node.end + SUFFIX.length) };
}

module.exports = { PREFIX, SUFFIX, parseScript };
