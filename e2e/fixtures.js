'use strict';

/**
 * Shared Playwright fixtures for the Adobe Launch Export Tool (Nuclear) Electron app.
 *
 * Two modes:
 *
 *  1. Mock mode (default) – IPC handlers in the Electron main process are replaced
 *     with in-process stubs, so no network access is required.  Use the `mockedWindow`
 *     fixture and the `loginWithMocks` helper.
 *
 *  2. Real-API mode – Reads credentials from env vars and makes real requests.
 *     Use the `window` fixture and the `loginWithEnvCreds` helper.
 *     Requires:  ADOBE_CLIENT_ID  ADOBE_CLIENT_SECRET  ADOBE_ORG_ID
 */

const { test: base, expect, _electron: electron } = require('@playwright/test');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Canned API data used by the mock handlers
// ---------------------------------------------------------------------------
const MOCK_DATA = {
    companies: [
        { id: 'CO_MOCK_001', attributes: { name: 'Mock Company Alpha' } },
        { id: 'CO_MOCK_002', attributes: { name: 'Mock Company Beta' } },
    ],
    properties: [
        { id: 'PR_MOCK_001', attributes: { name: 'Mock Property One', platform: 'web' } },
        { id: 'PR_MOCK_002', attributes: { name: 'Mock Property Two', platform: 'web' } },
        { id: 'PR_MOCK_003', attributes: { name: 'Mock Property Three', platform: 'web' } },
    ],
    environments: [
        { id: 'EN_DEV', attributes: { name: 'Development', stage: 'development' } },
        { id: 'EN_STG', attributes: { name: 'Staging',     stage: 'staging' } },
        { id: 'EN_PRD', attributes: { name: 'Production',  stage: 'production' } },
    ],
    libraries: [
        { id: 'LB_001', attributes: { name: 'Library 1.0', state: 'published', updated_at: '2026-01-01' } },
    ],
    envLibrary: { libraryId: 'LB_001', libraryName: 'Library 1.0', buildDate: '2026-01-15T12:00:00Z' },
};

// ---------------------------------------------------------------------------
// IPC mock injector – runs code in the Electron MAIN process
// ---------------------------------------------------------------------------
/**
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {'success'|'fail'} loginOutcome  Controls what adobe-login returns
 */
async function injectIPCMocks(electronApp, loginOutcome = 'success') {
    await electronApp.evaluate(({ ipcMain }, { outcome, data }) => {
        // Remove any existing handlers so we can replace them
        const channels = [
            'get-saved-config', 'save-config-field',
            'adobe-login', 'get-companies', 'get-properties',
            'get-environments', 'get-libraries', 'get-environment-library',
            'perform-environment-comparison',
        ];
        channels.forEach(ch => { try { ipcMain.removeHandler(ch); } catch (_) {} });

        ipcMain.handle('get-saved-config',  () => ({}));
        ipcMain.handle('save-config-field', () => true);

        ipcMain.handle('adobe-login', () =>
            outcome === 'success'
                ? { success: true,  token: 'mock-access-token-abc123' }
                : { success: false, error: 'Request failed with status code 401' }
        );

        ipcMain.handle('get-companies',           () => data.companies);
        ipcMain.handle('get-properties',          () => data.properties);
        ipcMain.handle('get-environments',        () => data.environments);
        ipcMain.handle('get-libraries',           () => data.libraries);
        ipcMain.handle('get-environment-library', () => data.envLibrary);
        ipcMain.handle('perform-environment-comparison', () => ({
            rulesA: [], rulesB: [], dataElementsA: [], dataElementsB: [],
            extensionsA: [], extensionsB: [],
        }));
    }, { outcome: loginOutcome, data: MOCK_DATA });
}

// ---------------------------------------------------------------------------
// Playwright fixtures
// ---------------------------------------------------------------------------
const test = base.extend({
    /** Raw Electron app – no mocks injected. */
    electronApp: async ({}, use) => {
        const app = await electron.launch({
            args: ['--no-sandbox', APP_ROOT],
            env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
            timeout: 30_000,
        });
        await use(app);
        await app.close();
    },

    /** BrowserWindow page – no mocks injected. */
    window: async ({ electronApp }, use) => {
        const win = await electronApp.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await use(win);
    },

    /** BrowserWindow page with IPC handlers replaced by success mocks. */
    mockedWindow: async ({ electronApp }, use) => {
        await injectIPCMocks(electronApp, 'success');
        const win = await electronApp.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await use(win);
    },
});

// ---------------------------------------------------------------------------
// Login helpers
// ---------------------------------------------------------------------------

/** Fill credentials from env vars and submit – requires real network to Adobe IMS. */
async function loginWithEnvCreds(win) {
    const clientId     = process.env.ADOBE_CLIENT_ID;
    const clientSecret = process.env.ADOBE_CLIENT_SECRET;
    const orgId        = process.env.ADOBE_ORG_ID;
    if (!clientId || !clientSecret || !orgId) {
        throw new Error('ADOBE_CLIENT_ID / ADOBE_CLIENT_SECRET / ADOBE_ORG_ID not set');
    }
    await win.locator('button.icon-btn[title="Manage Credentials"]').click();
    await expect(win.locator('#creds-panel')).not.toHaveClass(/hidden/);
    await win.locator('#clientId').fill(clientId);
    await win.locator('#clientSecret').fill(clientSecret);
    await win.locator('#orgId').fill(orgId);
    await win.locator('button.primary[onclick="loginAndSave()"]').click();
    await expect(win.locator('#login-status')).toContainText('Connected', { timeout: 30_000 });
}

/** Fill placeholder credentials and submit – resolved by the injected IPC mock. */
async function loginWithMocks(win) {
    await win.locator('button.icon-btn[title="Manage Credentials"]').click();
    await expect(win.locator('#creds-panel')).not.toHaveClass(/hidden/);
    await win.locator('#clientId').fill('mock-client-id');
    await win.locator('#clientSecret').fill('mock-client-secret');
    await win.locator('#orgId').fill('MOCK123@AdobeOrg');
    await win.locator('button.primary[onclick="loginAndSave()"]').click();
    await expect(win.locator('#login-status')).toContainText('Connected', { timeout: 15_000 });
}

module.exports = { test, expect, loginWithMocks, loginWithEnvCreds, injectIPCMocks, MOCK_DATA };
