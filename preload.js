/**
 * Preload — the only bridge between the renderer and the main process.
 *
 * Runs with contextIsolation enabled, so nothing here leaks into the page's
 * JavaScript context except the explicit `window.api` surface below. Each IPC
 * channel is named individually on purpose: exposing a generic
 * `invoke(channel, payload)` would hand the renderer every ipcMain handler and
 * defeat the point of isolating it.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wraps a renderer callback so the IpcRendererEvent (which carries `sender`
 * and sundry internals) never crosses the bridge — the callback receives only
 * the payload. Returns an unsubscribe function; listener identity does not
 * survive contextBridge, so `removeListener` cannot be exposed directly.
 */
function subscribe(channel, callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
    // --- Config & auth ---
    getSavedConfig: () => ipcRenderer.invoke('get-saved-config'),
    saveConfigField: (payload) => ipcRenderer.invoke('save-config-field', payload),
    adobeLogin: (creds) => ipcRenderer.invoke('adobe-login', creds),

    // --- Reactor API reads ---
    getCompanies: (payload) => ipcRenderer.invoke('get-companies', payload),
    getProperties: (payload) => ipcRenderer.invoke('get-properties', payload),
    getLibraries: (payload) => ipcRenderer.invoke('get-libraries', payload),
    getEnvironments: (payload) => ipcRenderer.invoke('get-environments', payload),
    getEnvironmentLibrary: (payload) => ipcRenderer.invoke('get-environment-library', payload),

    // --- Compare ---
    performEnvironmentComparison: (payload) =>
        ipcRenderer.invoke('perform-environment-comparison', payload),

    // --- Cache ---
    getCacheStats: (payload) => ipcRenderer.invoke('get-cache-stats', payload),
    clearCache: (payload) => ipcRenderer.invoke('clear-cache', payload),

    // --- Export ---
    performExport: (payload) => ipcRenderer.invoke('perform-export', payload),
    downloadNotes: (payload) => ipcRenderer.invoke('download-notes', payload),

    // --- Sync ---
    performSyncDownload: (payload) => ipcRenderer.invoke('perform-sync-download', payload),
    performSyncDiff: (payload) => ipcRenderer.invoke('perform-sync-diff', payload),
    performSyncPush: (payload) => ipcRenderer.invoke('perform-sync-push', payload),
    generateTestBuild: (payload) => ipcRenderer.invoke('generate-test-build', payload),
    onSyncLog: (callback) => subscribe('sync-log', callback),

    // --- Archive ---
    performArchiveScan: (payload) => ipcRenderer.invoke('perform-archive-scan', payload),
    performArchiveRun: (payload) => ipcRenderer.invoke('perform-archive-run', payload),
    resumeArchiveRun: () => ipcRenderer.invoke('resume-archive-run'),
    onArchiveProgress: (callback) => subscribe('archive-progress', callback),

    // --- File system dialogs ---
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    saveFile: (payload) => ipcRenderer.invoke('save-file', payload),

    // --- Shell (main-process side; the renderer has no `shell` access) ---
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath)
});
