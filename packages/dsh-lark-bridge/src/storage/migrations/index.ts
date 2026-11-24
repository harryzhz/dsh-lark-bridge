import {
  ENTITY_TABLE_NAMES as INITIAL_ENTITY_TABLE_NAMES,
  INITIAL_MIGRATION,
  type SqlMigration,
} from './001-initial.js'
import { TRIAGE_SESSIONS_MIGRATION } from './002-triage-sessions.js'

export type { SqlMigration }
export { INITIAL_MIGRATION, TRIAGE_SESSIONS_MIGRATION }

export const ALL_MIGRATIONS: readonly SqlMigration[] = [
  INITIAL_MIGRATION,
  TRIAGE_SESSIONS_MIGRATION,
]

export const ENTITY_TABLE_NAMES = [
  ...INITIAL_ENTITY_TABLE_NAMES,
  'triage_sessions',
] as const

export type EntityTableName = (typeof ENTITY_TABLE_NAMES)[number]
