import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  ALL_MIGRATIONS,
  ENTITY_TABLE_NAMES,
  type EntityTableName,
  type SqlMigration,
} from './migrations/index.js'

export const DB_FILENAME = 'lark-bridge.db'
export const LEGACY_STATE_FILENAME = 'lark-bridge-state.json'
export const CONFIG_SNAPSHOT_FILENAME = 'config.snapshot.json'

export interface AppliedMigrationRecord {
  readonly version: number
  readonly name: string
  readonly checksum: string
  readonly appliedAtMs: number
}

export interface IntegrityCheckResult {
  readonly ok: boolean
  readonly messages: readonly string[]
  readonly foreignKeyErrors: number
}

export interface StorageStats {
  readonly dbPath: string
  readonly schemaVersion: number
  readonly dbBytes: number
  readonly walBytes: number
  readonly shmBytes: number
  readonly journalMode: string
  readonly pageCount: number
  readonly pageSize: number
  readonly tableCounts: Record<EntityTableName, number>
}

export interface BridgeDatabaseOptions {
  readonly readOnly?: boolean
  readonly migrations?: readonly SqlMigration[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function safeFileSize(filePath: string): number {
  try {
    return existsSync(filePath) ? statSync(filePath).size : 0
  } catch {
    return 0
  }
}

export function tightenFileMode(filePath: string, mode = 0o600): void {
  if (process.platform === 'win32') return
  if (!existsSync(filePath)) return
  try {
    chmodSync(filePath, mode)
  } catch {
    // Best-effort on filesystems without POSIX permissions.
  }
}

export function assertNodeSqliteSupported(): void {
  if (typeof DatabaseSync !== 'function') {
    throw new Error(
      `node:sqlite (DatabaseSync) is unavailable on Node ${process.version}. ` +
        'dsh-lark-bridge requires Node.js >= 22.13.0 or Electron with built-in node:sqlite.',
    )
  }
}

export class BridgeDatabase {
  readonly dbPath: string
  readonly readOnly: boolean
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private savepointSeq = 0
  private closed = false

  constructor(dbPath: string, options: BridgeDatabaseOptions = {}) {
    assertNodeSqliteSupported()
    this.dbPath = dbPath
    this.readOnly = Boolean(options.readOnly)

    if (!this.readOnly && dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    }

    this.db = new DatabaseSync(dbPath, {
      readOnly: this.readOnly,
      enableForeignKeyConstraints: true,
    })

    this.configurePragmas()
    if (!this.readOnly) {
      this.applyPendingMigrations(options.migrations ?? ALL_MIGRATIONS)
      this.tightenPermissions()
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.db.isOpen
  }

  prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.statements.set(sql, stmt)
    }
    return stmt
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      const sp = `sp_${++this.savepointSeq}`
      this.db.exec(`SAVEPOINT ${sp}`)
      try {
        const result = fn()
        this.db.exec(`RELEASE SAVEPOINT ${sp}`)
        return result
      } catch (err) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`)
        } catch {
          // Ignore rollback cleanup failure if connection closed.
        }
        throw err
      }
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Ignore rollback failure if SQLite already auto-rolled back.
      }
      throw err
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.prepare('SELECT value FROM kv_meta WHERE key = ?').get(key) as
      | { value?: unknown }
      | undefined
    return typeof row?.value === 'string' ? row.value : undefined
  }

  setMeta(key: string, value: string, nowMs = Date.now()): void {
    this.prepare(
      `INSERT INTO kv_meta (key, value, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    ).run(key, value, nowMs)
  }

  deleteMeta(key: string): void {
    this.prepare('DELETE FROM kv_meta WHERE key = ?').run(key)
  }

  listAppliedMigrations(): AppliedMigrationRecord[] {
    const rows = this.prepare(
      'SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version ASC',
    ).all() as Array<{
      version: number
      name: string
      checksum: string
      applied_at_ms: number
    }>
    return rows.map((r) => ({
      version: Number(r.version),
      name: String(r.name),
      checksum: String(r.checksum),
      appliedAtMs: Number(r.applied_at_ms),
    }))
  }

  integrityCheck(): IntegrityCheckResult {
    const rows = this.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
    const messages = rows
      .map((r) => String(Object.values(r)[0] ?? ''))
      .filter(Boolean)
    const fkRows = this.prepare('PRAGMA foreign_key_check').all()
    const ok = messages.length === 1 && messages[0] === 'ok' && fkRows.length === 0
    return {
      ok,
      messages,
      foreignKeyErrors: fkRows.length,
    }
  }

  /**
   * Produces a standalone, WAL-free, consistent SQLite snapshot using atomic temp file + rename.
   * Safe to run while WAL readers/writers are active.
   */
  backupTo(destPath: string): void {
    mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 })
    const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`
    rmSync(tmpPath, { force: true })
    try {
      this.db.prepare('VACUUM INTO ?').run(tmpPath)
      tightenFileMode(tmpPath, 0o600)
      renameSync(tmpPath, destPath)
      tightenFileMode(destPath, 0o600)
    } catch (err) {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }

  compact(): { readonly beforeBytes: number; readonly afterBytes: number } {
    const beforeBytes = safeFileSize(this.dbPath) + safeFileSize(`${this.dbPath}-wal`)
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.tightenPermissions()
    const afterBytes = safeFileSize(this.dbPath) + safeFileSize(`${this.dbPath}-wal`)
    return { beforeBytes, afterBytes }
  }

  getStats(): StorageStats {
    const tableCounts = {} as Record<EntityTableName, number>
    for (const table of ENTITY_TABLE_NAMES) {
      const row = this.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt?: number }
      tableCounts[table] = Number(row?.cnt ?? 0)
    }
    const migrations = this.listAppliedMigrations()
    const schemaVersion = migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0
    const modeRow = this.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined
    const pageCountRow = this.prepare('PRAGMA page_count').get() as Record<string, unknown> | undefined
    const pageSizeRow = this.prepare('PRAGMA page_size').get() as Record<string, unknown> | undefined
    return {
      dbPath: this.dbPath,
      schemaVersion,
      dbBytes: safeFileSize(this.dbPath),
      walBytes: safeFileSize(`${this.dbPath}-wal`),
      shmBytes: safeFileSize(`${this.dbPath}-shm`),
      journalMode: String(Object.values(modeRow ?? {})[0] ?? 'unknown'),
      pageCount: Number(Object.values(pageCountRow ?? {})[0] ?? 0),
      pageSize: Number(Object.values(pageSizeRow ?? {})[0] ?? 0),
      tableCounts,
    }
  }

  tightenPermissions(): void {
    if (this.dbPath === ':memory:') return
    tightenFileMode(this.dbPath, 0o600)
    tightenFileMode(`${this.dbPath}-wal`, 0o600)
    tightenFileMode(`${this.dbPath}-shm`, 0o600)
  }

  close(options: { readonly checkpoint?: boolean } = {}): void {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    if (!this.db.isOpen) return
    if (!this.readOnly && options.checkpoint !== false && this.dbPath !== ':memory:') {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // Best-effort checkpoint if another reader holds a lock.
      }
    }
    try {
      this.db.close()
    } catch {
      // Idempotent close.
    }
  }

  private configurePragmas(): void {
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA temp_store = MEMORY')
    if (!this.readOnly && this.dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec('PRAGMA wal_autocheckpoint = 1000')
    }
  }

  private applyPendingMigrations(migrations: readonly SqlMigration[]): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version       INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        checksum      TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      ) STRICT;
    `)
    const applied = new Map<number, string>()
    const rows = this.db
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all() as Array<{ version: number; checksum: string }>
    for (const row of rows) {
      applied.set(Number(row.version), String(row.checksum))
    }

    const sorted = [...migrations].sort((a, b) => a.version - b.version)
    for (const mig of sorted) {
      if (applied.has(mig.version)) continue
      const checksum = sha256(mig.sql)
      this.transaction(() => {
        // Re-check inside BEGIN IMMEDIATE write lock so concurrent openers never re-run a migration.
        const already = this.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(
          mig.version,
        )
        if (already) return
        this.db.exec(mig.sql)
        this.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)',
        ).run(mig.version, mig.name, checksum, Date.now())
      })
    }
  }
}
