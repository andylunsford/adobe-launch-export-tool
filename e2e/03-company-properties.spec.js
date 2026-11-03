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
        for (const prop of MOCK_DATA.properties) {
            await expect(items.filter({ hasText: prop.attributes.name })).toHaveCount(1);
        }
    });

    test('properties are grouped by platform: Event Forwarding, Web, Mobile', async ({ mockedWindow }) => {
        await loginAndSelectCompany(mockedWindow);

        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        await expect(mockedWindow.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 10_000 });

        await expect(mockedWindow.locator('#property-list .prop-group-heading')).toHaveText([
            'Event Forwarding (Server Side) (1)',
            'Web (1)',
            'Mobile (App) (1)'
        ]);
        // Each property sits under its own platform's heading
        await expect(mockedWindow.locator('#property-list > *')).toHaveText([
            'Event Forwarding (Server Side) (1)', 'Mock Property Two',
            'Web (1)', 'Mock Property One',
            'Mobile (App) (1)', 'Mock Property Three'
        ]);
    });

    test('property selections are saved per company and restored', async ({ electronApp, mockedWindow }) => {
        await loginAndSelectCompany(mockedWindow);
        await mockedWindow.locator('button.icon-btn[title="Select Properties"]').click();
        const item = name => mockedWindow.locator('#property-list .prop-item', { hasText: name }).locator('input');
        await expect(item('Mock Property Two')).toBeVisible({ timeout: 10_000 });

        await item('Mock Property Two').check();
        await item('Mock Property Three').check();

        await expect.poll(() => electronApp.evaluate(() => globalThis.__savedConfig.selected_properties))
            .toEqual({ CO_MOCK_001: ['PR_MOCK_002', 'PR_MOCK_003'] });

        // Switching company and back reloads the list; the picks come back.
        const switchCompany = async index => {
            // The company panel is closed by now; set the value directly.
            await mockedWindow.evaluate(i => {
                document.getElementById('company-select').selectedIndex = i;
                return window.saveCompanySelection();
            }, index);
        };
        await switchCompany(2);
        await expect(mockedWindow.locator('#property-list input:checked')).toHaveCount(0);
        await switchCompany(1);
        await expect(item('Mock Property Two')).toBeChecked();
        await expect(item('Mock Property Three')).toBeChecked();
        await expect(item('Mock Property One')).not.toBeChecked();
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
