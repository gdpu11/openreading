CREATE TABLE IF NOT EXISTS pairing_sync_scopes(grant_id TEXT PRIMARY KEY REFERENCES pairing_grants(id) ON DELETE CASCADE,scope_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_sync_scopes(device_id TEXT PRIMARY KEY REFERENCES paired_devices(id) ON DELETE CASCADE,scope_json TEXT NOT NULL);
INSERT OR IGNORE INTO schema_version VALUES(5);
