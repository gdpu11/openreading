CREATE TABLE IF NOT EXISTS reading_event_words(
  id TEXT PRIMARY KEY REFERENCES reading_events(id) ON DELETE CASCADE,
  word_count INTEGER NOT NULL CHECK(word_count>0 AND word_count<=100000)
);
INSERT OR IGNORE INTO schema_version VALUES(8);
