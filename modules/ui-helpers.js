/**
 * UI Helpers Module
 * Common UI utility functions used across the application
 */

const { ipcRenderer, shell } = require('electron');

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

// --- Get Selected Properties ---
function getSelectedProperties() {
    const checks = document.querySelectorAll('.prop-check:checked');
    return Array.from(checks).map(cb => ({
        id: cb.value,
        name: cb.dataset.name // Assuming property name is stored in data-name
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
module.exports = {
    getGlobalToken,
    setGlobalToken,
    getCurrentCreds,
    setCurrentCreds,
    togglePanel,
    showLoading,
    hideLoading,
    switchTab,
    toggleSelectAll,
    initTheme,
    logArchive,
    logSync,
    getSelectedProperties,
    getAllLoadedProperties,
    setAllLoadedProperties
};
