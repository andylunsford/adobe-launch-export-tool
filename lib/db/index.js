const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const { CREATE_TABLES_SQL } = require('./schema');
const { runMigrations } = require('./migrations');

let db = null;
const now = () => Math.floor(Date.now() / 1000);

function initDb(dbPathOverride = null) {
    const dbPath = dbPathOverride ?? path.join(app.getPath('userData'), 'nuclear-cache.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.exec(CREATE_TABLES_SQL);
    runMigrations(db);
}

// ---------------------------------------------------------------------------
// Upsert Helpers
// ---------------------------------------------------------------------------

function upsertRules(rules, propertyId) {
    const stmt = db.prepare(`INSERT OR REPLACE INTO rules
      (id, property_id, name, enabled, revision_number, origin_id, attributes_json, cached_at)
      VALUES (@id, @property_id, @name, @enabled, @revision_number, @origin_id, @attributes_json, @cached_at)`);
    const insertMany = db.transaction((items) => {
        for (const r of items) stmt.run({
            id: r.id,
            property_id: propertyId,
            name: r.attributes.name,
            enabled: r.attributes.enabled ? 1 : 0,
            revision_number: r.attributes.revision_number ?? null,
            origin_id: r.relationships?.origin?.data?.id ?? r.id,
            attributes_json: JSON.stringify(r.attributes),
            cached_at: now()
        });
    });
    insertMany(rules);
}

function upsertDataElements(des, propertyId) {
    const stmt = db.prepare(`INSERT OR REPLACE INTO data_elements
      (id, property_id, name, delegate_descriptor_id, origin_id, extension_package_id, attributes_json, cached_at)
      VALUES (@id, @property_id, @name, @delegate_descriptor_id, @origin_id, @extension_package_id, @attributes_json, @cached_at)`);
    const insertMany = db.transaction((items) => {
        for (const r of items) stmt.run({
            id: r.id,
            property_id: propertyId,
            name: r.attributes.name,
            delegate_descriptor_id: r.attributes.delegate_descriptor_id,
            origin_id: r.relationships?.origin?.data?.id ?? r.id,
            extension_package_id: r.relationships?.updated_with_extension_package?.data?.id ?? null,
            attributes_json: JSON.stringify(r.attributes),
            cached_at: now()
        });
    });
    insertMany(des);
}

function upsertExtensions(exts, propertyId) {
    const stmt = db.prepare(`INSERT OR REPLACE INTO extensions
      (id, property_id, display_name, name, version, origin_id, extension_package_id, attributes_json, cached_at)
      VALUES (@id, @property_id, @display_name, @name, @version, @origin_id, @extension_package_id, @attributes_json, @cached_at)`);
    const insertMany = db.transaction((items) => {
        for (const r of items) stmt.run({
            id: r.id,
            property_id: propertyId,
            display_name: r.attributes.display_name,
            name: r.attributes.name ?? null,
            version: r.attributes.version ?? null,
            origin_id: r.relationships?.origin?.data?.id ?? r.id,
            extension_package_id: r.relationships?.extension_package?.data?.id ?? null,
            attributes_json: JSON.stringify(r.attributes),
            cached_at: now()
        });
    });
    insertMany(exts);
}

function upsertRuleComponents(rcs, ruleId, propertyId) {
    const stmt = db.prepare(`INSERT OR REPLACE INTO rule_components
      (id, rule_id, property_id, name, delegate_descriptor_id, sort_order, origin_id, extension_package_id, attributes_json, cached_at)
      VALUES (@id, @rule_id, @property_id, @name, @delegate_descriptor_id, @sort_order, @origin_id, @extension_package_id, @attributes_json, @cached_at)`);
    const insertMany = db.transaction((items) => {
        for (const rc of items) stmt.run({
            id: rc.id,
            rule_id: ruleId,
            property_id: propertyId,
            name: rc.attributes.name ?? null,
            delegate_descriptor_id: rc.attributes.delegate_descriptor_id,
            sort_order: rc.attributes.sort_order ?? null,
            origin_id: rc.relationships?.origin?.data?.id ?? rc.id,
            extension_package_id: rc.relationships?.extension_package?.data?.id ?? null,
            attributes_json: JSON.stringify(rc.attributes),
            cached_at: now()
        });
    });
    insertMany(rcs);
}

function upsertEnvironment(env, propertyId) {
    db.prepare(`INSERT OR REPLACE INTO environments
      (id, property_id, name, stage, attributes_json, cached_at)
      VALUES (@id, @property_id, @name, @stage, @attributes_json, @cached_at)`).run({
        id: env.id,
        property_id: propertyId,
        name: env.attributes.name,
        stage: env.attributes.stage ?? null,
        attributes_json: JSON.stringify(env.attributes),
        cached_at: now()
    });
}

function upsertLibrary(lib, propertyId) {
    db.prepare(`INSERT OR REPLACE INTO libraries
      (id, property_id, name, state, attributes_json, cached_at)
      VALUES (@id, @property_id, @name, @state, @attributes_json, @cached_at)`).run({
        id: lib.id,
        property_id: propertyId,
        name: lib.attributes.name,
        state: lib.attributes.state ?? null,
        attributes_json: JSON.stringify(lib.attributes),
        cached_at: now()
    });
}

function upsertBuild(build) {
    db.prepare(`INSERT OR REPLACE INTO builds
      (id, library_id, environment_id, status, attributes_json, cached_at)
      VALUES (@id, @library_id, @environment_id, @status, @attributes_json, @cached_at)`).run({
        id: build.id,
        library_id: build.relationships?.library?.data?.id ?? null,
        environment_id: build.relationships?.environment?.data?.id ?? null,
        status: build.attributes.status ?? null,
        attributes_json: JSON.stringify(build.attributes),
        cached_at: now()
    });
}

function upsertExtensionPackage(pkg) {
    db.prepare(`INSERT OR REPLACE INTO extension_packages
      (id, name, version, attributes_json, cached_at)
      VALUES (@id, @name, @version, @attributes_json, @cached_at)`).run({
        id: pkg.id,
        name: pkg.attributes.name ?? null,
        version: pkg.attributes.version ?? null,
        attributes_json: JSON.stringify(pkg.attributes),
        cached_at: now()
    });
}

function upsertProperty(prop) {
    db.prepare(`INSERT OR REPLACE INTO properties
      (id, name, platform, attributes_json, cached_at)
      VALUES (@id, @name, @platform, @attributes_json, @cached_at)`).run({
        id: prop.id,
        name: prop.attributes.name,
        platform: prop.attributes.platform ?? null,
        attributes_json: JSON.stringify(prop.attributes),
        cached_at: now()
    });
}

// ---------------------------------------------------------------------------
// Junction Table Helpers
// ---------------------------------------------------------------------------

function linkLibraryRules(libraryId, rules) {
    const stmt = db.prepare('INSERT OR IGNORE INTO library_rules (library_id, rule_id) VALUES (?, ?)');
    const insertMany = db.transaction((items) => {
        for (const r of items) stmt.run(libraryId, r.id);
    });
    insertMany(rules);
}

function linkLibraryDataElements(libraryId, des) {
    const stmt = db.prepare('INSERT OR IGNORE INTO library_data_elements (library_id, data_element_id) VALUES (?, ?)');
    const insertMany = db.transaction((items) => {
        for (const r of items) stmt.run(libraryId, r.id);
    });
    insertMany(des);
}

function linkLibraryExtensions(libraryId, exts) {
    const stmt = db.prepare('INSERT OR IGNORE INTO library_extensions (library_id, extension_id) VALUES (?, ?)');
    const insertMany = db.transaction((items) => {
        for (const r of items) stmt.run(libraryId, r.id);
    });
    insertMany(exts);
}

// ---------------------------------------------------------------------------
// Read Helpers
// ---------------------------------------------------------------------------

function hasCachedLibrary(libraryId) {
    const row = db.prepare('SELECT 1 FROM libraries WHERE id = ? LIMIT 1').get(libraryId);
    return !!row;
}

function getRulesForLibrary(libraryId) {
    const rows = db.prepare(`
        SELECT r.* FROM rules r
        JOIN library_rules lr ON lr.rule_id = r.id
        WHERE lr.library_id = ?`).all(libraryId);
    return rows.map(row => ({
        id: row.id,
        type: 'rules',
        attributes: JSON.parse(row.attributes_json),
        relationships: { origin: { data: { id: row.origin_id } } }
    }));
}

function getDataElementsForLibrary(libraryId) {
    const rows = db.prepare(`
        SELECT de.* FROM data_elements de
        JOIN library_data_elements lde ON lde.data_element_id = de.id
        WHERE lde.library_id = ?`).all(libraryId);
    return rows.map(row => ({
        id: row.id,
        type: 'data_elements',
        attributes: JSON.parse(row.attributes_json),
        relationships: { origin: { data: { id: row.origin_id } } }
    }));
}

function getExtensionsForLibrary(libraryId) {
    const rows = db.prepare(`
        SELECT e.* FROM extensions e
        JOIN library_extensions le ON le.extension_id = e.id
        WHERE le.library_id = ?`).all(libraryId);
    return rows.map(row => ({
        id: row.id,
        type: 'extensions',
        attributes: JSON.parse(row.attributes_json),
        relationships: { origin: { data: { id: row.origin_id } } }
    }));
}

function getLatestBuildForEnvironment(environmentId) {
    const row = db.prepare(
        'SELECT * FROM builds WHERE environment_id = ? ORDER BY cached_at DESC LIMIT 1'
    ).get(environmentId);
    if (!row) return null;
    return {
        id: row.id,
        type: 'builds',
        attributes: JSON.parse(row.attributes_json),
        relationships: {
            library: { data: { id: row.library_id } },
            environment: { data: { id: row.environment_id } }
        }
    };
}

function getExtensionPackage(id) {
    const row = db.prepare('SELECT * FROM extension_packages WHERE id = ?').get(id);
    if (!row) return null;
    return { id: row.id, type: 'extension_packages', attributes: JSON.parse(row.attributes_json) };
}

// ---------------------------------------------------------------------------
// Cache Management
// ---------------------------------------------------------------------------

function getCacheStats(propertyId) {
    const count = (table, col) =>
        db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${col} = ?`).get(propertyId).n;
    const oldest = db.prepare(
        `SELECT MIN(cached_at) as t FROM rules WHERE property_id = ?`
    ).get(propertyId).t;
    return {
        rules: count('rules', 'property_id'),
        data_elements: count('data_elements', 'property_id'),
        extensions: count('extensions', 'property_id'),
        rule_components: count('rule_components', 'property_id'),
        environments: count('environments', 'property_id'),
        libraries: count('libraries', 'property_id'),
        oldest_cached_at: oldest ?? null
    };
}

/**
 * Deletes a property and all its cached children (rules, data_elements, extensions,
 * environments, libraries, rule_components, junction rows) via ON DELETE CASCADE.
 * NOTE: Requires PRAGMA foreign_keys = ON on the connection — set in initDb().
 */
function clearPropertyCache(propertyId) {
    db.prepare('DELETE FROM properties WHERE id = ?').run(propertyId);
}

/**
 * Clears the entire cache. Relies on ON DELETE CASCADE (requires foreign_keys = ON).
 */
function clearAllCache() {
    db.prepare('DELETE FROM properties').run();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    initDb,
    upsertRules, upsertDataElements, upsertExtensions, upsertRuleComponents,
    upsertEnvironment, upsertLibrary, upsertBuild, upsertExtensionPackage, upsertProperty,
    linkLibraryRules, linkLibraryDataElements, linkLibraryExtensions,
    hasCachedLibrary, getRulesForLibrary, getDataElementsForLibrary,
    getExtensionsForLibrary, getLatestBuildForEnvironment, getExtensionPackage,
    getCacheStats, clearPropertyCache, clearAllCache
};
