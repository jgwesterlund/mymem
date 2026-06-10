-- myMem schema v1. Markdown-first: notes.content_md is the single source of truth.
-- Timestamps are unix-ms INTEGER. IDs are UUIDv7 TEXT, except chunks (INTEGER rowid —
-- FTS5 external-content and vec0 both key on rowid).

CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  title_source TEXT NOT NULL DEFAULT 'user' CHECK (title_source IN ('user', 'ai')),
  content_md   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  trashed_at   INTEGER                      -- NULL = live (soft delete)
);
CREATE INDEX idx_notes_live    ON notes(updated_at DESC) WHERE trashed_at IS NULL;
CREATE INDEX idx_notes_trashed ON notes(trashed_at)      WHERE trashed_at IS NOT NULL;

CREATE TABLE collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_collections_name ON collections(name);

CREATE TABLE note_collections (
  note_id       TEXT NOT NULL REFERENCES notes(id)       ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (note_id, collection_id)
);
CREATE INDEX idx_nc_by_collection ON note_collections(collection_id);

CREATE TABLE note_versions (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  content_md TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'session'
             CHECK (kind IN ('session','pre_cleanup','pre_restore','import','ai_edit')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_versions_by_note ON note_versions(note_id, created_at DESC);

CREATE TABLE links (
  from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_note_id, to_note_id)
);
CREATE INDEX idx_links_backlinks ON links(to_note_id);

CREATE TABLE assets (
  id         TEXT PRIMARY KEY,
  note_id    TEXT REFERENCES notes(id) ON DELETE SET NULL,
  file_name  TEXT NOT NULL,               -- on disk under userData/assets/<id>/<file_name>
  mime       TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE pins (
  item_type  TEXT NOT NULL CHECK (item_type IN ('note','collection')),
  item_id    TEXT NOT NULL,
  sort_order REAL NOT NULL,                -- fractional indexing for drag-reorder
  pinned_at  INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);

CREATE TABLE templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  content_md TEXT NOT NULL,                -- supports {{date}}, {{time}}, {{cursor}}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chats (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'New chat',
  provider_id TEXT,                        -- locked at first send
  model_id    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE chat_messages (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,           -- explicit ordering (created_at collides on fast tool turns)
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','toolResult')),
  content_json TEXT NOT NULL,              -- pi-ai message object (JSON-serializable)
  created_at   INTEGER NOT NULL,
  UNIQUE (chat_id, idx)
);

CREATE TABLE settings (                    -- value is JSON; secrets are safeStorage-encrypted base64
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,        -- rowid; shared key for chunks_fts and chunks_vec
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',   -- denormalized note title (FTS weighting)
  text         TEXT NOT NULL,
  text_hash    TEXT NOT NULL,              -- sha1(title|heading_path|text): incremental re-embed key
  embedded     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (note_id, idx)
);
CREATE INDEX idx_chunks_by_note ON chunks(note_id);
CREATE INDEX idx_chunks_pending ON chunks(embedded) WHERE embedded = 0;

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title, text,
  content='chunks', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
-- chunk rows are immutable (indexer deletes + reinserts) => only these two triggers
CREATE TRIGGER trg_chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER trg_chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, text)
  VALUES ('delete', old.id, old.title, old.text);
END;
