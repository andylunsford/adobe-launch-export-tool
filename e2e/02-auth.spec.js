'use strict';

/**
 * Suite 2 – Authentication flow
 * Requires env vars: ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET, ADOBE_ORG_ID
 */

const { test, expect, loginWithEnvCreds } = require('./fixtures');

test.describe('Authentication', () => {
    test.beforeEach(async ({ window }) => {
        // Skip entire suite if credentials are absent
        if (!process.env.ADOBE_CLIENT_ID || !process.env.ADOBE_CLIENT_SECRET || !process.env.ADOBE_ORG_ID) {
            test.skip(true, 'Skipping auth tests: ADOBE_CLIENT_ID / ADOBE_CLIENT_SECRET / ADOBE_ORG_ID not set');
        }
    });

    test('login succeeds and shows Connected status', async ({ window }) => {
        await loginWithEnvCreds(window);
        await expect(window.locator('#login-status')).toContainText('Connected');
    });

    test('company panel appears after successful login', async ({ window }) => {
        await loginWithEnvCreds(window);
        // The credentials panel auto-closes and company panel auto-opens
        await expect(window.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 15_000 });
    });

    test('company dropdown is populated after login', async ({ window }) => {
        await loginWithEnvCreds(window);
        await expect(window.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 15_000 });

        const options = window.locator('#company-select option');
        // At minimum the placeholder option + at least one real company
        await expect(options).toHaveCount({ minimum: 2 }, { timeout: 15_000 });
    });

    test('wrong credentials show error message', async ({ window }) => {
        // Open creds panel
        await window.locator('button[onclick="togglePanel(\'creds-panel\')"]').click();

        await window.locator('#clientId').fill('bad-client-id');
        await window.locator('#clientSecret').fill('bad-secret');
        await window.locator('#orgId').fill('bad-org@AdobeOrg');

        await window.locator('button.primary[onclick="loginAndSave()"]').click();

        // Should show an error, not "Connected"
        const status = window.locator('#login-status');
        await expect(status).not.toBeEmpty({ timeout: 30_000 });
        await expect(status).not.toContainText('Connected');
    });
});
