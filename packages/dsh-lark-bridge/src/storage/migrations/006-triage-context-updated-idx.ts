import type { SqlMigration } from './001-initial.js'

export const TRIAGE_CONTEXT_UPDATED_IDX_MIGRATION: SqlMigration = {
  version: 6,
  name: '006_triage_context_updated_idx',
  sql: `
CREATE INDEX IF NOT EXISTS idx_triage_context_scopes_updated
  ON triage_context_scopes(updated_at_ms DESC);
`,
}
