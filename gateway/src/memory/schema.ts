export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,
    vita_name     TEXT NOT NULL,
    category      TEXT NOT NULL,
    content       TEXT NOT NULL,
    tags          TEXT NOT NULL DEFAULT '[]',
    timestamp     INTEGER NOT NULL,
    importance    REAL NOT NULL DEFAULT 0.5,
    access_count  INTEGER NOT NULL DEFAULT 0,
    last_accessed INTEGER NOT NULL DEFAULT 0,
    is_summary    INTEGER NOT NULL DEFAULT 0,
    source_ids    TEXT NOT NULL DEFAULT '[]'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(
      content,
      tags,
      content='memories',
      content_rowid='rowid'
    );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags)
      VALUES (new.rowid, new.content, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
      VALUES ('delete', old.rowid, old.content, old.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
      VALUES ('delete', old.rowid, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags)
      VALUES (new.rowid, new.content, new.tags);
  END;

  CREATE INDEX IF NOT EXISTS idx_memories_vita_importance
    ON memories (vita_name, importance DESC, last_accessed DESC);
`;
