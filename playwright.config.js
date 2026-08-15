'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 60_000,          // API calls can be slow
    expect: { timeout: 15_000 },
    retries: 0,
    // Every test launches the real app, which means one shared userData
    // directory and one SQLite file. Parallel workers contend over both
    // (on Windows the Electron binary itself locks). Keep it serial.
    workers: 1,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
    use: {
        // Screenshots on failure are captured by the Electron fixture in each test
        trace: 'retain-on-failure',
    },
});
