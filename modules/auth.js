/**
 * Authentication Module
 * Handles login, company selection, and property loading
 */

import * as ui from './ui-helpers.js';

// --- Login ---
async function loginAndSave(silent = false) {
    if (!silent) ui.showLoading("Authenticating...");

    try {
        const creds = {
            client_id: document.getElementById('clientId').value.trim(),
            client_secret: document.getElementById('clientSecret').value.trim(),
            organization_id: document.getElementById('orgId').value.trim(),
            scope: "openid,AdobeID,additional_info.projectedProductContext,read_organizations,reactor.read,reactor.write",
            ims_endpoint: "https://ims-na1.adobelogin.com"
        };

        ui.setCurrentCreds(creds);

        const result = await window.api.adobeLogin(creds);

        if (result.success) {
            ui.setGlobalToken(result.token);
            await loadCompanies();

            if (!silent) {
                document.getElementById('login-status').innerText = "✅ Connected!";
                setTimeout(() => {
                    const credsPanel = document.getElementById('creds-panel');
                    if (!credsPanel.classList.contains('hidden')) ui.togglePanel('creds-panel');

                    const companyPanel = document.getElementById('company-panel');
                    if (companyPanel.classList.contains('hidden')) ui.togglePanel('company-panel');
                }, 500);
            }
        } else {
            if (!silent) document.getElementById('login-status').innerText = "❌ Error: " + result.error;
        }
    } catch (e) {
        console.error("Login Error:", e);
        if (!silent) document.getElementById('login-status').innerText = "❌ Exception: " + e.message;
    } finally {
        if (!silent) ui.hideLoading();
    }
}

// --- Load Companies ---
async function loadCompanies() {
    try {
        const companies = await window.api.getCompanies({
            token: ui.getGlobalToken(),
            creds: ui.getCurrentCreds()
        });

        const select = document.getElementById('company-select');
        select.innerHTML = '<option value="">Select a Company...</option>';

        if (Array.isArray(companies)) {
            companies.forEach(comp => {
                const opt = document.createElement('option');
                opt.value = comp.id;
                opt.innerText = comp.attributes.name;
                select.appendChild(opt);
            });
        } else {
            console.error("Companies API returned unexpected format:", companies);
        }
    } catch (e) {
        console.error("Failed to load companies:", e);
    }
}

// --- Save Company Selection ---
async function saveCompanySelection() {
    const companyId = document.getElementById('company-select').value;
    if (!companyId) {
        alert("Please select a company.");
        return;
    }

    try {
        await window.api.saveConfigField({ key: 'company_id', value: companyId });
        await loadProperties(companyId);
        ui.togglePanel('company-panel');
        document.getElementById('main-interface').classList.remove('hidden');
    } catch (e) {
        alert("Failed to save company: " + e.message);
    }
}

// --- Load Properties ---
async function loadProperties(companyId) {
    ui.showLoading("Fetching Properties...");

    try {
        const properties = await window.api.getProperties({
            token: ui.getGlobalToken(),
            creds: ui.getCurrentCreds(),
            companyId
        });

        if (!Array.isArray(properties)) {
            throw new Error("No properties found or API error.");
        }

        ui.setAllLoadedProperties(properties); // Store properties globally

        // Populate Global Property List, grouped under a heading per platform
        const list = document.getElementById('property-list');
        list.innerHTML = '';
        ui.groupByPlatform(properties, prop => prop.attributes.platform).forEach(group => {
            const heading = document.createElement('div');
            heading.className = 'prop-group-heading';
            heading.textContent = `${group.label} (${group.items.length})`;
            list.appendChild(heading);

            group.items.forEach(prop => {
                const name = prop.attributes.name;
                const label = document.createElement('label');
                label.className = 'prop-item';

                const check = document.createElement('input');
                check.type = 'checkbox';
                check.className = 'prop-check';
                check.value = prop.id;
                check.dataset.name = name;
                check.dataset.platform = prop.attributes.platform ?? '';

                const span = document.createElement('span');
                span.className = 'prop-name';
                span.title = name;
                span.textContent = name;

                label.append(check, span);
                list.appendChild(label);
            });
        });

        loadedCompanyId = companyId;
        await restorePropertySelection(companyId);

    } catch (e) {
        alert("Error loading properties: " + e.message);
    } finally {
        ui.hideLoading();
    }
}

// --- Persisted Property Selection ---
// Selections are saved per company under `selected_properties`
// ({ [companyId]: [propertyId, ...] }), so switching company neither loses
// nor leaks another company's picks.
let loadedCompanyId = null;

async function restorePropertySelection(companyId) {
    try {
        const config = await window.api.getSavedConfig();
        const saved = new Set(config.selected_properties?.[companyId] ?? []);
        const checks = document.querySelectorAll('.prop-check');
        checks.forEach(cb => { cb.checked = saved.has(cb.value); });
        syncSelectAllToggle();
    } catch (e) {
        console.error('Could not restore property selection:', e);
    }
    // Let listeners (e.g. the Compare tab dropdown) pick up the restored state.
    document.getElementById('property-list').dispatchEvent(new Event('change'));
}

async function savePropertySelection() {
    if (!loadedCompanyId) return;
    try {
        const config = await window.api.getSavedConfig();
        const all = { ...(config.selected_properties ?? {}) };
        all[loadedCompanyId] = ui.getSelectedProperties().map(p => p.id);
        await window.api.saveConfigField({ key: 'selected_properties', value: all });
    } catch (e) {
        console.error('Could not save property selection:', e);
    }
}

// Keep the Select All box checked only when every property is.
function syncSelectAllToggle() {
    const checks = document.querySelectorAll('.prop-check');
    const toggle = document.getElementById('select-all-toggle');
    if (toggle) toggle.checked = checks.length > 0 && Array.from(checks).every(cb => cb.checked);
}

document.getElementById('property-list').addEventListener('change', (e) => {
    // Ignore the synthetic event fired after a restore; nothing changed.
    if (!e.isTrusted) return;
    syncSelectAllToggle();
    savePropertySelection();
});
document.getElementById('select-all-toggle').addEventListener('change', savePropertySelection);

// --- TLS Opt-Out ---
// Disabling certificate verification is a real downgrade, so the checkbox state
// is mirrored by a visible warning rather than left as a quiet setting.
async function setAllowInsecureTls(enabled) {
    try {
        await window.api.saveConfigField({ key: 'allow_insecure_tls', value: !!enabled });
        reflectTlsSetting(enabled);
    } catch (e) {
        alert('Could not save the certificate setting: ' + e.message);
    }
}

function reflectTlsSetting(enabled) {
    const box = document.getElementById('chk-allow-insecure-tls');
    if (box) box.checked = !!enabled;
    const warning = document.getElementById('tls-warning');
    if (warning) warning.classList.toggle('hidden', !enabled);
}

// --- Export to window ---
window.loginAndSave = loginAndSave;
window.saveCompanySelection = saveCompanySelection;
window.setAllowInsecureTls = setAllowInsecureTls;

// --- Module Exports ---
export {
    loginAndSave,
    loadCompanies,
    saveCompanySelection,
    loadProperties,
    setAllowInsecureTls,
    reflectTlsSetting
};
