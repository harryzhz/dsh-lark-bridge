import type { SqlMigration } from './001-initial.js'

export const SESSION_TIER_ROUTING_MIGRATION: SqlMigration = {
  version: 13,
  name: '013_session_tier_routing',
  sql: `
ALTER TABLE session_bindings ADD COLUMN runtime_pinned INTEGER;
ALTER TABLE session_bindings ADD COLUMN routed_tier TEXT;
`,
}
