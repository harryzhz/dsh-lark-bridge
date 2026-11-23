export interface SqlMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

export const INITIAL_MIGRATION: SqlMigration = {
  version: 1,
  name: '001_initial',
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS kv_meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS bots (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  lark_app_id   TEXT NOT NULL,
  enabled       INTEGER NOT NULL,
  config_json   TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_bots_app_id ON bots(lark_app_id);

CREATE TABLE IF NOT EXISTS groups (
  key              TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  chat_name        TEXT NOT NULL,
  enabled          INTEGER NOT NULL,
  listener_enabled INTEGER NOT NULL,
  config_json      TEXT NOT NULL,
  updated_at_ms    INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_groups_bot_chat ON groups(bot_id, chat_id);

CREATE TABLE IF NOT EXISTS listener_templates (
  key           TEXT PRIMARY KEY,
  config_json   TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS schedule_bindings (
  schedule_id       TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL,
  delivery_mode     TEXT NOT NULL,
  notify_on         TEXT NOT NULL,
  send_intermediate INTEGER NOT NULL,
  targets_json      TEXT NOT NULL,
  updated_at_ms     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS session_bindings (
  route_key          TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  bot_id             TEXT NOT NULL,
  bot_name           TEXT,
  lark_app_id        TEXT NOT NULL,
  chat_type          TEXT,
  chat_id            TEXT NOT NULL,
  chat_name          TEXT,
  user_open_id       TEXT,
  user_name          TEXT,
  workspace_name     TEXT NOT NULL,
  agent_preset       TEXT NOT NULL,
  runtime_profile_id TEXT,
  model              TEXT,
  reasoning_effort   TEXT,
  working_dir        TEXT NOT NULL,
  trigger            TEXT NOT NULL,
  listener_name      TEXT,
  has_replied        INTEGER,
  created_at_ms      INTEGER NOT NULL,
  last_activity_ms   INTEGER NOT NULL,
  idle_close_ms      INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_bindings_session ON session_bindings(session_id);
CREATE INDEX IF NOT EXISTS idx_bindings_bot_chat ON session_bindings(bot_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_bindings_activity ON session_bindings(last_activity_ms DESC);

CREATE TABLE IF NOT EXISTS binding_aliases (
  alias_route_key   TEXT PRIMARY KEY,
  primary_route_key TEXT NOT NULL REFERENCES session_bindings(route_key) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_binding_aliases_primary ON binding_aliases(primary_route_key);

CREATE TABLE IF NOT EXISTS managed_sessions (
  session_id       TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  route_key        TEXT,
  trigger          TEXT,
  created_at_ms    INTEGER NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  idle_close_ms    INTEGER,
  archived_at_ms   INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_managed_bot_activity ON managed_sessions(bot_id, last_activity_ms DESC);
CREATE INDEX IF NOT EXISTS idx_managed_active_expire ON managed_sessions(archived_at_ms, idle_close_ms, last_activity_ms);

CREATE TABLE IF NOT EXISTS pending_turns (
  id                       TEXT PRIMARY KEY,
  bot_id                   TEXT NOT NULL,
  chat_id                  TEXT NOT NULL,
  chat_name                TEXT,
  message_id               TEXT NOT NULL,
  route_key                TEXT NOT NULL,
  reply_mode               TEXT NOT NULL,
  trigger                  TEXT NOT NULL,
  allow_silent_empty_reply INTEGER NOT NULL,
  reaction_id              TEXT,
  session_id               TEXT,
  trace_id                 TEXT,
  started_at_ms            INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_pending_turns_bot ON pending_turns(bot_id);

CREATE TABLE IF NOT EXISTS seen_messages (
  key        TEXT PRIMARY KEY,
  seen_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_seen_messages_ts ON seen_messages(seen_at_ms);

CREATE TABLE IF NOT EXISTS reminders (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL,
  status          TEXT NOT NULL,
  scheduled_at    TEXT NOT NULL,
  scheduled_at_ms INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  archived_at_ms  INTEGER,
  payload_json    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_reminders_status_sched ON reminders(status, scheduled_at_ms);
CREATE INDEX IF NOT EXISTS idx_reminders_bot ON reminders(bot_id);

CREATE TABLE IF NOT EXISTS dream_states (
  bot_id                     TEXT PRIMARY KEY,
  status                     TEXT NOT NULL,
  last_dream_at_ms           INTEGER,
  last_checked_date_key      TEXT,
  last_session_id            TEXT,
  last_processed_count       INTEGER,
  last_summary               TEXT,
  processed_session_ids_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS dream_sessions (
  session_id       TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL,
  status           TEXT NOT NULL,
  date_key         TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  payload_json     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_dream_sessions_bot_activity ON dream_sessions(bot_id, last_activity_ms DESC);

CREATE TABLE IF NOT EXISTS hourly_buckets (
  hour_key           TEXT PRIMARY KEY,
  inbound            INTEGER NOT NULL DEFAULT 0,
  replied            INTEGER NOT NULL DEFAULT 0,
  listener_triggered INTEGER NOT NULL DEFAULT 0,
  silent_skipped     INTEGER NOT NULL DEFAULT 0,
  ignored            INTEGER NOT NULL DEFAULT 0,
  errors             INTEGER NOT NULL DEFAULT 0,
  total_latency_ms   INTEGER NOT NULL DEFAULT 0,
  latency_samples    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS bot_metrics (
  bot_id                   TEXT PRIMARY KEY,
  inbound_total            INTEGER NOT NULL DEFAULT 0,
  replied_total            INTEGER NOT NULL DEFAULT 0,
  listener_triggered_total INTEGER NOT NULL DEFAULT 0,
  silent_skipped_total     INTEGER NOT NULL DEFAULT 0,
  ignored_total            INTEGER NOT NULL DEFAULT 0,
  error_total              INTEGER NOT NULL DEFAULT 0,
  latencies_json           TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE IF NOT EXISTS group_traffic (
  key            TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  chat_name      TEXT NOT NULL,
  inbound_total  INTEGER NOT NULL DEFAULT 0,
  replied_total  INTEGER NOT NULL DEFAULT 0,
  last_active_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_group_traffic_rank ON group_traffic(inbound_total DESC, last_active_ms DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  timestamp_ms INTEGER NOT NULL,
  bot_id       TEXT NOT NULL,
  bot_name     TEXT,
  chat_id      TEXT,
  chat_name    TEXT,
  route_key    TEXT,
  session_id   TEXT,
  trace_id     TEXT,
  duration_ms  INTEGER,
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(timestamp_ms DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_bot_ts ON audit_events(bot_id, timestamp_ms DESC);
`,
}

export const ALL_MIGRATIONS: readonly SqlMigration[] = [INITIAL_MIGRATION]

export const ENTITY_TABLE_NAMES = [
  'bots',
  'groups',
  'listener_templates',
  'schedule_bindings',
  'session_bindings',
  'binding_aliases',
  'managed_sessions',
  'pending_turns',
  'seen_messages',
  'reminders',
  'dream_states',
  'dream_sessions',
  'hourly_buckets',
  'bot_metrics',
  'group_traffic',
  'audit_events',
] as const

export type EntityTableName = (typeof ENTITY_TABLE_NAMES)[number]
