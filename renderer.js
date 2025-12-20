const { ipcRenderer, shell } = require('electron');

let globalToken = null;
let currentCreds = {};

window.addEventListener('DOMContentLoaded', async () => {
    await checkSavedState();
});

document.addEventListener('DOMContentLoaded', () => {
    // 1. Existing Theme Check
    checkSavedState();

    // 2. Handle External Link Clicks
    const link = document.getElementById('credit-link');
    if (link) {
        link.addEventListener('click', (e) => {
            e.preventDefault(); // Stop app from navigating
            shell.openExternal(link.href); // Open in Chrome/Safari/Edge
        });
    }
});

async function checkSavedState() {
    const hasCreds = await ipcRenderer.invoke('check-stored-creds');
    
    if (hasCreds) {
        // Show "Saved" UI, Hide "Form" UI
        document.getElementById('saved-creds-view').classList.remove('hidden');
        document.getElementById('login-form').classList.add('hidden');
    } else {
        // Show "Form" UI
        document.getElementById('saved-creds-view').classList.add('hidden');
        document.getElementById('login-form').classList.remove('hidden');
    }
}

function enableEditMode() {
    // Show form, but keep "Cancel" button visible in case they didn't mean to
    document.getElementById('saved-creds-view').classList.add('hidden');
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('cancel-edit-btn').classList.remove('hidden');
}

function cancelEdit() {
    checkSavedState(); // Revert UI
}

async function clearCreds() {
    await ipcRenderer.invoke('clear-creds');
    currentCreds = {};
    globalToken = null;
    document.getElementById('login-status').innerText = "Logged out.";
    checkSavedState();
}

async function useSavedCreds() {
    const creds = await ipcRenderer.invoke('get-stored-creds');
    if (creds) {
        // Populate the fields internally (or just pass to login)
        document.getElementById('clientId').value = creds.client_id;
        document.getElementById('clientSecret').value = creds.client_secret; // Decrypted!
        document.getElementById('orgId').value = creds.organization_id;
        
        // Auto-login
        login();
    }
}

async function login() {
    currentCreds = {
        client_id: document.getElementById('clientId').value,
        client_secret: document.getElementById('clientSecret').value,
        organization_id: document.getElementById('orgId').value,
        scope: "openid,AdobeID,additional_info.projectedProductContext,read_organizations,reactor.read,reactor.write", 
        ims_endpoint: "https://ims-na1.adobelogin.com"
    };

    const result = await ipcRenderer.invoke('adobe-login', currentCreds);
    
    if (result.success) {
        globalToken = result.token;
        document.getElementById('login-status').innerText = "✅ Connected!";
        
        // Refresh UI to show "Saved" state since adobe-login saves creds now
        checkSavedState(); 
        loadCompanies();
    } else {
        document.getElementById('login-status').innerText = "❌ Error: " + result.error;
    }
}

async function loadCompanies() {
    const companies = await ipcRenderer.invoke('get-companies', { token: globalToken, creds: currentCreds });
    const select = document.getElementById('company-select');
    
    companies.forEach(comp => {
        const opt = document.createElement('option');
        opt.value = comp.id;
        opt.innerText = comp.attributes.name;
        select.appendChild(opt);
    });

    document.getElementById('company-section').classList.remove('hidden');
}

async function loadProperties() {
    const companyId = document.getElementById('company-select').value;
    const properties = await ipcRenderer.invoke('get-properties', { token: globalToken, creds: currentCreds, companyId });
    
    const list = document.getElementById('property-list');
    list.innerHTML = '';
    
    // Reset Select All
    document.getElementById('select-all-toggle').checked = false;

    properties.forEach(prop => {
        const div = document.createElement('div');
        div.style.padding = "2px 0";
        div.innerHTML = `<label><input type="checkbox" value="${prop.id}" data-name="${prop.attributes.name}" class="prop-check"> ${prop.attributes.name} (${prop.id})</label>`;
        list.appendChild(div);
    });

    document.getElementById('property-section').classList.remove('hidden');
}

function toggleSelectAll() {
    const master = document.getElementById('select-all-toggle');
    const checkboxes = document.querySelectorAll('.prop-check');
    checkboxes.forEach(cb => cb.checked = master.checked);
}

async function startExportJob() {
    // 1. Get Selected Properties
    const propCheckboxes = document.querySelectorAll('.prop-check:checked');
    if (propCheckboxes.length === 0) {
        alert("Please select at least one property.");
        return;
    }

    // 2. Get Selected Export Modes
    const types = [];
    if (document.getElementById('opt-full-export').checked) types.push('full');
    if (document.getElementById('opt-library-export').checked) types.push('library');

    if (types.length === 0) {
        alert("Please select at least one Export Configuration (Full or Library).");
        return;
    }

    // 3. Prepare Data
    const selectedProps = Array.from(propCheckboxes).map(cb => ({
        id: cb.value,
        name: cb.getAttribute('data-name') 
    }));

    const statusDiv = document.getElementById('export-status');
    statusDiv.style.color = "var(--text-main)"; // Ensure visible color
    statusDiv.innerText = "Initializing export job...";

    // [NEW] Listen for progress updates from Main Process
    // We define the listener function so we can remove it later
    const progressListener = (event, message) => {
        statusDiv.innerText = message;
    };
    ipcRenderer.on('export-progress', progressListener);

    try {
        // 4. Send to Backend
        const result = await ipcRenderer.invoke('perform-export', { 
            types, 
            properties: selectedProps,
            token: globalToken,
            creds: currentCreds
        });

        // 5. Job Done
        statusDiv.innerText = result;
        statusDiv.style.color = "green"; // Optional success color
        alert(result);

    } catch (error) {
        statusDiv.innerText = "Error: " + error.message;
        statusDiv.style.color = "red";
    } finally {
        // [IMPORTANT] Clean up listener to prevent duplicates next time
        ipcRenderer.removeListener('export-progress', progressListener);
    }
}
