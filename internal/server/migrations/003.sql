CREATE TABLE IF NOT EXISTS reading_events(id TEXT PRIMARY KEY,workspace_document_id TEXT NOT NULL REFERENCES workspace_documents(id) ON DELETE CASCADE,started_at INTEGER NOT NULL,ended_at INTEGER NOT NULL,CHECK(ended_at>started_at AND ended_at-started_at<=60000));
CREATE INDEX IF NOT EXISTS reading_events_member_time ON reading_events(workspace_document_id,started_at);
INSERT OR IGNORE INTO schema_version VALUES(3);
