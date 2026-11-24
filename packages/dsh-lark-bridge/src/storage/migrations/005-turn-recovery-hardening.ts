import type { SqlMigration } from './001-initial.js'

export const TURN_RECOVERY_HARDENING_MIGRATION: SqlMigration = {
  version: 5,
  name: '005_turn_recovery_hardening',
  sql: `
ALTER TABLE pending_turns ADD COLUMN interrupted_at_ms INTEGER;
ALTER TABLE pending_turns ADD COLUMN last_activity_at_ms INTEGER;
ALTER TABLE pending_turns ADD COLUMN interrupt_kind TEXT;
ALTER TABLE pending_turns ADD COLUMN graceful_recovery_attempts INTEGER NOT NULL DEFAULT 0;
`,
}
