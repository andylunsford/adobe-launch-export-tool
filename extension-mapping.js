module.exports = {
    extensions: {
        "gcoe-adobe-client-data-layer": "Adobe Client Data Layer",
        "adobe-alloy": "Adobe Experience Platform Web SDK",
        "core": "Core",
        "adobe-analytics": "Adobe Analytics",
        "adobe-target": "Adobe Target",
        "adobe-mcid": "Experience Cloud ID Service",
        "facebook-pixel": "Facebook Pixel",
        "google-universal-analytics": "Google Universal Analytics",
        "google-global-site-tag": "Google Global Site Tag"
    },

    // Component type mappings (suffix of delegate_descriptor_id)
    componentTypes: {
        // Core
        "custom-code": "Custom Code",
        "data-element": "Data Element",

        // Adobe Client Data Layer
        "datalayer-push": "Data Pushed",

        // Adobe Alloy (Web SDK)
        "send-event": "Send Event",
        "update-variable": "Update Variable",

        // Common Actions/Events
        "click": "Click",
        "submit": "Submit",
        "page-bottom": "Page Bottom",
        "library-loaded": "Library Loaded",
        "dom-ready": "DOM Ready",
        "window-loaded": "Window Loaded"
    },

    // Helper to extract friendly extension name from delegate_descriptor_id
    getFriendlyName: function (descriptorId) {
        if (!descriptorId) return descriptorId;

        const parts = descriptorId.split('::');
        const extensionKey = parts[0];

        if (this.extensions[extensionKey]) {
            return this.extensions[extensionKey];
        }

        // Fallback: format the key (capitalize, replace dashes with spaces)
        return extensionKey.split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },

    // Helper to get friendly component type name (e.g. "Send Event")
    getFriendlyComponentType: function (descriptorId) {
        if (!descriptorId) return '';

        const parts = descriptorId.split('::');
        // The component type identifier is typically the last part
        const typeKey = parts[parts.length - 1];

        if (this.componentTypes[typeKey]) {
            return this.componentTypes[typeKey];
        }

        // Fallback: format the key
        return typeKey.split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },

    // Helper to determine component type (events, conditions, actions)
    getComponentType: function (descriptorId) {
        if (!descriptorId) return 'unknown';
        if (descriptorId.includes('::events::')) return 'events';
        if (descriptorId.includes('::conditions::')) return 'conditions';
        if (descriptorId.includes('::actions::')) return 'actions';
        return 'unknown';
    }
};
