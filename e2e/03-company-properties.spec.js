'use strict';

/**
 * Suite 3 – Company selection & property loading
 * Requires env vars: ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET, ADOBE_ORG_ID
 */

const { test, expect, loginWithEnvCreds } = require('./fixtures');

test.describe('Company & property selection', () => {
    test.beforeEach(async ({ window }) => {
        if (!process.env.ADOBE_CLIENT_ID || !process.env.ADOBE_CLIENT_SECRET || !process.env.ADOBE_ORG_ID) {
            test.skip(true, 'Skipping: credentials env vars not set');
        }
        await loginWithEnvCreds(window);
        // Ensure company panel is visible before each test
        await expect(window.locator('#company-panel')).not.toHaveClass(/hidden/, { timeout: 15_000 });
    });

    test('selecting a company and saving reveals main interface', async ({ window }) => {
        // Select the first real company (index 1 skips the placeholder)
        await window.locator('#company-select').selectOption({ index: 1 });
        await window.locator('button.primary[onclick="saveCompanySelection()"]').click();

        await expect(window.locator('#main-interface')).not.toHaveClass(/hidden/, { timeout: 30_000 });
    });

    test('property list is populated after company selection', async ({ window }) => {
        await window.locator('#company-select').selectOption({ index: 1 });
        await window.locator('button.primary[onclick="saveCompanySelection()"]').click();

        // Open property selector
        await window.locator('button[onclick="togglePanel(\'property-select-panel\')"]').click();
        await expect(window.locator('#property-select-panel')).not.toHaveClass(/hidden/);

        // At least one property should be listed
        const props = window.locator('#property-list .prop-item');
        await expect(props.first()).toBeVisible({ timeout: 30_000 });
        const count = await props.count();
        expect(count).toBeGreaterThan(0);
        console.log(`Properties loaded: ${count}`);
    });

    test('select-all toggle checks all properties', async ({ window }) => {
        await window.locator('#company-select').selectOption({ index: 1 });
        await window.locator('button.primary[onclick="saveCompanySelection()"]').click();

        await window.locator('button[onclick="togglePanel(\'property-select-panel\')"]').click();
        await expect(window.locator('#property-select-panel')).not.toHaveClass(/hidden/);

        // Wait for properties to load
        await expect(window.locator('#property-list .prop-item').first()).toBeVisible({ timeout: 30_000 });

        // Click select-all
        await window.locator('#select-all-toggle').check();

        const checked = window.locator('#property-list input[type="checkbox"]:checked');
        const all     = window.locator('#property-list input[type="checkbox"]');
        expect(await checked.count()).toBe(await all.count());
    });
});
