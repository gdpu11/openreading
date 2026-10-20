CREATE TABLE IF NOT EXISTS library_books(
 workspace_document_id TEXT PRIMARY KEY REFERENCES workspace_documents(id) ON DELETE CASCADE,
 favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
 finished_at TEXT NOT NULL DEFAULT '',
 removed_at TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO schema_version VALUES(4);
