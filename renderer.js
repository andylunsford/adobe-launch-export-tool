// --- Import Modules ---
// Imported for their side effects too: each module binds its handlers onto
// `window` for the inline onclick attributes in index.html.
import * as ui from './modules/ui-helpers.js';
import * as auth from './modules/auth.js';
import * as exp from './modules/export.js';
import * as sync from './modules/sync.js';
import * as archive from './modules/archive.js';
import * as compare from './modules/compare.js';

console.log("Renderer.js starting...");

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    // Initialize Theme
    ui.initTheme();

    // 1. Footer Link
    const link = document.getElementById('credit-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(link.href); });

    // 2. Load Saved Config
    try {
        const savedConfig = await window.api.getSavedConfig();

        // Reflect the TLS opt-out before anything else, so the warning is
        // visible even when there are no saved credentials yet.
        auth.reflectTlsSetting(savedConfig.allow_insecure_tls === true);

        const creds = savedConfig.credentials;

        // 3. Auto-Login if Creds exist
        if (creds && creds.client_id) {
            document.getElementById('clientId').value = creds.client_id;
            document.getElementById('clientSecret').value = creds.client_secret || "";
            document.getElementById('orgId').value = creds.organization_id;
            
            // Set global creds for use in modules
            ui.setCurrentCreds(creds);

            // Attempt Silent Login
            const result = await window.api.adobeLogin(creds);

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