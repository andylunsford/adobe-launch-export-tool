'use strict';

/**
 * Suite 4 – Tab navigation & feature smoke tests  (mock-based, no network required)
 */

const { test, expect, loginWithMocks, MOCK_DATA } = require('./fixtures');

/** Shared setup: log in via mocks and select the first company. */
async function setupMainInterface(win) {
    await loginWithMocks(win);
    await expect(win.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await win.locator('#company-select').selectOption({ index: 1 });
    await win.locator('button.primary[onclick="saveCompanySelection()"]').click();
    await expect(win.locator('#main-interface')).not.toHaveClass(/hidden/, { timeout: 10_000 });
}

test.describe('Tab navigation', () => {
    test('four tabs are rendered', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await expect(mockedWindow.locator('.tab-btn')).toHaveCount(4);
    });

    test('Export Manager tab is active by default', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await expect(mockedWindow.locator('#tab-export')).toHaveClass(/active/);
    });

    test('switching to Environment Comparison tab shows its content', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();
        await expect(mockedWindow.locator('#tab-compare')).toHaveClass(/active/);
        await expect(mockedWindow.locator('#compare-prop-select')).toBeVisible();
        await expect(mockedWindow.locator('#compare-mode-select')).toBeVisible();
    });

    test('switching to Developer Sync tab shows its content', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'Developer Sync' }).click();
        await expect(mockedWindow.locator('#tab-sync')).toHaveClass(/active/);
        await expect(mockedWindow.locator('#sync-prop-select')).toBeVisible();
        await expect(mockedWindow.locator('#sync-folder-path')).toBeVisible();
        await expect(mockedWindow.locator('#sync-console')).toBeVisible();
    });

    test('switching to History Archive tab shows its content', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'History Archive' }).click();
        await expect(mockedWindow.locator('#tab-archive')).toHaveClass(/active/);
        await expect(mockedWindow.locator('#archive-folder-path')).toBeVisible();
        await expect(mockedWindow.locator('#archive-console')).toBeVisible();
    });
});

test.describe('Export Manager tab', () => {
    test('Full Export checkbox is pre-checked, Latest Library is unchecked', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await expect(mockedWindow.locator('#opt-full-export')).toBeChecked();
        await expect(mockedWindow.locator('#opt-library-export')).not.toBeChecked();
    });

    test('Download Selected button is present', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await expect(mockedWindow.locator('button[onclick="startExportJob()"]')).toBeVisible();
    });
});

test.describe('Environment Comparison tab', () => {
    test('compare mode selector has three options', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();
        await expect(mockedWindow.locator('#compare-mode-select option')).toHaveCount(3);
    });

    test('property dropdown in compare tab reflects selected properties', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);

        // Select all properties in the property panel first
        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(mockedWindow.locator('#property-select-panel')).not.toHaveClass(/hidden/);
        await expect(mockedWindow.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 10_000 });
        await mockedWindow.locator('#select-all-toggle').check();
        await mockedWindow.locator('#property-select-panel button.primary').click(); // Done

        // Now switch to compare tab
        await mockedWindow.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();
        await expect(mockedWindow.locator('#tab-compare')).toHaveClass(/active/);

        // Dropdown should have one option per selected property + 1 placeholder
        const opts = mockedWindow.locator('#compare-prop-select option');
        await expect(opts).toHaveCount(MOCK_DATA.properties.length + 1, { timeout: 10_000 });
    });

    test('property dropdown picks up properties selected after the tab was opened', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);

        // Open the compare tab before any property is selected
        await mockedWindow.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();
        await expect(mockedWindow.locator('#compare-prop-select option')).toHaveCount(1);

        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(mockedWindow.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 10_000 });
        await mockedWindow.locator('#select-all-toggle').check();
        await mockedWindow.locator('#property-select-panel button.primary').click(); // Done

        await expect(mockedWindow.locator('#compare-prop-select option'))
            .toHaveCount(MOCK_DATA.properties.length + 1, { timeout: 10_000 });
    });

    /** Select every property, open the compare tab and choose the first property. */
    async function openCompareWithProperty(win) {
        await setupMainInterface(win);
        await win.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(win.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 10_000 });
        await win.locator('#select-all-toggle').check();
        await win.locator('#property-select-panel button.primary').click(); // Done
        await win.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();
        await win.locator('#compare-prop-select').selectOption(MOCK_DATA.properties[0].id);
    }

    test('each compare mode lists only what it compares', async ({ mockedWindow }) => {
        await openCompareWithProperty(mockedWindow);
        const optionsA = mockedWindow.locator('#envA-select option');
        const optionsB = mockedWindow.locator('#envB-select option');
        const environments = MOCK_DATA.environments.length + 1; // + placeholder
        const libraries = MOCK_DATA.libraries.length + 1;

        await expect(optionsA).toHaveCount(environments, { timeout: 10_000 });
        await expect(optionsB).toHaveCount(environments);
        await expect(mockedWindow.locator('#loading-overlay')).toHaveClass(/hidden/);

        await mockedWindow.locator('#compare-mode-select').selectOption('libraries');
        await expect(optionsA).toHaveCount(libraries);
        await expect(optionsB).toHaveCount(libraries);

        // History compares an environment's own builds, so it takes environments only
        await mockedWindow.locator('#compare-mode-select').selectOption('history');
        await expect(optionsA).toHaveCount(environments);
    });

    test('environment details show the deployed library and build', async ({ mockedWindow }) => {
        await openCompareWithProperty(mockedWindow);
        await mockedWindow.locator('#envA-select').selectOption('EN_PRD');

        const info = mockedWindow.locator('#envA-library-info');
        await expect(info).toContainText('production');
        await expect(info).toContainText(MOCK_DATA.envLibrary.libraryName);
        await expect(info).toContainText(MOCK_DATA.envLibrary.buildId);
        await expect(info).not.toContainText('N/A');
    });

    test('a comparison lists real changes and only counts revisions that changed nothing', async ({ electronApp, mockedWindow }) => {
        await openCompareWithProperty(mockedWindow);
        await mockedWindow.locator('#envA-select').selectOption('EN_PRD');
        await mockedWindow.locator('#envB-select').selectOption('EN_DEV');
        await mockedWindow.locator('button.primary[onclick="performEnvironmentComparison()"]').click();

        const results = mockedWindow.locator('#comparison-content');
        await expect(results).toContainText('Page View', { timeout: 10_000 });
        await expect(results).toContainText('1 rule has a new revision with no changes');
        await expect(results).not.toContainText('Click (Click to see changes)');

        // The property decides whether component timeouts and delays count
        const payload = await electronApp.evaluate(() => globalThis.__lastComparePayload);
        expect(payload.propertyId).toBe(MOCK_DATA.properties[0].id);
    });

    /** Compare production with development and wait for the results. */
    async function runComparison(win) {
        await openCompareWithProperty(win);
        await win.locator('#envA-select').selectOption('EN_PRD');
        await win.locator('#envB-select').selectOption('EN_DEV');
        await win.locator('button.primary[onclick="performEnvironmentComparison()"]').click();
        await expect(win.locator('#comparison-content')).toContainText('Form Submit', { timeout: 10_000 });
    }

    test('a new rule shows its components, with custom code as text', async ({ mockedWindow }) => {
        await runComparison(mockedWindow);
        await mockedWindow.locator('#comparison-content .diff-item', { hasText: 'Form Submit' }).click();

        const modal = mockedWindow.locator('#diff-content');
        await expect(modal).toContainText('Submit (core::events::submit)');
        await expect(modal).toContainText('Thank You Banner (core::actions::custom-code)');
        await expect(modal).toContainText('<b>Thanks</b>');
        await expect(modal.locator('img, b')).toHaveCount(0);
        expect(await mockedWindow.evaluate(() => window.__injected)).toBeUndefined();
    });

    test('release notes list a new rule\'s components', async ({ electronApp, mockedWindow }) => {
        mockedWindow.on('dialog', dialog => dialog.accept());
        await runComparison(mockedWindow);
        await mockedWindow.locator('button[onclick="downloadComparisonNotes()"]').click();

        await expect.poll(() => electronApp.evaluate(() => globalThis.__lastSavedFile?.content))
            .toContain('Thank You Banner (core::actions::custom-code)');
    });

    test('library details show its state and last build', async ({ mockedWindow }) => {
        await openCompareWithProperty(mockedWindow);
        await mockedWindow.locator('#compare-mode-select').selectOption('libraries');
        await mockedWindow.locator('#envA-select').selectOption('LB_001');

        const info = mockedWindow.locator('#envA-library-info');
        await expect(info).toContainText('published');
        await expect(info).toContainText('BL_001');
        await expect(info).not.toContainText('N/A');
    });
});

test.describe('History Archive tab', () => {
    test('all resource-type checkboxes are present and pre-checked', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'History Archive' }).click();

        for (const id of ['chk-scan-rules', 'chk-scan-de', 'chk-scan-ext', 'chk-scan-rc', 'chk-scan-env', 'chk-scan-lib']) {
            await expect(mockedWindow.locator(`#${id}`)).toBeChecked();
        }
    });

    test('a scan lists counts per property, with totals and failures', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(mockedWindow.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 10_000 });
        await mockedWindow.locator('#select-all-toggle').check();
        await mockedWindow.locator('#property-select-panel button.primary').click();

        await mockedWindow.locator('.tab-btn', { hasText: 'History Archive' }).click();
        await mockedWindow.locator('button', { hasText: 'Scan Property' }).click();

        const table = mockedWindow.locator('#archive-scan-table');
        await expect(table.locator('thead th')).toHaveText([
            'Property', 'Rules', 'Data Elements', 'Extensions', 'Rule Components', 'Environments', 'Libraries', 'Total'
        ]);
        await expect(table.locator('tr[data-property-id="PR_MOCK_001"] td')).toHaveText([
            'Mock Property One', '12', '30', '4', 'via rules', '3', '1,500', '1,549'
        ]);
        await expect(table.locator('tr[data-property-id="PR_MOCK_002"] td')).toHaveText([
            'Mock Property Two', '5', '8', '2', 'via rules', '3', '20', '38'
        ]);
        await expect(table.locator('tr[data-property-id="PR_MOCK_003"] td').nth(1)).toHaveText('Scan failed: Request failed with status code 403');
        await expect(table.locator('tfoot td')).toHaveText([
            'All properties', '17', '38', '6', '—', '6', '1,520', '1,587'
        ]);

        // The badges beside each type show the totals too
        await expect(mockedWindow.locator('#count-rules')).toHaveText('17');
        await expect(mockedWindow.locator('#count-lib')).toHaveText('1,520');
        await expect(mockedWindow.locator('#count-rc')).toHaveText('via rules');

        // The properties that scanned can still be archived
        await expect(mockedWindow.locator('#btn-start-archive')).toBeEnabled();
    });

    test('Start Archive button is initially disabled', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'History Archive' }).click();
        await expect(mockedWindow.locator('#btn-start-archive')).toBeDisabled();
    });
});

test.describe('Developer Sync tab', () => {
    /** Select one property, open the sync tab and pick a folder. */
    async function openSyncWithProperty(win) {
        await setupMainInterface(win);
        await win.locator('button.icon-btn[title="Select Properties"]').click();
        await win.locator('#property-list .prop-item', { hasText: 'Mock Property One' }).locator('input').check();
        await win.locator('#property-select-panel button.primary').click();
        await win.locator('.tab-btn', { hasText: 'Developer Sync' }).click();
        await win.locator('#tab-sync button[onclick="selectSyncFolder()"]').click();
        await expect(win.locator('#sync-folder-path')).toHaveValue('C:/mock-sync');
    }

    const LIBRARY = 'Library 2.0 (development)';
    // The library's name loses its dot, as sanitizeFolderName does
    const LIBRARY_FOLDER = 'C:/mock-sync/Mock Property One - Library 20';

    /** The button that lists the chosen property's unpublished libraries. */
    const fetchLibraries = (win) => win.locator('#tab-sync button', { hasText: 'Fetch Unpublished Libraries' });

    /** List the property's libraries and choose the one that isn't published. */
    async function chooseLibrary(win) {
        await fetchLibraries(win).click();
        await win.locator('#sync-library').selectOption({ label: LIBRARY });
    }

    /** Pick the overrides folder under Test Build. */
    async function browseOverrides(win) {
        await win.locator('#tab-sync button[onclick="selectOverridesFolder()"]').click();
        await expect(win.locator('#test-build-overrides-path')).toHaveValue('C:/mock-sync');
    }

    /** Tick or untick a property in the header's property list. */
    async function setProperty(win, name, checked) {
        await win.locator('button.icon-btn[title="Select Properties"]').click();
        await win.locator('#property-list .prop-item', { hasText: name }).locator('input').setChecked(checked);
        await win.locator('#property-select-panel button.primary').click();
    }

    test('a status check lists each state, conflicts with their reason, and failed lists', async ({ mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await mockedWindow.locator('button', { hasText: 'Check Status' }).click();

        const log = mockedWindow.locator('#sync-console');
        await expect(log).toContainText('Files To Be Pushed (Modified) [1]');
        await expect(log).toContainText('[~] sync/rule_components/RC_TRACK (Page View › Track)');
        await expect(log).toContainText('Files To Be Pushed (Deleted Locally) [1]');
        await expect(log).toContainText('Files To Be Pulled (New/Modified in Launch) [1]');
        await expect(log).toContainText('Deleted in Launch (Download moves these to _deleted) [1]');
        await expect(log).toContainText('[x] sync/rules/RL_OLD (Old Campaign)');
        await expect(log).toContainText('[!] sync/data_elements/DE_CART (Cart): changed locally and in Launch');
        await expect(log).toContainText("⚠ Couldn't list extensions: Request failed with status code 500");
        await expect(log).not.toContainText('Everything is in sync');
    });

    test('a download reports folders set aside and local edits kept', async ({ mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await mockedWindow.locator('button', { hasText: 'Initialize' }).click();

        const log = mockedWindow.locator('#sync-console');
        await expect(log).toContainText('✅ Downloaded 120 items.');
        await expect(log).toContainText('Removed 3 code files the items no longer have.');
        await expect(log).toContainText('Moved to _deleted (deleted in Launch) [1]');
        await expect(log).toContainText('[x] rules/RL_OLD (Old Campaign)');
        await expect(log).toContainText('[~] data_elements/DE_CART (Cart)');
        await expect(log).toContainText('All downloads complete.');
    });

    test('Developer Sync generates a test build for a library', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await fetchLibraries(mockedWindow).click();

        // The published library isn't offered, and the environment list holds development environments only
        const picker = mockedWindow.locator('#sync-library');
        await expect(picker.locator('option')).toHaveText(['Whole property', LIBRARY]);
        await expect(mockedWindow.locator('#test-build-environment option')).toHaveText(['Development']);
        await picker.selectOption({ label: LIBRARY });

        await browseOverrides(mockedWindow);
        await mockedWindow.locator('#tab-sync button', { hasText: 'Generate' }).click();

        const log = mockedWindow.locator('#sync-console');
        await expect(log).toContainText('Replaced [1]');
        await expect(log).toContainText('rule Click');
        await expect(log).toContainText('Point Chrome DevTools → Sources → Overrides at C:/mock-sync (overrides apply only while DevTools is open).');
        // Said once
        await expect(log.locator('div', { hasText: /Sources → Overrides/ })).toHaveCount(1);

        const sent = await electronApp.evaluate(() => globalThis.__lastTestBuildPayload);
        expect(sent).toMatchObject({
            targetDir: LIBRARY_FOLDER,
            overridesDir: 'C:/mock-sync',
            environmentId: 'EN_DEV',
            token: 'mock-access-token-abc123'
        });
    });

    test('a library is downloaded and checked in a folder of its own', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await chooseLibrary(mockedWindow);

        await mockedWindow.locator('button', { hasText: 'Initialize' }).click();
        await expect(mockedWindow.locator('#sync-console')).toContainText('✅ Downloaded 120 items.');
        const download = await electronApp.evaluate(() => globalThis.__lastSyncDownloadPayload);
        expect(download).toMatchObject({
            property: { id: 'PR_MOCK_001', name: 'Mock Property One' },
            library: { id: 'LB_002', name: 'Library 2.0' },
            targetDir: LIBRARY_FOLDER
        });

        await mockedWindow.locator('button', { hasText: 'Check Status' }).click();
        await expect(mockedWindow.locator('#sync-console')).toContainText('Files To Be Pushed (Modified) [1]');
        const diff = await electronApp.evaluate(() => globalThis.__lastSyncDiffPayload);
        expect(diff.targetDir).toBe(LIBRARY_FOLDER);

        // Back to the whole property: today's folder, and no library
        await mockedWindow.locator('#sync-library').selectOption('');
        await mockedWindow.locator('button', { hasText: 'Initialize' }).click();
        await expect.poll(() => electronApp.evaluate(() => globalThis.__lastSyncDownloadPayload.targetDir))
            .toBe('C:/mock-sync/Mock Property One');
        expect(await electronApp.evaluate(() => globalThis.__lastSyncDownloadPayload.library)).toBeNull();
    });

    test('Generate and Push say what they need, and do nothing', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        const log = mockedWindow.locator('#sync-console');
        const generate = mockedWindow.locator('#tab-sync button', { hasText: 'Generate' });

        await generate.click();
        await expect(log).toContainText('Choose a library');

        await chooseLibrary(mockedWindow);
        await generate.click();
        await expect(log).toContainText('Choose an overrides folder');

        // Pushing a library's folder isn't offered. (The tab has no Push button.)
        await mockedWindow.evaluate(() => window.pushToLaunch());
        await expect(log).toContainText("Pushing a library sync isn't available yet");
        await expect(log).not.toContainText('Starting Push');

        expect(await electronApp.evaluate(() => globalThis.__lastTestBuildPayload)).toBeUndefined();
    });

    test('the property picker lists the header\'s properties, and keeps the one chosen', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'Developer Sync' }).click();
        const picker = mockedWindow.locator('#sync-prop-select');
        await expect(picker.locator('option')).toHaveText(['Select Properties Globally First']);

        // One property is the one chosen
        await setProperty(mockedWindow, 'Mock Property One', true);
        await expect(picker.locator('option')).toHaveText(['Mock Property One']);
        await expect(picker).toHaveValue('PR_MOCK_001');

        // A second joins: all of them can be chosen, and the first stays chosen. The
        // properties are grouped by platform, so Two (Event Forwarding) comes first.
        await setProperty(mockedWindow, 'Mock Property Two', true);
        await expect(picker.locator('option')).toHaveText(['All selected properties', 'Mock Property Two', 'Mock Property One']);
        await expect(picker).toHaveValue('PR_MOCK_001');
    });

    test('Fetch Unpublished Libraries comes before the library list', async ({ mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        const button = await fetchLibraries(mockedWindow).boundingBox();
        const list = await mockedWindow.locator('#sync-library').boundingBox();
        expect(button.x + button.width).toBeLessThanOrEqual(list.x);
    });

    test('library actions work on the property chosen, and its libraries only', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await setProperty(mockedWindow, 'Mock Property Two', true);
        const picker = mockedWindow.locator('#sync-prop-select');
        const libraries = mockedWindow.locator('#sync-library option');
        const environments = mockedWindow.locator('#test-build-environment option');
        const log = mockedWindow.locator('#sync-console');

        // Two are selected, and the one chosen has its library downloaded
        await chooseLibrary(mockedWindow);
        await mockedWindow.locator('button', { hasText: 'Initialize' }).click();
        await expect(log).toContainText('✅ Downloaded 120 items.');
        expect(await electronApp.evaluate(() => globalThis.__syncDownloadPayloads)).toEqual([
            expect.objectContaining({ property: { id: 'PR_MOCK_001', name: 'Mock Property One' }, library: { id: 'LB_002', name: 'Library 2.0' } })
        ]);

        // The list is that property's: choosing another empties it, environments too
        await picker.selectOption('PR_MOCK_002');
        await expect(libraries).toHaveText(['Whole property']);
        await expect(environments).toHaveCount(0);

        // A library is one property's, so with all of them chosen none are fetched
        await picker.selectOption('');
        await fetchLibraries(mockedWindow).click();
        await expect(log).toContainText('Fetching libraries needs one property. Choose it under Select Property.');
        await expect(libraries).toHaveText(['Whole property']);

        // Unticking the chosen property in the header empties the list too
        await picker.selectOption('PR_MOCK_001');
        await chooseLibrary(mockedWindow);
        await setProperty(mockedWindow, 'Mock Property One', false);
        await expect(picker).toHaveValue('PR_MOCK_002');
        await expect(libraries).toHaveText(['Whole property']);
    });

    test('whole-property actions work on the property chosen, or on every one selected', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await setProperty(mockedWindow, 'Mock Property Two', true);
        const downloaded = () => electronApp.evaluate(() => globalThis.__syncDownloadPayloads.map(payload => payload.targetDir));
        const initialize = mockedWindow.locator('button', { hasText: 'Initialize' });

        await initialize.click();
        await expect.poll(downloaded).toEqual(['C:/mock-sync/Mock Property One']);

        await mockedWindow.locator('#sync-prop-select').selectOption('');
        await initialize.click();
        await expect.poll(downloaded).toHaveLength(3);
        expect((await downloaded()).slice(1).sort()).toEqual(['C:/mock-sync/Mock Property One', 'C:/mock-sync/Mock Property Two']);
    });

    test('a test build lists what was added and dropped, its warnings, and what stopped it', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await chooseLibrary(mockedWindow);
        await browseOverrides(mockedWindow);
        const log = mockedWindow.locator('#sync-console');
        const generate = mockedWindow.locator('#tab-sync button', { hasText: 'Generate' });
        const returns = (result) => electronApp.evaluate(({ ipcMain }, result) => {
            ipcMain.removeHandler('generate-test-build');
            ipcMain.handle('generate-test-build', () => result);
        }, result);

        await returns({
            report: {
                replaced: [],
                added: ['data element Cart'],
                dropped: ['rule Old Campaign'],
                warnings: ['rule Click: new or changed in Launch since the sync. Sync the library again.']
            },
            written: [],
            removed: []
        });
        await generate.click();
        await expect(log).toContainText('Added [1]');
        await expect(log).toContainText('data element Cart');
        await expect(log).toContainText('Dropped [1]');
        await expect(log).toContainText('rule Old Campaign');
        await expect(log).toContainText('⚠ Warnings [1]');
        await expect(log).toContainText('rule Click: new or changed in Launch since the sync. Sync the library again.');
        await expect(log).toContainText('Point Chrome DevTools');
        await expect(log).not.toContainText('Replaced');

        await returns({ stopped: true, problems: ['Production has no successful build yet', 'Check 3 failed'] });
        await generate.click();
        await expect(log).toContainText('⛔ Stopped [2]');
        await expect(log).toContainText('Production has no successful build yet');
        await expect(log).toContainText('Check 3 failed');
        await expect(log).not.toContainText('Point Chrome DevTools');
    });

    test('the overrides folder is saved and restored', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await browseOverrides(mockedWindow);
        await expect.poll(() => electronApp.evaluate(() => globalThis.__savedConfig.test_build_overrides_dir))
            .toBe('C:/mock-sync');

        // The mocks keep no login, so log in again; the folder comes back with the Developer Sync tab
        await mockedWindow.reload();
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'Developer Sync' }).click();
        await expect(mockedWindow.locator('#test-build-overrides-path')).toHaveValue('C:/mock-sync');
    });

    // Read at import, the saved folder could come from the real config before the mocks are in
    test('the overrides folder is read when the Developer Sync tab is first shown, not before', async ({ electronApp, mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await electronApp.evaluate(() => { globalThis.__savedConfig.test_build_overrides_dir = 'C:/saved-overrides'; });
        await expect(mockedWindow.locator('#test-build-overrides-path')).toHaveValue('');

        await mockedWindow.locator('.tab-btn', { hasText: 'Developer Sync' }).click();
        await expect(mockedWindow.locator('#test-build-overrides-path')).toHaveValue('C:/saved-overrides');
    });

    test('Generate runs once at a time, and again once the last run has settled, even in error', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await chooseLibrary(mockedWindow);
        await browseOverrides(mockedWindow);
        const log = mockedWindow.locator('#sync-console');
        const generate = mockedWindow.locator('#tab-sync button', { hasText: 'Generate' });
        // A run that lasts until the test ends it, in error
        await electronApp.evaluate(({ ipcMain }) => {
            globalThis.__testBuildCalls = 0;
            ipcMain.removeHandler('generate-test-build');
            ipcMain.handle('generate-test-build', () => {
                globalThis.__testBuildCalls += 1;
                return new Promise((_, reject) => {
                    globalThis.__failTestBuild = () => reject(new Error('Test Build Failed: the network went away'));
                });
            });
        });
        const calls = () => electronApp.evaluate(() => globalThis.__testBuildCalls);

        await generate.dblclick();
        await expect.poll(calls).toBe(1);
        await expect(generate).toBeDisabled();
        // Nor does a call that doesn't go through the button start another
        await mockedWindow.evaluate(() => window.generateTestBuild());
        expect(await calls()).toBe(1);

        await electronApp.evaluate(() => globalThis.__failTestBuild());
        await expect(log).toContainText('the network went away');
        await expect(generate).toBeEnabled();
        await generate.click();
        await expect.poll(calls).toBe(2);
    });

    test('Check Status with a library checks the chosen property\'s library, whatever else is selected', async ({ electronApp, mockedWindow }) => {
        await openSyncWithProperty(mockedWindow);
        await chooseLibrary(mockedWindow);
        await setProperty(mockedWindow, 'Mock Property Two', true);

        await mockedWindow.locator('button', { hasText: 'Check Status' }).click();
        await expect(mockedWindow.locator('#sync-console')).toContainText('Files To Be Pushed (Modified) [1]');
        expect(await electronApp.evaluate(() => globalThis.__lastSyncDiffPayload)).toMatchObject({
            property: { id: 'PR_MOCK_001' },
            targetDir: LIBRARY_FOLDER
        });
    });
});
