import type { SqlMigration } from './001-initial.js'

export const RESILIENCE_MIGRATION: SqlMigration = {
  version: 4,
  name: '004_resilience',
  sql: `
ALTER TABLE pending_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'running';
ALTER TABLE pending_turns ADD COLUMN inbound_msg_json TEXT;
ALTER TABLE pending_turns ADD COLUMN sender_name TEXT;
ALTER TABLE pending_turns ADD COLUMN intermediate_sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_turns ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_turns ADD COLUMN handoff_turns_json TEXT;
ALTER TABLE pending_turns ADD COLUMN updated_at_ms INTEGER;

CREATE TABLE IF NOT EXISTS triage_context_scopes (
  scope_key     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_key, kind)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_triage_context_kind_updated
  ON triage_context_scopes(kind, updated_at_ms DESC);
`,
}
