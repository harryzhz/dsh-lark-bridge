import type { SqlMigration } from './001-initial.js'

export const EXTERNAL_SESSION_LINKS_MIGRATION: SqlMigration = {
  version: 8,
  name: '008_external_session_links',
  sql: `
CREATE TABLE IF NOT EXISTS external_session_links (
  external_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  driver         TEXT NOT NULL DEFAULT '',
  updated_at_ms  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_external_session_links_session
  ON external_session_links(session_id);

CREATE INDEX IF NOT EXISTS idx_external_session_links_updated
  ON external_session_links(updated_at_ms ASC);
`,
}
