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

    test('Start Archive button is initially disabled', async ({ mockedWindow }) => {
        await setupMainInterface(mockedWindow);
        await mockedWindow.locator('.tab-btn', { hasText: 'History Archive' }).click();
        await expect(mockedWindow.locator('#btn-start-archive')).toBeDisabled();
    });
});
