'use strict';

/**
 * Shared Playwright fixtures for the Adobe Launch Export Tool (Nuclear) Electron app.
 *
 * Credentials are read from environment variables so they are never committed:
 *   ADOBE_CLIENT_ID     – API key from Adobe Developer Console
 *   ADOBE_CLIENT_SECRET – Client secret
 *   ADOBE_ORG_ID        – IMS Org ID  (format: XXXXXXXX@AdobeOrg)
 */

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

/**
 * Launch the Electron app and expose the first BrowserWindow as `window`.
 * The app is closed automatically after every test.
 */
const test = base.extend({
    electronApp: async ({}, use) => {
        const app = await electron.launch({
            args: ['--no-sandbox', APP_ROOT],
            env: {
                ...process.env,
                // Ensure a virtual display is used when DISPLAY isn't already set
                DISPLAY: process.env.DISPLAY || ':99',
            },
            timeout: 30_000,
        });
        await use(app);
        await app.close();
    },

    window: async ({ electronApp }, use) => {
        const win = await electronApp.firstWindow();
        // Wait for the renderer to finish loading
        await win.waitForLoadState('domcontentloaded');
        await use(win);
    },
});

/**
 * Helper: read a required env var or skip the test with a clear message.
 */
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `Missing required environment variable: ${name}\n` +
            `Run tests with:\n` +
            `  ADOBE_CLIENT_ID=... ADOBE_CLIENT_SECRET=... ADOBE_ORG_ID=... npm run test:e2e`
        );
    }
    return value;
}

/**
 * Helper: open the credentials panel, fill in credentials from env vars, and
 * submit the login form.  Waits for "Connected!" before returning.
 */
async function loginWithEnvCreds(win) {
    const clientId     = requireEnv('ADOBE_CLIENT_ID');
    const clientSecret = requireEnv('ADOBE_CLIENT_SECRET');
    const orgId        = requireEnv('ADOBE_ORG_ID');

    // Open credentials panel (it starts hidden)
    await win.locator('button.icon-btn[title="Manage Credentials"]').click();
    await expect(win.locator('#creds-panel')).not.toHaveClass(/hidden/);

    // Fill credentials
    await win.locator('#clientId').fill(clientId);
    await win.locator('#clientSecret').fill(clientSecret);
    await win.locator('#orgId').fill(orgId);

    // Submit
    await win.locator('button.primary[onclick="loginAndSave()"]').click();

    // Wait for success indicator
    await expect(win.locator('#login-status')).toContainText('Connected', { timeout: 30_000 });
}

module.exports = { test, expect, loginWithEnvCreds };
