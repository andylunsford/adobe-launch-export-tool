'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 60_000,          // API calls can be slow
    expect: { timeout: 15_000 },
    retries: 0,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
    use: {
        // Screenshots on failure are captured by the Electron fixture in each test
        trace: 'retain-on-failure',
    },
});
