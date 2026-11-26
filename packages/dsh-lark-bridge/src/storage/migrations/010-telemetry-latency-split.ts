import type { SqlMigration } from './001-initial.js'

export const TELEMETRY_LATENCY_SPLIT_MIGRATION: SqlMigration = {
  version: 10,
  name: '010_telemetry_latency_split',
  sql: `
ALTER TABLE telemetry_usage_events ADD COLUMN queue_wait_ms INTEGER;
ALTER TABLE telemetry_usage_events ADD COLUMN exec_ms INTEGER;
`,
}
