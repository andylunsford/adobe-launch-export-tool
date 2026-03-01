'use strict';

/**
 * Suite 2 – Authentication flow  (mock-based, no network required)
 */

const { test, expect, loginWithMocks, injectIPCMocks, MOCK_DATA } = require('./fixtures');

test.describe('Authentication', () => {
    test('login succeeds and shows Connected status', async ({ mockedWindow }) => {
        await loginWithMocks(mockedWindow);
        await expect(mockedWindow.locator('#login-status')).toContainText('Connected');
    });

    test('company panel appears after successful login', async ({ mockedWindow }) => {
        await loginWithMocks(mockedWindow);
        // After success the creds panel auto-closes and the company panel auto-opens
        await expect(mockedWindow.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 10_000 });
    });

    test('company dropdown is populated with mock companies after login', async ({ mockedWindow }) => {
        await loginWithMocks(mockedWindow);
        await expect(mockedWindow.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 10_000 });

        // Placeholder + 2 mock companies = 3 options
        const options = mockedWindow.locator('#company-select option');
        await expect(options).toHaveCount(MOCK_DATA.companies.length + 1 /* placeholder */);
        await expect(options.nth(1)).toHaveText(MOCK_DATA.companies[0].attributes.name);
    });

    test('wrong credentials show an error message', async ({ electronApp, window }) => {
        // Override login to return failure for this test only
        await injectIPCMocks(electronApp, 'fail');

        await window.locator('button.icon-btn[title="Manage Credentials"]').click();
        await window.locator('#clientId').fill('bad-client');
        await window.locator('#clientSecret').fill('bad-secret');
        await window.locator('#orgId').fill('bad-org@AdobeOrg');
        await window.locator('button.primary[onclick="loginAndSave()"]').click();

        const status = window.locator('#login-status');
        await expect(status).not.toBeEmpty({ timeout: 15_000 });
        await expect(status).not.toContainText('Connected');
        await expect(status).toContainText('Error');
    });
});
