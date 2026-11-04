'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scriptUrls, urlToPath, writeOverrides, longPath } = require('../../lib/reactor-core/runtime-script');

const BASE = 'https://assets.adobedtm.com/0000aaaa/1111bbbb';
const DEVELOPMENT = { minified: `${BASE}/launch-a1b2c3d4e5f6-development.min.js`, debug: `${BASE}/launch-a1b2c3d4e5f6-development.js` };
const STAGING = { minified: `${BASE}/launch-a1b2c3d4e5f6-staging.min.js`, debug: `${BASE}/launch-a1b2c3d4e5f6-staging.js` };
const PRODUCTION = { minified: `${BASE}/launch-a1b2c3d4e5f6.min.js`, debug: `${BASE}/launch-a1b2c3d4e5f6.js` };

// An environment as the Reactor API lists it
const environment = (stage, sources, attributes = {}) => ({
    id: `EN${stage}`,
    type: 'environments',
    attributes: { name: stage, stage, ...attributes },
    ...(sources && { meta: { script_sources: sources } })
});

describe('scriptUrls', () => {
    test('lists the minified and debug URL of every environment', () => {
        const environments = [
            environment('development', [DEVELOPMENT]),
            environment('staging', [STAGING]),
            environment('production', [PRODUCTION])
        ];
        expect(scriptUrls(environments)).toEqual([
            DEVELOPMENT.minified, DEVELOPMENT.debug,
            STAGING.minified, STAGING.debug,
            PRODUCTION.minified, PRODUCTION.debug
        ]);
    });

    test('falls back to library_path and library_name', () => {
        const environments = [environment('production', undefined, { library_path: '0000aaaa/1111bbbb', library_name: 'launch-a1b2c3d4e5f6.min.js' })];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.minified, PRODUCTION.debug]);
    });

    test('falls back when script_sources is empty', () => {
        const environments = [environment('production', [], { library_path: '0000aaaa/1111bbbb', library_name: 'launch-a1b2c3d4e5f6.min.js' })];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.minified, PRODUCTION.debug]);
    });

    test('prefers script_sources over library_path and library_name', () => {
        const environments = [environment('production', [PRODUCTION], { library_path: 'ffff0000/9999eeee', library_name: 'launch-other.min.js' })];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.minified, PRODUCTION.debug]);
    });

    test('a library_name without .min.js gives one URL', () => {
        const environments = [environment('production', undefined, { library_path: '0000aaaa/1111bbbb', library_name: 'launch-a1b2c3d4e5f6.js' })];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.debug]);
    });

    test('skips an environment with neither', () => {
        const environments = [
            environment('development', undefined),
            environment('staging', undefined, { library_path: '0000aaaa/1111bbbb' }),
            environment('production', [PRODUCTION])
        ];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.minified, PRODUCTION.debug]);
    });

    test('lists a URL once when environments share it', () => {
        const environments = [environment('staging', [PRODUCTION]), environment('production', [PRODUCTION])];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.minified, PRODUCTION.debug]);
    });

    test('takes the URL a source has when it lacks the other', () => {
        const environments = [environment('production', [{ minified: PRODUCTION.minified }])];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.minified]);
    });
});

describe('urlToPath', () => {
    test('puts the host and path segments under the overrides folder', () => {
        expect(urlToPath('overrides', PRODUCTION.minified))
            .toBe(path.join('overrides', 'assets.adobedtm.com', '0000aaaa', '1111bbbb', 'launch-a1b2c3d4e5f6.min.js'));
    });

    test('ignores the query string and fragment', () => {
        expect(urlToPath('overrides', `${PRODUCTION.minified}?v=2#top`)).toBe(urlToPath('overrides', PRODUCTION.minified));
    });
});

describe('longPath', () => {
    // A path of exactly this many characters, that doesn't exist
    const pathOfLength = (length) => {
        const base = path.resolve(os.tmpdir());
        return path.join(base, 'x'.repeat(length - base.length - 1));
    };

    test('leaves a path under 260 characters alone', () => {
        const p = pathOfLength(259);
        expect(p).toHaveLength(259);
        expect(longPath(p)).toBe(p);
    });

    test('prefixes a path of 260 characters or more on Windows only', () => {
        const p = pathOfLength(260);
        expect(p).toHaveLength(260);
        expect(longPath(p)).toBe(process.platform === 'win32' ? `\\\\?\\${p}` : p);
    });
});

describe('writeOverrides', () => {
    let dir, overridesDir, syncA, syncB;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-'));
        overridesDir = path.join(dir, 'overrides');
        syncA = path.join(dir, 'sync-a');
        syncB = path.join(dir, 'sync-b');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const read = (p) => fs.readFileSync(p, 'utf8');
    const manifestOf = (syncDir) => JSON.parse(read(path.join(syncDir, '.reactor-sync', 'test-build.json')));
    const onDisk = (...segments) => path.join(overridesDir, 'assets.adobedtm.com', '0000aaaa', '1111bbbb', ...segments);
    const write = (syncDir, options) => writeOverrides({
        overridesDir, syncDir, scriptText: 'script text', scriptUrls: [], files: [], manifest: {}, ...options
    });

    test('script goes at every environment URL, both names', () => {
        const urls = scriptUrls([environment('development', [DEVELOPMENT]), environment('production', [PRODUCTION])]);
        const { written, removed } = write(syncA, { scriptText: '// the test build\n', scriptUrls: urls });

        const names = ['launch-a1b2c3d4e5f6-development.min.js', 'launch-a1b2c3d4e5f6-development.js', 'launch-a1b2c3d4e5f6.min.js', 'launch-a1b2c3d4e5f6.js'];
        expect(written).toEqual(names.map(name => onDisk(name)));
        for (const file of written) expect(read(file)).toBe('// the test build\n');
        expect(removed).toEqual([]);
    });

    test('custom code files go at their own URLs', () => {
        const { written } = write(syncA, {
            scriptUrls: [PRODUCTION.debug],
            files: [{ url: `${BASE}/rule-code/RC1111.js`, text: 'console.log(1);' }, { url: 'https://assets.adobedtm.com/0000aaaa/other/RC2222.js', text: 'console.log(2);' }]
        });

        expect(written).toEqual([
            onDisk('launch-a1b2c3d4e5f6.js'),
            onDisk('rule-code', 'RC1111.js'),
            path.join(overridesDir, 'assets.adobedtm.com', '0000aaaa', 'other', 'RC2222.js')
        ]);
        expect(read(written[1])).toBe('console.log(1);');
        expect(read(written[2])).toBe('console.log(2);');
    });

    test('writes UTF-8 and creates the folders it needs', () => {
        const text = 'var greeting = "café €";';
        const { written } = write(syncA, { scriptText: text, scriptUrls: [PRODUCTION.debug] });

        expect(fs.readFileSync(written[0])).toEqual(Buffer.from(text, 'utf8'));
        expect(fs.existsSync(path.join(syncA, '.reactor-sync'))).toBe(true);
    });

    test('keeps a manifest in the sync folder with the files it wrote', () => {
        const manifest = { time: '2026-11-03T10:00:00.000Z', buildId: 'a1b2c3d4e5f6', library: 'LB1111', report: { replaced: [], added: [], dropped: [] }, files: ['stale'] };
        const { written } = write(syncA, { scriptUrls: [PRODUCTION.debug], manifest });

        expect(manifestOf(syncA)).toEqual({ ...manifest, files: written });
        expect(fs.existsSync(path.join(overridesDir, '.reactor-sync'))).toBe(false);
    });

    test('removes files the previous run wrote and this one didn\'t', () => {
        const first = write(syncA, {
            scriptUrls: [PRODUCTION.minified, PRODUCTION.debug],
            files: [{ url: `${BASE}/rule-code/RC1111.js`, text: 'old code' }]
        });
        expect(first.removed).toEqual([]);

        const second = write(syncA, { scriptText: 'new text', scriptUrls: [PRODUCTION.debug] });

        expect(second.written).toEqual([onDisk('launch-a1b2c3d4e5f6.js')]);
        expect(second.removed).toEqual([onDisk('launch-a1b2c3d4e5f6.min.js'), onDisk('rule-code', 'RC1111.js')]);
        expect(fs.existsSync(onDisk('launch-a1b2c3d4e5f6.min.js'))).toBe(false);
        expect(fs.existsSync(onDisk('rule-code', 'RC1111.js'))).toBe(false);
        expect(read(onDisk('launch-a1b2c3d4e5f6.js'))).toBe('new text');
        expect(manifestOf(syncA).files).toEqual([onDisk('launch-a1b2c3d4e5f6.js')]);
    });

    test('keeps a file the previous run wrote when this one writes it again', () => {
        write(syncA, { scriptText: 'one', scriptUrls: [PRODUCTION.minified, PRODUCTION.debug] });
        const { removed } = write(syncA, { scriptText: 'two', scriptUrls: [PRODUCTION.debug, PRODUCTION.minified] });

        expect(removed).toEqual([]);
        expect(read(onDisk('launch-a1b2c3d4e5f6.min.js'))).toBe('two');
        expect(read(onDisk('launch-a1b2c3d4e5f6.js'))).toBe('two');
    });

    test('removes only files, and leaves the folders', () => {
        write(syncA, { scriptUrls: [PRODUCTION.debug], files: [{ url: `${BASE}/rule-code/RC1111.js`, text: 'old code' }] });
        write(syncA, { scriptUrls: [PRODUCTION.debug] });

        expect(fs.statSync(onDisk('rule-code')).isDirectory()).toBe(true);
    });

    test('ignores a listed file that is already gone', () => {
        const first = write(syncA, { scriptUrls: [PRODUCTION.minified, PRODUCTION.debug] });
        fs.rmSync(first.written[0]);

        const second = write(syncA, { scriptUrls: [PRODUCTION.debug] });

        expect(second.removed).toEqual([]);
        expect(manifestOf(syncA).files).toEqual([onDisk('launch-a1b2c3d4e5f6.js')]);
    });

    test('leaves files another sync folder wrote', () => {
        const a = write(syncA, { scriptText: 'property A', scriptUrls: [DEVELOPMENT.debug] });
        const b1 = write(syncB, { scriptText: 'property B', scriptUrls: [PRODUCTION.minified, PRODUCTION.debug] });
        const b2 = write(syncB, { scriptText: 'property B again', scriptUrls: [PRODUCTION.debug] });

        expect(b1.removed).toEqual([]);
        expect(b2.removed).toEqual([onDisk('launch-a1b2c3d4e5f6.min.js')]);
        expect(read(a.written[0])).toBe('property A');
        expect(manifestOf(syncA).files).toEqual(a.written);
    });

    describe('a previous manifest that lists more than it should', () => {
        const previously = (syncDir, files) => {
            fs.mkdirSync(path.join(syncDir, '.reactor-sync'), { recursive: true });
            fs.writeFileSync(path.join(syncDir, '.reactor-sync', 'test-build.json'), JSON.stringify({ files }));
        };

        test('never removes a file outside the overrides folder', () => {
            const outside = path.join(dir, 'outside.js');
            // Joined by hand, so the ".." stays in the manifest as written
            const viaDotDot = `${overridesDir}${path.sep}..${path.sep}outside-too.js`;
            const inSibling = path.join(dir, 'overrides-elsewhere', 'file.js');
            fs.mkdirSync(path.dirname(inSibling), { recursive: true });
            for (const file of [outside, viaDotDot, inSibling]) fs.writeFileSync(file, 'keep me');
            previously(syncA, [outside, viaDotDot, inSibling]);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            for (const file of [outside, viaDotDot, inSibling]) expect(read(file)).toBe('keep me');
        });

        test('never removes a file in an overrides folder that has changed since', () => {
            const oldOverridesDir = path.join(dir, 'old-overrides');
            const oldFile = path.join(oldOverridesDir, 'assets.adobedtm.com', 'launch.js');
            fs.mkdirSync(path.dirname(oldFile), { recursive: true });
            fs.writeFileSync(oldFile, 'old folder');
            previously(syncA, [oldFile]);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(read(oldFile)).toBe('old folder');
        });

        test('ignores entries that aren\'t absolute paths', () => {
            fs.mkdirSync(overridesDir, { recursive: true });
            const relative = path.relative(process.cwd(), path.join(overridesDir, 'relative.js'));
            fs.writeFileSync(path.join(overridesDir, 'relative.js'), 'keep me');
            previously(syncA, [relative, 42, null, '']);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(read(path.join(overridesDir, 'relative.js'))).toBe('keep me');
        });

        test('never removes a folder', () => {
            const folder = onDisk('rule-code');
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, 'inside.js'), 'keep me');
            previously(syncA, [folder]);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(read(path.join(folder, 'inside.js'))).toBe('keep me');
        });

        test('removes nothing when the manifest can\'t be read, and replaces it', () => {
            const stale = onDisk('launch-a1b2c3d4e5f6.min.js');
            fs.mkdirSync(path.dirname(stale), { recursive: true });
            fs.writeFileSync(stale, 'keep me');
            fs.mkdirSync(path.join(syncA, '.reactor-sync'), { recursive: true });
            fs.writeFileSync(path.join(syncA, '.reactor-sync', 'test-build.json'), '{ not json');

            const { written, removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(read(stale)).toBe('keep me');
            expect(manifestOf(syncA).files).toEqual(written);
        });

        // Windows paths ignore case: the same file, spelled differently, is still this run's
        (process.platform === 'win32' ? test : test.skip)('keeps a file this run wrote when the manifest spells its path in another case', () => {
            const { written } = write(syncA, { scriptUrls: [PRODUCTION.debug] });
            previously(syncA, [written[0].toUpperCase()]);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(fs.existsSync(written[0])).toBe(true);
        });
    });

    test('writes paths over 260 characters', () => {
        const deep = path.join(overridesDir, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(60));
        const target = urlToPath(deep, PRODUCTION.minified);
        expect(path.resolve(target).length).toBeGreaterThan(260);

        try {
            const { written } = writeOverrides({
                overridesDir: deep, syncDir: syncA, scriptText: 'deep text', scriptUrls: [PRODUCTION.minified], files: [], manifest: {}
            });

            expect(written).toEqual([path.resolve(target)]);
            expect(written[0].startsWith('\\\\?\\')).toBe(false);
            expect(fs.existsSync(longPath(target))).toBe(true);
            expect(fs.readFileSync(longPath(target), 'utf8')).toBe('deep text');
            expect(manifestOf(syncA).files).toEqual(written);

            // The next run removes it by the same path
            const next = writeOverrides({
                overridesDir: deep, syncDir: syncA, scriptText: 'deep text', scriptUrls: [PRODUCTION.debug], files: [], manifest: {}
            });
            expect(next.removed).toEqual(written);
            expect(fs.existsSync(longPath(target))).toBe(false);
        } finally {
            // The folders under 260 characters go with the temp folder
            fs.rmSync(longPath(deep), { recursive: true, force: true });
        }
    });
});
