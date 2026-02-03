const { ipcRenderer, shell } = require('electron');

// --- Import Modules ---
const ui = require('./modules/ui-helpers');
const auth = require('./modules/auth');
const exp = require('./modules/export');
const sync = require('./modules/sync');
const archive = require('./modules/archive');
const compare = require('./modules/compare');

console.log("Renderer.js starting...");

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize Theme
    ui.initTheme();

    // 1. Footer Link
    const link = document.getElementById('credit-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); shell.openExternal(link.href); });

    // 2. Load Saved Config
    try {
        const savedConfig = await ipcRenderer.invoke('get-saved-config');
        const creds = savedConfig.credentials;

        // 3. Auto-Login if Creds exist
        if (creds && creds.client_id) {
            document.getElementById('clientId').value = creds.client_id;
            document.getElementById('clientSecret').value = creds.client_secret || "";
            document.getElementById('orgId').value = creds.organization_id;
            
            // Set global creds for use in modules
            ui.setCurrentCreds(creds);

            // Attempt Silent Login
            const result = await ipcRenderer.invoke('adobe-login', creds);

            if (result.success) {
                ui.setGlobalToken(result.token);
                await auth.loadCompanies();

                // 4. Auto-Load Company if Saved
                if (savedConfig.company_id && ui.getGlobalToken()) {
                    // Pre-select the company in the dropdown (visual only)
                    const select = document.getElementById('company-select');
                    if (select) select.value = savedConfig.company_id;

                    // Load properties immediately
                    await auth.loadProperties(savedConfig.company_id);
                    document.getElementById('main-interface').classList.remove('hidden');
                }
            }
        }
    } catch (e) {
        console.error("Initialization Error:", e);
        // Do not alert, fail silently on boot
    }

    // 5. Override switchTab to handle module-specific initialization
    const originalSwitchTab = window.switchTab;
    window.switchTab = (tabId) => {
        originalSwitchTab(tabId);
        
        // Comparison Tab Initialization
        if (tabId === 'tab-compare') {
            compare.populateComparisonProperties();
        }
    };
});

console.log("Renderer.js loaded completely");