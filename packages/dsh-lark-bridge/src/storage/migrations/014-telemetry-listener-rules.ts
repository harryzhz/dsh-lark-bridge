import type { SqlMigration } from './001-initial.js'

export const TELEMETRY_LISTENER_RULES_MIGRATION: SqlMigration = {
  version: 14,
  name: '014_telemetry_listener_rules',
  sql: `
ALTER TABLE telemetry_usage_events ADD COLUMN listener_name TEXT NOT NULL DEFAULT '';
ALTER TABLE telemetry_usage_events ADD COLUMN silence_source TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_tel_events_listener_ts
  ON telemetry_usage_events(bot_id, trigger, timestamp_ms DESC);
ALTER TABLE dream_states ADD COLUMN last_rule_reflection_date_key TEXT;
ALTER TABLE dream_states ADD COLUMN last_rule_reflection_at_ms INTEGER;
`,
}
