import type { SqlMigration } from './001-initial.js'

export const OBSERVABILITY_MIGRATION: SqlMigration = {
  version: 7,
  name: '007_observability',
  sql: `
CREATE TABLE IF NOT EXISTS telemetry_usage_events (
  id                 TEXT PRIMARY KEY,
  timestamp_ms       INTEGER NOT NULL,
  record_kind        TEXT NOT NULL,
  bot_id             TEXT NOT NULL,
  chat_id            TEXT NOT NULL DEFAULT '',
  chat_type          TEXT NOT NULL DEFAULT '',
  session_id         TEXT NOT NULL DEFAULT '',
  trigger            TEXT NOT NULL DEFAULT '',
  agent_preset       TEXT NOT NULL DEFAULT '',
  provider           TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  outcome            TEXT NOT NULL DEFAULT '',
  error_code         TEXT NOT NULL DEFAULT '',
  latency_ms         INTEGER,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  tool_errors        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tel_events_ts
  ON telemetry_usage_events(timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tel_events_bot_ts
  ON telemetry_usage_events(bot_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tel_events_bot_chat_ts
  ON telemetry_usage_events(bot_id, chat_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tel_events_kind_ts
  ON telemetry_usage_events(record_kind, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_tel_events_session
  ON telemetry_usage_events(session_id);

CREATE TABLE IF NOT EXISTS telemetry_daily_rollups (
  day_key               TEXT NOT NULL,
  bot_id                TEXT NOT NULL,
  chat_id               TEXT NOT NULL DEFAULT '',
  model                 TEXT NOT NULL DEFAULT '',
  trigger               TEXT NOT NULL DEFAULT '',
  inbound_count         INTEGER NOT NULL DEFAULT 0,
  replied_count         INTEGER NOT NULL DEFAULT 0,
  silent_count          INTEGER NOT NULL DEFAULT 0,
  ignored_count         INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0,
  triage_count          INTEGER NOT NULL DEFAULT 0,
  triage_quick_count    INTEGER NOT NULL DEFAULT 0,
  triage_handoff_count  INTEGER NOT NULL DEFAULT 0,
  triage_silent_count   INTEGER NOT NULL DEFAULT 0,
  triage_fallback_count INTEGER NOT NULL DEFAULT 0,
  llm_steps             INTEGER NOT NULL DEFAULT 0,
  tool_calls            INTEGER NOT NULL DEFAULT 0,
  tool_errors           INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  latency_sum_ms        INTEGER NOT NULL DEFAULT 0,
  latency_count         INTEGER NOT NULL DEFAULT 0,
  latency_max_ms        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_key, bot_id, chat_id, model, trigger)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tel_rollups_day
  ON telemetry_daily_rollups(day_key DESC);
CREATE INDEX IF NOT EXISTS idx_tel_rollups_bot_day
  ON telemetry_daily_rollups(bot_id, day_key DESC);

CREATE TABLE IF NOT EXISTS telemetry_session_watermarks (
  session_id    TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL DEFAULT -1,
  updated_at_ms INTEGER NOT NULL
) STRICT;
`,
}
