import type { SqlMigration } from './001-initial.js'

export const COT_ORPHAN_TRACKING_MIGRATION: SqlMigration = {
  version: 12,
  name: '012_cot_orphan_tracking',
  sql: `
ALTER TABLE pending_turns ADD COLUMN cot_id TEXT;
ALTER TABLE pending_turns ADD COLUMN cot_message_id TEXT;
`,
}
