import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  BridgeDatabase,
  CONFIG_SNAPSHOT_FILENAME,
  DB_FILENAME,
  LEGACY_STATE_FILENAME,
  tightenFileMode,
} from './database.js'
import {
  exportDbToV3Json,
  migrateLegacyJsonToSqlite,
  rollbackDbFromJson,
  verifyDbAgainstJson,
  type MigrationVerificationReport,
} from './legacy-migrator.js'
import { RuntimeRepo } from './runtime-repo.js'

const LOCK_FILENAME = 'bridge.lock'

export interface ActiveLockSummary {
  readonly locked: boolean
  readonly alive: boolean
  readonly pid?: number
  readonly host?: string
  readonly startedAtMs?: number
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as { code?: string })?.code
    return code === 'EPERM'
  }
}

export function inspectInstanceLockFile(dataDir: string): ActiveLockSummary {
  const lockPath = join(dataDir, LOCK_FILENAME)
  if (!existsSync(lockPath)) return { locked: false, alive: false }
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: unknown
      host?: unknown
      startedAtMs?: unknown
    }
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined
    const alive = pid !== undefined ? isPidAlive(pid) : false
    return {
      locked: true,
      alive,
      ...(pid !== undefined ? { pid } : {}),
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
      ...(typeof parsed.startedAtMs === 'number' ? { startedAtMs: parsed.startedAtMs } : {}),
    }
  } catch {
    return { locked: true, alive: false }
  }
}

export { runOfflineDoctor, type OfflineDoctorReport } from '../diagnostics.js'
export { resolveDataDir }

function resolveDataDir(rawFlag?: string): string {
  if (rawFlag && rawFlag.trim()) return resolve(rawFlag.trim())
  const endpointFile = process.env.LARK_BRIDGE_ENDPOINT_FILE?.trim()
  if (endpointFile) return dirname(resolve(endpointFile))
  const dshHome = process.env.DSH_HOME?.trim()
  if (dshHome) return join(resolve(dshHome), 'lark-bridge')
  return join(homedir(), '.dsh', 'lark-bridge')
}

function assertNotLiveLocked(dataDir: string, force: boolean, action: string): void {
  if (force) return
  const lock = inspectInstanceLockFile(dataDir)
  if (lock.locked && lock.alive) {
    throw new Error(
      `检测到 dsh-lark-bridge 实例正在运行（PID=${lock.pid}），为避免并发写入冲突，已拒绝执行 \`db ${action}\`。请先停止服务后再重试，或确认无写入风险后传入 --force。`,
    )
  }
}

export interface DbCliResult {
  readonly ok: boolean
  readonly [key: string]: unknown
}

export function runDbCliCommand(
  subCommand: string,
  flags: Record<string, string | boolean | string[]>,
): DbCliResult {
  const dataDir = resolveDataDir(typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined)
  const dbPath = join(dataDir, DB_FILENAME)
  const legacyPath = join(dataDir, LEGACY_STATE_FILENAME)
  const snapshotPath = join(dataDir, CONFIG_SNAPSHOT_FILENAME)
  const force = Boolean(flags.force)

  if (subCommand === 'status') {
    const lock = inspectInstanceLockFile(dataDir)
    const hasDb = existsSync(dbPath)
    const hasLegacy = existsSync(legacyPath)
    const hasConfigSnapshot = existsSync(snapshotPath)
    if (!hasDb) {
      return {
        ok: true,
        dataDir,
        backend: hasLegacy ? 'legacy_json' : 'uninitialized',
        hasDb,
        hasLegacyJson: hasLegacy,
        hasConfigSnapshot,
        instanceLock: lock,
      }
    }
    const db = new BridgeDatabase(dbPath, { readOnly: true })
    try {
      const stats = db.getStats()
      const migrations = db.listAppliedMigrations()
      const rawReport = db.getMeta('migration_report_json')
      let lastMigrationReport: MigrationVerificationReport | undefined
      if (rawReport) {
        try {
          lastMigrationReport = JSON.parse(rawReport) as MigrationVerificationReport
        } catch {
          // Ignore.
        }
      }
      return {
        ok: true,
        dataDir,
        backend: 'sqlite_wal',
        hasDb,
        hasLegacyJson: hasLegacy,
        hasConfigSnapshot,
        instanceLock: lock,
        stats,
        migrations,
        ...(lastMigrationReport ? { lastMigrationReport } : {}),
      }
    } finally {
      db.close({ checkpoint: false })
    }
  }

  if (subCommand === 'migrate') {
    const dryRun = Boolean(flags['dry-run'])
    const fromPath = typeof flags.from === 'string' ? resolve(flags.from) : legacyPath
    if (!dryRun) {
      assertNotLiveLocked(dataDir, force, 'migrate')
    }
    if (!existsSync(fromPath)) {
      throw new Error(`未找到待迁移的 JSON 状态文件：${fromPath}`)
    }
    if (existsSync(dbPath) && !dryRun && !force) {
      return {
        ok: true,
        skipped: true,
        reason: 'sqlite_db_already_exists',
        dbPath,
        hint: '目标 SQLite 数据库已存在；如需强制覆盖重建请先备份并追加 --force。',
      }
    }
    const report = migrateLegacyJsonToSqlite(dataDir, {
      legacyPath: fromPath,
      archiveLegacy: fromPath === legacyPath,
      dryRun,
      force,
    })
    return {
      ok: Boolean(report?.ok),
      dryRun,
      dataDir,
      dbPath,
      report,
    }
  }

  if (subCommand === 'verify') {
    if (!existsSync(dbPath)) {
      throw new Error(`未找到 SQLite 数据库：${dbPath}`)
    }
    const againstPath = typeof flags.against === 'string' ? resolve(flags.against) : undefined
    const db = new BridgeDatabase(dbPath, { readOnly: true })
    try {
      const report = verifyDbAgainstJson(db, againstPath)
      return {
        ok: report.ok,
        dbPath,
        ...(againstPath ? { againstPath } : {}),
        report,
      }
    } finally {
      db.close({ checkpoint: false })
    }
  }

  if (subCommand === 'backup') {
    if (!existsSync(dbPath)) {
      throw new Error(`未找到 SQLite 数据库：${dbPath}`)
    }
    const outPath =
      typeof flags.out === 'string' && flags.out.trim()
        ? resolve(flags.out.trim())
        : join(dataDir, 'backups', `lark-bridge.backup-${Date.now()}.db`)
    const db = new BridgeDatabase(dbPath, { readOnly: true })
    try {
      db.backupTo(outPath)
    } finally {
      db.close({ checkpoint: false })
    }
    const checkDb = new BridgeDatabase(outPath, { readOnly: true })
    try {
      const integrity = checkDb.integrityCheck()
      const stats = checkDb.getStats()
      return {
        ok: integrity.ok,
        sourcePath: dbPath,
        backupPath: outPath,
        integrity,
        stats,
      }
    } finally {
      checkDb.close({ checkpoint: false })
    }
  }

  if (subCommand === 'export') {
    if (!existsSync(dbPath)) {
      throw new Error(`未找到 SQLite 数据库：${dbPath}`)
    }
    const redact = Boolean(flags.redact)
    const db = new BridgeDatabase(dbPath, { readOnly: true })
    let exported: ReturnType<typeof exportDbToV3Json>
    try {
      exported = exportDbToV3Json(db, dataDir, { redact })
    } finally {
      db.close({ checkpoint: false })
    }
    if (typeof flags.out === 'string' && flags.out.trim()) {
      const outPath = resolve(flags.out.trim())
      mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 })
      const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, `${JSON.stringify(exported, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(tmp, outPath)
      tightenFileMode(outPath, 0o600)
      return {
        ok: true,
        outPath,
        redacted: redact,
        counts: {
          bots: exported.bots.length,
          groups: exported.groups.length,
          bindings: exported.bindings.length,
          reminders: exported.reminders?.length ?? 0,
          auditEvents: exported.auditEvents.length,
        },
      }
    }
    return {
      ok: true,
      redacted: redact,
      data: exported,
    }
  }

  if (subCommand === 'rollback') {
    assertNotLiveLocked(dataDir, force, 'rollback')
    const fromPath = typeof flags.from === 'string' ? resolve(flags.from) : ''
    if (!fromPath) {
      throw new Error('用法：lark-bridge db rollback --from <backup.json> [--to-json] [--data-dir <dir>]')
    }
    const result = rollbackDbFromJson(dataDir, fromPath, {
      toJsonOnly: Boolean(flags['to-json']),
    })
    return {
      ok: true,
      dataDir,
      ...result,
    }
  }

  if (subCommand === 'compact') {
    assertNotLiveLocked(dataDir, force, 'compact')
    if (!existsSync(dbPath)) {
      throw new Error(`未找到 SQLite 数据库：${dbPath}`)
    }
    const db = new BridgeDatabase(dbPath)
    try {
      const runtime = new RuntimeRepo(db)
      const prunedSeenMessages = runtime.pruneSeenMessages(Date.now())
      const compacted = db.compact()
      const integrity = db.integrityCheck()
      return {
        ok: integrity.ok,
        dbPath,
        prunedSeenMessages,
        beforeBytes: compacted.beforeBytes,
        afterBytes: compacted.afterBytes,
        integrity,
      }
    } finally {
      db.close({ checkpoint: true })
    }
  }

  throw new Error(
    `未知的 db 子命令 "${subCommand}"（支持 status | migrate | verify | backup | export | rollback | compact）`,
  )
}
