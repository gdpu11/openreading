CREATE TABLE IF NOT EXISTS note_learning(id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,tags_json TEXT NOT NULL DEFAULT '[]',due_at TEXT NOT NULL DEFAULT '',interval_days INTEGER NOT NULL DEFAULT 0,reviewed_at TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS book_preferences(id TEXT PRIMARY KEY REFERENCES workspace_documents(id) ON DELETE CASCADE,data_json TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY,workspace_document_id TEXT NOT NULL REFERENCES workspace_documents(id) ON DELETE CASCADE,version_id TEXT NOT NULL REFERENCES versions(id),title TEXT NOT NULL,locator_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bookmarks_member ON bookmarks(workspace_document_id,created_at);
CREATE TABLE IF NOT EXISTS search_sections(version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,position INTEGER NOT NULL,label TEXT NOT NULL,locator_json TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(version_id,position));
CREATE TABLE IF NOT EXISTS search_indexes(version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,complete INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS recognized_pages(version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,page_index INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(version_id,page_index));
INSERT OR IGNORE INTO schema_version VALUES(6);
