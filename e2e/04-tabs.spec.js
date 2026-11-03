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
