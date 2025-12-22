const { ipcRenderer, shell } = require('electron');

let globalToken = null;
let currentCreds = {};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Footer Link
    const link = document.getElementById('credit-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); shell.openExternal(link.href); });

    // 2. Load Saved Config
    try {
        const savedConfig = await ipcRenderer.invoke('get-saved-config');
        
        // 3. Auto-Login if Creds exist
        if (savedConfig.credentials && savedConfig.credentials.client_id) {
            document.getElementById('clientId').value = savedConfig.credentials.client_id;
            document.getElementById('clientSecret').value = savedConfig.credentials.client_secret || "";
            document.getElementById('orgId').value = savedConfig.credentials.organization_id;
            
            // Attempt Silent Login
            await loginAndSave(true);

            // 4. Auto-Load Company if Saved
            if (savedConfig.company_id && globalToken) {
                // Pre-select the company in the dropdown (visual only)
                const select = document.getElementById('company-select');
                if(select) select.value = savedConfig.company_id;

                // Load properties immediately
                await loadProperties(savedConfig.company_id);
                document.getElementById('main-interface').classList.remove('hidden');
            } else {
                if(globalToken) togglePanel('company-panel');
            }
        } else {
            togglePanel('creds-panel');
        }
    } catch (e) {
        console.error("Init failed:", e);
        togglePanel('creds-panel');
    }
});

// --- UI HELPERS ---

function togglePanel(id) {
    const el = document.getElementById(id);
    if(el) el.classList.toggle('hidden');
}

function showLoading(msg = "Loading...") {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    if(text) text.innerText = msg;
    if(overlay) overlay.classList.remove('hidden');
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if(overlay) overlay.classList.add('hidden');
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active');
    // Find the button that calls this function and make it active
    const btn = document.querySelector(`button[onclick="switchTab('${tabId}')"]`);
    if(btn) btn.classList.add('active');
}

function toggleSelectAll() {
    const val = document.getElementById('select-all-toggle').checked;
    document.querySelectorAll('.prop-check').forEach(cb => cb.checked = val);
}

// --- CORE LOGIC ---

async function loginAndSave(silent = false) {
    if(!silent) showLoading("Authenticating...");

    try {
        currentCreds = {
            client_id: document.getElementById('clientId').value.trim(),
            client_secret: document.getElementById('clientSecret').value.trim(),
            organization_id: document.getElementById('orgId').value.trim(),
            scope: "openid,AdobeID,additional_info.projectedProductContext,read_organizations,reactor.read,reactor.write",
            ims_endpoint: "https://ims-na1.adobelogin.com"
        };

        const result = await ipcRenderer.invoke('adobe-login', currentCreds);

        if (result.success) {
            globalToken = result.token;
            
            // [FIX] Await the company load so we catch errors here
            await loadCompanies(); 

            if (!silent) {
                document.getElementById('login-status').innerText = "✅ Connected!";
                setTimeout(() => {
                    // Close creds, open company selection
                    const credsPanel = document.getElementById('creds-panel');
                    if(!credsPanel.classList.contains('hidden')) togglePanel('creds-panel');
                    
                    const companyPanel = document.getElementById('company-panel');
                    if(companyPanel.classList.contains('hidden')) togglePanel('company-panel');
                }, 500);
            }
        } else {
            if(!silent) document.getElementById('login-status').innerText = "❌ Error: " + result.error;
        }
    } catch (e) {
        console.error("Login Error:", e);
        if(!silent) document.getElementById('login-status').innerText = "❌ Exception: " + e.message;
    } finally {
        if(!silent) hideLoading(); // [FIX] Spinner ALWAYS turns off
    }
}

async function loadCompanies() {
    try {
        const companies = await ipcRenderer.invoke('get-companies', { token: globalToken, creds: currentCreds });
        
        const select = document.getElementById('company-select');
        select.innerHTML = '<option value="">Select a Company...</option>';
        
        // [FIX] Safety check to ensure companies is actually an array
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
        // Don't alert here if silent login, just log it
    }
}

async function saveCompanySelection() {
    const companyId = document.getElementById('company-select').value;
    if(!companyId) {
        alert("Please select a company.");
        return;
    }

    try {
        // Save to persistence
        await ipcRenderer.invoke('save-config-field', { key: 'company_id', value: companyId });
        
        // Load Properties (Handles its own loading spinner)
        await loadProperties(companyId);
        
        // Update UI
        togglePanel('company-panel');
        document.getElementById('main-interface').classList.remove('hidden');
    } catch (e) {
        alert("Failed to save company: " + e.message);
    }
}

async function loadProperties(companyId) {
    showLoading("Fetching Properties...");
    
    try {
        const properties = await ipcRenderer.invoke('get-properties', { token: globalToken, creds: currentCreds, companyId });
        
        // Populate Tab 1 List (Grid Layout)
        const list = document.getElementById('property-list');
        list.innerHTML = '';
        
        if (Array.isArray(properties)) {
            properties.forEach(prop => {
                const label = document.createElement('label');
                label.className = 'prop-item'; 
                label.innerHTML = `
                    <input type="checkbox" value="${prop.id}" data-name="${prop.attributes.name}" class="prop-check"> 
                    <span class="prop-name" title="${prop.attributes.name}">${prop.attributes.name}</span>
                `;
                list.appendChild(label);
            });

            // Populate Tab 2 Dropdown
            const compareSelect = document.getElementById('compare-prop-select');
            compareSelect.innerHTML = '<option value="">Select Property...</option>';
            properties.forEach(prop => {
                const opt = document.createElement('option');
                opt.value = prop.id;
                opt.innerText = prop.attributes.name;
                compareSelect.appendChild(opt);
            });
        } else {
            throw new Error("No properties found or API error.");
        }

    } catch (e) {
        alert("Error loading properties: " + e.message);
    } finally {
        hideLoading(); // [FIX] Spinner ALWAYS turns off
    }
}

// [NEW] Logic for Tab 2
async function loadLibrariesForCompare() {
    const propertyId = document.getElementById('compare-prop-select').value;
    if(!propertyId) return;

    showLoading("Fetching Libraries...");
    try {
        const libraries = await ipcRenderer.invoke('get-libraries', { token: globalToken, creds: currentCreds, propertyId });
        
        const fill = (id) => {
            const sel = document.getElementById(id);
            sel.innerHTML = '';
            if (Array.isArray(libraries)) {
                libraries.forEach(lib => {
                    const opt = document.createElement('option');
                    opt.value = lib.id;
                    opt.innerText = lib.attributes.name;
                    sel.appendChild(opt);
                });
            }
        };

        fill('lib-a-select');
        fill('lib-b-select');
    } catch(e) {
        alert("Error fetching libraries: " + e.message);
    } finally {
        hideLoading();
    }
}

async function startExportJob() {
    const propCheckboxes = document.querySelectorAll('.prop-check:checked');
    const statusDiv = document.getElementById('export-status');
    
    if (propCheckboxes.length === 0) return alert("Select at least one property.");
    
    const types = [];
    if (document.getElementById('opt-full-export').checked) types.push('full');
    if (document.getElementById('opt-library-export').checked) types.push('library');

    if (types.length === 0) return alert("Select at least one export type.");

    const selectedProps = Array.from(propCheckboxes).map(cb => ({
        id: cb.value, name: cb.getAttribute('data-name') 
    }));

    // Listener
    const progressListener = (event, message) => { 
        // Also update the loading spinner text if it's visible, or the status div
        if(!document.getElementById('loading-overlay').classList.contains('hidden')) {
             document.getElementById('loading-text').innerText = message;
        }
        statusDiv.innerText = message; 
    };
    ipcRenderer.on('export-progress', progressListener);

    showLoading("Initializing Export...");

    try {
        const result = await ipcRenderer.invoke('perform-export', { types, properties: selectedProps, token: globalToken, creds: currentCreds });
        alert(result);
        statusDiv.innerText = "Done.";
    } catch (e) {
        alert("Export failed: " + e.message);
    } finally {
        ipcRenderer.removeListener('export-progress', progressListener);
        hideLoading();
    }
}