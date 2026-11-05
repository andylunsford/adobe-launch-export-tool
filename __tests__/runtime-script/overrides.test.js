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

    test('skips a missing environment, source and attributes', () => {
        const environments = [
            null,
            undefined,
            { id: 'EN1' },
            { attributes: null, meta: { script_sources: [null, { debug: PRODUCTION.debug }] } }
        ];
        expect(scriptUrls(environments)).toEqual([PRODUCTION.debug]);
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

    // 248 is the longest directory path Windows takes without the prefix, less one
    test('leaves a path under 248 characters alone', () => {
        const p = pathOfLength(247);
        expect(p).toHaveLength(247);
        expect(longPath(p)).toBe(p);
    });

    test('prefixes a path of 248 characters or more on Windows only', () => {
        const p = pathOfLength(248);
        expect(p).toHaveLength(248);
        expect(longPath(p)).toBe(process.platform === 'win32' ? `\\\\?\\${p}` : p);
    });

    test('doesn\'t prefix a path twice', () => {
        const p = pathOfLength(300);
        expect(longPath(longPath(p))).toBe(longPath(p));
    });
});

describe('writeOverrides', () => {
    let dir, overridesDir, syncA, syncB;

    beforeEach(() => {
        // The real path, so that where the temp folder is a link (macOS) paths can't differ by it
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overrides-')));
        overridesDir = path.join(dir, 'overrides');
        syncA = path.join(dir, 'sync-a');
        syncB = path.join(dir, 'sync-b');
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const read = (p) => fs.readFileSync(p, 'utf8');
    const manifestOf = (syncDir) => JSON.parse(read(path.join(syncDir, '.reactor-sync', 'test-build.json')));
    const onDisk = (...segments) => path.join(overridesDir, 'assets.adobedtm.com', '0000aaaa', '1111bbbb', ...segments);
    const write = (syncDir, options) => writeOverrides({
        overridesDir, syncDir, scriptText: 'script text', scriptUrls: [], files: [], manifest: {}, ...options
    });

    test('script goes at every environment URL, both names', () => {
        const urls = scriptUrls([environment('development', [DEVELOPMENT]), environment('production', [PRODUCTION])]);
        const { written, removed, warnings } = write(syncA, { scriptText: '// the test build\n', scriptUrls: urls });

        const names = ['launch-a1b2c3d4e5f6-development.min.js', 'launch-a1b2c3d4e5f6-development.js', 'launch-a1b2c3d4e5f6.min.js', 'launch-a1b2c3d4e5f6.js'];
        expect(written).toEqual(names.map(name => onDisk(name)));
        for (const file of written) expect(read(file)).toBe('// the test build\n');
        expect(removed).toEqual([]);
        expect(warnings).toEqual([]);
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

    test('writes a URL once when it is listed twice', () => {
        const { written } = write(syncA, {
            scriptUrls: [PRODUCTION.debug, PRODUCTION.debug],
            files: [{ url: PRODUCTION.debug, text: 'custom code' }]
        });

        expect(written).toEqual([onDisk('launch-a1b2c3d4e5f6.js')]);
        expect(manifestOf(syncA).files).toEqual(written);
    });

    test('needs an overrides folder, and writes nothing without one', () => {
        // Without one, the build would land in the folder the run is in
        const cwd = process.cwd();
        process.chdir(dir);
        try {
            for (const missing of ['', '  ', undefined, null]) {
                expect(() => write(syncA, { overridesDir: missing, scriptUrls: [PRODUCTION.debug] })).toThrow('Choose an overrides folder');
            }
        } finally {
            process.chdir(cwd);
        }
        expect(fs.readdirSync(dir)).toEqual([]);
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
            // The ".." resolves the folder before it, so that has to be there
            fs.mkdirSync(overridesDir, { recursive: true });
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
            fs.writeFileSync(path.join(overridesDir, 'relative.js'), 'keep me');
            // Relative to the folder the run is in, which is dir, whatever drive that is on
            previously(syncA, [path.join('overrides', 'relative.js'), 42, null, '']);

            const cwd = process.cwd();
            process.chdir(dir);
            try {
                const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });
                expect(removed).toEqual([]);
            } finally {
                process.chdir(cwd);
            }
            expect(read(path.join(overridesDir, 'relative.js'))).toBe('keep me');
        });

        test('removes only .js files under the hosts this tool writes to', () => {
            const kept = [
                path.join(overridesDir, 'notes.txt'),
                path.join(overridesDir, 'other-host', 'x.js'),
                path.join(overridesDir, 'loose.js'),
                onDisk('notes.txt'),
                onDisk('launch.js.txt')
            ];
            for (const file of kept) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, 'keep me');
            }
            previously(syncA, kept);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            for (const file of kept) expect(read(file)).toBe('keep me');
        });

        test('removes .js files under assets.adobedtm.com and under the host of any URL this run writes', () => {
            const SELF_HOSTED = 'https://cdn.example.test/launch';
            write(syncA, {
                scriptUrls: [`${SELF_HOSTED}/launch.min.js`, `${SELF_HOSTED}/launch.js`, PRODUCTION.debug],
                files: [{ url: 'https://code.example.test/RC1111.js', text: 'old code' }]
            });

            // Nothing this run writes is on assets.adobedtm.com
            const { removed } = write(syncA, {
                scriptUrls: [`${SELF_HOSTED}/launch.js`],
                files: [{ url: 'https://code.example.test/RC2222.js', text: 'new code' }]
            });

            expect(removed).toEqual([
                path.join(overridesDir, 'cdn.example.test', 'launch', 'launch.min.js'),
                onDisk('launch-a1b2c3d4e5f6.js'),
                path.join(overridesDir, 'code.example.test', 'RC1111.js')
            ]);
        });

        test('never removes a folder', () => {
            // Named like a file this tool writes, so only its being a folder keeps it
            const folder = onDisk('rule-code.js');
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, 'inside.js'), 'keep me');
            previously(syncA, [folder]);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(read(path.join(folder, 'inside.js'))).toBe('keep me');
        });

        describe('that can\'t be read', () => {
            const unreadable = (syncDir) => `The previous test build's manifest (${path.join(syncDir, '.reactor-sync', 'test-build.json')}) couldn't be read, so the files it listed were left in place`;
            const manifestPath = () => path.join(syncA, '.reactor-sync', 'test-build.json');
            const stale = () => onDisk('launch-a1b2c3d4e5f6.min.js');

            beforeEach(() => {
                fs.mkdirSync(path.dirname(stale()), { recursive: true });
                fs.writeFileSync(stale(), 'keep me');
                fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
            });

            // The text is made when the test runs, once there is a folder to point at
            test.each([
                ['isn\'t JSON', () => '{ not json'],
                ['is null', () => 'null'],
                ['has no files', () => '{}'],
                ['is a list', () => '[]'],
                ['has files that aren\'t a list', () => JSON.stringify({ files: stale() })],
                ['has files as an object', () => JSON.stringify({ files: { 0: stale() } })]
            ])('a manifest that %s removes nothing, says so, and is replaced', (_, textOf) => {
                fs.writeFileSync(manifestPath(), textOf());

                const { written, removed, warnings } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

                expect(removed).toEqual([]);
                expect(warnings).toEqual([unreadable(syncA)]);
                expect(read(stale())).toBe('keep me');
                expect(manifestOf(syncA).files).toEqual(written);
            });

            test('no manifest at all is not a warning', () => {
                const { warnings } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

                expect(warnings).toEqual([]);
            });
        });

        // These file systems ignore case: the same file, spelled differently, is still this run's
        (['win32', 'darwin'].includes(process.platform) ? test : test.skip)('keeps a file this run wrote when the manifest spells its name in another case', () => {
            const { written } = write(syncA, { scriptUrls: [PRODUCTION.debug] });
            previously(syncA, [path.join(path.dirname(written[0]), path.basename(written[0]).toUpperCase())]);

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(fs.existsSync(written[0])).toBe(true);
        });
    });

    describe('links', () => {
        // A directory link: a junction on Windows, which needs no privilege. False when the OS refuses.
        const link = (target, at) => {
            try {
                fs.symlinkSync(target, at, 'junction');
                return true;
            } catch (err) {
                if (err.code === 'EPERM' || err.code === 'EACCES') return false;
                throw err;
            }
        };

        test('never removes a file by way of a link out of the overrides folder', () => {
            const elsewhere = path.join(dir, 'elsewhere');
            fs.mkdirSync(elsewhere);
            fs.writeFileSync(path.join(elsewhere, 'victim.js'), 'keep me');
            // Under a host this tool writes to, so only the link keeps it
            const host = path.join(overridesDir, 'assets.adobedtm.com');
            fs.mkdirSync(host, { recursive: true });
            if (!link(elsewhere, path.join(host, 'linked'))) return;
            fs.mkdirSync(path.join(syncA, '.reactor-sync'), { recursive: true });
            fs.writeFileSync(path.join(syncA, '.reactor-sync', 'test-build.json'), JSON.stringify({ files: [path.join(host, 'linked', 'victim.js')] }));

            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([]);
            expect(read(path.join(elsewhere, 'victim.js'))).toBe('keep me');
        });

        test('removes files in an overrides folder that is itself a link', () => {
            const real = path.join(dir, 'real-overrides');
            fs.mkdirSync(real);
            if (!link(real, overridesDir)) return;

            write(syncA, { scriptUrls: [PRODUCTION.minified, PRODUCTION.debug] });
            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });

            expect(removed).toEqual([onDisk('launch-a1b2c3d4e5f6.min.js')]);
            expect(fs.existsSync(path.join(real, 'assets.adobedtm.com', '0000aaaa', '1111bbbb', 'launch-a1b2c3d4e5f6.min.js'))).toBe(false);
            expect(fs.existsSync(path.join(real, 'assets.adobedtm.com', '0000aaaa', '1111bbbb', 'launch-a1b2c3d4e5f6.js'))).toBe(true);
        });
    });

    describe('a run that fails part way', () => {
        const denied = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        // Makes fs[name] fail for these paths and work for every other
        const failOn = (name, ...targets) => {
            const original = fs[name];
            return jest.spyOn(fs, name).mockImplementation((p, ...rest) => {
                if (targets.includes(p)) throw denied();
                return original(p, ...rest);
            });
        };
        const MINIFIED = () => onDisk('launch-a1b2c3d4e5f6.min.js');
        const DEBUG = () => onDisk('launch-a1b2c3d4e5f6.js');
        const CODE = () => onDisk('rule-code', 'RC1111.js');

        beforeEach(() => {
            write(syncA, { scriptUrls: [PRODUCTION.minified, PRODUCTION.debug], files: [{ url: `${BASE}/rule-code/RC1111.js`, text: 'old code' }] });
        });

        test('a file that can\'t be removed doesn\'t stop the others, stays listed, and is thrown', () => {
            failOn('unlinkSync', MINIFIED());

            expect(() => write(syncA, { scriptUrls: [PRODUCTION.debug] })).toThrow('EPERM');

            expect(fs.existsSync(CODE())).toBe(false);
            expect(fs.existsSync(MINIFIED())).toBe(true);
            expect(manifestOf(syncA).files).toEqual([DEBUG(), MINIFIED()]);

            // Once it can be removed, the next run does
            jest.restoreAllMocks();
            const { removed } = write(syncA, { scriptUrls: [PRODUCTION.debug] });
            expect(removed).toEqual([MINIFIED()]);
            expect(manifestOf(syncA).files).toEqual([DEBUG()]);
        });

        test('several files that can\'t be removed are thrown together', () => {
            failOn('unlinkSync', MINIFIED(), CODE());

            let error;
            try {
                write(syncA, { scriptUrls: [PRODUCTION.debug] });
            } catch (err) {
                error = err;
            }

            expect(error).toBeInstanceOf(AggregateError);
            expect(error.errors).toHaveLength(2);
            expect(manifestOf(syncA).files).toEqual([DEBUG(), MINIFIED(), CODE()]);
        });

        test('a file that can\'t be written lists what was written and what was not yet removed', () => {
            const development = onDisk('launch-a1b2c3d4e5f6-development.js');
            failOn('writeFileSync', development);

            expect(() => write(syncA, { scriptUrls: [PRODUCTION.debug, DEVELOPMENT.debug] })).toThrow('EPERM');

            expect(fs.existsSync(MINIFIED())).toBe(true);
            expect(fs.existsSync(CODE())).toBe(true);
            expect(manifestOf(syncA).files).toEqual([DEBUG(), development, MINIFIED(), CODE()]);
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
            // The folders above it are short enough to go with the temp folder
            fs.rmSync(longPath(deep), { recursive: true, force: true });
        }
    });

    // Windows reads a path of 248 characters or more only with the prefix, and a call that
    // forgets it fails only on a machine without long path support: this catches it anywhere
    (process.platform === 'win32' ? test : test.skip)('every fs call on a long path carries the prefix', () => {
        const nested = (root) => path.join(root, 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(60));
        const deepOverrides = nested(overridesDir);
        const deepSync = nested(syncA);
        const names = ['mkdirSync', 'writeFileSync', 'readFileSync', 'realpathSync.native', 'lstatSync', 'unlinkSync'];
        const spies = Object.fromEntries(names.map(name => {
            const [owner, method] = name === 'realpathSync.native' ? [fs.realpathSync, 'native'] : [fs, name];
            return [name, jest.spyOn(owner, method)];
        }));
        const options = { overridesDir: deepOverrides, syncDir: deepSync, scriptText: 'deep text', files: [], manifest: {} };

        try {
            // The second run reads the manifest, then removes the minified file
            writeOverrides({ ...options, scriptUrls: [PRODUCTION.minified, PRODUCTION.debug] });
            writeOverrides({ ...options, scriptUrls: [PRODUCTION.debug] });

            for (const name of names) {
                const paths = spies[name].mock.calls.map(([p]) => String(p));
                const long = paths.filter(p => p.replace(/^\\\\\?\\/, '').length >= 248);
                expect(long.length).toBeGreaterThan(0);
                for (const p of long) expect(p.startsWith('\\\\?\\')).toBe(true);
            }
        } finally {
            jest.restoreAllMocks();
            fs.rmSync(longPath(deepOverrides), { recursive: true, force: true });
            fs.rmSync(longPath(deepSync), { recursive: true, force: true });
        }
    });
});
