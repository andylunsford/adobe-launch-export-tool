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
    // Archive scan counts as main.js returns them, keyed by property.
    archiveScan: {
        PR_MOCK_001: { rules: 12, data_elements: 30, extensions: 4, rule_components: 'N/A (Scanned via Rules)', environments: 3, libraries: 1500, total: 1549 },
        PR_MOCK_002: { rules: 5, data_elements: 8, extensions: 2, rule_components: 'N/A (Scanned via Rules)', environments: 3, libraries: 20, total: 38 },
    },
    properties: [
        { id: 'PR_MOCK_001', attributes: { name: 'Mock Property One', platform: 'web' } },
        { id: 'PR_MOCK_002', attributes: { name: 'Mock Property Two', platform: 'edge' } },
        { id: 'PR_MOCK_003', attributes: { name: 'Mock Property Three', platform: 'mobile' } },
    ],
    environments: [
        { id: 'EN_DEV', type: 'environments', attributes: { name: 'Development', stage: 'development', status: 'succeeded' } },
        { id: 'EN_STG', type: 'environments', attributes: { name: 'Staging',     stage: 'staging',     status: 'succeeded' } },
        { id: 'EN_PRD', type: 'environments', attributes: { name: 'Production',  stage: 'production',  status: 'succeeded' } },
    ],
    libraries: [
        {
            id: 'LB_001',
            type: 'libraries',
            attributes: { name: 'Library 1.0', state: 'published', build_required: false,
                          published_at: '2026-01-15T12:00:00Z', updated_at: '2026-01-15T12:00:00Z' },
            meta: { build_status: null, currently_live: true },
            relationships: { last_build: { data: { id: 'BL_001', type: 'builds' } } },
        },
    ],
    envLibrary: { libraryId: 'LB_001', libraryName: 'Library 1.0', buildId: 'BL_001', buildDate: '2026-01-15T12:00:00Z' },
    // What lib/reactor-core/compare-builds diffSets returns: one rule with a
    // changed action, one rule re-revised with nothing changed, and one new
    // rule whose custom code is markup.
    comparison: {
        rules: {
            onlyInA: [], identical: [],
            onlyInB: [{
                id: 'RL_FSr1', name: 'Form Submit', revisionNumber: 1,
                item: { id: 'RL_FSr1', type: 'rules', attributes: { name: 'Form Submit', enabled: true } },
                components: [
                    { name: 'Submit', componentType: 'core::events::submit', attributes: { settings: {} } },
                    { name: 'Thank You Banner', componentType: 'core::actions::custom-code',
                      attributes: { settings: { language: 'html', source: '<img src=x onerror="window.__injected=true"><b>Thanks</b>' } } }
                ]
            }],
            modified: [{
                id: 'RL_PVr2', name: 'Page View', oldName: 'Page View', newName: 'Page View',
                revisionNumberA: 1, revisionNumberB: 2, attributeDiffs: [],
                componentDiffs: [{
                    type: 'modified', name: 'Track', componentType: 'core::actions::custom-code',
                    attributeDiffs: [{ field: 'settings', oldValue: { source: 'run();' }, newValue: { source: 'track();' } }]
                }]
            }],
            revised: [{
                id: 'RL_CLr2', name: 'Click', oldName: 'Click', newName: 'Click',
                revisionNumberA: 1, revisionNumberB: 2, attributeDiffs: [], componentDiffs: []
            }]
        },
        data_elements: { onlyInA: [], onlyInB: [], modified: [], revised: [], identical: [] },
        extensions: { onlyInA: [], onlyInB: [], modified: [], revised: [], identical: [] },
        fromCache: false
    },
    // What lib/reactor-core/diff/runner returns: one item in each state, and a
    // type whose list failed.
    syncDiff: {
        hasBase: true,
        added: [],
        modified: [{ type: 'rule_components', id: 'RC_TRACK', path: 'sync/rule_components/RC_TRACK', name: 'Track', rule_id: 'RL_PV', rule_name: 'Page View' }],
        deleted: [{ type: 'rules', id: 'RL_GONE', path: 'sync/rules/RL_GONE', name: 'Removed Here' }],
        behind: [{ type: 'data_elements', id: 'DE_PAGE', path: 'sync/data_elements/DE_PAGE', name: 'Page Name' }],
        deletedInLaunch: [{ type: 'rules', id: 'RL_OLD', path: 'sync/rules/RL_OLD', name: 'Old Campaign' }],
        conflict: [{ type: 'data_elements', id: 'DE_CART', path: 'sync/data_elements/DE_CART', name: 'Cart',
                     details: { reason: 'changed locally and in Launch', attributes: {} } }],
        unchanged: [{ type: 'rules', id: 'RL_PV', path: 'sync/rules/RL_PV', name: 'Page View' }],
        errors: [{ type: 'extensions', message: "Couldn't list extensions: Request failed with status code 500" }]
    },
    // What lib/reactor-core/sync writeDownload returns.
    syncDownload: {
        written: 120,
        removedFiles: 3,
        keptLocal: [{ type: 'data_elements', id: 'DE_CART', name: 'Cart' }],
        setAside: [{ type: 'rules', id: 'RL_OLD', name: 'Old Campaign' }],
        keptUnlisted: [],
        incomplete: []
    },
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
            'perform-environment-comparison', 'save-file',
            'get-cache-stats', 'clear-cache', 'perform-archive-scan',
            'resume-archive-run', 'select-folder', 'perform-sync-download',
            'perform-sync-diff',
        ];
        channels.forEach(ch => { try { ipcMain.removeHandler(ch); } catch (_) {} });

        // In-memory config, so a test can save a field and read it back.
        const savedConfig = {};
        globalThis.__savedConfig = savedConfig;
        ipcMain.handle('get-saved-config',  () => JSON.parse(JSON.stringify(savedConfig)));
        ipcMain.handle('save-config-field', (_event, { key, value }) => {
            savedConfig[key] = value;
            return true;
        });

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
        // Keeps the last payload so a test can check what the renderer sent.
        ipcMain.handle('perform-environment-comparison', (_event, payload) => {
            globalThis.__lastComparePayload = payload;
            return data.comparison;
        });
        ipcMain.handle('save-file', (_event, payload) => {
            globalThis.__lastSavedFile = payload;
            return true;
        });
        ipcMain.handle('get-cache-stats', () => ({
            rules: 0, data_elements: 0, extensions: 0,
            rule_components: 0, environments: 0, libraries: 0,
            oldest_cached_at: null
        }));
        ipcMain.handle('clear-cache', () => ({ success: true }));
        // Counts differ per property; PR_MOCK_003 fails, to show one error
        // doesn't stop the rest of the scan.
        ipcMain.handle('perform-archive-scan', (_event, { propertyId }) => {
            const scan = data.archiveScan[propertyId];
            if (!scan) throw new Error('Request failed with status code 403');
            return scan;
        });
        ipcMain.handle('resume-archive-run', () => ({ success: true }));
        ipcMain.handle('select-folder', () => 'C:/mock-sync');
        ipcMain.handle('perform-sync-download', () => data.syncDownload);
        ipcMain.handle('perform-sync-diff', () => data.syncDiff);
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
