import { existsSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { LarkBotStatus, TransportDiagnosticsSnapshot } from '@dsh-lark/lark-core'
import { assessWalBloat } from './diagnostics.js'
import type {
  ObservabilityBotRow,
  ObservabilityPayload,
  ObservabilityWindow,
  ProcessVitalPoint,
  StorageCategoryEntry,
  TelemetryUsageEventInput,
} from './observability-types.js'
import type { SplitBrainAlert } from './split-brain-detector.js'
import {
  calcDeltaPct,
  calcPercentiles,
  P2P_CHAT_FILTER_VALUE,
} from './storage/observability-repo.js'
import type { LarkBridgeStore } from './store.js'
import {
  LARK_ORIGIN_RECORD_TYPE,
  type BridgeLifecycleStatus,
  type LarkDiagnosticAlert,
  type LarkOriginRecord,
} from './types.js'

const STORAGE_SCAN_CACHE_TTL_MS = 60_000
const STORAGE_MAX_DEPTH = 6
const STORAGE_MAX_ENTRIES_PER_ROOT = 12_000
const VITALS_SAMPLE_INTERVAL_MS = 60_000
const VITALS_MAX_POINTS = 60
const MAX_MODEL_CACHE_SESSIONS = 1000
const MAX_BACKFILL_SESSIONS = 400
const MAX_EVENTS_PER_BACKFILL_SESSION = 1500
const READ_EVENTS_PAGE_SIZE = 300
const BACKFILL_YIELD_BATCH = 10

interface SessionAttribution {
  readonly botId: string
  readonly chatId: string
  readonly chatType: 'group' | 'p2p' | 'internal' | ''
  readonly trigger: string
  readonly agentPreset: string
  readonly model?: string
}

interface SessionModelState {
  provider: string
  model: string
}

interface StorageScanSnapshot {
  readonly scannedAtMs: number
  readonly totalBytes: number
  readonly bridgeBytes: number
  readonly dshBytes: number
  readonly categories: readonly StorageCategoryEntry[]
}

export interface ObservabilityServiceHost {
  readonly ctx: Context
  readonly dataDir: string
  readonly store: LarkBridgeStore
  readonly startedAtMs: number
  readonly enableBackgroundTimers?: boolean
  readonly listBotStatuses: () => readonly LarkBotStatus[]
  readonly getTransportDiagnostics: (botId: string) => TransportDiagnosticsSnapshot | undefined
  readonly listSplitBrainAlerts: () => readonly SplitBrainAlert[]
  readonly getLifecycleStatus: () => BridgeLifecycleStatus
  readonly getConcurrencyStats: () => { readonly activeActors: number; readonly queuedTurns: number }
  readonly getDiagnosticAlerts: () => readonly LarkDiagnosticAlert[]
  readonly getConfiguredScheduleCount: () => number
}

function normalizeTokenUsage(usage?: TokenUsage): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
} {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    }
  }
  const inputTokens = Math.max(0, Math.round(usage.inputTokens || 0))
  const outputTokens = Math.max(0, Math.round(usage.outputTokens || 0))
  const cacheReadTokens = Math.max(0, Math.round(usage.cacheReadTokens || 0))
  const cacheWriteTokens = Math.max(0, Math.round(usage.cacheWriteTokens || 0))
  const reasoningTokens = Math.max(0, Math.round(usage.reasoningTokens || 0))
  const disjointSum = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const reportedTotal =
    typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
      ? Math.round(usage.totalTokens)
      : 0
  const totalTokens = Math.max(disjointSum, reportedTotal)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  }
}

function inferErrorCodeFromSummary(summary: string): string {
  const s = summary.toLowerCase()
  if (/timeout|timed?\s*out|超时/.test(s)) return 'timeout'
  if (/429|rate[\s_-]?limit|限流|频控|quota/.test(s)) return 'rate_limited'
  if (/401|403|auth|权限|鉴权|token/.test(s)) return 'auth_error'
  if (/5\d\d|unavailable|overloaded|网关/.test(s)) return 'upstream_5xx'
  if (/econn|enotfound|network|socket|fetch failed|连接|网络/.test(s)) return 'network_error'
  if (/230006|撤回|recall/.test(s)) return 'message_recalled'
  if (/中断|abort|取消|停止/.test(s)) return 'turn_aborted'
  if (/分流|triage/.test(s)) return 'triage_fallback'
  return 'turn_error'
}

function formatClockLabel(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

async function measureDirectoryAsync(
  targetPath: string,
  excludeNames?: ReadonlySet<string>,
): Promise<{ readonly bytes: number; readonly fileCount: number }> {
  if (!existsSync(targetPath)) return { bytes: 0, fileCount: 0 }
  let bytes = 0
  let fileCount = 0
  let visited = 0

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > STORAGE_MAX_DEPTH || visited >= STORAGE_MAX_ENTRIES_PER_ROOT) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= STORAGE_MAX_ENTRIES_PER_ROOT) break
      if (depth === 0 && excludeNames?.has(entry.name)) continue
      visited += 1
      const fullPath = join(dir, entry.name)
      try {
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1)
        } else if (entry.isFile()) {
          const st = await lstat(fullPath)
          bytes += st.size
          fileCount += 1
        }
      } catch {
        // Ignore transient or permission-denied entries.
      }
    }
  }

  try {
    const rootStat = await stat(targetPath)
    if (rootStat.isFile()) {
      return { bytes: rootStat.size, fileCount: 1 }
    }
    if (rootStat.isDirectory()) {
      await walk(targetPath, 0)
    }
  } catch {
    return { bytes: 0, fileCount: 0 }
  }
  return { bytes, fileCount }
}

async function safeFileSizeAsync(filePath: string): Promise<number> {
  try {
    const st = await stat(filePath)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/**
 * Runtime observability collector, historical session token backfill engine,
 * process vitals monitor, and async storage telemetry projector.
 */
export class ObservabilityService {
  private readonly sessionModels = new Map<string, SessionModelState>()
  private readonly sessionAttrCache = new Map<string, SessionAttribution | null>()
  private readonly vitals: ProcessVitalPoint[] = []
  private eventLoopMonitor?: IntervalHistogram
  private vitalsTimer: ReturnType<typeof setInterval> | null = null
  private backfillTimer: ReturnType<typeof setTimeout> | null = null
  private offSessionEvent?: () => void
  private disposed = false

  private storageCache: StorageScanSnapshot | null = null
  private storageScanInFlight: Promise<StorageScanSnapshot> | null = null

  private backfillRunning = false
  private backfillCompleted = false
  private backfillScanned = 0
  private backfillTotal = 0
  private backfillLastCompletedAtMs?: number
  private backfillPromise: Promise<void> | null = null

  constructor(private readonly host: ObservabilityServiceHost) {}

  install(): () => void {
    this.disposed = false

    // 1. Live session/event collector (tokens, model headers, tool calls/errors)
    if (typeof this.host.ctx.on === 'function') {
      this.offSessionEvent = this.host.ctx.on(
        'session/event',
        (session: Session, event: SessionEvent) => {
          if (this.disposed) return
          this.handleLiveSessionEvent(session, event)
        },
        { global: true },
      )
    }

    // 2. Event loop delay & process vitals sampler
    try {
      this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 })
      this.eventLoopMonitor.enable()
    } catch {
      this.eventLoopMonitor = undefined
    }
    this.sampleVitalsNow()

    if (this.host.enableBackgroundTimers !== false) {
      this.vitalsTimer = setInterval(() => {
        if (!this.disposed) this.sampleVitalsNow()
      }, VITALS_SAMPLE_INTERVAL_MS)
      this.vitalsTimer.unref?.()

      // 3. Delayed non-blocking historical backfill (audit_events + sessionPersistence)
      this.backfillTimer = setTimeout(() => {
        if (!this.disposed) {
          void this.triggerBackfill()
        }
      }, 2_000)
      this.backfillTimer.unref?.()
    }

    return () => this.dispose()
  }

  dispose(): void {
    this.disposed = true
    if (this.offSessionEvent) {
      const fn = this.offSessionEvent
      this.offSessionEvent = undefined
      try {
        fn()
      } catch {
        // Ignore already detached listener.
      }
    }
    if (this.vitalsTimer) {
      clearInterval(this.vitalsTimer)
      this.vitalsTimer = null
    }
    if (this.backfillTimer) {
      clearTimeout(this.backfillTimer)
      this.backfillTimer = null
    }
    if (this.eventLoopMonitor) {
      try {
        this.eventLoopMonitor.disable()
      } catch {
        // Ignore.
      }
      this.eventLoopMonitor = undefined
    }
  }

  /**
   * Records a smart-triage evaluation result directly with its exact LLM TokenUsage,
   * avoiding any double-counting with background session persistence backfill.
   */
  recordTriageEvaluation(input: {
    readonly botId: string
    readonly chatId: string
    readonly chatType?: 'group' | 'p2p'
    readonly triageSessionId?: string
    readonly traceId?: string
    readonly action: 'silent' | 'quick_reply' | 'handoff'
    readonly fallback?: boolean
    readonly errorCode?: string
    readonly provider?: string
    readonly model?: string
    readonly durationMs: number
    readonly usage?: TokenUsage
    readonly timestampMs?: number
  }): void {
    const id = input.triageSessionId
      ? `triage:${input.triageSessionId}`
      : `triage_trace:${input.traceId || randomUUID()}`
    const tokens = normalizeTokenUsage(input.usage)
    const now = input.timestampMs ?? Date.now()
    this.host.store.recordUsageEvent({
      id,
      timestampMs: now,
      recordKind: 'triage',
      botId: input.botId,
      chatId: input.chatId,
      chatType: input.chatType ?? 'group',
      ...(input.triageSessionId ? { sessionId: input.triageSessionId } : {}),
      trigger: 'triage',
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      outcome: input.fallback ? 'fallback' : input.action,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      latencyMs: input.durationMs,
      ...tokens,
    })
    if (input.triageSessionId) {
      // Mark high watermark so historical persistence backfill will not double-count triage steps.
      this.host.store.observabilityRepo.setSessionWatermark(
        input.triageSessionId,
        Number.MAX_SAFE_INTEGER,
        now,
      )
    }
  }

  /** Triggers an idempotent asynchronous backfill of historical audit & session token usage. */
  triggerBackfill(): Promise<void> {
    if (this.backfillPromise) return this.backfillPromise
    this.backfillPromise = this.runBackfillInternal().finally(() => {
      this.backfillPromise = null
    })
    return this.backfillPromise
  }

  async getPayload(options: {
    readonly window?: ObservabilityWindow
    readonly botId?: string
    readonly chatId?: string
    readonly refreshStorage?: boolean
    readonly nowMs?: number
  } = {}): Promise<ObservabilityPayload> {
    const nowMs = options.nowMs ?? Date.now()
    const botId = options.botId?.trim() || ''
    const chatId = options.chatId?.trim() || ''

    // Ensure fast SQLite-only historical backfill (audit_events + triage_sessions) has run at least once.
    this.backfillSqliteTablesOnce()

    const agg = this.host.store.queryObservabilityAggregate({
      ...(options.window ? { window: options.window } : {}),
      ...(botId ? { botId } : {}),
      ...(chatId ? { chatId } : {}),
      nowMs,
    })

    const storageScan = await this.getStorageScan(Boolean(options.refreshStorage))
    const storageStats = this.host.store.getStorageStats()
    const integrity = this.host.store.runIntegrityCheck()
    const walCheck = assessWalBloat(storageStats)

    const bots = this.host.store.listBots()
    const botsById = new Map(bots.map((b) => [b.id, b]))
    const statuses = this.host.listBotStatuses()
    const statusById = new Map(statuses.map((s) => [s.botId, s]))
    const bindings = this.host.store.listBindings()
    const filteredBindings = bindings.filter((b) => {
      if (botId && b.botId !== botId) return false
      if (chatId === P2P_CHAT_FILTER_VALUE) return b.chatType === 'p2p' || b.trigger === 'p2p'
      if (chatId) return b.chatId === chatId
      return true
    })

    // Build bot rows combining live transport diagnostics + windowed telemetry
    const botIdsOrdered = new Set<string>([
      ...bots.map((b) => b.id),
      ...statuses.map((s) => s.botId),
      ...agg.botStats.keys(),
    ])
    const allBotRows: ObservabilityBotRow[] = []
    for (const id of botIdsOrdered) {
      if (botId && id !== botId) continue
      const cfg = botsById.get(id)
      const st = statusById.get(id)
      const stats = agg.botStats.get(id)
      const diag = this.host.getTransportDiagnostics(id)
      const lat = calcPercentiles(stats?.latencies ?? [])
      const replied = stats?.replied ?? 0
      const errors = stats?.errors ?? 0
      const denom = replied + errors
      const successRate = denom > 0 ? Math.round((replied / denom) * 1000) / 10 : 100
      const cacheHitRate =
        stats && stats.promptTokens > 0
          ? Math.round((stats.cacheReadTokens / stats.promptTokens) * 1000) / 10
          : 0
      const avatarUrl = st?.avatarUrl || cfg?.avatarUrl
      allBotRows.push({
        botId: id,
        name: cfg?.name ?? st?.name ?? id,
        ...(avatarUrl ? { avatarUrl } : {}),
        agentPreset: cfg?.agentPreset ?? 'codex',
        ...(cfg?.runtimeProfileId ? { runtimeProfileId: cfg.runtimeProfileId } : {}),
        ...(cfg?.model ? { model: cfg.model } : {}),
        enabled: cfg?.enabled ?? st?.enabled ?? false,
        connected: st?.connected ?? false,
        sessions: stats?.sessions ?? 0,
        activeBindings: bindings.filter((b) => b.botId === id).length,
        inbound: stats?.inbound ?? 0,
        replied,
        silentSkipped: stats?.silentSkipped ?? 0,
        errors,
        successRate,
        totalTokens: stats?.totalTokens ?? 0,
        cacheHitRate,
        avgLatencyMs: lat.avgMs,
        p95LatencyMs: lat.p95Ms,
        ackP50Ms: diag?.ackP50Ms ?? 0,
        ackP95Ms: diag?.ackP95Ms ?? 0,
        ackSamples: diag?.ackSamples ?? 0,
        sdkErrorCount: diag?.sdkErrors.length ?? 0,
        ...(st?.lastEventAtMs ? { lastEventAtMs: st.lastEventAtMs } : {}),
        ...(st?.lastError ? { lastError: st.lastError } : {}),
      })
    }
    const botRanking = [...allBotRows].sort(
      (a, b) => b.totalTokens - a.totalTokens || b.inbound - a.inbound || b.sessions - a.sessions,
    )

    // Enrich chat ranking with live activeBindings counts
    const chatRanking = agg.chatRanking.map((row) => ({
      ...row,
      activeBindings: bindings.filter((b) => b.botId === row.botId && b.chatId === row.chatId).length,
    }))

    // Product metrics
    const cur = agg.current
    const prev = agg.previous
    const promptTokens = cur.inputTokens + cur.cacheReadTokens + cur.cacheWriteTokens
    const cacheHitRate =
      promptTokens > 0 ? Math.round((cur.cacheReadTokens / promptTokens) * 1000) / 10 : 0
    const avgPerReply = cur.replied > 0 ? Math.round(cur.totalTokens / cur.replied) : 0
    const toolErrorRate =
      cur.toolCalls > 0 ? Math.round((cur.toolErrors / cur.toolCalls) * 1000) / 10 : 0
    const triageLat = calcPercentiles(cur.triageLatencies)
    const triageDeflectRate =
      cur.triageTotal > 0
        ? Math.round(((cur.triageSilent + cur.triageQuickReply) / cur.triageTotal) * 1000) / 10
        : 0

    const memoryStats = this.host.store.getMemorySummaryStats(botId || undefined)
    const reminders = this.host.store.listReminders('active').filter((r) => !botId || r.origin.botId === botId)
    const pendingConfirmReminders = reminders.filter((r) => r.status === 'pending_confirm').length

    // Technical metrics
    const curLat = calcPercentiles(cur.latencies)
    const prevLat = calcPercentiles(prev.latencies)
    const curDenom = cur.replied + cur.errors
    const prevDenom = prev.replied + prev.errors
    const curSuccessRate = curDenom > 0 ? Math.round((cur.replied / curDenom) * 1000) / 10 : 100
    const prevSuccessRate = prevDenom > 0 ? Math.round((prev.replied / prevDenom) * 1000) / 10 : 100
    const errorRate = curDenom > 0 ? Math.round((cur.errors / curDenom) * 1000) / 10 : 0
    const triageFallbackRate =
      cur.triageTotal > 0 ? Math.round((cur.triageFallback / cur.triageTotal) * 1000) / 10 : 0

    const lifecycle = this.host.getLifecycleStatus()
    const concurrency = this.host.getConcurrencyStats()
    const splitBrains = this.host.listSplitBrainAlerts()
    const enabledBots = allBotRows.filter((b) => b.enabled)
    const onlineBots = enabledBots.filter((b) => b.connected).length
    const ackP50Values = allBotRows.filter((b) => b.ackSamples > 0).map((b) => b.ackP50Ms)
    const avgAckP50Ms =
      ackP50Values.length > 0
        ? Math.round(ackP50Values.reduce((a, b) => a + b, 0) / ackP50Values.length)
        : 0
    const maxAckP95Ms = allBotRows.reduce((max, b) => Math.max(max, b.ackP95Ms), 0)
    const totalSdkErrors = allBotRows.reduce((sum, b) => sum + b.sdkErrorCount, 0)

    const mem = process.memoryUsage()
    const elMeanMs = this.readHistogramMs(this.eventLoopMonitor?.mean)
    const elP95Ms = this.readHistogramMs(this.eventLoopMonitor?.percentile(95))
    const elMaxMs = this.readHistogramMs(this.eventLoopMonitor?.max)

    const recentErrors = this.host.store
      .listEvents(120)
      .filter((e) => {
        if (e.kind !== 'error') return false
        if (e.timestampMs < agg.fromMs || e.timestampMs > agg.toMs) return false
        if (botId && e.botId !== botId) return false
        if (chatId && chatId !== P2P_CHAT_FILTER_VALUE && e.chatId !== chatId) return false
        return true
      })
      .slice(0, 12)

    const interruptedRecoveries = this.host.store
      .listEvents(200)
      .filter(
        (e) =>
          e.timestampMs >= agg.fromMs &&
          e.kind === 'lifecycle' &&
          /恢复|续跑|重连/.test(e.summary) &&
          (!botId || e.botId === botId),
      ).length

    const tables = Object.entries(storageStats.tableCounts)
      .map(([table, rows]) => ({ table, rows: Number(rows) || 0 }))
      .sort((a, b) => b.rows - a.rows)

    const activeSessionsInWindow = Math.max(cur.sessions.size, agg.createdSessionsInWindow)
    const prevSessionsInWindow = Math.max(prev.sessions.size, agg.prevCreatedSessions)

    return {
      generatedAtMs: nowMs,
      window: agg.window,
      fromMs: agg.fromMs,
      toMs: agg.toMs,
      bucketSpanMs: agg.bucketSpanMs,
      filters: {
        botId,
        chatId,
        chats: agg.chatFilterOptions,
      },
      backfill: {
        running: this.backfillRunning,
        completed: this.backfillCompleted,
        scannedSessions: this.backfillScanned,
        totalSessions: this.backfillTotal,
        ...(this.backfillLastCompletedAtMs
          ? { lastCompletedAtMs: this.backfillLastCompletedAtMs }
          : {}),
      },
      product: {
        tokens: {
          total: cur.totalTokens,
          input: cur.inputTokens,
          output: cur.outputTokens,
          cacheRead: cur.cacheReadTokens,
          cacheWrite: cur.cacheWriteTokens,
          reasoning: cur.reasoningTokens,
          cacheHitRate,
          avgPerReply,
          deltaPct: calcDeltaPct(cur.totalTokens, prev.totalTokens),
        },
        sessions: {
          activeInWindow: activeSessionsInWindow,
          createdInWindow: agg.createdSessionsInWindow,
          archivedInWindow: agg.archivedSessionsInWindow,
          liveBindings: filteredBindings.length,
          deltaPct: calcDeltaPct(activeSessionsInWindow, prevSessionsInWindow),
        },
        traffic: {
          inbound: cur.inbound,
          replied: cur.replied,
          silentSkipped: cur.silentSkipped,
          ignored: cur.ignored,
          errors: cur.errors,
          llmSteps: cur.llmSteps,
          toolCalls: cur.toolCalls,
          toolErrors: cur.toolErrors,
          toolErrorRate,
          deltaPct: calcDeltaPct(cur.inbound, prev.inbound),
        },
        triage: {
          total: cur.triageTotal,
          silent: cur.triageSilent,
          quickReply: cur.triageQuickReply,
          handoff: cur.triageHandoff,
          fallback: cur.triageFallback,
          deflectRate: triageDeflectRate,
          avgLatencyMs: triageLat.avgMs,
          p95LatencyMs: triageLat.p95Ms,
          totalTokens: cur.triageTokens,
        },
        proactive: {
          scheduleRuns: cur.scheduleRuns,
          reminderRuns: cur.reminderRuns,
          dreamRuns: cur.dreamRuns,
          activeReminders: reminders.length,
          pendingConfirmReminders,
          configuredSchedules: this.host.getConfiguredScheduleCount(),
          activeMemories: memoryStats.activeCount,
          pinnedMemories: memoryStats.pinnedCount,
          totalMemoryRecalls: memoryStats.totalRecalls,
        },
        models: agg.models,
        triggers: agg.triggers,
        heatmap: agg.heatmap,
        botRanking,
        chatRanking,
      },
      technical: {
        sla: {
          successRate: curSuccessRate,
          deltaPct:
            prevDenom > 0
              ? Math.round((curSuccessRate - prevSuccessRate) * 10) / 10
              : null,
          errorRate,
          triageFallbackRate,
          toolErrorRate,
          totalErrors: cur.errors,
          abortedTurns: cur.abortedTurns,
          interruptedRecoveries,
        },
        latency: {
          samples: curLat.samples,
          avgMs: curLat.avgMs,
          p50Ms: curLat.p50Ms,
          p75Ms: curLat.p75Ms,
          p95Ms: curLat.p95Ms,
          p99Ms: curLat.p99Ms,
          maxMs: curLat.maxMs,
          deltaP95Pct: calcDeltaPct(curLat.p95Ms, prevLat.p95Ms),
          histogram: agg.latencyHistogram,
        },
        connections: {
          onlineBots,
          enabledBots: enabledBots.length,
          totalBots: allBotRows.length,
          avgAckP50Ms,
          maxAckP95Ms,
          totalSdkErrors,
          splitBrainCount: splitBrains.length,
          bots: allBotRows,
        },
        runtime: {
          phase: lifecycle.phase,
          draining: lifecycle.draining,
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
          uptimeSec: Math.max(0, Math.round((nowMs - this.host.startedAtMs) / 1000)),
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          heapTotalBytes: mem.heapTotal,
          externalBytes: mem.external,
          eventLoopMeanMs: elMeanMs,
          eventLoopP95Ms: elP95Ms,
          eventLoopMaxMs: elMaxMs,
          activeTurns: lifecycle.activeTurns.length,
          activeTriageCount: lifecycle.activeTriageCount,
          activeRemindersCount: lifecycle.activeRemindersCount,
          activeDreamingCount: lifecycle.activeDreamingCount,
          persistedPendingTurns: lifecycle.persistedPendingTurns,
          activeActors: concurrency.activeActors,
          queuedTurns: concurrency.queuedTurns,
          vitalsSeries: [...this.vitals],
        },
        storage: {
          scannedAtMs: storageScan.scannedAtMs,
          totalBytes: storageScan.totalBytes,
          bridgeBytes: storageScan.bridgeBytes,
          dshBytes: storageScan.dshBytes,
          dbBytes: storageStats.dbBytes,
          walBytes: storageStats.walBytes,
          shmBytes: storageStats.shmBytes,
          walBloated: walCheck.bloated,
          walDetail: walCheck.bloated
            ? walCheck.detail
            : `WAL ${walCheck.walMb} MB / 主库 ${walCheck.dbMb} MB，状态健康`,
          journalMode: storageStats.journalMode,
          schemaVersion: storageStats.schemaVersion,
          pageCount: storageStats.pageCount,
          pageSize: storageStats.pageSize,
          integrityOk: integrity.ok && integrity.foreignKeyErrors === 0,
          foreignKeyErrors: integrity.foreignKeyErrors,
          categories: storageScan.categories,
          tables,
        },
        errors: {
          breakdown: agg.errors,
          recent: recentErrors,
        },
        alerts: this.host.getDiagnosticAlerts(),
      },
      series: agg.series,
    }
  }

  // ── Live Session Event Capture ────────────────────────────────────────────

  private handleLiveSessionEvent(session: Session, event: SessionEvent): void {
    const sid = String(session.id)
    if (event.type === 'request/header') {
      const cfg = (
        event.data as { header?: { config?: { provider?: string; model?: string } } }
      )?.header?.config
      if (cfg?.model || cfg?.provider) {
        this.rememberSessionModel(sid, cfg.provider ?? '', cfg.model ?? '')
      }
      return
    }

    if (event.type === 'assistant/message') {
      const attr = this.resolveSessionAttribution(sid, session)
      if (!attr) return
      const data = event.data as {
        usage?: TokenUsage
        message?: { content?: readonly { type?: string }[] }
      }
      const toolCalls = (data.message?.content ?? []).filter((b) => b?.type === 'tool-call').length
      const tokens = normalizeTokenUsage(data.usage)
      if (tokens.totalTokens === 0 && toolCalls === 0) return

      const modelState = this.sessionModels.get(sid)
      const seq = Number(event.seq ?? 0)
      const ts = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
      this.host.store.recordUsageEvent({
        id: `step:${sid}:${seq}`,
        timestampMs: ts,
        recordKind: 'llm_step',
        botId: attr.botId,
        chatId: attr.chatId,
        chatType: attr.chatType,
        sessionId: sid,
        trigger: attr.trigger,
        agentPreset: attr.agentPreset,
        provider: modelState?.provider ?? '',
        model: modelState?.model || attr.model || '',
        outcome: 'completed',
        ...tokens,
        toolCalls,
      })
      this.host.store.observabilityRepo.setSessionWatermark(sid, seq, ts)
      return
    }

    if (event.type === 'tool/result') {
      const data = event.data as { isError?: boolean; name?: string }
      if (!data?.isError) return
      const attr = this.resolveSessionAttribution(sid, session)
      if (!attr) return
      const seq = Number(event.seq ?? 0)
      const ts = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
      this.host.store.recordUsageEvent({
        id: `toolerr:${sid}:${seq}`,
        timestampMs: ts,
        recordKind: 'llm_step',
        botId: attr.botId,
        chatId: attr.chatId,
        chatType: attr.chatType,
        sessionId: sid,
        trigger: attr.trigger,
        agentPreset: attr.agentPreset,
        outcome: 'completed',
        errorCode: 'tool_error',
        toolErrors: 1,
      })
      this.host.store.observabilityRepo.setSessionWatermark(sid, seq, ts)
    }
  }

  private rememberSessionModel(sessionId: string, provider: string, model: string): void {
    this.sessionModels.delete(sessionId)
    this.sessionModels.set(sessionId, { provider, model })
    while (this.sessionModels.size > MAX_MODEL_CACHE_SESSIONS) {
      const oldest = this.sessionModels.keys().next().value
      if (!oldest) break
      this.sessionModels.delete(oldest)
    }
  }

  private resolveSessionAttribution(
    sessionId: string,
    liveSession?: Session,
  ): SessionAttribution | null {
    const cached = this.sessionAttrCache.get(sessionId)
    if (cached !== undefined) return cached

    let found: SessionAttribution | null = null

    const binding = this.host.store.getBindingBySessionId(sessionId)
    if (binding) {
      found = {
        botId: binding.botId,
        chatId: binding.chatId,
        chatType:
          binding.chatType === 'p2p' || binding.trigger === 'p2p' ? 'p2p' : 'group',
        trigger: binding.trigger || 'mention',
        agentPreset: binding.agentPreset || '',
        ...(binding.model ? { model: binding.model } : {}),
      }
    }

    if (!found) {
      const ms = this.host.store.getManagedSession(sessionId)
      if (ms) {
        const bot = this.host.store.getBot(ms.botId)
        found = {
          botId: ms.botId,
          chatId: ms.chatId,
          chatType:
            ms.trigger === 'p2p'
              ? 'p2p'
              : ms.chatId.startsWith('dream:')
                ? 'internal'
                : 'group',
          trigger: ms.trigger || 'mention',
          agentPreset: bot?.agentPreset ?? '',
          ...(bot?.model ? { model: bot.model } : {}),
        }
      }
    }

    if (!found && liveSession && typeof liveSession.snapshotEvents === 'function') {
      const originEvent = liveSession
        .snapshotEvents()
        .find((e) => (e as { type?: string }).type === LARK_ORIGIN_RECORD_TYPE)
      if (originEvent) {
        const origin = (originEvent as unknown as { data?: LarkOriginRecord }).data
        if (origin?.botId) {
          const bot = this.host.store.getBot(origin.botId)
          found = {
            botId: origin.botId,
            chatId: origin.chatId ?? '',
            chatType:
              origin.chatType === 'p2p' || origin.trigger === 'p2p' ? 'p2p' : 'group',
            trigger: origin.trigger || 'mention',
            agentPreset: bot?.agentPreset ?? '',
            ...(bot?.model ? { model: bot.model } : {}),
          }
        }
      }
    }

    if (found) {
      this.cacheSessionAttr(sessionId, found)
    }
    return found
  }

  private cacheSessionAttr(sessionId: string, attr: SessionAttribution | null): void {
    this.sessionAttrCache.delete(sessionId)
    this.sessionAttrCache.set(sessionId, attr)
    while (this.sessionAttrCache.size > MAX_MODEL_CACHE_SESSIONS) {
      const oldest = this.sessionAttrCache.keys().next().value
      if (!oldest) break
      this.sessionAttrCache.delete(oldest)
    }
  }

  // ── Historical Backfill (SQLite Audit/Triage + DSH SessionPersistence) ───

  private backfillSqliteTablesOnce(): void {
    const doneFlag = this.host.store.db.getMeta('observability_sqlite_backfill_v1')
    if (doneFlag === '1') return

    const installedAtMs = this.host.store.getObservabilityInstalledAtMs()
    const batch: TelemetryUsageEventInput[] = []

    // 1. Historical audit_events strictly before v7 live recording started (zero double-counting).
    const audits = this.host.store.listEvents(2000)
    for (const ev of audits) {
      if (ev.timestampMs >= installedAtMs) continue
      if (ev.botId === 'system') continue
      if (ev.kind === 'inbound') {
        batch.push({
          id: `audit:${ev.id}`,
          timestampMs: ev.timestampMs,
          recordKind: 'inbound',
          botId: ev.botId,
          ...(ev.chatId ? { chatId: ev.chatId } : {}),
          ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
          outcome: 'received',
        })
      } else if (ev.kind === 'reply') {
        const trigger = ev.summary.includes('定时') || ev.summary.includes('自动化')
          ? 'schedule'
          : ev.summary.includes('提醒')
            ? 'reminder'
            : ev.summary.includes('分流快回')
              ? 'triage'
              : 'mention'
        batch.push({
          id: `audit:${ev.id}`,
          timestampMs: ev.timestampMs,
          recordKind: trigger === 'schedule' || trigger === 'reminder' ? 'proactive' : 'turn',
          botId: ev.botId,
          ...(ev.chatId ? { chatId: ev.chatId } : {}),
          ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
          trigger,
          outcome: 'replied',
          ...(ev.durationMs !== undefined ? { latencyMs: ev.durationMs } : {}),
        })
      } else if (ev.kind === 'silent_skip') {
        batch.push({
          id: `audit:${ev.id}`,
          timestampMs: ev.timestampMs,
          recordKind: 'turn',
          botId: ev.botId,
          ...(ev.chatId ? { chatId: ev.chatId } : {}),
          ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
          outcome: 'silent_skip',
          ...(ev.durationMs !== undefined ? { latencyMs: ev.durationMs } : {}),
        })
      } else if (ev.kind === 'ignored') {
        batch.push({
          id: `audit:${ev.id}`,
          timestampMs: ev.timestampMs,
          recordKind: 'inbound',
          botId: ev.botId,
          ...(ev.chatId ? { chatId: ev.chatId } : {}),
          outcome: 'ignored',
        })
      } else if (ev.kind === 'error') {
        batch.push({
          id: `audit:${ev.id}`,
          timestampMs: ev.timestampMs,
          recordKind: 'turn',
          botId: ev.botId,
          ...(ev.chatId ? { chatId: ev.chatId } : {}),
          ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
          outcome: 'error',
          errorCode: inferErrorCodeFromSummary(ev.summary),
          ...(ev.durationMs !== undefined ? { latencyMs: ev.durationMs } : {}),
        })
      }
    }

    // 2. Historical triage_sessions strictly before v7 live recording
    for (const ts of this.host.store.listTriageSessions()) {
      if (ts.createdAtMs >= installedAtMs) continue
      batch.push({
        id: `triage:${ts.sessionId}`,
        timestampMs: ts.createdAtMs,
        recordKind: 'triage',
        botId: ts.botId,
        chatId: ts.chatId,
        chatType: 'group',
        sessionId: ts.sessionId,
        trigger: 'triage',
        ...(ts.provider ? { provider: ts.provider } : {}),
        ...(ts.model ? { model: ts.model } : {}),
        outcome: ts.fallback ? 'fallback' : ts.action,
        ...(ts.errorCode ? { errorCode: ts.errorCode } : {}),
        latencyMs: ts.durationMs,
      })
    }

    // 3. Historical dream_sessions strictly before v7 live recording
    for (const ds of this.host.store.listDreamSessions()) {
      if (ds.createdAtMs >= installedAtMs) continue
      batch.push({
        id: `dream:${ds.sessionId}`,
        timestampMs: ds.createdAtMs,
        recordKind: 'proactive',
        botId: ds.botId,
        chatId: 'dream:internal',
        chatType: 'internal',
        sessionId: ds.sessionId,
        trigger: 'dreaming',
        agentPreset: ds.agentPreset,
        ...(ds.model ? { model: ds.model } : {}),
        outcome: ds.status === 'failed' ? 'error' : 'completed',
        ...(ds.durationMs !== undefined ? { latencyMs: ds.durationMs } : {}),
      })
    }

    if (batch.length > 0) {
      this.host.store.recordUsageEventsBatch(batch)
    }
    this.host.store.db.setMeta('observability_sqlite_backfill_v1', '1')
  }

  private async runBackfillInternal(): Promise<void> {
    if (this.disposed) return
    this.backfillRunning = true
    try {
      this.backfillSqliteTablesOnce()

      const persistence = this.host.ctx.get('sessionPersistence' as never) as
        | SessionPersistence
        | undefined
      if (!persistence || typeof persistence.open !== 'function') {
        this.backfillCompleted = true
        this.backfillLastCompletedAtMs = Date.now()
        return
      }

      const candidates = this.collectBackfillSessionCandidates()
      const watermarks = this.host.store.observabilityRepo.listSessionWatermarks()
      this.backfillTotal = candidates.length
      this.backfillScanned = 0

      for (let i = 0; i < candidates.length; i += 1) {
        if (this.disposed) break
        const item = candidates[i]!
        const prevSeq = watermarks.get(item.sessionId) ?? -1
        if (prevSeq >= Number.MAX_SAFE_INTEGER - 1) {
          this.backfillScanned += 1
          continue
        }
        await this.scanSinglePersistedSession(persistence, item, prevSeq)
        this.backfillScanned += 1
        if ((i + 1) % BACKFILL_YIELD_BATCH === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }

      if (!this.disposed) {
        this.backfillCompleted = true
        this.backfillLastCompletedAtMs = Date.now()
      }
    } catch {
      // Non-fatal; observability still serves live and SQLite data cleanly.
    } finally {
      this.backfillRunning = false
    }
  }

  private collectBackfillSessionCandidates(): Array<{
    readonly sessionId: string
    readonly attr: SessionAttribution
    readonly lastActivityMs: number
  }> {
    const byId = new Map<
      string,
      { readonly sessionId: string; readonly attr: SessionAttribution; readonly lastActivityMs: number }
    >()
    const botsById = new Map(this.host.store.listBots().map((b) => [b.id, b]))

    for (const b of this.host.store.listBindings()) {
      byId.set(b.sessionId, {
        sessionId: b.sessionId,
        lastActivityMs: b.lastActivityMs,
        attr: {
          botId: b.botId,
          chatId: b.chatId,
          chatType: b.chatType === 'p2p' || b.trigger === 'p2p' ? 'p2p' : 'group',
          trigger: b.trigger || 'mention',
          agentPreset: b.agentPreset || '',
          ...(b.model ? { model: b.model } : {}),
        },
      })
    }

    for (const ms of this.host.store.listAllManagedSessions()) {
      if (byId.has(ms.sessionId)) continue
      const bot = botsById.get(ms.botId)
      byId.set(ms.sessionId, {
        sessionId: ms.sessionId,
        lastActivityMs: ms.lastActivityMs,
        attr: {
          botId: ms.botId,
          chatId: ms.chatId,
          chatType:
            ms.trigger === 'p2p'
              ? 'p2p'
              : ms.chatId.startsWith('dream:')
                ? 'internal'
                : 'group',
          trigger: ms.trigger || 'mention',
          agentPreset: bot?.agentPreset ?? '',
          ...(bot?.model ? { model: bot.model } : {}),
        },
      })
    }

    for (const ds of this.host.store.listDreamSessions()) {
      if (byId.has(ds.sessionId)) continue
      byId.set(ds.sessionId, {
        sessionId: ds.sessionId,
        lastActivityMs: ds.lastActivityMs,
        attr: {
          botId: ds.botId,
          chatId: 'dream:internal',
          chatType: 'internal',
          trigger: 'dreaming',
          agentPreset: ds.agentPreset,
          ...(ds.model ? { model: ds.model } : {}),
        },
      })
    }

    for (const ts of this.host.store.listTriageSessions()) {
      if (byId.has(ts.sessionId)) continue
      byId.set(ts.sessionId, {
        sessionId: ts.sessionId,
        lastActivityMs: ts.lastActivityMs,
        attr: {
          botId: ts.botId,
          chatId: ts.chatId,
          chatType: 'group',
          trigger: 'triage',
          agentPreset: '',
          ...(ts.model ? { model: ts.model } : {}),
        },
      })
    }

    return [...byId.values()]
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
      .slice(0, MAX_BACKFILL_SESSIONS)
  }

  private async scanSinglePersistedSession(
    persistence: SessionPersistence,
    item: { readonly sessionId: string; readonly attr: SessionAttribution },
    prevSeq: number,
  ): Promise<void> {
    let handle
    try {
      handle = await persistence.open(brandString<SessionId>(item.sessionId), 'read')
    } catch {
      return
    }
    try {
      const batch: TelemetryUsageEventInput[] = []
      let provider = ''
      let model = item.attr.model ?? ''
      let offset = 0
      let maxSeenSeq = prevSeq
      let totalRead = 0

      while (!this.disposed && totalRead < MAX_EVENTS_PER_BACKFILL_SESSION) {
        const res = await handle.read(offset, READ_EVENTS_PAGE_SIZE)
        if (!res.events || res.events.length === 0) break
        for (const ev of res.events) {
          const seq = Number(ev.seq ?? offset)
          if (ev.type === 'request/header') {
            const cfg = (
              ev.data as { header?: { config?: { provider?: string; model?: string } } }
            )?.header?.config
            if (cfg?.provider) provider = cfg.provider
            if (cfg?.model) model = cfg.model
          }
          if (seq <= prevSeq) continue
          if (seq > maxSeenSeq) maxSeenSeq = seq

          if (ev.type === 'assistant/message') {
            const data = ev.data as {
              usage?: TokenUsage
              message?: { content?: readonly { type?: string }[] }
            }
            const toolCalls = (data.message?.content ?? []).filter(
              (b) => b?.type === 'tool-call',
            ).length
            const tokens = normalizeTokenUsage(data.usage)
            if (tokens.totalTokens === 0 && toolCalls === 0) continue
            const ts = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : Date.now()
            batch.push({
              id: `step:${item.sessionId}:${seq}`,
              timestampMs: ts,
              recordKind: 'llm_step',
              botId: item.attr.botId,
              chatId: item.attr.chatId,
              chatType: item.attr.chatType,
              sessionId: item.sessionId,
              trigger: item.attr.trigger,
              agentPreset: item.attr.agentPreset,
              provider,
              model,
              outcome: 'completed',
              ...tokens,
              toolCalls,
            })
          } else if (ev.type === 'tool/result') {
            const data = ev.data as { isError?: boolean }
            if (!data?.isError) continue
            const ts = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : Date.now()
            batch.push({
              id: `toolerr:${item.sessionId}:${seq}`,
              timestampMs: ts,
              recordKind: 'llm_step',
              botId: item.attr.botId,
              chatId: item.attr.chatId,
              chatType: item.attr.chatType,
              sessionId: item.sessionId,
              trigger: item.attr.trigger,
              agentPreset: item.attr.agentPreset,
              provider,
              model,
              outcome: 'completed',
              errorCode: 'tool_error',
              toolErrors: 1,
            })
          }
        }
        totalRead += res.events.length
        offset += res.events.length
        if (res.events.length < READ_EVENTS_PAGE_SIZE) break
      }

      if (batch.length > 0) {
        this.host.store.recordUsageEventsBatch(batch)
      }
      if (maxSeenSeq > prevSeq) {
        this.host.store.observabilityRepo.setSessionWatermark(item.sessionId, maxSeenSeq)
      }
    } catch {
      // Ignore corrupted or concurrently truncated session log.
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // ── Process Vitals Sampler ────────────────────────────────────────────────

  private sampleVitalsNow(): void {
    const nowMs = Date.now()
    const mem = process.memoryUsage()
    const lifecycle = this.host.getLifecycleStatus()
    const onlineBots = this.host.listBotStatuses().filter((s) => s.enabled && s.connected).length
    const point: ProcessVitalPoint = {
      timestampMs: nowMs,
      label: formatClockLabel(nowMs),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      eventLoopP95Ms: this.readHistogramMs(this.eventLoopMonitor?.percentile(95)),
      eventLoopMeanMs: this.readHistogramMs(this.eventLoopMonitor?.mean),
      activeTurns: lifecycle.activeTurns.length,
      onlineBots,
    }
    this.vitals.push(point)
    if (this.vitals.length > VITALS_MAX_POINTS) {
      this.vitals.splice(0, this.vitals.length - VITALS_MAX_POINTS)
    }
  }

  private readHistogramMs(ns?: number): number {
    if (typeof ns !== 'number' || !Number.isFinite(ns) || ns <= 0) return 0
    return Math.round((ns / 1e6) * 10) / 10
  }

  // ── Async Storage Telemetry Scanner ───────────────────────────────────────

  private async getStorageScan(forceRefresh: boolean): Promise<StorageScanSnapshot> {
    const now = Date.now()
    if (
      !forceRefresh &&
      this.storageCache &&
      now - this.storageCache.scannedAtMs < STORAGE_SCAN_CACHE_TTL_MS
    ) {
      return this.storageCache
    }
    if (this.storageScanInFlight) return this.storageScanInFlight
    this.storageScanInFlight = this.scanStorageNow()
      .then((snap) => {
        this.storageCache = snap
        return snap
      })
      .finally(() => {
        this.storageScanInFlight = null
      })
    return this.storageScanInFlight
  }

  private async scanStorageNow(): Promise<StorageScanSnapshot> {
    const dataDir = this.host.dataDir
    const stats = this.host.store.getStorageStats()
    const dbBytes = stats.dbBytes
    const walShmBytes = stats.walBytes + stats.shmBytes

    // Only scan sibling DSH directories when dataDir follows the canonical `<dshHome>/lark-bridge` layout.
    const hasCanonicalDshParent = basename(dataDir) === 'lark-bridge'
    const dshHome = hasCanonicalDshParent ? dirname(dataDir) : null

    const [
      backupsStat,
      memoryStat,
      dreamingStat,
      bridgeOtherStat,
      dshSessionsStat,
      dshAttachmentsStat,
      dshLogsStat,
      dshStoragesStat,
    ] = await Promise.all([
      measureDirectoryAsync(join(dataDir, 'backups')),
      measureDirectoryAsync(join(dataDir, 'memory')),
      measureDirectoryAsync(join(dataDir, 'dreaming')),
      measureDirectoryAsync(
        dataDir,
        new Set([
          'backups',
          'memory',
          'dreaming',
          'lark-bridge.db',
          'lark-bridge.db-wal',
          'lark-bridge.db-shm',
        ]),
      ),
      dshHome ? measureDirectoryAsync(join(dshHome, 'sessions')) : Promise.resolve({ bytes: 0, fileCount: 0 }),
      dshHome
        ? measureDirectoryAsync(join(dshHome, 'attachments'))
        : Promise.resolve({ bytes: 0, fileCount: 0 }),
      dshHome ? measureDirectoryAsync(join(dshHome, 'logs')) : Promise.resolve({ bytes: 0, fileCount: 0 }),
      dshHome ? measureDirectoryAsync(join(dshHome, 'storages')) : Promise.resolve({ bytes: 0, fileCount: 0 }),
    ])

    // Fallback check for db file size if in-memory DB returned 0
    const effectiveDbBytes =
      dbBytes || (await safeFileSizeAsync(join(dataDir, 'lark-bridge.db')))

    const rawCategories: Array<Omit<StorageCategoryEntry, 'sharePct'>> = [
      {
        id: 'dsh_sessions',
        label: 'DSH 会话归档',
        pathLabel: 'sessions/',
        scope: 'dsh',
        bytes: dshSessionsStat.bytes,
        fileCount: dshSessionsStat.fileCount,
      },
      {
        id: 'bridge_db',
        label: '桥接主库 (SQLite)',
        pathLabel: 'lark-bridge/lark-bridge.db',
        scope: 'bridge',
        bytes: effectiveDbBytes,
        fileCount: effectiveDbBytes > 0 ? 1 : 0,
      },
      {
        id: 'bridge_wal',
        label: 'SQLite WAL / SHM',
        pathLabel: 'lark-bridge/lark-bridge.db-wal',
        scope: 'bridge',
        bytes: walShmBytes,
        fileCount: walShmBytes > 0 ? 2 : 0,
      },
      {
        id: 'dsh_attachments',
        label: '媒体与附件缓存',
        pathLabel: 'attachments/',
        scope: 'dsh',
        bytes: dshAttachmentsStat.bytes,
        fileCount: dshAttachmentsStat.fileCount,
      },
      {
        id: 'bridge_backups',
        label: '桥接历史备份',
        pathLabel: 'lark-bridge/backups/',
        scope: 'bridge',
        bytes: backupsStat.bytes,
        fileCount: backupsStat.fileCount,
      },
      {
        id: 'dsh_logs_storages',
        label: '运行日志与状态缓存',
        pathLabel: 'logs/ & storages/',
        scope: 'dsh',
        bytes: dshLogsStat.bytes + dshStoragesStat.bytes,
        fileCount: dshLogsStat.fileCount + dshStoragesStat.fileCount,
      },
      {
        id: 'bridge_memory_dream',
        label: '记忆镜像与 Dreaming',
        pathLabel: 'lark-bridge/memory & dreaming',
        scope: 'bridge',
        bytes: memoryStat.bytes + dreamingStat.bytes + bridgeOtherStat.bytes,
        fileCount: memoryStat.fileCount + dreamingStat.fileCount + bridgeOtherStat.fileCount,
      },
    ]

    const nonEmpty = rawCategories
      .filter((c) => c.bytes > 0 || c.id === 'bridge_db' || c.id === 'bridge_wal')
      .sort((a, b) => b.bytes - a.bytes)

    const bridgeBytes = rawCategories
      .filter((c) => c.scope === 'bridge')
      .reduce((sum, c) => sum + c.bytes, 0)
    const dshBytes = rawCategories
      .filter((c) => c.scope === 'dsh')
      .reduce((sum, c) => sum + c.bytes, 0)
    const totalBytes = bridgeBytes + dshBytes

    const categories: StorageCategoryEntry[] = nonEmpty.map((c) => ({
      ...c,
      sharePct: totalBytes > 0 ? Math.round((c.bytes / totalBytes) * 1000) / 10 : 0,
    }))

    return {
      scannedAtMs: Date.now(),
      totalBytes,
      bridgeBytes,
      dshBytes,
      categories,
    }
  }
}
