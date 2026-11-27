import type { SqlMigration } from './001-initial.js'

export const HOT_RELOAD_REATTACH_MIGRATION: SqlMigration = {
  version: 11,
  name: '011_hot_reload_reattach',
  sql: `
ALTER TABLE pending_turns ADD COLUMN target_turn INTEGER;
ALTER TABLE pending_turns ADD COLUMN user_message_id TEXT;
ALTER TABLE pending_turns ADD COLUMN last_event_seq INTEGER;
`,
}
