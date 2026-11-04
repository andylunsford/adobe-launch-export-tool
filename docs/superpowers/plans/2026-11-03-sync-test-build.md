# Developer Sync Test Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Developer Sync can sync one Launch library's revisions and generate a test build: production's current
runtime script with that library and the local edits applied. The test build is written where Chrome's Local
Overrides serves it at every environment URL of the property.

**Architecture:** Pure modules in `lib/reactor-core/runtime-script/` do the work:
- parse the downloaded debug script with acorn, without evaluating it;
- print it back byte for byte;
- write container entries from revisions;
- assemble production plus the library;
- check the result and write the overrides folder.

`generateTestBuild` ties them together with injected I/O, so Jest can drive it end to end. `main.js` only supplies
the HTTP clients. The renderer gets a library picker and a Test Build panel through named IPC channels.

**Tech Stack:** Node.js (Electron 43 main process), acorn 8 (new runtime dependency), Jest 30, Playwright (E2E,
mocked IPC).

**Spec:** `docs/superpowers/specs/2026-11-03-sync-test-build-design.md`. Container layout and field rules are in
reverse-engineer-launch `docs/07-runtime-script.md`, findings 4–9 and 12. That file is in a local folder outside
this repo; the spec and this plan carry what the tasks need from it.

## Global Constraints

- **Never execute the downloaded script.** No `eval`, `new Function`, `vm` or `<script>`. Parse it as text, in
  `lib/` or the main process only.
- **Never write to Launch.** Generation and library sync only `GET`.
- **No real property data in the repo or a PR.** Fixtures are synthetic. Ids follow `__tests__/sync.test.js`'s
  `reactorId(prefix, n)`, which gives the prefix plus 32 zero-padded digits.
- **Three edits per IPC channel:** a handler in `main.js`, a named method in `preload.js`, a call from the module.
  No generic `invoke`.
- **TLS:** every request goes through `apiAgent`. Never `rejectUnauthorized: false`.
- **No test traffic to production. This is a hard rule:** check 5 stops generation (Task 4).
- **Windows paths of 260 characters or more** are written through the `\\?\` prefix.
- **Git:**
  - commit on `claude/sync-test-build`, which builds on PR #5 (`claude/sync-diff`);
  - the PR's base is `feature-library-diff`, opened after PR #5 merges, never `main`;
  - conventional commits with a scope, for example `feat(sync):`.

## Review Focus

1. **A data element renamed in the library.** Production's old key is gone and the new key appears in revision id
   order (Task 6, `renamed data element replaces the old key`).
2. **Production has no successful build.** Generation stops with "Production has no successful build yet", rather
   than failing on a null (Task 8, `stops when production has no build`).
3. **A rule component's folder deleted locally.** The rule is written without that component (Task 6,
   `readLibraryItems leaves out a deleted component`).
4. **An overrides folder shared by two sync folders.** Generating from one never removes the other's files (Task
   7, `leaves files another sync folder wrote`).
5. **Overrides paths over 260 characters on Windows.** The file is still written (Task 7, `writes paths over 260
   characters`).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/reactor-core/runtime-script/parse.js` (new) | debug script text → `{ container, turbine }`; function stubs keep their source text |
| `lib/reactor-core/runtime-script/print.js` (new) | container → text, in Launch's exact layout; `functionStub` |
| `lib/reactor-core/runtime-script/entries.js` (new) | a revision → its container entry (data element, extension, rule); transforms |
| `lib/reactor-core/runtime-script/checks.js` (new) | round trip, production entries, behind production, stage destinations |
| `lib/reactor-core/runtime-script/library-items.js` (new) | the sync folder → library revisions, with local edits |
| `lib/reactor-core/runtime-script/assemble.js` (new) | production + library → test container, custom code files, report |
| `lib/reactor-core/runtime-script/overrides.js` (new) | script URLs, URL → overrides path, writing files and the manifest |
| `lib/reactor-core/runtime-script/test-build.js` (new) | `generateTestBuild`: the whole run, with I/O injected |
| `lib/reactor-core/runtime-script/index.js` (new) | exports the above; `lib/reactor-core/index.js` adds `runtimeScript` |
| `lib/reactor-core/transforms.js` | export `expandPath` |
| `lib/reactor-core/sync.js` | `listLibrary`, `librarySyncApi` |
| `main.js`, `preload.js` | library download and diff; `generate-test-build` |
| `index.html`, `modules/sync.js` | library picker, Test Build panel |
| `__tests__/fixtures/runtime-script/` (new) | `launch-fixture.js` (the script text) and `fixture-data.js` (its revisions and package) |
| `__tests__/runtime-script/*.test.js` (new) | one test file per module |
| `e2e/fixtures.js`, `e2e/04-tabs.spec.js` | mocks and the panel test |

---

### Task 1: Parse and print a runtime script

**Files:**
- Create: `lib/reactor-core/runtime-script/parse.js`, `lib/reactor-core/runtime-script/print.js`,
  `lib/reactor-core/runtime-script/index.js`, `__tests__/fixtures/runtime-script/launch-fixture.js`
- Modify: `package.json` (dependency `"acorn": "^8.14.0"`), `lib/reactor-core/index.js`
- Test: `__tests__/runtime-script/parse-print.test.js`

**Interfaces:**
- Produces:
  - `PREFIX = '(function() {\n  window._satellite = window._satellite || {};\n  window._satellite.container = '`
  - `SUFFIX = '\n})();\n\n'`
  - a **function stub** is `{ $function: true, params: string[], source: string }`, where `source` is the whole
    function text;
  - `parseScript(text: string) → { container: Object, turbine: string }`. It throws `Error('Not a Launch debug
    script: <reason>')`;
  - `printValue(value) → string`;
  - `printScript({ container, turbine }) → string`;
  - `functionStub(params: string[], code: string) → stub`, whose `source` is
    `` `function(${params.join(', ')}) {\n  ${code}\n}` `` (docs/07 finding 4);
  - `isModuleStub(stub) → boolean`, true when `params` is exactly `['module', 'exports', 'require', 'turbine']`.

- [ ] **Step 1: Write the fixture.** `__tests__/fixtures/runtime-script/launch-fixture.js` exports this exact text as
  a template literal, with `String.raw` so `\"` stays as written. The layout is Launch's (docs/07 finding 4):
  - 2-space JSON;
  - functions spliced in, unindented;
  - an empty line after each module's closing `}`;
  - the external URL single-quoted;
  - `50.0`.

  Tabs in the Turbine part are real tabs.

```
(function() {
  window._satellite = window._satellite || {};
  window._satellite.container = {
  "buildInfo": {
    "turbineVersion": "29.1.0",
    "turbineBuildDate": "2026-06-04T00:00:00Z",
    "buildDate": "2026-11-01T10:00:00Z"
  },
  "environment": {
    "id": "EN00000000000000000000000000000003",
    "stage": "production"
  },
  "dataElements": {
    "Page Title": {
      "modulePath": "core/src/lib/dataElements/customCode.js",
      "settings": {
        "source": function(event) {
  return document.title;
}
      }
    },
    "Site Section": {
      "defaultValue": "home",
      "forceLowerCase": true,
      "modulePath": "core/src/lib/dataElements/javascriptVariable.js",
      "settings": {
        "path": "site.section"
      }
    }
  },
  "extensions": {
    "core": {
      "displayName": "Core",
      "hostedLibFilesBaseUrl": "https://assets.adobedtm.com/extensions/EP00000000000000000000000000000001/",
      "modules": {
        "core/src/lib/dataElements/customCode.js": {
          "name": "custom-code",
          "displayName": "Custom Code",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings, event) { return settings.source(event); };
          }

        },
        "core/src/lib/dataElements/javascriptVariable.js": {
          "name": "javascript-variable",
          "displayName": "JavaScript Variable",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings) { return settings.path; };
          }

        },
        "core/src/lib/events/libraryLoaded.js": {
          "name": "library-loaded",
          "displayName": "Library Loaded (Page Top)",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings, trigger) { trigger(); };
          }

        },
        "core/src/lib/events/domReady.js": {
          "name": "dom-ready",
          "displayName": "DOM Ready",
          "script": function(module, exports, require, turbine) {
module.exports = function (settings, trigger) { trigger(); };
          }

        },
        "core/src/lib/conditions/path.js": {
          "name": "path",
          "displayName": "Path Without Query String",
          "script": function(module, exports, require, turbine) {
module.exports = function () { return true; };
          }

        },
        "core/src/lib/actions/customCode.js": {
          "name": "custom-code",
          "displayName": "Custom Code",
          "script": function(module, exports, require, turbine) {
module.exports = function () {};
          }

        },
        "core/src/lib/helpers/once.js": {
          "script": function(module, exports, require, turbine) {
module.exports = function (fn) { return fn; };
          }

        }
      }
    }
  },
  "company": {
    "orgId": "00000000000000000000000A@AdobeOrg",
    "dynamicCdnEnabled": false
  },
  "property": {
    "name": "Fixture Property",
    "settings": {
      "domains": [
        "example.com"
      ],
      "undefinedVarsReturnEmpty": false,
      "ruleComponentSequencingEnabled": true
    },
    "id": "PR00000000000000000000000000000001"
  },
  "rules": [
    {
      "id": "RL00000000000000000000000000000011",
      "name": "Load",
      "events": [
        {
          "modulePath": "core/src/lib/events/libraryLoaded.js",
          "settings": {},
          "ruleOrder": 50.0
        }
      ],
      "conditions": [],
      "actions": [
        {
          "modulePath": "core/src/lib/actions/customCode.js",
          "settings": {
            "source": "console.log(\"inline\");",
            "language": "javascript"
          }
        }
      ]
    },
    {
      "id": "RL00000000000000000000000000000012",
      "name": "Click",
      "events": [
        {
          "modulePath": "core/src/lib/events/domReady.js",
          "settings": {},
          "ruleOrder": 50.0
        }
      ],
      "conditions": [
        {
          "modulePath": "core/src/lib/conditions/path.js",
          "settings": {
            "paths": [
              {
                "value": "/checkout"
              }
            ]
          },
          "negate": true,
          "timeout": 2000
        }
      ],
      "actions": [
        {
          "modulePath": "core/src/lib/actions/customCode.js",
          "settings": {
            "source": 'https://assets.adobedtm.com/0000aaaa/1111bbbb/a1b2c3d4e5f6/RC00000000000000000000000000000022-source.js',
            "language": "javascript",
            "isExternal": true
          },
          "timeout": 2000,
          "delayNext": true
        }
      ]
    }
  ]
}
})();

var _satellite = (function () {
	'use strict';
	return {};
})();
```

- [ ] **Step 2: Write the failing tests** in `__tests__/runtime-script/parse-print.test.js`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail.** Run `npx jest __tests__/runtime-script/parse-print.test.js`.
  Expected: FAIL with "Cannot find module '../../lib/reactor-core/runtime-script'".

- [ ] **Step 4: Implement `parseScript` in `parse.js`.**
  - Check that the text starts with `PREFIX`, and fail otherwise.
  - Parse it with `acorn.parse(text, { ecmaVersion: 'latest' })`.
  - Find the `AssignmentExpression` whose left side is `window._satellite.container`.
  - Convert its `ObjectExpression` recursively:
    - `Literal` → its value;
    - a `UnaryExpression` `-` on a numeric literal → the negative number;
    - `ArrayExpression` → an array;
    - `ObjectExpression` → an object, keyed by the literal key's `value`;
    - `FunctionExpression` → a stub, with `params` as the identifier names and
      `source = text.slice(node.start, node.end)`;
    - anything else → throw `Not a Launch debug script: unexpected <type> at <start>`.
  - Check that the text from the object's end begins with `SUFFIX`.
  - `turbine` is everything after it.

- [ ] **Step 5: Implement `printValue`, `printScript`, `functionStub` and `isModuleStub` in `print.js`.**
  - `printValue` is `JSON.stringify(value, replacer, 2)`. The replacer swaps three kinds of value for placeholder
    strings, and the output's quoted placeholders are then replaced:
    - a stub → its `source`, plus `'\n'` when `isModuleStub`;
    - a `source` string whose holder has `isExternal === true` → the string in single quotes;
    - an integer `ruleOrder` → `value.toFixed(1)`.
  - Placeholders are `@@fn-7d3f9a@@<n>`, ASCII so that JSON leaves them alone.
  - `printScript` is `PREFIX + printValue(container) + SUFFIX + turbine`.
  - `index.js` re-exports each runtime-script module with `...require('./<module>')`; each later task adds its own
    line there. `lib/reactor-core/index.js` adds `runtimeScript: require('./runtime-script')`.

- [ ] **Step 6: Run the tests to verify they pass.** Run `npm install`, then
  `npx jest __tests__/runtime-script/parse-print.test.js`. Expected: 5 passed.

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json lib/reactor-core/runtime-script lib/reactor-core/index.js __tests__/fixtures/runtime-script __tests__/runtime-script
git commit -m "feat(sync): parse and print Launch debug scripts without running them"
```

---

### Task 2: Container entries from revisions

**Files:**
- Create: `lib/reactor-core/runtime-script/entries.js`, `__tests__/fixtures/runtime-script/fixture-data.js`
- Modify: `lib/reactor-core/transforms.js` (add `expandPath` to the exports), `lib/reactor-core/runtime-script/index.js`
- Test: `__tests__/runtime-script/entries.test.js`

**Interfaces:**
- Consumes: `functionStub` (Task 1); `getNested`, `setNested` and `expandPath` from `transforms.js`.
- Produces:
  - `applyTransforms(settings, transforms, { originId, onCustomCode }) → settings`
  - `dataElementEntry(revision, pkg) → { name, entry, warnings: string[] }`
  - `extensionEntry(revision, pkg, modules) → { name, entry }`
  - `ruleEntry(revision, components: Array<{ component, pkg }>, { customCodeUrl: (componentId) → string, sequencing: boolean, inlineMovedCode: boolean }) → { entry, files: Array<{ url, code }>, warnings: string[] }`
  - `byRevisionId(a: string, b: string) → number`: code-unit order.
- Produces in `fixture-data.js`, for later tasks:
  - `PACKAGE`, the core package;
  - `PRODUCTION`: `{ revisions: { rules, data_elements, extensions }, components: Map<rule revision id, component[]>, buildBaseUrl }`;
  - helpers `revision(type, n, attributes, origin)` and `component(n, attributes)`.

  Together they reproduce the fixture's entries exactly. The values are below.

**Fixture data** (`reactorId` as in `__tests__/sync.test.js`; package id `EP…01`):
- `PACKAGE.attributes`:
  - `name: 'core'`, `version: '3.4.1'`;
  - `data_elements`:
    - `custom-code` → `src/lib/dataElements/customCode.js`, with transforms
      `[{type:'function', propertyPath:'source', parameters:['event']}]`;
    - `javascript-variable` → `src/lib/dataElements/javascriptVariable.js`;
  - `events`: `library-loaded` → `src/lib/events/libraryLoaded.js`, `dom-ready` → `src/lib/events/domReady.js`;
  - `conditions`: `path` → `src/lib/conditions/path.js`;
  - `actions`: `custom-code` → `src/lib/actions/customCode.js`, with transforms
    `[{type:'customCode', propertyPath:'source'}]`;
  - `configuration: {}`.

  Each delegate's `id` is `core::<kind>::<name>`, with its `name` and `displayName` as in the fixture's modules.
- **Data elements:**
  - `DE…31` "Page Title": `custom-code`, settings `{"source":"return document.title;"}`, origin `DE…01`;
  - `DE…32` "Site Section": `javascript-variable`, settings `{"path":"site.section"}`, `default_value: 'home'`,
    `force_lower_case: true`, origin `DE…02`.
- **Extension:** `EX…41`, `name: 'core'`, `display_name: 'Core'`, `settings: null`, `extension_package` `EP…01`.
- **Rule `RL…11` "Load"**, origin `RL…01`:
  - `RC…21`: `library-loaded`, `order: 0`, `rule_order: 50`, `settings: null`;
  - `RC…23`: action `custom-code`, `order: 1`, settings `{"source":"console.log(\"inline\");","language":"javascript"}`,
    `delay_next: false`, `timeout: 2000`.
- **Rule `RL…12` "Click"**, origin `RL…02`:
  - `RC…24`: `dom-ready`, `order: 0`, `rule_order: 50`;
  - `RC…25`: condition `path`, `order: 1`, `negate: true`, `timeout: 2000`, settings `{"paths":[{"value":"/checkout"}]}`;
  - `RC…22`: action `custom-code`, `order: 2`, `delay_next: true`, `timeout: 2000`, settings
    `{"source":"console.log(\"external\");","language":"javascript"}`.
- `buildBaseUrl: 'https://assets.adobedtm.com/0000aaaa/1111bbbb/a1b2c3d4e5f6/'`.
- **Defaults:** every revision has `enabled: true` and `revision_number: 1`. Booleans are `false` and other fields
  `null` unless listed.

- [ ] **Step 1: Write the failing tests** in `__tests__/runtime-script/entries.test.js`. Compare with `printValue` from
  Task 1, so key order counts.

```js
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
    expect(warnings.some(w => /sequencing is off/.test(w))).toBe(true);
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
```

- [ ] **Step 2: Run the tests to verify they fail.** Run `npx jest __tests__/runtime-script/entries.test.js`.
  Expected: FAIL with "dataElementEntry is not a function".

- [ ] **Step 3: Implement `entries.js`.** These are the rules the tests don't fully determine (docs/07 findings 5,
  7, 8, 12):
  - **Delegate.** It is found in `pkg.attributes[KIND]` by `id`, with `KIND` mapping the descriptor's kind to
    `data_elements`, `events`, `conditions` or `actions`. `modulePath` is
    `` `${descriptor.split('::')[0]}/${def.libPath}` ``. If the delegate is missing, throw
    `Error(`${descriptor} isn't in ${pkg.attributes.name} ${pkg.attributes.version}`)`.
  - **Settings** are `JSON.parse(attributes.settings)`, or `{}` when null or empty. Transforms come from the
    delegate, or from `pkg.attributes.configuration.transforms` for extensions. `originId` is
    `relationships.origin.data.id`.
  - **Data element key order:**
    - `defaultValue` (when non-empty);
    - `forceLowerCase: true`;
    - `cleanText: true`;
    - `storageDuration`;
    - `modulePath`;
    - `settings`.

    Warn `"<name>: cleanText's place in the entry is unverified"`. Also warn `"<name>: storageDuration's place
    next to other fields is unverified"` when it appears with `defaultValue` or `forceLowerCase`.
  - **Extension entry:** `{ displayName, hostedLibFilesBaseUrl: 'https://assets.adobedtm.com/extensions/<package id>/', settings?, modules }`.
    `settings` is left out when the object is empty.
  - **Rule entry:** `{ id: revision.id, name, events, conditions, actions }`. Components are sorted by
    `attributes.order`, and the kind comes from `::events::`, `::conditions::` or `::actions::`.
    - Events: `{ modulePath, settings, ruleOrder: rule_order }`.
    - Conditions: `{ modulePath, settings, negate: true (only when true), timeout }`.
    - Actions: `{ modulePath, settings }`, plus `timeout, delayNext: true` only when `delay_next`.
  - **Custom code:** `onCustomCode(parts, code)`.
    - In a rule with a `core::events::library-loaded` component, it stays as is. When `!sequencing`, warn
      `"<rule>: custom code in a Library Loaded rule with sequencing off is unverified"`.
    - Otherwise, with `inlineMovedCode`, it stays as is, with the warning `"<rule>: custom code kept inline; Launch
      would load it from a file"`.
    - Otherwise, set it to `customCodeUrl(component.id)`, set `settings.isExternal = true`, and push
      `{ url, code }`. When `settings.language === 'html'`, warn `"<rule>: HTML custom code moved to a file is
      unverified"`.

- [ ] **Step 4: Run the tests to verify they pass.** Run `npx jest __tests__/runtime-script`. Expected: all passed.

- [ ] **Step 5: Commit.** `git commit -m "feat(sync): write container entries from revisions"`, after `git add` of
  the files above.

---

### Task 3: Checks against production

**Files:**
- Create: `lib/reactor-core/runtime-script/checks.js`
- Test: `__tests__/runtime-script/checks.test.js`

**Interfaces:**
- Consumes: `parseScript`, `printScript` and `printValue` (Task 1); the entry writers and `fixture-data` (Task 2).
- Produces:
  - `checkRoundTrip(text, parsed) → string | null`: null when it matches, else
    `"Production's script doesn't print back exactly (first difference at byte <n>)"`.
  - `checkProductionEntries({ container, revisions, components, packages, customCodeUrl }) → string[]`. `packages`
    is a `Map<package id, pkg>`. It returns one problem per entry that differs:
    `"<type> <name>: differs from production at <path>"`.
  - `firstDifference(a, b) → string | null`: the first differing key path, like `actions.0.settings.source`.
  - `checkBehindProduction(library, productionRevisions) → string[]`. `library` has the shape `readLibraryItems`
    returns (Task 6): `{ rules: Array<{ revision }>, data_elements, extensions }`. `productionRevisions` is
    `{ rules, data_elements, extensions }`. Each problem is
    `"<type> <name>: the library holds revision <n>, production runs <m>"`.

- [ ] **Step 1: Write the failing tests:**
  - `round trip passes on the fixture`;
  - `round trip reports the first differing byte` (the fixture with one character changed);
  - `production entries all match on the fixture data` (expect `[]`);
  - `a changed revision is reported with its path`: change `RC…25`'s `negate` to false, and expect
    `['rules Click: differs from production at conditions.0.negate']`;
  - `behind production`: a library revision of origin `RL…02` with `revision_number: 0` gives one problem naming
    "Click", and `revision_number: 2` gives none.

  Each test asserts the exact strings above.
- [ ] **Step 2: Run them to verify they fail.** Run `npx jest __tests__/runtime-script/checks.test.js`. Expected:
  FAIL, `checkRoundTrip is not a function`.
- [ ] **Step 3: Implement `checks.js`.**
  - `checkProductionEntries` writes every container entry again from its production revision:
    - data elements by `attributes.name`;
    - extensions by `attributes.name`, with `modules` taken from the container;
    - rules by `id`.

    Compare `printValue` of each side with `firstDifference` for the path. Use `sequencing` from
    `container.property.settings.ruleComponentSequencingEnabled` and `inlineMovedCode: false`.
  - "Behind" compares `revision_number` for the same `relationships.origin.data.id`.
- [ ] **Step 4: Run to verify they pass.** Run `npx jest __tests__/runtime-script`.
- [ ] **Step 5: Commit.** `feat(sync): check the entry writer against production on every run`

---

### Task 4: Stage destinations (the hard rule)

**Files:**
- Modify: `lib/reactor-core/runtime-script/checks.js`
- Test: `__tests__/runtime-script/stage.test.js`

**Interfaces:**
- Produces: `checkStageDestinations(container) → { problems: string[], unaware: string[] }`.
  - `problems` lists stage-aware extensions that would send test traffic to production.
  - `unaware` lists every other extension name except `core`.

**Fields:**
- `adobe-alloy`, confirmed in real exports: each `settings.instances[i]` has `edgeConfigId` (production),
  `stagingEdgeConfigId` and `developmentEdgeConfigId`.
- `adobe-analytics`: `settings.libraryCode.accounts.{production, staging, development}`, each an array of report
  suite ids. **Not yet seen in a real export. Confirm against the Adobe Analytics extension package's
  `configuration.schema` before merging,** and fix the field path here and in the test if it differs.

- [ ] **Step 1: Write the failing tests:**
  - `alloy with a development datastream passes`;
  - `alloy with an empty development datastream stops`, expecting
    `'adobe-alloy instance 0: no development datastream, so test traffic would reach production'`;
  - `alloy with the production datastream as development stops`, expecting
    `'adobe-alloy instance 0: the development datastream is production's'`;
  - `analytics with no development report suites stops`, and `analytics sharing a production report suite stops`,
    with the same message shapes, using "report suites";
  - `other extensions are listed as unaware`: a container with `core`, `adobe-alloy` and `facebook-pixel` gives
    `unaware: ['facebook-pixel']`.
- [ ] **Step 2: Run to verify they fail.** Run `npx jest __tests__/runtime-script/stage.test.js`.
- [ ] **Step 3: Implement it.** `STAGE_AWARE = { 'adobe-alloy': fn, 'adobe-analytics': fn }`; each `fn(settings)`
  returns its problems.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit.** `feat(sync): stop a test build that would send traffic to production`

---

### Task 5: Library sync

**Files:**
- Modify: `lib/reactor-core/sync.js`, `main.js` (`perform-sync-download`, `perform-sync-diff`)
- Test: `__tests__/sync.test.js` (new `describe('library sync')`)

**Interfaces:**
- Consumes: `listAll`, and the existing `writeDownload` and diff runner, unchanged.
- Produces:
  - `listLibrary(get, libraryId) → { rules, data_elements, extensions, rule_components, ruleOf, failed }`, the same
    shape as `listProperty`. It reads `/libraries/{id}/rules`, `/data_elements` and `/extensions`, and
    `/rules/{rule revision id}/rule_components` five at a time, as `listRuleComponents` does.
  - `librarySyncApi(get, libraryId)`, the same shape as `syncApi`.
  - `readConfig(targetDir) → { propertyId, propertyName, orgId, libraryId?, libraryName? } | null`.
  - `bindFolder(targetDir, config) → void`. It throws `Error('This folder holds library "<name>". Sync another library into its own folder.')`
    when the existing config names another library. With no `libraryId` but a download record, it throws
    `'This folder holds the whole property'`.

- [ ] **Step 1: Write the failing tests:**
  - `listLibrary lists the library's revisions and each rule revision's components`. A fake `get` serves the four
    URLs; expect `ruleOf` to map the components to the rule revision ids.
  - `writeDownload of a library listing writes folders by revision id, and the diff compares against the library`:
    `writeDownload` with that listing, then `runner(dir, librarySyncApi(get, 'LB1'), fetchPkg)`. Expect every item
    `unchanged`.
  - `a revision removed from the library is set aside on the next download`.
  - `bindFolder refuses a folder bound to another library`, and `bindFolder refuses a whole-property folder`.
- [ ] **Step 2: Run to verify they fail.** Run `npx jest __tests__/sync.test.js -t "library sync"`.
- [ ] **Step 3: Implement `listLibrary`, `librarySyncApi`, `readConfig` and `bindFolder` in `sync.js`.**
- [ ] **Step 4: Wire it into `main.js`.**
  - `perform-sync-download` accepts an optional `library: { id, name }`.
  - When it's set, call `bindFolder` before writing anything, and write `libraryId` and `libraryName` into
    `.reactor-settings.json`.
  - List with `listLibrary`, and **skip the `db.upsert*` calls**: these are revisions, not heads, so they would
    corrupt the cache.
  - `perform-sync-diff` uses `librarySyncApi` when the config has a `libraryId`.
- [ ] **Step 5: Run `npm test`.** Expected: all suites pass.
- [ ] **Step 6: Commit.** `feat(sync): download one library's revisions into its own folder`

---

### Task 6: Assemble the test build

**Files:**
- Create: `lib/reactor-core/runtime-script/library-items.js`, `lib/reactor-core/runtime-script/assemble.js`
- Test: `__tests__/runtime-script/assemble.test.js`

**Interfaces:**
- Consumes: the entry writers (Task 2), `byRevisionId`, `fromFile`, `readBase` and `transformFiles`.
- Produces:
  - `readLibraryItems(syncDir, fetchPkg) → { rules: Array<{ revision, components }>, data_elements, extensions, warnings }`.
    - It reads the folders under each type, skipping `_deleted`, through `fromFile`.
    - Components are grouped by their download-record `rule_id`. A component without one is skipped, with a warning.
    - When a code file equals the code stored in `data.json` once line endings are ignored, the stored code is kept.
  - `class TestBuildStop extends Error { problems: string[] }`.
  - `assembleTestBuild({ production: { container, revisions, buildBaseUrl }, library, environmentId, packages, now: Date, inlineMovedCode }) → { container, files, report }`.
    `report` is `{ replaced, added, dropped, warnings }`, each a list of strings like `"rule Click"`. It throws
    `TestBuildStop`.

- [ ] **Step 1: Write the failing tests.** Production is the parsed fixture plus `PRODUCTION` from `fixture-data`.
  - `a library rule revision replaces production's entry and moves to revision id order`: library rule `RL…13`,
    origin `RL…02`, with a changed action. Expect `rules.map(r => r.id)` to be `[RL…11, RL…13]` and
    `report.replaced` to be `['rule Click']`.
  - `renamed data element replaces the old key`: `DE…34`, origin `DE…02`, named "Section". Expect the old key gone,
    and the keys in revision id order: `['Page Title', 'Section']`.
  - `a new library data element is added`, origin not in production.
  - `a disabled library rule drops production's entry`.
  - `a library rule whose folder was deleted keeps production's entry`: it's absent from `library.rules`, so
    production's `RL…12` stays and nothing is reported for it.
  - `warns when the library changes nothing`: a library holding only production's own revisions, unedited, gives
    exactly one warning, `"Nothing to apply: the test build is production's script on the development environment"`.
  - `a delegate production doesn't load stops`: a library rule using `core::events::click`, which is added to the
    package but not loaded by production. Expect the problem `"rule Click: core/src/lib/events/click.js isn't loaded by production"`.
  - `an extension on another package version stops`.
  - `environment is the development one and buildDate is now`: expect `environment` to be
    `{ id: 'EN…01', stage: 'development' }` and `buildInfo.buildDate` to be `'2026-11-03T12:00:00Z'` for
    `now = new Date('2026-11-03T12:00:00.123Z')`. Other `buildInfo` keys are unchanged.
  - `custom code files use production's build folder`: file text is
    `` `_satellite.__registerScript('${url}', ${JSON.stringify(code)});` `` with no trailing newline.
  - `readLibraryItems leaves out a deleted component`: write a library with `writeDownload`, delete one
    `rule_components/RC…` folder, and expect that rule's components to lack it.
  - `readLibraryItems keeps stored code that differs only by line endings`.
- [ ] **Step 2: Run to verify they fail.** Run `npx jest __tests__/runtime-script/assemble.test.js`.
- [ ] **Step 3: Implement `library-items.js` and `assemble.js`.**
  - Start from a deep copy of production's container. Stubs are plain objects, so `structuredClone` works.
  - Map production entries to origins using `production.revisions`.
  - Apply the library per the spec's table. Every library component's `modulePath` must be a key of its
    extension's `modules`. Every library extension must have the same `extension_package` id as production's
    extension of that name, and production must have it. Collect all problems before throwing.
  - Rebuild `dataElements`, `extensions` and `rules` in `byRevisionId` order. Production entries use their
    production revision ids.
  - Set `environment` to `{ id: environmentId, stage: 'development' }`.
  - Set `buildInfo.buildDate` to `now.toISOString().replace(/\.\d{3}Z$/, 'Z')`.
  - `inlineMovedCode` defaults to the module constant `INLINE_MOVED_CODE = true` until Task 10 confirms that
    Chrome runs a 404 override. Inline code always runs, so this is the safe default. A test pins the default.
  - "Nothing to apply" means every library item's printed entry equals production's entry for the same origin, and
    the library adds and drops nothing.
- [ ] **Step 4: Run to verify they pass.** Run `npx jest __tests__/runtime-script`.
- [ ] **Step 5: Commit.** `feat(sync): assemble a test build from production and a library`

---

### Task 7: The overrides folder

**Files:**
- Create: `lib/reactor-core/runtime-script/overrides.js`
- Test: `__tests__/runtime-script/overrides.test.js`

**Interfaces:**
- Produces:
  - `scriptUrls(environments) → string[]`. For each environment it uses `meta.script_sources[]`'s `minified` and
    `debug` when present. Otherwise it uses `https://assets.adobedtm.com/${library_path}/${library_name}` and the
    same URL with `.min.js` → `.js`. It skips environments with neither, and returns deduplicated URLs.
  - `urlToPath(overridesDir, url) → string`, which is `path.join(overridesDir, host, ...pathname segments)`.
  - `writeOverrides({ overridesDir, syncDir, scriptText, scriptUrls, files, manifest }) → { written: string[], removed: string[] }`.
    - It writes the script at every URL and each `{ url, text }` file.
    - It then removes the files the previous `syncDir/.reactor-sync/test-build.json` listed that this run didn't
      write.
    - It writes the new manifest: `{ ...manifest, files: written }`.
  - `longPath(p) → string`: `\\?\` + the absolute path on `win32` when it's 260 characters or more, otherwise `p`.

- [ ] **Step 1: Write the failing tests:**
  - `script goes at every environment URL, both names`;
  - `falls back to library_path and library_name`;
  - `removes files the previous run wrote and this one didn't`;
  - `leaves files another sync folder wrote`: two sync dirs share one overrides dir, and a run from B never
    removes A's files;
  - `writes paths over 260 characters`: an overrides dir nested deep enough that the script path passes 260
    characters. Expect `fs.existsSync(longPath(p))`. On non-Windows, `longPath` is the identity and the test still
    passes.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement it.** Every `fs` call goes through `longPath`.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit.** `feat(sync): write test builds where Chrome Local Overrides serves them`

---

### Task 8: Generate, end to end

**Files:**
- Create: `lib/reactor-core/runtime-script/test-build.js`
- Modify: `main.js` (handler `generate-test-build`), `preload.js` (`generateTestBuild`)
- Test: `__tests__/runtime-script/test-build.test.js`

**Interfaces:**
- Consumes: everything above; `latestSucceededBuild` and `listAll` (`api.js`); `readConfig` and `librarySyncApi`
  (Task 5); the diff runner.
- Produces: `generateTestBuild({ syncDir, overridesDir, get, getText, fetchPkg, environmentId?, now, log }) → { report, written, removed }`.
  It throws `TestBuildStop`. The order is fixed:
  1. **Config.** `readConfig`, and stop `'This folder isn't a library sync. Download a library first.'` without
     `libraryId`.
  2. **Production build.** Environments come from `/properties/{id}/environments`. Production is
     `stage === 'production'`. `latestSucceededBuild` gives the build; with none, stop
     `"Production has no successful build yet"`.
  3. **Script.** It is `.reactor-sync/builds/{build id}/script.js` if present. Otherwise
     `getText(direct_artifact_url with .min.js → .js)`, saved there.
  4. **Check 1:** `parseScript`, then `checkRoundTrip`.
  5. **Production revisions:** `/builds/{id}/rules`, `data_elements` and `extensions`, plus each production rule's
     components. They are cached as `.reactor-sync/builds/{build id}/revisions.json`. Packages come through
     `fetchPkg`, by each item's package relationship.
  6. **Check 2:** `checkProductionEntries`. `customCodeUrl` uses `buildBaseUrl`, which is `direct_artifact_url` up
     to its last `/`.
  7. **Library:** `readLibraryItems`. Diff with `librarySyncApi`; its `behind` and `conflict` lists become warnings
     that name each item and suggest syncing again.
  8. **Check 3:** `checkBehindProduction(readLibraryItems' result, production revisions)`.
  9. **Environment.** It is the library's `relationships.environment` from `GET /libraries/{id}`, else the
     `environmentId` argument. With neither, stop `'Pick a development environment for this library'`.
  10. **Assemble**, then **check 5** (`checkStageDestinations`). Add a warning naming the `unaware` extensions:
      `"These extensions don't choose a destination by stage and send where they always do: <names>"`.
  11. **Write:** `writeOverrides`, with `scriptUrls` of the property's environments.

- [ ] **Step 1: Write the failing tests.** Use fakes:
  - `get` routes URLs to fixture data;
  - `getText` returns `FIXTURE` and counts its calls;
  - the sync dir is written with `writeDownload` from a library listing.

  The tests:
  - `generates and writes the test build`: the manifest exists, and the script at the production URL starts with
    `PREFIX`;
  - `reuses the downloaded script for the same build`: run twice, `getText` called once;
  - `stops when production has no build`;
  - `stops when the folder isn't a library sync`;
  - `stops and writes nothing when the script doesn't round-trip`: `getText` returns the fixture with an extra
    space, and the overrides dir stays empty;
  - `stops when a stage-aware extension has no development destination`;
  - `uses environmentId when the library has no environment`.
- [ ] **Step 2: Run to verify they fail.** Run `npx jest __tests__/runtime-script/test-build.test.js`.
- [ ] **Step 3: Implement `generateTestBuild`.**
- [ ] **Step 4: Add the handler and the preload method.**
  - `ipcMain.handle('generate-test-build', async (event, { targetDir, overridesDir, environmentId, token, creds }) => …)`.
  - `get` is `reactorGet(getHeaders(token, creds))`.
  - `getText` is `(url) => axios.get(url, { httpsAgent: apiAgent, responseType: 'text', transformResponse: [x => x] }).then(r => r.data)`.
    It sends no auth headers to the CDN.
  - `log` sends `sync-log`.
  - On `TestBuildStop`, return `{ stopped: true, problems }` rather than throwing, so the renderer can list them.
  - In `preload.js`: `generateTestBuild: (payload) => ipcRenderer.invoke('generate-test-build', payload)`.
- [ ] **Step 5: Run `npm test`.** Expected: all suites pass.
- [ ] **Step 6: Commit.** `feat(sync): generate a test build from a library sync`

---

### Task 9: The Developer Sync UI

**Files:**
- Modify: `index.html` (sync tab), `modules/sync.js`, `e2e/fixtures.js`, `e2e/04-tabs.spec.js`

**Interfaces:**
- Consumes: `window.api.getLibraries`, `getEnvironments`, `performSyncDownload` (now with `library`),
  `generateTestBuild`, `selectFolder`, `saveConfigField`, `getSavedConfig` and `onSyncLog`.
- Produces these globals, for the inline handlers: `loadSyncLibraries`, `selectOverridesFolder` and
  `generateTestBuild`.

- [ ] **Step 1: Write the failing E2E test** in `e2e/04-tabs.spec.js`:
  `Developer Sync generates a test build for a library`.
  - Select Mock Property One and open Developer Sync.
  - Click **Libraries**; `#sync-library` lists `Library 2.0 (development)` and not the published `Library 1.0`.
  - Choose it, click **Browse** under Test Build (the mock returns `C:/mock-sync`), then click **Generate**.
  - `#sync-console` contains `Replaced [1]` and `rule Click`.

  Mocks in `e2e/fixtures.js`:
  - `MOCK_DATA.libraries` gains `LB_002`, "Library 2.0", `state: 'development'`;
  - `generate-test-build` returns
    `{ report: { replaced: ['rule Click'], added: [], dropped: [], warnings: [] }, written: ['C:/mock-sync/x.js'], removed: [] }`.
- [ ] **Step 2: Run it to verify it fails.** Run `npx playwright test e2e/04-tabs.spec.js -g "test build"`. On
  Linux, use `npm run test:e2e -- -g "test build"`. Expected: FAIL, `#sync-library` not found.
- [ ] **Step 3: Add the markup and the module code.**
  - **Configuration card:** a `#sync-library` select with "Whole property" (value `""`), a **Libraries** button
    (`loadSyncLibraries()`, which needs exactly one selected property), and a `#test-build-environment` select
    filled with the property's development environments.
  - **New "3. Test Build" card:** `#test-build-overrides-path` (readonly, saved with
    `saveConfigField('test_build_overrides_dir', …)` and restored from `getSavedConfig`), a **Browse** button, and
    a **Generate** button.
  - **Library download target:** `` `${folder}/${property.name} - ${libraryName}` ``, with the library name passed
    through `name.replace(/[^a-zA-Z0-9\- ]/g, '').trim()`, as `sanitizeFolderName` does.
  - **Report:** use the existing `logList` and `itemLine` style, with these headings:
    - "Replaced", "Added", "Dropped";
    - "⚠ Warnings";
    - "⛔ Stopped" for `problems`;
    - finally `Point Chrome DevTools → Sources → Overrides at <folder> (overrides apply only while DevTools is open).`
- [ ] **Step 4: Run it to verify it passes,** then run `npm test`.
- [ ] **Step 5: Commit.** `feat(sync): library picker and Test Build panel`

---

### Task 10: Manual verification (needs the user)

These can't run in CI. The person running this plan asks the user to do them and records the results in the PR
description.

- [ ] **Step 1: Chrome and a 404.**
  - In Chrome DevTools → Sources → Overrides, override a script URL on `assets.adobedtm.com` that returns 404,
    with `console.log('override ran')`.
  - Load a page that includes it, with DevTools open.
  - If it logs, set `INLINE_MOVED_CODE = false` in `assemble.js` and update the Task 6 test that pins the default.
    Commit `fix(sync): load moved custom code from override files`.
- [ ] **Step 2: Analytics fields.** Confirm Task 4's `adobe-analytics` field path against that extension package's
  `configuration.schema`.
- [ ] **Step 3: A real run on a test property, not the real Developer Sync folder.**
  - Sync a development library and generate.
  - Point Chrome at the folder, load the site, and check `_satellite.buildInfo.buildDate` and
    `_satellite.environment.stage === 'development'`.
  - Check in the Network panel that no request goes to a production datastream or report suite.
- [ ] **Step 4: Open the PR** against `feature-library-diff` once PR #5 has merged. It needs a test plan and the
  results above, and no property data.
