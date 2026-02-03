/**
 * Authentication Module
 * Handles login, company selection, and property loading
 */

const { ipcRenderer, shell } = require('electron');
const ui = require('./ui-helpers');

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

        const result = await ipcRenderer.invoke('adobe-login', creds);

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
        const companies = await ipcRenderer.invoke('get-companies', { 
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
        await ipcRenderer.invoke('save-config-field', { key: 'company_id', value: companyId });
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
        const properties = await ipcRenderer.invoke('get-properties', { 
            token: ui.getGlobalToken(), 
            creds: ui.getCurrentCreds(), 
            companyId 
        });

        if (!Array.isArray(properties)) {
            throw new Error("No properties found or API error.");
        }

        ui.setAllLoadedProperties(properties); // Store properties globally

        // Populate Global Property List
        const list = document.getElementById('property-list');
        list.innerHTML = '';
        properties.forEach(prop => {
            const label = document.createElement('label');
            label.className = 'prop-item';
            label.innerHTML = `
                <input type="checkbox" value="${prop.id}" data-name="${prop.attributes.name}" class="prop-check"> 
                <span class="prop-name" title="${prop.attributes.name}">${prop.attributes.name}</span>
            `;
            list.appendChild(label);
        });

    } catch (e) {
        alert("Error loading properties: " + e.message);
    } finally {
        ui.hideLoading();
    }
}

// --- Export to window ---
window.loginAndSave = loginAndSave;
window.saveCompanySelection = saveCompanySelection;

// --- Module Exports ---
module.exports = {
    loginAndSave,
    loadCompanies,
    saveCompanySelection,
    loadProperties
};
