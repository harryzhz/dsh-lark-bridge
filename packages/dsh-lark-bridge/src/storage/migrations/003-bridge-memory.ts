import type { SqlMigration } from './001-initial.js'

export const BRIDGE_MEMORY_MIGRATION: SqlMigration = {
  version: 3,
  name: '003_bridge_memory',
  sql: `
CREATE TABLE IF NOT EXISTS memory_entries (
  id                TEXT PRIMARY KEY,
  bot_id            TEXT NOT NULL,
  scope             TEXT NOT NULL,
  scope_id          TEXT NOT NULL DEFAULT '',
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  title_key         TEXT NOT NULL,
  content           TEXT NOT NULL,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  confidence        TEXT NOT NULL DEFAULT 'high',
  pinned            INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',
  source_session_id TEXT,
  superseded_by     TEXT,
  superseded_at_ms  INTEGER,
  supersede_reason  TEXT,
  created_at_ms     INTEGER NOT NULL,
  updated_at_ms     INTEGER NOT NULL,
  last_verified_ms  INTEGER NOT NULL,
  last_recalled_ms  INTEGER,
  recall_count      INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_bot_status
  ON memory_entries(bot_id, status, pinned DESC, last_verified_ms DESC);
CREATE INDEX IF NOT EXISTS idx_memory_bot_scope_title
  ON memory_entries(bot_id, scope, scope_id, title_key, status);
CREATE INDEX IF NOT EXISTS idx_memory_source_session
  ON memory_entries(source_session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
  entry_id UNINDEXED,
  bot_id UNINDEXED,
  title,
  content,
  tags,
  tokenize='trigram'
);
`,
}
