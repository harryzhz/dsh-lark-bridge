import type { SqlMigration } from './001-initial.js'

export const TRIAGE_SESSIONS_MIGRATION: SqlMigration = {
  version: 2,
  name: '002_triage_sessions',
  sql: `
CREATE TABLE IF NOT EXISTS triage_sessions (
  session_id       TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  action           TEXT NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  payload_json     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_triage_sessions_activity ON triage_sessions(last_activity_ms DESC);
CREATE INDEX IF NOT EXISTS idx_triage_sessions_bot_activity ON triage_sessions(bot_id, last_activity_ms DESC);
`,
}
