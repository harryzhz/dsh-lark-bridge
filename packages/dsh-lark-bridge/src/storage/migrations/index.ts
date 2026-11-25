import {
  ENTITY_TABLE_NAMES as INITIAL_ENTITY_TABLE_NAMES,
  INITIAL_MIGRATION,
  type SqlMigration,
} from './001-initial.js'
import { TRIAGE_SESSIONS_MIGRATION } from './002-triage-sessions.js'
import { MEMORY_MIGRATION } from './003-memory.js'
import { RESILIENCE_MIGRATION } from './004-resilience.js'
import { TURN_RECOVERY_HARDENING_MIGRATION } from './005-turn-recovery-hardening.js'
import { TRIAGE_CONTEXT_UPDATED_IDX_MIGRATION } from './006-triage-context-updated-idx.js'
import { OBSERVABILITY_MIGRATION } from './007-observability.js'

export type { SqlMigration }
export {
  INITIAL_MIGRATION,
  TRIAGE_SESSIONS_MIGRATION,
  MEMORY_MIGRATION,
  RESILIENCE_MIGRATION,
  TURN_RECOVERY_HARDENING_MIGRATION,
  TRIAGE_CONTEXT_UPDATED_IDX_MIGRATION,
  OBSERVABILITY_MIGRATION,
}

export const ALL_MIGRATIONS: readonly SqlMigration[] = [
  INITIAL_MIGRATION,
  TRIAGE_SESSIONS_MIGRATION,
  MEMORY_MIGRATION,
  RESILIENCE_MIGRATION,
  TURN_RECOVERY_HARDENING_MIGRATION,
  TRIAGE_CONTEXT_UPDATED_IDX_MIGRATION,
  OBSERVABILITY_MIGRATION,
]

export const ENTITY_TABLE_NAMES = [
  ...INITIAL_ENTITY_TABLE_NAMES,
  'triage_sessions',
  'memory_entries',
  'triage_context_scopes',
  'telemetry_usage_events',
  'telemetry_daily_rollups',
  'telemetry_session_watermarks',
] as const

export type EntityTableName = (typeof ENTITY_TABLE_NAMES)[number]
