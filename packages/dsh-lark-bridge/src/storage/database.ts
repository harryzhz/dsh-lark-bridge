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

export interface DatabaseQueryStat {
  readonly fingerprint: string
  readonly count: number
  readonly avgMs: number
  readonly maxMs: number
  readonly lastAtMs: number
}

export interface DatabasePerfSnapshot {
  readonly totalQueries: number
  readonly sampleCount: number
  readonly avgMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly slowThresholdMs: number
  readonly slowQueryCount: number
  readonly integrityCheckMs: number
  readonly integrityCheckedAtMs?: number
  readonly lastCheckpointMs?: number
  readonly lastCheckpointAtMs?: number
  readonly slowQueries: readonly DatabaseQueryStat[]
}

const QUERY_PERF_RING_SIZE = 512
const QUERY_SLOW_THRESHOLD_MS = 100
const INTEGRITY_CHECK_CACHE_TTL_MS = 5 * 60_000
const MAX_FINGERPRINT_ENTRIES = 64

function fingerprintSql(sql: string): string {
  const clean = sql.replace(/\s+/g, ' ').trim()
  const pragma = /^PRAGMA\s+([a-z0-9_]+)/i.exec(clean)
  if (pragma) return `PRAGMA ${pragma[1]!.toLowerCase()}`
  const select = /^SELECT\b[\s\S]*?\bFROM\s+["`]?([a-z0-9_]+)["`]?/i.exec(clean)
  if (select) return `SELECT ${select[1]}`
  const insert = /^INSERT\b[\s\S]*?\bINTO\s+["`]?([a-z0-9_]+)["`]?/i.exec(clean)
  if (insert) return `INSERT ${insert[1]}`
  const update = /^UPDATE\s+["`]?([a-z0-9_]+)["`]?/i.exec(clean)
  if (update) return `UPDATE ${update[1]}`
  const del = /^DELETE\s+FROM\s+["`]?([a-z0-9_]+)["`]?/i.exec(clean)
  if (del) return `DELETE ${del[1]}`
  return clean.split(' ').slice(0, 2).join(' ').toUpperCase() || 'SQL'
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
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

export type WalCheckpointMode = 'PASSIVE' | 'TRUNCATE'

export interface WalCheckpointResult {
  readonly mode: WalCheckpointMode
  readonly busy: number
  readonly log: number
  readonly checkpointed: number
  readonly beforeWalBytes: number
  readonly afterWalBytes: number
  readonly truncated: boolean
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

  private readonly durationRing: number[] = []
  private ringCursor = 0
  private totalQueries = 0
  private slowQueryCount = 0
  private readonly queryStats = new Map<
    string,
    { count: number; totalMs: number; maxMs: number; lastAtMs: number }
  >()
  private integrityCache: {
    readonly result: IntegrityCheckResult
    readonly checkedAtMs: number
    readonly durationMs: number
  } | null = null
  private lastCheckpointMs?: number
  private lastCheckpointAtMs?: number

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
      const raw = this.db.prepare(sql)
      const fp = fingerprintSql(sql)
      const record = (ms: number) => this.recordQueryTiming(fp, ms)
      stmt = new Proxy(raw, {
        get(target, prop, receiver) {
          const val = Reflect.get(target, prop, target)
          if (
            (prop === 'get' || prop === 'all' || prop === 'run') &&
            typeof val === 'function'
          ) {
            return (...args: unknown[]) => {
              const t0 = performance.now()
              try {
                return (val as (...a: unknown[]) => unknown).apply(target, args)
              } finally {
                record(performance.now() - t0)
              }
            }
          }
          return typeof val === 'function' ? val.bind(target) : Reflect.get(target, prop, receiver)
        },
      })
      this.statements.set(sql, stmt)
    }
    return stmt
  }

  private recordQueryTiming(fingerprint: string, durationMs: number): void {
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0
    this.totalQueries += 1
    if (this.durationRing.length < QUERY_PERF_RING_SIZE) {
      this.durationRing.push(ms)
    } else {
      this.durationRing[this.ringCursor] = ms
      this.ringCursor = (this.ringCursor + 1) % QUERY_PERF_RING_SIZE
    }
    if (ms >= QUERY_SLOW_THRESHOLD_MS) {
      this.slowQueryCount += 1
    }
    const existing = this.queryStats.get(fingerprint)
    const now = Date.now()
    if (existing) {
      existing.count += 1
      existing.totalMs += ms
      if (ms > existing.maxMs) existing.maxMs = ms
      existing.lastAtMs = now
    } else if (this.queryStats.size < MAX_FINGERPRINT_ENTRIES) {
      this.queryStats.set(fingerprint, { count: 1, totalMs: ms, maxMs: ms, lastAtMs: now })
    }
  }

  getPerfSnapshot(): DatabasePerfSnapshot {
    const sampleCount = this.durationRing.length
    let avgMs = 0
    let p50Ms = 0
    let p95Ms = 0
    let maxMs = 0
    if (sampleCount > 0) {
      const sorted = [...this.durationRing].sort((a, b) => a - b)
      const pick = (q: number) =>
        sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1))] ?? 0
      const sum = sorted.reduce((acc, v) => acc + v, 0)
      avgMs = roundMs(sum / sampleCount)
      p50Ms = roundMs(pick(0.5))
      p95Ms = roundMs(pick(0.95))
      maxMs = roundMs(sorted[sorted.length - 1] ?? 0)
    }
    const slowQueries: DatabaseQueryStat[] = [...this.queryStats.entries()]
      .map(([fingerprint, s]) => ({
        fingerprint,
        count: s.count,
        avgMs: roundMs(s.totalMs / Math.max(1, s.count)),
        maxMs: roundMs(s.maxMs),
        lastAtMs: s.lastAtMs,
      }))
      .sort((a, b) => b.maxMs - a.maxMs || b.avgMs - a.avgMs)
      .slice(0, 8)
    return {
      totalQueries: this.totalQueries,
      sampleCount,
      avgMs,
      p50Ms,
      p95Ms,
      maxMs,
      slowThresholdMs: QUERY_SLOW_THRESHOLD_MS,
      slowQueryCount: this.slowQueryCount,
      integrityCheckMs: this.integrityCache ? roundMs(this.integrityCache.durationMs) : 0,
      ...(this.integrityCache ? { integrityCheckedAtMs: this.integrityCache.checkedAtMs } : {}),
      ...(this.lastCheckpointMs !== undefined ? { lastCheckpointMs: roundMs(this.lastCheckpointMs) } : {}),
      ...(this.lastCheckpointAtMs !== undefined ? { lastCheckpointAtMs: this.lastCheckpointAtMs } : {}),
      slowQueries,
    }
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

  integrityCheck(
    options: { readonly force?: boolean; readonly maxAgeMs?: number } = {},
  ): IntegrityCheckResult {
    const now = Date.now()
    const maxAgeMs = options.maxAgeMs ?? INTEGRITY_CHECK_CACHE_TTL_MS
    if (
      !options.force &&
      this.integrityCache &&
      now - this.integrityCache.checkedAtMs < maxAgeMs
    ) {
      return this.integrityCache.result
    }
    const t0 = performance.now()
    const rows = this.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
    const messages = rows
      .map((r) => String(Object.values(r)[0] ?? ''))
      .filter(Boolean)
    const fkRows = this.prepare('PRAGMA foreign_key_check').all()
    const ok = messages.length === 1 && messages[0] === 'ok' && fkRows.length === 0
    const result: IntegrityCheckResult = {
      ok,
      messages,
      foreignKeyErrors: fkRows.length,
    }
    this.integrityCache = {
      result,
      checkedAtMs: now,
      durationMs: performance.now() - t0,
    }
    return result
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
    this.integrityCache = null
    this.tightenPermissions()
    const afterBytes = safeFileSize(this.dbPath) + safeFileSize(`${this.dbPath}-wal`)
    return { beforeBytes, afterBytes }
  }

  /**
   * Flushes WAL frames into the main database file without blocking active readers/writers.
   * When `truncateAboveBytes` is supplied and a PASSIVE checkpoint cleanly drains all WAL frames
   * while the WAL file exceeds that threshold, attempts a zero-wait TRUNCATE to reclaim disk space.
   */
  checkpointWal(
    options: {
      readonly mode?: WalCheckpointMode
      readonly truncateAboveBytes?: number
    } = {},
  ): WalCheckpointResult {
    const mode: WalCheckpointMode = options.mode === 'TRUNCATE' ? 'TRUNCATE' : 'PASSIVE'
    if (this.readOnly || this.closed || !this.db.isOpen || this.dbPath === ':memory:') {
      return {
        mode,
        busy: 0,
        log: 0,
        checkpointed: 0,
        beforeWalBytes: 0,
        afterWalBytes: 0,
        truncated: false,
      }
    }
    const walPath = `${this.dbPath}-wal`
    const beforeWalBytes = safeFileSize(walPath)
    const t0 = performance.now()
    const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined
    let busy = Number(row?.busy ?? 0)
    let log = Number(row?.log ?? 0)
    let checkpointed = Number(row?.checkpointed ?? 0)
    let truncated = mode === 'TRUNCATE' && busy === 0

    if (
      mode === 'PASSIVE' &&
      busy === 0 &&
      checkpointed === log &&
      typeof options.truncateAboveBytes === 'number' &&
      options.truncateAboveBytes >= 0 &&
      safeFileSize(walPath) > options.truncateAboveBytes
    ) {
      try {
        this.db.exec('PRAGMA busy_timeout = 0')
        const truncRow = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
          | { busy?: number; log?: number; checkpointed?: number }
          | undefined
        const truncBusy = Number(truncRow?.busy ?? 0)
        if (truncBusy === 0) {
          truncated = true
        }
      } catch {
        // Ignore transient lock contention; PASSIVE checkpoint already completed safely.
      } finally {
        try {
          this.db.exec('PRAGMA busy_timeout = 5000')
        } catch {
          // Ignore if DB was closed concurrently.
        }
      }
    }

    const afterWalBytes = safeFileSize(walPath)
    this.lastCheckpointMs = performance.now() - t0
    this.lastCheckpointAtMs = Date.now()
    if (mode === 'TRUNCATE' && truncated) {
      this.integrityCache = null
    }
    if (afterWalBytes !== beforeWalBytes) {
      this.tightenPermissions()
    }
    return {
      mode,
      busy,
      log,
      checkpointed,
      beforeWalBytes,
      afterWalBytes,
      truncated,
    }
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
      this.db.exec('PRAGMA journal_size_limit = 4194304')
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
