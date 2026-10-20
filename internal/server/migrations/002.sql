CREATE TABLE IF NOT EXISTS paired_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,workspace_ids_json TEXT NOT NULL,created_at TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at TEXT);
CREATE TABLE IF NOT EXISTS pairing_grants(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL,workspace_ids_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'waiting',claim_name TEXT NOT NULL DEFAULT '',claim_hash TEXT NOT NULL DEFAULT '',expires_at INTEGER NOT NULL,device_id TEXT);
INSERT OR IGNORE INTO schema_version VALUES(2);
