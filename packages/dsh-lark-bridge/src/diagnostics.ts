import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LarkBotStatus,
  LarkSdkErrorRecord,
  TransportDiagnosticsSnapshot,
} from '@dsh-lark/lark-core'
import type { InstanceLockStatus } from './instance-lock.js'
import type { SplitBrainAlert } from './split-brain-detector.js'
import {
  BridgeDatabase,
  CONFIG_SNAPSHOT_FILENAME,
  DB_FILENAME,
  LEGACY_STATE_FILENAME,
  type IntegrityCheckResult,
  type StorageStats,
} from './storage/database.js'
import { inspectInstanceLockFile, type ActiveLockSummary } from './storage/db-cli.js'
import type { MigrationVerificationReport } from './storage/legacy-migrator.js'
import type { LarkBridgeStore } from './store.js'
import type { LarkDiagnosticAlert } from './types.js'

export interface BotDiagnosticItem {
  readonly botId: string
  readonly name: string
  readonly larkAppId: string
  readonly enabled: boolean
  readonly connected: boolean
  readonly botOpenId?: string
  readonly lastEventAtMs?: number
  readonly lastError?: string
  readonly ackP50Ms: number
  readonly ackP95Ms: number
  readonly ackSamples: number
  readonly sdkErrors: readonly LarkSdkErrorRecord[]
  readonly splitBrain?: SplitBrainAlert
}

export interface BridgeDiagnosticsPayload {
  readonly ok: boolean
  readonly generatedAtMs: number
  readonly runtime: {
    readonly nodeVersion: string
    readonly platform: NodeJS.Platform
    readonly pid: number
    readonly uptimeSec: number
    readonly sqliteSupported: boolean
  }
  readonly storage: {
    readonly backend: 'sqlite_wal'
    readonly integrity: IntegrityCheckResult
    readonly stats: StorageStats
    readonly lastMigrationReport?: MigrationVerificationReport
  }
  readonly instanceLock: InstanceLockStatus
  readonly bots: readonly BotDiagnosticItem[]
  readonly splitBrainAlerts: readonly SplitBrainAlert[]
  readonly alerts: readonly LarkDiagnosticAlert[]
}

export interface OfflineDoctorReport {
  readonly ok: boolean
  readonly dataDir: string
  readonly runtime: {
    readonly nodeVersion: string
    readonly nodeVersionSupported: boolean
    readonly sqliteAvailable: boolean
  }
  readonly storage: {
    readonly backend: 'sqlite_wal' | 'legacy_json' | 'uninitialized'
    readonly hasDb: boolean
    readonly hasLegacyJson: boolean
    readonly hasConfigSnapshot: boolean
    readonly integrity?: IntegrityCheckResult
    readonly stats?: StorageStats
    readonly lastMigrationReport?: MigrationVerificationReport
  }
  readonly instanceLock: ActiveLockSummary
  readonly issues: readonly string[]
}

export function isNodeVersionSqliteReady(version = process.version): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 22 || (major === 22 && minor >= 13)
}

export function buildDiagnosticAlerts(input: {
  readonly integrity: IntegrityCheckResult
  readonly splitBrainAlerts: readonly SplitBrainAlert[]
  readonly botStatuses: readonly LarkBotStatus[]
  readonly recoveredStaleLock?: { readonly pid: number; readonly host: string }
}): LarkDiagnosticAlert[] {
  const alerts: LarkDiagnosticAlert[] = []

  for (const sb of input.splitBrainAlerts) {
    alerts.push({
      id: `split-brain:${sb.botId}`,
      code: 'split_brain',
      severity: 'warning',
      botId: sb.botId,
      title: `检测到多实例冲突：${sb.botName}（${sb.larkAppId}）`,
      detail: `在群 ${sb.lastChatId} 观测到 ${sb.observedCount} 条由同一飞书应用发出、但非本实例发送的消息（最新 ${sb.lastMessageId}）。另一台设备或进程正同时连接此应用，可能导致事件分流与上下文分裂。`,
      suggestion: '请关闭另一台设备上的重复实例，或为不同环境分配独立的飞书测试应用；处理完成后可点击「已处理」。',
      timestampMs: sb.lastObservedAtMs,
    })
  }

  if (!input.integrity.ok || input.integrity.foreignKeyErrors > 0) {
    alerts.push({
      id: 'storage:integrity',
      code: 'storage_integrity',
      severity: 'error',
      title: 'SQLite 数据库完整性检查异常',
      detail: `integrity_check=${input.integrity.messages.join('; ')}，外键冲突数=${input.integrity.foreignKeyErrors}`,
      suggestion: '请先运行 `lark-bridge db backup` 备份当前库，再运行 `lark-bridge db verify` / `rollback` 排查修复。',
      timestampMs: Date.now(),
    })
  }

  for (const st of input.botStatuses) {
    if (st.enabled && !st.connected && st.lastError) {
      alerts.push({
        id: `bot-offline:${st.botId}`,
        code: 'bot_disconnected',
        severity: 'warning',
        botId: st.botId,
        title: `智能体「${st.name}」长连接异常`,
        detail: st.lastError,
        suggestion: '请检查网络连通性、飞书应用凭证，或点击重连；也可运行 `lark-bridge doctor` 查看详细错误码。',
        timestampMs: Date.now(),
      })
    }
  }

  if (input.recoveredStaleLock) {
    alerts.push({
      id: 'instance-lock:recovered',
      code: 'stale_lock_recovered',
      severity: 'info',
      title: '启动时已自动回收陈旧实例锁',
      detail: `已清理上次异常退出残留的锁文件（PID=${input.recoveredStaleLock.pid}, host=${input.recoveredStaleLock.host}）。`,
      suggestion: '通常由非优雅重启引起，无需额外操作。',
      timestampMs: Date.now(),
    })
  }

  return alerts
}

export function buildBridgeDiagnostics(input: {
  readonly store: LarkBridgeStore
  readonly botStatuses: readonly LarkBotStatus[]
  readonly getTransportDiagnostics: (botId: string) => TransportDiagnosticsSnapshot | undefined
  readonly splitBrainAlerts: readonly SplitBrainAlert[]
  readonly instanceLock: InstanceLockStatus
  readonly startedAtMs: number
}): BridgeDiagnosticsPayload {
  const integrity = input.store.runIntegrityCheck()
  const stats = input.store.getStorageStats()
  const lastMigrationReport = input.store.getMigrationReport()
  const splitBrainByBot = new Map(input.splitBrainAlerts.map((a) => [a.botId, a]))

  const bots: BotDiagnosticItem[] = input.botStatuses.map((st) => {
    const diag = input.getTransportDiagnostics(st.botId)
    const sb = splitBrainByBot.get(st.botId)
    return {
      botId: st.botId,
      name: st.name,
      larkAppId: st.larkAppId,
      enabled: st.enabled,
      connected: st.connected,
      ...(st.botOpenId ? { botOpenId: st.botOpenId } : {}),
      ...(st.lastEventAtMs ? { lastEventAtMs: st.lastEventAtMs } : {}),
      ...(st.lastError ? { lastError: st.lastError } : {}),
      ackP50Ms: diag?.ackP50Ms ?? 0,
      ackP95Ms: diag?.ackP95Ms ?? 0,
      ackSamples: diag?.ackSamples ?? 0,
      sdkErrors: diag?.sdkErrors ?? [],
      ...(sb ? { splitBrain: sb } : {}),
    }
  })

  const alerts = buildDiagnosticAlerts({
    integrity,
    splitBrainAlerts: input.splitBrainAlerts,
    botStatuses: input.botStatuses,
    ...(input.instanceLock.recoveredStaleLock
      ? { recoveredStaleLock: input.instanceLock.recoveredStaleLock }
      : {}),
  })

  const hasFatal = !integrity.ok || input.splitBrainAlerts.length > 0
  return {
    ok: !hasFatal,
    generatedAtMs: Date.now(),
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      pid: process.pid,
      uptimeSec: Math.max(0, Math.round((Date.now() - input.startedAtMs) / 1000)),
      sqliteSupported: isNodeVersionSqliteReady(),
    },
    storage: {
      backend: 'sqlite_wal',
      integrity,
      stats,
      ...(lastMigrationReport ? { lastMigrationReport } : {}),
    },
    instanceLock: input.instanceLock,
    bots,
    splitBrainAlerts: input.splitBrainAlerts,
    alerts,
  }
}

export function runOfflineDoctor(dataDir: string): OfflineDoctorReport {
  const issues: string[] = []
  const nodeVersionSupported = isNodeVersionSqliteReady()
  if (!nodeVersionSupported) {
    issues.push(`Node 版本过低（${process.version}），要求 >= 22.13.0`)
  }

  const dbPath = join(dataDir, DB_FILENAME)
  const legacyPath = join(dataDir, LEGACY_STATE_FILENAME)
  const snapshotPath = join(dataDir, CONFIG_SNAPSHOT_FILENAME)
  const hasDb = existsSync(dbPath)
  const hasLegacyJson = existsSync(legacyPath)
  const hasConfigSnapshot = existsSync(snapshotPath)
  const instanceLock = inspectInstanceLockFile(dataDir)

  if (instanceLock.locked && !instanceLock.alive) {
    issues.push(`发现陈旧实例锁（PID=${instanceLock.pid ?? 'unknown'} 未存活），重启服务将自动回收`)
  }

  let integrity: IntegrityCheckResult | undefined
  let stats: StorageStats | undefined
  let lastMigrationReport: MigrationVerificationReport | undefined

  if (hasDb) {
    try {
      const db = new BridgeDatabase(dbPath, { readOnly: true })
      try {
        integrity = db.integrityCheck()
        stats = db.getStats()
        const rawReport = db.getMeta('migration_report_json')
        if (rawReport) {
          try {
            lastMigrationReport = JSON.parse(rawReport) as MigrationVerificationReport
          } catch {
            // Ignore malformed report.
          }
        }
        if (!integrity.ok) {
          issues.push(`SQLite 完整性校验失败：${integrity.messages.join('; ')}`)
        }
        if (stats.walBytes > 32 * 1024 * 1024) {
          issues.push(`WAL 文件体积较大（${Math.round(stats.walBytes / 1024 / 1024)} MB），建议在低峰期运行 lark-bridge db compact`)
        }
      } finally {
        db.close({ checkpoint: false })
      }
    } catch (err) {
      issues.push(`无法打开 SQLite 数据库：${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (hasLegacyJson) {
    issues.push('当前仍为旧版 JSON 状态文件，首次启动或运行 `lark-bridge db migrate` 将自动迁移至 SQLite')
  }

  return {
    ok: issues.length === 0,
    dataDir,
    runtime: {
      nodeVersion: process.version,
      nodeVersionSupported,
      sqliteAvailable: nodeVersionSupported,
    },
    storage: {
      backend: hasDb ? 'sqlite_wal' : hasLegacyJson ? 'legacy_json' : 'uninitialized',
      hasDb,
      hasLegacyJson,
      hasConfigSnapshot,
      ...(integrity ? { integrity } : {}),
      ...(stats ? { stats } : {}),
      ...(lastMigrationReport ? { lastMigrationReport } : {}),
    },
    instanceLock,
    issues,
  }
}
