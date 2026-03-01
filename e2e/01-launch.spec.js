'use strict';

/**
 * Suite 1 – App launch & initial UI state
 * These tests require NO credentials and validate that the app boots correctly.
 */

const { test, expect } = require('./fixtures');

test.describe('App launch', () => {
    test('window opens with correct title', async ({ window }) => {
        const title = await window.title();
        expect(title).toBe('Nuclear');
    });

    test('header heading is visible', async ({ window }) => {
        await expect(window.locator('h1')).toContainText('Nuclear');
    });

    test('credentials panel is hidden on start', async ({ window }) => {
        await expect(window.locator('#creds-panel')).toHaveClass(/hidden/);
    });

    test('main interface is hidden until authenticated', async ({ window }) => {
        await expect(window.locator('#main-interface')).toHaveClass(/hidden/);
    });

    test('credential panel opens and closes via header button', async ({ window }) => {
        const btn = window.locator('button.icon-btn[title="Manage Credentials"]');
        const panel = window.locator('#creds-panel');

        // Open
        await btn.click();
        await expect(panel).not.toHaveClass(/hidden/);

        // Close
        await window.locator('#creds-panel .close-btn').click();
        await expect(panel).toHaveClass(/hidden/);
    });

    test('credential panel contains all required inputs', async ({ window }) => {
        await window.locator('button.icon-btn[title="Manage Credentials"]').click();
        await expect(window.locator('#clientId')).toBeVisible();
        await expect(window.locator('#clientSecret')).toBeVisible();
        await expect(window.locator('#orgId')).toBeVisible();
        await expect(window.locator('button.primary[onclick="loginAndSave()"]')).toBeVisible();
    });

    test('company panel is hidden on start', async ({ window }) => {
        await expect(window.locator('#company-panel')).toHaveClass(/hidden/);
    });

    test('property-select panel is hidden on start', async ({ window }) => {
        await expect(window.locator('#property-select-panel')).toHaveClass(/hidden/);
    });
});
