'use strict';

/**
 * Suite 4 – Tab navigation & feature smoke tests
 * Requires env vars: ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET, ADOBE_ORG_ID
 *
 * These tests log in, select the first company, and verify each tab's
 * UI structure and key interactive elements without triggering
 * long-running downloads or destructive actions.
 */

const { test, expect, loginWithEnvCreds } = require('./fixtures');

/** Shared setup: log in and select first company so main interface is visible. */
async function setupMainInterface(window) {
    await loginWithEnvCreds(window);
    await expect(window.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 15_000 });
    await window.locator('#company-select').selectOption({ index: 1 });
    await window.locator('button.primary[onclick="saveCompanySelection()"]').click();
    await expect(window.locator('#main-interface')).not.toHaveClass(/hidden/, { timeout: 30_000 });
}

test.describe('Tab navigation', () => {
    test.beforeEach(async ({ window }) => {
        if (!process.env.ADOBE_CLIENT_ID || !process.env.ADOBE_CLIENT_SECRET || !process.env.ADOBE_ORG_ID) {
            test.skip(true, 'Skipping: credentials env vars not set');
        }
    });

    test('four tabs are rendered', async ({ window }) => {
        await setupMainInterface(window);
        const tabs = window.locator('.tab-btn');
        await expect(tabs).toHaveCount(4);
    });

    test('Export Manager tab is active by default', async ({ window }) => {
        await setupMainInterface(window);
        await expect(window.locator('#tab-export')).toHaveClass(/active/);
    });

    test('switching to Environment Comparison tab shows its content', async ({ window }) => {
        await setupMainInterface(window);
        await window.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();
        await expect(window.locator('#tab-compare')).toHaveClass(/active/);
        await expect(window.locator('#compare-prop-select')).toBeVisible();
        await expect(window.locator('#compare-mode-select')).toBeVisible();
    });

    test('switching to Developer Sync tab shows its content', async ({ window }) => {
        await setupMainInterface(window);
        await window.locator('.tab-btn', { hasText: 'Developer Sync' }).click();
        await expect(window.locator('#tab-sync')).toHaveClass(/active/);
        await expect(window.locator('#sync-folder-path')).toBeVisible();
        await expect(window.locator('#sync-console')).toBeVisible();
    });

    test('switching to History Archive tab shows its content', async ({ window }) => {
        await setupMainInterface(window);
        await window.locator('.tab-btn', { hasText: 'History Archive' }).click();
        await expect(window.locator('#tab-archive')).toHaveClass(/active/);
        await expect(window.locator('#archive-folder-path')).toBeVisible();
        await expect(window.locator('#archive-console')).toBeVisible();
    });
});

test.describe('Export Manager tab', () => {
    test.beforeEach(async ({ window }) => {
        if (!process.env.ADOBE_CLIENT_ID || !process.env.ADOBE_CLIENT_SECRET || !process.env.ADOBE_ORG_ID) {
            test.skip(true, 'Skipping: credentials env vars not set');
        }
    });

    test('export options checkboxes are present and Full Export is pre-checked', async ({ window }) => {
        await setupMainInterface(window);
        const fullExport = window.locator('#opt-full-export');
        const libExport  = window.locator('#opt-library-export');
        await expect(fullExport).toBeVisible();
        await expect(libExport).toBeVisible();
        await expect(fullExport).toBeChecked();
        await expect(libExport).not.toBeChecked();
    });

    test('Download Selected button is present', async ({ window }) => {
        await setupMainInterface(window);
        await expect(window.locator('button[onclick="startExportJob()"]')).toBeVisible();
    });
});

test.describe('Environment Comparison tab', () => {
    test.beforeEach(async ({ window }) => {
        if (!process.env.ADOBE_CLIENT_ID || !process.env.ADOBE_CLIENT_SECRET || !process.env.ADOBE_ORG_ID) {
            test.skip(true, 'Skipping: credentials env vars not set');
        }
    });

    test('compare mode selector has three options', async ({ window }) => {
        await setupMainInterface(window);
        await window.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();

        const options = window.locator('#compare-mode-select option');
        await expect(options).toHaveCount(3);
    });

    test('property dropdown in compare tab is populated', async ({ window }) => {
        await setupMainInterface(window);
        await window.locator('.tab-btn', { hasText: 'Environment Comparison' }).click();

        // The compare-prop-select is populated by the same properties already loaded
        const opts = window.locator('#compare-prop-select option');
        await expect(opts.first()).toBeVisible({ timeout: 15_000 });
        expect(await opts.count()).toBeGreaterThan(0);
    });
});
