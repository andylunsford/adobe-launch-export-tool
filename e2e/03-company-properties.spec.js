'use strict';

/**
 * Suite 3 – Company selection & property loading  (mock-based, no network required)
 */

const { test, expect, loginWithMocks, MOCK_DATA } = require('./fixtures');

/** Log in then select the first mock company. */
async function loginAndSelectCompany(win) {
    await loginWithMocks(win);
    await expect(win.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await win.locator('#company-select').selectOption({ index: 1 }); // first real company
    await win.locator('button.primary[onclick="saveCompanySelection()"]').click();
    await expect(win.locator('#main-interface')).not.toHaveClass(/hidden/, { timeout: 10_000 });
}

test.describe('Company & property selection', () => {
    test('selecting a company and saving reveals the main interface', async ({ mockedWindow }) => {
        await loginAndSelectCompany(mockedWindow);
        await expect(mockedWindow.locator('#main-interface')).not.toHaveClass(/hidden/);
    });

    test('property list is populated after company selection', async ({ mockedWindow }) => {
        await loginAndSelectCompany(mockedWindow);

        // Open the property selector panel
        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(mockedWindow.locator('#property-select-panel')).not.toHaveClass(/hidden/);

        // All mock properties should be listed
        const items = mockedWindow.locator('#property-list .prop-item');
        await expect(items).toHaveCount(MOCK_DATA.properties.length, { timeout: 10_000 });
        await expect(items.first()).toContainText(MOCK_DATA.properties[0].attributes.name);
    });

    test('select-all toggle checks all property checkboxes', async ({ mockedWindow }) => {
        await loginAndSelectCompany(mockedWindow);

        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(mockedWindow.locator('#property-select-panel')).not.toHaveClass(/hidden/);

        // Ensure properties are rendered
        await expect(mockedWindow.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 10_000 });

        await mockedWindow.locator('#select-all-toggle').check();

        const all     = mockedWindow.locator('#property-list input[type="checkbox"]');
        const checked = mockedWindow.locator('#property-list input[type="checkbox"]:checked');
        expect(await checked.count()).toBe(await all.count());
    });

    test('select-all can be toggled off (deselects all)', async ({ mockedWindow }) => {
        await loginAndSelectCompany(mockedWindow);

        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(mockedWindow.locator('#property-select-panel')).not.toHaveClass(/hidden/);
        await expect(mockedWindow.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 10_000 });

        // Select all then deselect all
        const toggle = mockedWindow.locator('#select-all-toggle');
        await toggle.check();
        await toggle.uncheck();

        const checked = mockedWindow.locator('#property-list input[type="checkbox"]:checked');
        expect(await checked.count()).toBe(0);
    });
});
