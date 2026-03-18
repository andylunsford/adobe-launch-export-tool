const CREATE_TABLES_SQL = `
-- NOTE: Foreign key enforcement is OFF by default in SQLite.
-- The caller must issue: PRAGMA foreign_keys = ON
-- before running this SQL for ON DELETE CASCADE to take effect.

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL, enabled INTEGER, revision_number INTEGER,
  origin_id TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_property_id ON rules(property_id);
CREATE INDEX IF NOT EXISTS idx_rules_origin_id   ON rules(origin_id);

CREATE TABLE IF NOT EXISTS data_elements (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL, delegate_descriptor_id TEXT, origin_id TEXT,
  extension_package_id TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_de_property_id ON data_elements(property_id);
CREATE INDEX IF NOT EXISTS idx_de_origin_id   ON data_elements(origin_id);

CREATE TABLE IF NOT EXISTS extensions (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL, name TEXT, version TEXT, origin_id TEXT,
  extension_package_id TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ext_property_id ON extensions(property_id);

CREATE TABLE IF NOT EXISTS rule_components (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  name TEXT, delegate_descriptor_id TEXT NOT NULL, sort_order INTEGER,
  origin_id TEXT, extension_package_id TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rc_rule_id     ON rule_components(rule_id);
CREATE INDEX IF NOT EXISTS idx_rc_property_id ON rule_components(property_id);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL, stage TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_env_property_id ON environments(property_id);

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name TEXT NOT NULL, state TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
  environment_id TEXT,
  status TEXT, attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_build_environment_id ON builds(environment_id);

CREATE TABLE IF NOT EXISTS extension_packages (
  id TEXT PRIMARY KEY, name TEXT, version TEXT,
  attributes_json TEXT NOT NULL, cached_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library_rules (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  rule_id    TEXT NOT NULL REFERENCES rules(id)     ON DELETE CASCADE,
  PRIMARY KEY (library_id, rule_id)
);
CREATE TABLE IF NOT EXISTS library_data_elements (
  library_id      TEXT NOT NULL REFERENCES libraries(id)     ON DELETE CASCADE,
  data_element_id TEXT NOT NULL REFERENCES data_elements(id) ON DELETE CASCADE,
  PRIMARY KEY (library_id, data_element_id)
);
CREATE TABLE IF NOT EXISTS library_extensions (
  library_id   TEXT NOT NULL REFERENCES libraries(id)  ON DELETE CASCADE,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  PRIMARY KEY (library_id, extension_id)
);
`;

module.exports = { CREATE_TABLES_SQL };
