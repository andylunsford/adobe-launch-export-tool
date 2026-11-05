# Developer Sync Test Builds for Chrome Local Overrides

**Date:** 2026-11-03
**Status:** Draft
**Builds on:** PR #5 (Developer Sync download record, diff and mirror download)

---

## Intent

Developer Sync is where a property's rules, rule components, data elements and extension settings get edited
locally. Those edits will later be pushed to Launch as new revisions (push is a separate, later piece of work).
Before pushing, the person editing needs to see the edits running on a real site.

A **test build** is a Launch runtime script made from three things:

1. production's current build, for everything the edits don't touch;
2. the revisions in one Launch library the person picked;
3. their local edits to those revisions.

It is written into a folder laid out for Chrome DevTools' Local Overrides, so the browser loads it in place of the
real Launch script on whatever site embeds the property.

The test build is only useful if it is what Launch would build from the same revisions. So the sync has to hold
everything a build needs, and the generator has to prove on every run that it reproduces production exactly
before it changes anything.

### Background

The reverse-engineering notes (reverse-engineer-launch `docs/07-runtime-script.md`) rebuilt a large production
property's debug script byte for byte from exported revision data. Turbine, the extension module code and a few
build fields were copied from the real script. Its findings 4 to 9 and 12 are the specification for how container
entries are written. The rest of this document refers to them as "docs/07 finding N".

---

## Goals

- In Developer Sync, pick an existing library in Launch and sync its revisions as editable files.
- Generate a test build: production's current build, with the library's revisions and the local edits applied.
- Write it so Chrome Local Overrides serves it at every environment URL of the property. The site and its embed
  code (development, staging or production) don't matter.
- Stop with a clear message rather than write a script that differs from what Launch would build in a way the
  person can't see.

## Non-goals (first version)

- **Push.** It comes later, in its own PR, tested only against a dev property.
- **Creating items through the API.** New rules and data elements are created in Launch and added to the library,
  then synced.
- **Extension upgrades.** A library that changes an extension's package version stops generation with a message.
- **Delegates production doesn't load.** A library item using an action, condition, event or data element type
  whose module isn't in production's script stops generation with a message. Supplying it from the package
  archive (`extension_packages.meta.archive_url`) is a follow-up.
- **Submitted and approved libraries.** Only production is the base; libraries between the picked one and
  production are ignored.
- **A minified script.** The debug script is served under both the `.js` and `.min.js` names, so no Terser.
- **Property settings edits.** The property's settings come from production's build.

## Anti-goals

- A test build that silently differs from what Launch would build. Every difference from production must come from
  the library or from a local edit.
- **Running a downloaded script.** Production's script is parsed as text and never executed: no `eval`,
  `new Function`, `vm` or `<script>`. It is handled in the main process, never in the renderer.
- **Sending test traffic to production.** This is a hard rule. See [Environment](#environment).
- **Writing to Launch.** Generation only reads from Launch.
- **Property data in the repo.** Tests use small synthetic fixtures. No real property's names, ids, settings or
  code go into the repo or a PR.

---

## Design

### 1. Library sync

Developer Sync's download gains a library choice:

- **No library:** today's property-wide download, unchanged.
- **A library:** the folder holds exactly that library's revisions.

The picker lists the property's libraries that aren't published yet (`get-libraries` already lists them; filter on
`attributes.state`).

A library download lists:

- `/libraries/{id}/rules`, `/libraries/{id}/data_elements` and `/libraries/{id}/extensions`: the revisions in the
  library;
- `/rules/{rule revision id}/rule_components` for each rule revision. That returns the revision's own frozen
  components, each with `origin` pointing at its head component (reverse-engineer-launch `docs/02`,
  "Rule components are revisioned").

A library never holds a deleted item: Launch refuses to add one (reverse-engineer-launch `docs/06` finding 14).

Files are written the way `to-files.js` writes them today (`data.json`, `settings.json`, code files). Each
`data.json` is the revision as the library lists it, revision id included. The PR #5 machinery works unchanged,
with the library's lists standing in for the property's:

- the download record tells local edits apart from changes in Launch;
- the diff's `added`, `modified` and `deleted` lists are the local edits;
- **a folder deleted locally means "take this revision out of the library".** Its changes are gone, so the test
  build uses production's version of the item, or leaves it out if production doesn't have it. Push will later
  remove the revision from the library. It can't delete the item: Launch refuses to delete an item that has a
  revision in an unpublished library (reverse-engineer-launch `docs/06` finding 12). To take an item off the site,
  disable it. A deleted rule component's folder is different: the rule revision just loses that component;
- an item removed from the library is set aside in `_deleted/` like an item deleted in Launch;
- `syncApi` gets a library variant, so the diff compares against the library and not the property's heads.

`.reactor-settings.json` records the library's id and name next to the property. **My call:** a folder is bound to
one library. Syncing a different library needs a different folder, so one folder never mixes two libraries'
revisions.

Folders are named by revision id, as `to-files.js` names them by `data.id`. Push will need each item's head,
which is `relationships.origin` in `data.json`.

### 2. The base: production's current build

1. The production environment is the property's environment with `attributes.stage === 'production'`. Its newest
   succeeded build comes from `latestSucceededBuild` (`lib/reactor-core/api.js`).
2. **The script.** It is the build's `meta.direct_artifact_url`, with `.min.js` swapped for `.js` (docs/07
   finding 2). It is fetched from `assets.adobedtm.com` without credentials, through the shared `apiAgent`, so
   the TLS setting applies. Keep it in the sync folder, keyed by build id
   (`.reactor-sync/builds/{build id}.js`), so a second generate against the same build doesn't download again.
3. **Its revisions.** `/builds/{id}/rules`, `/data_elements` and `/extensions` give the build's revisions with
   `relationships.origin`. Compare already reads these. They map script entries to items:
   - a rule entry's `id` is a rule revision id;
   - a data element entry is keyed by the revision's `name`;
   - an extension entry is keyed by its package `name`.
4. **Parse.** Split the script into the container object literal and Turbine (docs/07 finding 4). Parse the
   literal with a JavaScript parser, such as acorn (builder's choice). Keep each spliced-in function's source
   text by its range instead of evaluating it. The result is the container as data, plus each function's
   original text, so the container can be printed again exactly.

### 3. Assembling the container

Start from production's container and apply the library, then the edits:

| Library item | Production has its origin | Production doesn't |
|---|---|---|
| enabled | replace production's entry | add an entry |
| disabled | drop production's entry | nothing |
| folder deleted locally (taken out of the library) | keep production's entry | nothing |

- Library items are written from the sync folder's files (`from-file.js`), so local edits are included. Production
  entries for items not in the library keep their exact text.
- Each type stays in revision id order (docs/07 finding 9).
- A data element renamed in the library drops the old key and adds the new one.
- Entries are written per docs/07:
  - layout: finding 4;
  - data element and extension fields: finding 5;
  - rule components: finding 7;
  - custom code, inline or moved to a file: finding 8;
  - transforms: finding 12.

  Module paths come from each delegate's definition in the cached extension package (finding 6).
- **Custom code moved to a file** gets the URL production's build would give it: production's build folder plus
  `{component revision id}-source.js` (finding 8). The file is written to the overrides folder (section 5),
  because the CDN has no file for a revision production doesn't run. That URL returns 404 from the CDN. **Verify
  by hand first** that Chrome runs an overridden script whose real response is a 404. If it doesn't, the test build
  keeps such code inline instead (`source` as a string, no `isExternal`) and warns, naming each component, that
  Launch would load it from a file. **My call.**
- **Line endings.** `from-file.js` turns CRLF into LF so the diff ignores line endings. When a code file differs
  from the code stored in `data.json` only by line endings, the entry uses the stored code, so an unedited item
  comes out exactly as Launch has it. **My call.**
- **Modules.** Production's modules stay as they are. A library item whose delegate has no module in production's
  script stops generation (see Non-goals). So does a library extension whose `extension_package` differs from
  production's.

#### Environment

**No test traffic to production. This is a hard rule.**

The stage belongs to the environment a build is made for, not to the library. A library is built on a development
environment while it's being worked on, on staging once submitted, and on production once published. The script
carries that environment as `environment`. Extensions read its `stage` to choose where to send data.

`environment` becomes the library's development environment, `{id, stage: 'development'}`, even though the script
is served at the production URL. The environment is the one `relationships.environment` names on the library. If
the library has none, the panel asks for one of the property's development environments.

Switching the stage isn't enough by itself, so generation checks the finished container (check 5):

- **Extensions that choose a destination by stage**, at least Adobe Analytics and the Adobe Experience Platform
  Web SDK. Each must have a development destination set (report suites for Analytics, a datastream for Web SDK),
  and it must not be one of its production destinations. If not, generation stops, naming the extension and the
  setting. An empty development setting stops it too, since these extensions may fall back to production. Confirm
  the exact settings fields, and any other stage-aware extensions, from the extension packages.
- **Extensions that don't choose by stage**, like most third-party tags, send where they always do. Nothing in the
  container can redirect them. Every generate lists them in a warning that names each one. **My call:** the
  hard rule covers every destination the script can choose by stage. Stopping on every extension that isn't
  stage-aware would block almost every real property.

#### Marker

`buildInfo.buildDate` is set to the time of generation, so `_satellite.buildInfo` on the page shows that the
override is active and which generation it is. The other `buildInfo` fields, `company` and `property`, stay
production's.

### 4. Checks

All of these run before anything is written. A failed check stops generation, writes nothing and names what
failed.

1. **Round trip.** Production's parsed container, printed again, must give back production's script byte for
   byte. If it doesn't, the serializer doesn't understand this build.
2. **Production's entries.** Every data element, extension and rule in production's script is written again by
   `entries.js` from production's own revisions, and must equal its entry exactly. Rules need their components:
   one `/rules/{rule revision id}/rule_components` request per production rule, kept in
   `.reactor-sync/builds/{build id}/` with the script, so it is paid once per production build. A failure names the
   item and the first difference. This checks the entry writer against real data on every run.

   Checking only library items that production already runs would almost never check anything. Adding an item to
   a library cuts a new revision of the rule and of every one of its components (reverse-engineer-launch `docs/04`,
   `revise` action), so a library rarely holds a revision production runs. **My call.**
3. **Behind production.** A library revision older than production's revision of the same item stops generation,
   naming the items, the way Launch refuses to build such a library. "Older" means a lower `revision_number` for
   the same origin. That is **my call**: verify it against Launch's own error.
4. **Unsupported.** Missing modules or an extension package change stop generation (section 3).
5. **Production destinations.** A stage-aware extension with no development destination, or with one shared with
   production, stops generation ([Environment](#environment)).

Warnings that don't stop generation:

- **Library changed in Launch since the sync:** the diff's `behind` and `conflict` lists. Name them and suggest
  syncing again.
- **Nothing to apply:** the library holds only revisions production already runs, and there are no local edits.
- **Unproven shapes.** Some entries can't be checked against production, because docs/07 leaves them open. Each is
  written by the best documented rule, with a warning naming the item and the rule (**my call**):
  - HTML custom code outside Library Loaded rules: moved to a file, like JavaScript;
  - custom code in Library Loaded rules when sequencing is off: kept inline;
  - `cleanText` on a data element, and `storageDuration` together with `defaultValue` or `forceLowerCase`:
    placed in the order of the revision's attributes.

### 5. Output: the overrides folder

The person picks an overrides folder once, and it is remembered with the sync folder's settings. Chrome's Local
Overrides serves `{folder}/{host}/{path}` in place of `https://{host}/{path}`.

- **The script** goes at every environment URL of the property: each `meta.script_sources[]` entry's `minified`
  and `debug` URL. The same debug text is used for both names. So whichever embed code the site uses, development,
  staging or production, it loads the test build.
- **Custom code files** go at their URLs (section 3).
- **A manifest.** It is kept in the sync folder as `.reactor-sync/test-build.json`, not in the overrides folder.
  Chrome uses one overrides folder at a time, so several properties' test builds may share it. The manifest records:
  - the time, production's build id, the library;
  - what was replaced, added and dropped;
  - the warnings;
  - every file written.

  On the next generate from the same sync folder, files its previous manifest lists and this run doesn't produce
  are removed. Nothing else in the overrides folder is touched. **My call.**
- **Windows paths.** Paths can pass 260 characters (the host, two path segments, a 12-hex build folder and a long
  file name). Write them with the `\\?\` prefix, or check the length and say so.

Chrome applies Local Overrides only while DevTools is open. The panel's log says so, along with the folder to
select in **Sources → Overrides**.

### 6. UI

In the Developer Sync tab:

- **Download:** a library picker. "Whole property" is the default and keeps today's behaviour.
- **Test build panel**, shown when the folder is bound to a library:
  - the overrides folder;
  - the development environment, if the library has none;
  - a **Generate** button.

  The log lists:
  - what was replaced, added and dropped;
  - what stopped it, or the warnings;
  - the check results;
  - the folder to point Chrome at.

### 7. Where the code goes

- **`lib/reactor-core/runtime-script/`**, pure JavaScript with no Electron:
  - `parse.js`: script text to container data plus function texts;
  - `print.js`: container to script text;
  - `entries.js`: revision to container entry, for data elements, extensions and rules with their components;
  - `assemble.js`: production plus library plus edits;
  - `checks.js`.
- **`lib/reactor-core/sync.js`:** library listing and the library `syncApi`.
- **`main.js`:** the handlers, the script download, and writing the overrides folder.
- **Named IPC channels**, each in `main.js`, `preload.js` and `modules/sync.js` (CLAUDE.md). For example
  `perform-sync-download` takes an optional library id, and there is a new `generate-test-build`. Progress goes
  through the existing `sync-log` subscription.
- **Tests:**
  - Jest with synthetic fixtures: a small made-up build script, with one test per docs/07 finding the entry writer
    relies on, and one per check failing.
  - E2E for the panel, with mocked IPC (`e2e/fixtures.js`).

---

## To verify before building on it

- **Chrome and a 404.** Whether Local Overrides runs a script whose real response is a 404 (section 3, custom code
  files).
- **Behind production.** How Launch decides a library revision is behind upstream, and its error text.
- **Custom code in Library Loaded rules.** docs/07 leaves open whether custom code stays inline in Library Loaded
  rules when sequencing is off. Check 2 catches a wrong answer for any rule production runs. Otherwise it is a
  warning (section 4).

## Left to the builder

- The JavaScript parser, as long as nothing is evaluated.
- The panel's layout and wording.
- Where the overrides folder setting is stored.
- The revision id comparator for ordering. Confirm it against the fixtures and docs/07 finding 9.

## Decisions made without asking (check these)

- A sync folder is bound to one library.
- Only unpublished libraries are offered.
- "Behind production" means a lower `revision_number` for the same origin.
- A missing module stops generation; supplying it from the package archive is a follow-up.
- The script is downloaded once per build id and kept in the sync folder.
- `buildInfo.buildDate` marks the test build.
- A manifest in the sync folder decides which old files to remove, so properties can share an overrides folder.
- Check 2 covers every production entry, not just the library items production runs.
- If Chrome won't run an override for a 404, custom code Launch would move to a file stays inline, with a warning.
- Code differing from Launch's only by line endings is written as Launch has it.
- Shapes docs/07 leaves open are written by the best documented rule, with a warning, rather than stopping.
- The "no production traffic" rule stops generation for stage-aware extensions (Analytics, Web SDK). Extensions
  that don't choose by stage are named in a warning, not stopped.
