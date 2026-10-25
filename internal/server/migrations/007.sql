CREATE TABLE IF NOT EXISTS mcp_documents(
  workspace_document_id TEXT PRIMARY KEY REFERENCES workspace_documents(id) ON DELETE CASCADE,
  source_entry_id TEXT NOT NULL UNIQUE REFERENCES source_entries(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id),
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO schema_version VALUES(7);
