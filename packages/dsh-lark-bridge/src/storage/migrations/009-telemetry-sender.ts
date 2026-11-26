import type { SqlMigration } from './001-initial.js'

export const TELEMETRY_SENDER_MIGRATION: SqlMigration = {
  version: 9,
  name: '009_telemetry_sender',
  sql: `
ALTER TABLE telemetry_usage_events ADD COLUMN sender_id TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_usage_events ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_usage_events ADD COLUMN sender_type TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tel_events_sender_ts
  ON telemetry_usage_events(sender_id, timestamp_ms DESC);

CREATE TABLE IF NOT EXISTS telemetry_sender_profiles (
  bot_id        TEXT NOT NULL,
  open_id       TEXT NOT NULL,
  union_id      TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  sender_type   TEXT NOT NULL DEFAULT 'user',
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (bot_id, open_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tel_sender_profiles_union
  ON telemetry_sender_profiles(union_id);
`,
}
