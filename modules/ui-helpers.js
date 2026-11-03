/**
 * UI Helpers Module
 * Common UI utility functions used across the application
 */

// --- UI State ---
let globalToken = null;
let currentCreds = {};
let allLoadedProperties = []; // New State

// --- Exports for other modules ---
function getGlobalToken() { return globalToken; }
function setGlobalToken(token) { globalToken = token; }
function getCurrentCreds() { return currentCreds; }
function setCurrentCreds(creds) { currentCreds = creds; }
function getAllLoadedProperties() { return allLoadedProperties; }
function setAllLoadedProperties(properties) { allLoadedProperties = properties; }

// --- Panel Toggle ---
function togglePanel(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden');
}

// --- Loading Overlay ---
function showLoading(msg = "Loading...") {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    if (text) text.innerText = msg;
    if (overlay) overlay.classList.remove('hidden');
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
}

// --- Tab Switching ---
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    const btn = document.querySelector(`button[onclick="switchTab('${tabId}')"]`);
    if (btn) btn.classList.add('active');
}

// --- Select All Toggle ---
function toggleSelectAll() {
    const val = document.getElementById('select-all-toggle').checked;
    document.querySelectorAll('.prop-check').forEach(cb => cb.checked = val);
}

// --- Theme Toggle ---
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const target = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', target);
    localStorage.setItem('theme', target);
}

// --- Initialize Theme ---
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
}

// --- Property Platform Groups ---
// Reactor tags each property with a platform; Event Forwarding properties are
// "edge". Listed in display order. Anything unrecognised falls into "Other".
const PLATFORM_GROUPS = [
    { platform: 'edge', label: 'Event Forwarding (Server Side)' },
    { platform: 'web', label: 'Web' },
    { platform: 'mobile', label: 'Mobile (App)' }
];

// Buckets items by platform, returning only non-empty groups in display order.
// `getPlatform` reads the platform off each item.
function groupByPlatform(items, getPlatform) {
    const known = PLATFORM_GROUPS.map(g => ({ ...g, items: [] }));
    const other = { platform: 'other', label: 'Other', items: [] };
    items.forEach(item => {
        const group = known.find(g => g.platform === getPlatform(item)) || other;
        group.items.push(item);
    });
    return [...known, other].filter(g => g.items.length > 0);
}

// --- Get Selected Properties ---
function getSelectedProperties() {
    const checks = document.querySelectorAll('.prop-check:checked');
    return Array.from(checks).map(cb => ({
        id: cb.value,
        name: cb.dataset.name,
        platform: cb.dataset.platform
    }));
}

// --- Console Logging Helpers ---
function logToConsole(consoleId, msg, progressBarId = null, progress = null) {
    const consoleDiv = document.getElementById(consoleId);
    if (!consoleDiv) return;
    
    const line = document.createElement('div');
    line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleDiv.appendChild(line);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;

    if (progressBarId && progress !== null) {
        const bar = document.getElementById(progressBarId);
        if (bar) bar.style.width = `${progress}%`;
    }
}

function logArchive(msg, progress = null) {
    logToConsole('archive-console', msg, 'archive-progress-fill', progress);
}

function logSync(msg) {
    logToConsole('sync-console', msg);
}

// --- Export to window for HTML onclick handlers ---
window.togglePanel = togglePanel;
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.switchTab = switchTab;
window.toggleSelectAll = toggleSelectAll;
window.toggleTheme = toggleTheme;

// --- Module Exports ---
export {
    getGlobalToken,
    setGlobalToken,
    getCurrentCreds,
    setCurrentCreds,
    togglePanel,
    showLoading,
    hideLoading,
    switchTab,
    toggleSelectAll,
    groupByPlatform,
    initTheme,
    logArchive,
    logSync,
    getSelectedProperties,
    getAllLoadedProperties,
    setAllLoadedProperties
};
