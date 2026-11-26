import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { pluginRecordOf, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  LarkPlatformManager,
  type DiscoveredLarkChat,
  type InboundLarkMessage,
  type LarkBaselineEventSyncResult,
  type LarkBotConfig,
  type LarkBotProfile,
  type LarkBotStatus,
  type LarkBotTransport,
  type LarkChatMember,
  type LarkHistoryMessage,
  type LarkMessageDetail,
  type LarkQrJobView,
  type LarkUserSearchHit,
  type SubstituteTarget,
} from '@dsh-lark/lark-core'
import {
  AgentToolFacade,
  SessionIdentityError,
  type AgentCliSendInput,
  type ResolvedCliSessionIdentity,
} from './agent-tool-facade.js'
import { BotConnectionPool } from './bot-connection-pool.js'
import {
  ensureCliAuthEndpoint,
  ensureOperatorAuth,
  installLocalCliAndSkill,
  type CliAuthEndpoint,
  type OperatorAuthToken,
} from './cli-support.js'
import {
  ConsoleLoginHandoff,
  DEFAULT_CONSOLE_LOGIN_TTL_MS,
  type IssuedConsoleLoginLink,
} from './console-login.js'
import { buildBridgeDiagnostics, type BridgeDiagnosticsPayload } from './diagnostics.js'
import { LarkDirectoryEnricher } from './directory-enrichment.js'
import { DreamingService } from './dreaming-service.js'
import { InboundPipeline } from './inbound-pipeline.js'
import { InstanceLock } from './instance-lock.js'
import { MemoryService } from './memory-service.js'
import { ObservabilityService } from './observability-service.js'
import type { ObservabilityPayload, ObservabilityWindow } from './observability-types.js'
import { PluginUpdateService } from './plugin-updater.js'
import { ProactiveReminderService } from './reminder-service.js'
import { RuntimeCatalog } from './runtime-catalog.js'
import { ScheduleNotifier, type ScheduleCreateInputLike } from './schedule-notifier.js'
import { SessionCoordinator } from './session-coordinator.js'
import { LoopbackSessionHandoff, isLoopbackOrigin } from './session-handoff.js'
import { SessionTitleGuard } from './session-title-guard.js'
import { LarkSessionViewerService } from './session-viewer.js'
import type { SplitBrainDetector } from './split-brain-detector.js'
import type { LarkBridgeStore } from './store.js'
import { TriageSessionRecorder } from './triage-session-recorder.js'
import { LlmTriageService } from './triage-service.js'
import { runTurnAndCollectReply } from './turn-runner.js'
import type {
  BridgeLifecyclePhase,
  BridgeLifecycleStatus,
  LarkBridgeConfig,
  LarkScheduleDeliveryMode,
  LarkScheduleNotifyOn,
} from './types.js'
import { WorkspaceGrouping } from './workspace-grouping.js'

const SHUTDOWN_DISPOSE_BUDGET_MS = 2_500
const EXTERNAL_BINDING_RECORD_TYPE = 'plugin:external-agent/binding'
const WAL_PASSIVE_CHECKPOINT_THRESHOLD_BYTES = 2 * 1024 * 1024
const WAL_IDLE_TRUNCATE_THRESHOLD_BYTES = 4 * 1024 * 1024
const WAL_PERIODIC_CHECKPOINT_INTERVAL_MS = 15 * 60_000

export {
  SessionIdentityError,
  type AgentCliSendInput,
  type ResolvedCliSessionIdentity,
} from './agent-tool-facade.js'

async function withShutdownBudget(work: Promise<unknown>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Thin lifecycle coordinator & public facade assembling:
 * - `BotConnectionPool` (Lark WSClient pool, serialized syncBot, split-brain detector)
 * - `SessionCoordinator` (per-session `SessionActor` 5-state lifecycle & mailbox)
 * - `InboundPipeline` (dedup, traceId, routing, prompt synthesis, reply delivery, silence control)
 * - `AgentToolFacade` (CLI/HTTP agent endpoints & proactive schedule/reminder delivery)
 * - `SessionTitleGuard` (isolated DSH host title sanitization & historical reconciliation)
 */
export class LarkBridgeManager {
  readonly runtimes: RuntimeCatalog
  readonly schedules: ScheduleNotifier
  readonly memory: MemoryService
  readonly dreaming: DreamingService
  readonly reminders: ProactiveReminderService
  readonly platform: LarkPlatformManager
  readonly cliAuth: CliAuthEndpoint
  readonly operatorAuth: OperatorAuthToken
  readonly sessionHandoff = new LoopbackSessionHandoff()
  readonly consoleLogin = new ConsoleLoginHandoff()
  readonly sessionViewer: LarkSessionViewerService
  readonly connections: BotConnectionPool
  readonly sessions: SessionCoordinator
  readonly triage: LlmTriageService
  readonly inbound: InboundPipeline
  readonly facade: AgentToolFacade
  readonly titleGuard: SessionTitleGuard
  readonly splitBrain: SplitBrainDetector
  readonly pluginUpdater: PluginUpdateService
  readonly observability: ObservabilityService

  private readonly instanceLock: InstanceLock
  private readonly directoryEnricher: LarkDirectoryEnricher
  private readonly workspaces: WorkspaceGrouping
  private readonly shutdownController = new AbortController()
  private readonly disposers: Array<() => void> = []
  private readonly drainWaiters = new Set<() => void>()
  private readonly startedAtMs = Date.now()
  private liveWebOrigin = ''
  private liveConnection?: { authenticatedUrl?: (baseUrl: string) => string }
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private lastWalCheckpointAtMs = 0
  private phase: BridgeLifecyclePhase = 'starting'
  private drainRequestedAtMs?: number
  private drainReason?: string
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: LarkBridgeConfig,
    readonly store: LarkBridgeStore,
  ) {
    this.instanceLock = new InstanceLock(config.dataDir)
    this.runtimes = new RuntimeCatalog(ctx)
    this.workspaces = new WorkspaceGrouping(ctx, store)
    this.platform = new LarkPlatformManager(config.dataDir)
    this.sessionViewer = new LarkSessionViewerService(ctx, store)
    this.directoryEnricher = new LarkDirectoryEnricher(this.platform, () => this.store.listBots())
    this.cliAuth = ensureCliAuthEndpoint(config.dataDir, config.publicBaseUrl)
    this.operatorAuth = ensureOperatorAuth(config.dataDir)
    const notifyActivityChange = () => this.notifyDrainWaitersIfQuiescent()

    this.connections = new BotConnectionPool({
      ctx,
      store,
      runtimes: this.runtimes,
      workspaces: this.workspaces,
      platform: this.platform,
      directoryEnricher: this.directoryEnricher,
      isDisposed: () => this.disposed,
      onInboundMessage: (botId, transport, msg) =>
        this.inbound.handleInbound(botId, transport, msg),
      onMessageRecalled: (botId, transport, event) =>
        this.inbound.handleMessageRecalled(botId, transport, event),
      onCardAction: async (action) => {
        const toast = await this.reminders.handleCardAction(action.actionValue, {
          ...(action.operatorOpenId ? { operatorOpenId: action.operatorOpenId } : {}),
        })
        return toast ? { toast } : undefined
      },
      onBotReady: (botId) => {
        if (this.phase === 'draining' || this.disposed) return
        void this.inbound.recoverStalePendingTurns(botId).catch((err) => {
          this.ctx.logger.warn(
            `[lark-bridge] bot "${botId}" pending turn recovery warning: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      },
    })
    this.splitBrain = this.connections.splitBrain

    this.sessions = new SessionCoordinator({
      ctx,
      store,
      runtimes: this.runtimes,
      workspaces: this.workspaces,
      instrumentAgent: (agent) => this.schedules.instrumentAgent(agent),
      disposeReminderHandle: (sessionId) => this.reminders.disposeSessionHandle(sessionId),
    })

    this.titleGuard = new SessionTitleGuard(ctx, store, this.workspaces, (sid) =>
      this.sessions.archiveManagedSession(sid),
    )

    const triageRecorder = new TriageSessionRecorder(ctx, store, this.workspaces)
    const triagePersistence =
      typeof store.loadTriageContextScopes === 'function'
        ? {
            loadTriageContextScopes: (minUpdatedAtMs?: number) =>
              store.loadTriageContextScopes(minUpdatedAtMs),
            upsertTriageContextScope: (
              scopeKey: string,
              kind: 'history' | 'worker_reply' | 'ephemeral_thread',
              payloadJson: string,
              updatedAtMs: number,
            ) => store.upsertTriageContextScope(scopeKey, kind, payloadJson, updatedAtMs),
            deleteTriageContextScope: (
              scopeKey: string,
              kind?: 'history' | 'worker_reply' | 'ephemeral_thread',
            ) => store.deleteTriageContextScope(scopeKey, kind),
            pruneTriageContextScopes: (cutoffMs: number) =>
              store.pruneTriageContextScopes(cutoffMs),
          }
        : undefined
    this.triage = new LlmTriageService(ctx, this.runtimes, triageRecorder, {
      ...(triagePersistence ? { persistence: triagePersistence } : {}),
      ...(typeof store.resolvePrimaryRouteKey === 'function'
        ? { resolvePrimaryRouteKey: (routeKey) => store.resolvePrimaryRouteKey(routeKey) }
        : {}),
      onActivityChange: notifyActivityChange,
    })
    this.memory = new MemoryService(config.dataDir, store)

    this.inbound = new InboundPipeline({
      ctx,
      store,
      runtimes: this.runtimes,
      connections: this.connections,
      sessions: this.sessions,
      memory: this.memory,
      triage: this.triage,
      titleGuard: this.titleGuard,
      shutdownSignal: this.shutdownController.signal,
      isDisposed: () => this.disposed,
      isDraining: () => this.phase === 'draining' || this.phase === 'stopping',
      onActivityChange: notifyActivityChange,
      onTriageRecorded: (input) => this.observability?.recordTriageEvaluation(input),
      sessionWebUrl: (sid) => this.sessionWebUrl(sid),
      issueConsoleLoginLink: (input) => this.issueConsoleLoginLink(input),
    })

    this.facade = new AgentToolFacade({
      ctx,
      store,
      connections: this.connections,
      sessions: this.sessions,
      inbound: this.inbound,
      getSchedules: () => this.schedules,
      getReminders: () => this.reminders,
      sessionWebUrl: (sid) => this.sessionWebUrl(sid),
      resolveExternalSessionId: (extId) => this.resolveExternalSessionId(extId),
    })

    this.schedules = new ScheduleNotifier({
      ctx,
      store,
      workspaces: this.workspaces,
      memory: this.memory,
      getBotOpenId: (botId) => this.connections.getTransport(botId)?.state.botOpenId,
      sendScheduleMessage: (input) => this.facade.sendScheduleMessage(input),
    })

    this.dreaming = new DreamingService({
      ctx,
      dataDir: config.dataDir,
      store,
      memory: this.memory,
      runtimes: this.runtimes,
      workspaces: this.workspaces,
      onActivityChange: notifyActivityChange,
      runTurn: (agent, content) =>
        runTurnAndCollectReply(this.ctx, agent, content, {
          signal: this.shutdownController.signal,
        }),
    })

    this.reminders = new ProactiveReminderService({
      ctx,
      store,
      runtimes: this.runtimes,
      workspaces: this.workspaces,
      memory: this.memory,
      onActivityChange: notifyActivityChange,
      getExecutingTurnContext: (sessionId) => this.inbound.getExecutingTurnContext(sessionId),
      resolveMemberName: (botId, chatId, openId) =>
        this.facade.resolveMemberName(botId, chatId, openId),
      runTurn: (agent, content) =>
        runTurnAndCollectReply(this.ctx, agent, content, {
          signal: this.shutdownController.signal,
        }),
      sendOriginCard: (origin, card) => this.facade.sendOriginCard(origin, card),
      patchOriginCard: (botId, messageId, card) =>
        this.facade.patchOriginCard(botId, messageId, card),
      deliverReminderOutput: (input) => this.facade.deliverReminderOutput(input),
    })

    this.pluginUpdater = new PluginUpdateService({
      ctx,
      dataDir: config.dataDir,
      lifecycle: {
        getLifecycleStatus: () => this.getLifecycleStatus(),
        beginDrain: (opts) => this.beginDrain(opts),
        waitForDrain: (timeoutMs, signal) => this.waitForDrain(timeoutMs, signal),
        cancelDrain: () => this.cancelDrain(),
        countActiveExternalAgents: () => {
          try {
            const extSvc = this.ctx.get('externalRuntimes' as never) as
              | {
                  list?: () => readonly { id: string }[]
                  listExposedPresets?: () => readonly { presetId: string }[]
                }
              | undefined
            if (!extSvc) return 0
            const externalIds = new Set<string>([
              ...(extSvc.list?.().map((r) => r.id) ?? []),
              ...(extSvc.listExposedPresets?.().map((p) => p.presetId) ?? []),
            ])
            if (externalIds.size === 0) return 0
            const agents = this.ctx.agents?.list?.() ?? []
            return agents.filter((agent) => {
              if (agent.status === 'idle') return false
              const preset = (agent.session?.header as { agentPreset?: string } | undefined)
                ?.agentPreset
              return typeof preset === 'string' && externalIds.has(preset)
            }).length
          } catch {
            return 0
          }
        },
        recordUpdateEvent: (summary, isError) => {
          try {
            this.store.recordEvent({
              botId: 'system',
              kind: isError ? 'error' : 'lifecycle',
              summary,
            })
          } catch {
            // Ignore audit error during teardown/reload.
          }
        },
      },
    })

    this.observability = new ObservabilityService({
      ctx,
      dataDir: config.dataDir,
      store,
      startedAtMs: this.startedAtMs,
      enableBackgroundTimers: config.idleSweepIntervalMs > 0,
      listBotStatuses: () => this.listBotStatuses(),
      getTransportDiagnostics: (botId) => this.connections.getDiagnosticsSnapshot(botId),
      listSplitBrainAlerts: () => this.splitBrain.listAlerts(),
      getLifecycleStatus: () => this.getLifecycleStatus(),
      getConcurrencyStats: () => this.sessions.getRuntimeConcurrencyStats(),
      getDiagnosticAlerts: () => this.getDiagnostics().alerts,
      getConfiguredScheduleCount: () =>
        this.store.listScheduleBindings().filter((s) => s.enabled).length,
    })
  }

  // Test-compatible accessors preserving direct delegation without duplicating state.
  private get transports() {
    return this.connections.transports
  }

  private get inFlightTurns() {
    return this.sessions.inFlightTurns
  }

  private handleInbound(
    botId: string,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ): Promise<void> {
    return this.inbound.handleInbound(botId, transport, msg)
  }

  async start(): Promise<void> {
    this.phase = 'starting'
    if (this.config.enableInstanceLock !== false) {
      const lockStatus = await this.instanceLock.acquireAsync({
        ...(this.config.instanceLockWaitMs !== undefined
          ? { waitMs: this.config.instanceLockWaitMs }
          : {}),
      })
      if (lockStatus.recoveredStaleLock) {
        this.ctx.logger.warn(
          `[lark-bridge] recovered stale instance lock from PID=${lockStatus.recoveredStaleLock.pid} (${lockStatus.recoveredStaleLock.host})`,
        )
      }
    }

    this.sessionViewer.attachToHost()
    if (this.config.autoInstallCliAndSkill !== false) {
      installLocalCliAndSkill(this.config.dataDir, this.cliAuth.endpointFile, {
        logger: this.ctx.logger,
        ...(this.config.syncGlobalCliAndSkill !== undefined
          ? { syncGlobalPaths: this.config.syncGlobalCliAndSkill }
          : {}),
      })
    }

    this.disposers.push(this.workspaces.install())
    this.disposers.push(this.observability.install())
    this.disposers.push(this.installExternalBindingPersistence())
    this.schedules.start()
    this.dreaming.start(this.config.idleSweepIntervalMs > 0 ? 60_000 : 0)
    await this.reminders.recoverStaleRunningReminders().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] stale reminder recovery warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    this.disposers.push(this.titleGuard.install())
    await this.workspaces.reconcileBindings()

    await this.connections.startAllEnabled()
    if (!this.disposed) {
      this.reminders.start(this.config.idleSweepIntervalMs > 0 ? 30_000 : 0)
    }
    this.phase = 'running'

    await this.inbound.recoverStalePendingTurns().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] stale pending turn recovery warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    void this.schedules.refreshScheduleContextCache()
    void this.backfillExternalSessionLinks().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] external session link backfill warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    void this.titleGuard.reconcileHistoricalSessions().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] historical session reconciliation warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    if (this.config.idleSweepIntervalMs > 0) {
      this.idleTimer = setInterval(
        () => {
          if (this.phase === 'draining' || this.disposed) return
          void this.sweepIdleBindings()
            .then(() =>
              this.workspaces.reconcileBindings().catch((err) => {
                this.ctx.logger.warn(
                  `[lark-bridge] periodic workspace reconciliation warning: ${err instanceof Error ? err.message : String(err)}`,
                )
              }),
            )
            .finally(() => {
              this.maybeCheckpointWal()
            })
        },
        this.config.idleSweepIntervalMs,
      )
      this.idleTimer.unref?.()
    }
  }

  getLifecycleStatus(): BridgeLifecycleStatus {
    const activeTurns = this.inbound.listActiveTurnSummaries()
    const activeTurnsCount = this.inbound.getActiveCount()
    const activeTriageCount = this.triage.getActiveCount()
    const activeRemindersCount = this.reminders.getActiveCount()
    const activeDreamingCount = this.dreaming.getActiveCount()
    const totalInFlight =
      activeTurnsCount + activeTriageCount + activeRemindersCount + activeDreamingCount
    const persistedPendingTurns =
      typeof this.store.countPendingTurns === 'function'
        ? this.store.countPendingTurns()
        : this.store.listPendingTurns().length
    return {
      phase: this.phase,
      draining: this.phase === 'draining',
      ...(this.drainRequestedAtMs ? { drainRequestedAtMs: this.drainRequestedAtMs } : {}),
      ...(this.drainReason ? { drainReason: this.drainReason } : {}),
      drained: totalInFlight === 0,
      activeTurns,
      activeTriageCount,
      activeRemindersCount,
      activeDreamingCount,
      totalInFlight,
      persistedPendingTurns,
      pid: process.pid,
      startedAtMs: this.startedAtMs,
    }
  }

  /**
   * Enters graceful maintenance drain: pauses inbound Feishu WSClient intake and
   * background reminder/dreaming dispatches while keeping REST clients alive so
   * every currently running turn can complete and deliver its final reply cleanly.
   */
  async beginDrain(options: { readonly reason?: string } = {}): Promise<BridgeLifecycleStatus> {
    if (this.disposed) return this.getLifecycleStatus()
    if (this.phase !== 'draining') {
      this.phase = 'draining'
      this.drainRequestedAtMs = Date.now()
      this.drainReason = options.reason?.trim() || 'operator_drain'
      this.reminders.pauseDispatch()
      this.dreaming.pauseDispatch()
      await this.connections.pauseAllInbound()
      this.store.recordEvent({
        botId: 'system',
        kind: 'lifecycle',
        summary: `已进入优雅排空模式（停止接入新消息，等待在途任务完成：${this.drainReason}）`,
      })
    }
    return this.getLifecycleStatus()
  }

  /** Waits until all in-flight turns, triage calls, reminders and dreaming runs complete or timeout. */
  async waitForDrain(timeoutMs = 120_000, signal?: AbortSignal): Promise<BridgeLifecycleStatus> {
    const clampedTimeoutMs = Math.max(0, Math.min(timeoutMs, 15 * 60_000))
    const initial = this.getLifecycleStatus()
    if (initial.drained || clampedTimeoutMs === 0 || signal?.aborted) {
      return initial
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        clearInterval(pollTimer)
        this.drainWaiters.delete(check)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const check = () => {
        if (this.disposed || this.getLifecycleStatus().drained) {
          done()
        }
      }
      const timeoutTimer = setTimeout(done, clampedTimeoutMs)
      timeoutTimer.unref?.()
      const pollTimer = setInterval(check, 250)
      pollTimer.unref?.()
      this.drainWaiters.add(check)
      signal?.addEventListener('abort', done, { once: true })
      check()
    })

    return this.getLifecycleStatus()
  }

  /** Exits graceful drain and resumes Feishu WSClient intake & background schedulers. */
  async cancelDrain(): Promise<BridgeLifecycleStatus> {
    if (this.disposed || this.phase !== 'draining') return this.getLifecycleStatus()
    this.phase = 'running'
    this.drainRequestedAtMs = undefined
    this.drainReason = undefined
    this.reminders.resumeDispatch()
    this.dreaming.resumeDispatch()
    await this.connections.resumeAllInbound()
    this.store.recordEvent({
      botId: 'system',
      kind: 'lifecycle',
      summary: '已取消排空模式并恢复飞书消息接入',
    })
    return this.getLifecycleStatus()
  }

  async stop(): Promise<void> {
    this.phase = 'stopping'
    this.disposed = true
    // 1. Snapshot recoverable in-flight turns to SQLite BEFORE aborting handles so
    //    no turn is prematurely failed or stripped of its Feishu reaction.
    await this.inbound.suspendActiveTurnsForShutdown()
    this.shutdownController.abort()
    this.sessionHandoff.dispose()
    this.consoleLogin.dispose()
    this.sessionViewer.dispose()
    this.schedules.stop()
    this.dreaming.stop()
    while (this.disposers.length > 0) {
      this.disposers.pop()?.()
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    // 2. Dispose WS connections, agent handles and reminders in parallel within a
    //    strict 2.5s budget so SQLite WAL checkpoint and bridge.lock release always
    //    complete inside DSH host's 5s process shutdown grace window.
    await withShutdownBudget(
      Promise.allSettled([
        this.connections.stopAll(),
        this.sessions.disposeAll(),
        this.reminders.stop(),
      ]),
      SHUTDOWN_DISPOSE_BUDGET_MS,
    )
    this.triage.context.flushPersisted()
    this.triage.context.prunePersisted()
    this.store.flushSeenMessages?.()
    this.store.flushConfigSnapshot?.()
    this.instanceLock.release()
    this.phase = 'stopped'
    this.notifyDrainWaitersIfQuiescent(true)
  }

  private notifyDrainWaitersIfQuiescent(force = false): void {
    if (this.drainWaiters.size === 0) return
    if (force || this.getLifecycleStatus().drained) {
      for (const wake of [...this.drainWaiters]) {
        wake()
      }
    }
  }

  // ── Diagnostics & Split-Brain ────────────────────────────────────────────

  getDiagnostics(): BridgeDiagnosticsPayload {
    return buildBridgeDiagnostics({
      store: this.store,
      botStatuses: this.listBotStatuses(),
      getTransportDiagnostics: (botId) => this.connections.getDiagnosticsSnapshot(botId),
      splitBrainAlerts: this.splitBrain.listAlerts(),
      instanceLock: this.instanceLock.status(),
      startedAtMs: this.startedAtMs,
    })
  }

  getObservability(options: {
    readonly window?: ObservabilityWindow
    readonly botId?: string
    readonly chatId?: string
    readonly refreshStorage?: boolean
  } = {}): Promise<ObservabilityPayload> {
    return this.observability.getPayload(options)
  }

  recordApiTiming(route: string, durationMs: number): void {
    this.observability.recordApiTiming(route, durationMs)
  }

  clearSplitBrainAlert(botId: string): boolean {
    return this.splitBrain.clearAlert(botId)
  }

  // ── Bot Connection & Directory Facade ────────────────────────────────────

  listBotStatuses(): LarkBotStatus[] {
    return this.connections.listBotStatuses()
  }

  async syncBot(
    botId: string,
    options: { readonly preserveLocalDescription?: boolean } = {},
  ): Promise<void> {
    this.inbound.cancelDisabledTurns(botId)
    await this.connections.syncBot(botId, options)
  }

  cancelDisabledTurns(botId: string, chatId?: string): number {
    return this.inbound.cancelDisabledTurns(botId, chatId)
  }

  ensureBotProfileHydrated(botId: string): Promise<void> {
    return this.connections.ensureBotProfileHydrated(botId)
  }

  syncBotProfile(botId: string): Promise<LarkBotProfile | undefined> {
    return this.connections.syncBotProfile(botId)
  }

  hydrateAllowedUserProfiles(bot: LarkBotConfig): Promise<SubstituteTarget[]> {
    return this.connections.hydrateAllowedUserProfiles(bot)
  }

  hydrateAdminUserProfiles(bot: LarkBotConfig): Promise<SubstituteTarget[]> {
    return this.connections.hydrateAdminUserProfiles(bot)
  }

  listGroupMembers(
    botId: string,
    chatId: string,
    options: { readonly includeAvatars?: boolean } = {},
  ): Promise<LarkChatMember[]> {
    return this.connections.listGroupMembers(botId, chatId, options)
  }

  searchUsers(botId: string, query: string): Promise<LarkUserSearchHit[]> {
    return this.connections.searchUsers(botId, query)
  }

  syncJoinedChats(targetBotId?: string): Promise<DiscoveredLarkChat[]> {
    return this.connections.syncJoinedChats(targetBotId)
  }

  startAutoCreateBot(rawBody: Record<string, unknown>): Promise<LarkQrJobView> {
    return this.connections.startAutoCreateBot(rawBody)
  }

  importExistingOpenPlatformBot(
    rawBody: Record<string, unknown>,
  ): Promise<{ readonly bot: LarkBotConfig; readonly eventSync?: LarkBaselineEventSyncResult }> {
    return this.connections.importExistingOpenPlatformBot(rawBody)
  }

  async syncGroupWorkspace(botId: string, chatId: string): Promise<void> {
    await this.workspaces.syncGroup(botId, chatId)
    await this.workspaces.reconcileBindings()
  }

  // ── Session Lifecycle Facade ─────────────────────────────────────────────

  unbindRoute(routeKey: string, options: { archive?: boolean } = {}): Promise<boolean> {
    this.triage.context.clearRoute(routeKey)
    return this.sessions.unbindRoute(routeKey, options)
  }

  sweepIdleBindings(now = Date.now()): Promise<number> {
    return this.sessions.sweepIdleBindings(now)
  }

  /**
   * Periodically flushes SQLite WAL frames in non-blocking PASSIVE mode during idle sweeps
   * and opportunistically truncates bloated WAL files when zero turns/tasks are in flight.
   */
  maybeCheckpointWal(now = Date.now()): boolean {
    if (this.disposed || this.phase === 'draining' || typeof this.store.checkpointWal !== 'function') {
      return false
    }
    try {
      const stats = this.store.getStorageStats()
      const elapsedMs = now - this.lastWalCheckpointAtMs
      const dueBySize = stats.walBytes >= WAL_PASSIVE_CHECKPOINT_THRESHOLD_BYTES
      const dueByTime = stats.walBytes > 0 && elapsedMs >= WAL_PERIODIC_CHECKPOINT_INTERVAL_MS
      if (!dueBySize && !dueByTime) return false

      const isIdle = this.getLifecycleStatus().totalInFlight === 0
      const result = this.store.checkpointWal({
        mode: 'PASSIVE',
        ...(isIdle ? { truncateAboveBytes: WAL_IDLE_TRUNCATE_THRESHOLD_BYTES } : {}),
      })
      this.lastWalCheckpointAtMs = now
      if (result.truncated && result.beforeWalBytes > result.afterWalBytes) {
        this.ctx.logger.info(
          `[lark-bridge] periodic WAL checkpoint truncated ${Math.round(result.beforeWalBytes / 1024)} KB -> ${Math.round(result.afterWalBytes / 1024)} KB`,
        )
      }
      return true
    } catch (err) {
      this.ctx.logger.warn(
        `[lark-bridge] periodic WAL checkpoint warning: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  recoverStalePendingTurns(botId?: string, nowMs = Date.now()): Promise<number> {
    return this.inbound.recoverStalePendingTurns(botId, nowMs)
  }

  listArchivedSessionIds(): string[] {
    return this.workspaces.listArchivedSessionIds()
  }

  // ── Web Origin & Session Handoff ─────────────────────────────────────────

  bindLiveWebOrigin(
    origin: string,
    connection?: { authenticatedUrl?: (baseUrl: string) => string },
  ): void {
    const clean = origin.trim().replace(/\/+$/, '')
    if (!clean) return
    this.liveWebOrigin = clean
    if (connection) {
      this.liveConnection = connection
    }
    if (!this.config.publicBaseUrl.trim()) {
      this.cliAuth.updateBaseUrl(clean)
    }
  }

  getLiveWebOrigin(): string {
    return this.liveWebOrigin
  }

  getAdvertisedWebOrigin(): string {
    return this.resolveWebBaseUrl()
  }

  sessionWebUrl(
    sessionId: string,
    options: { readonly allowGuestViewer?: boolean } = {},
  ): string {
    const base = this.resolveWebBaseUrl()
    if (this.shouldUseLoopbackSessionHandoff(base)) {
      return this.sessionHandoff.buildUrl(base, sessionId)
    }
    if (
      options.allowGuestViewer !== false &&
      !isLoopbackOrigin(base) &&
      this.sessionViewer.canViewSession(sessionId)
    ) {
      return this.sessionViewer.buildViewerUrl(base, sessionId)
    }
    return `${base}/#session=${encodeURIComponent(sessionId)}`
  }

  issueConsoleLoginLink(input: {
    readonly botId: string
    readonly botName: string
    readonly adminOpenId: string
  }): IssuedConsoleLoginLink | undefined {
    const base = this.resolveWebBaseUrl()
    if (!base) return undefined
    const conn =
      this.liveConnection ??
      (this.ctx.get('connection' as never) as { authenticatedUrl?: (url: string) => string } | undefined)
    if (typeof conn?.authenticatedUrl !== 'function') return undefined
    const ticket = this.consoleLogin.issue({
      ...input,
      ttlMs: DEFAULT_CONSOLE_LOGIN_TTL_MS,
    })
    return {
      url: this.consoleLogin.buildUrl(base, ticket.code),
      origin: base,
      expiresInSec: Math.round((ticket.expiresAtMs - ticket.createdAtMs) / 1000),
      expiresAtMs: ticket.expiresAtMs,
    }
  }

  // ── External Session Binding Persistence (durable ext:<id> -> sessionId) ─

  private resolveExternalSessionId(externalId: string): string | undefined {
    const clean = externalId.trim()
    if (!clean) return undefined
    const live = this.runtimes.resolveSessionIdByExternalId(clean)
    if (live) {
      if (typeof this.store.upsertExternalSessionLink === 'function') {
        try {
          this.store.upsertExternalSessionLink(clean, live)
        } catch {
          // Best-effort read-through cache into SQLite.
        }
      }
      return live
    }
    if (typeof this.store.resolveSessionIdByExternalId === 'function') {
      return this.store.resolveSessionIdByExternalId(clean)
    }
    return undefined
  }

  private recordExternalBindingEvent(sessionId: string, event: unknown): void {
    const rec = pluginRecordOf(event as never) as
      | { type?: string; data?: unknown; payload?: unknown }
      | undefined
    if (rec?.type !== EXTERNAL_BINDING_RECORD_TYPE) return
    const data = (rec.data ?? rec.payload) as { driver?: unknown; externalId?: unknown } | undefined
    const externalId = typeof data?.externalId === 'string' ? data.externalId.trim() : ''
    if (!externalId) return
    const driver = typeof data?.driver === 'string' ? data.driver.trim() : ''
    if (typeof this.store.upsertExternalSessionLink === 'function') {
      try {
        this.store.upsertExternalSessionLink(externalId, sessionId, driver)
      } catch {
        // Ignore persistence failures during shutdown/teardown.
      }
    }
  }

  private installExternalBindingPersistence(): () => void {
    if (typeof this.ctx.on !== 'function') return () => {}
    return this.ctx.on(
      'session/event' as never,
      ((session: Session, event: unknown) => {
        if (!session?.id) return
        this.recordExternalBindingEvent(String(session.id), event)
      }) as never,
    )
  }

  private async backfillExternalSessionLinks(): Promise<void> {
    if (
      typeof this.store.upsertExternalSessionLink !== 'function' ||
      typeof this.store.hasExternalSessionLinkForSession !== 'function'
    ) {
      return
    }
    const candidateIds = new Set<string>()
    for (const binding of this.store.listBindings()) {
      if (binding.sessionId) candidateIds.add(binding.sessionId)
    }
    for (const rem of this.store.listReminders('active')) {
      if (rem.lastSessionId) candidateIds.add(rem.lastSessionId)
    }
    if (candidateIds.size === 0) return

    const liveSessions = this.ctx.sessions as unknown as {
      get?: (id: SessionId) => Session | undefined
    }
    const persistence =
      typeof this.ctx.get === 'function'
        ? (this.ctx.get('sessionPersistence' as never) as SessionPersistence | undefined)
        : undefined

    for (const sid of candidateIds) {
      if (this.disposed) return
      if (this.store.hasExternalSessionLinkForSession(sid)) continue
      const live = liveSessions?.get?.(brandString<SessionId>(sid))
      if (live && typeof live.snapshotEvents === 'function') {
        for (const ev of live.snapshotEvents()) {
          this.recordExternalBindingEvent(sid, ev)
        }
        if (this.store.hasExternalSessionLinkForSession(sid)) continue
      }
      if (!persistence || typeof persistence.open !== 'function') continue
      try {
        const handle = await persistence.open(brandString<SessionId>(sid), 'read')
        try {
          const res = await handle.read(0, 60)
          for (const ev of res.events) {
            this.recordExternalBindingEvent(sid, ev)
          }
        } finally {
          await handle.close().catch(() => {})
        }
      } catch {
        // Ignore unreadable/archived sessions.
      }
    }
  }

  // ── Agent CLI Tool Facade ────────────────────────────────────────────────

  resolveCliSessionId(sessionId?: string): string | undefined {
    return this.facade.canonicalizeSessionId(sessionId)
  }

  resolveCliSessionIdentity(
    sessionId?: string,
    externalSessionId?: string,
  ): ResolvedCliSessionIdentity {
    return this.facade.resolveCliSessionIdentity(sessionId, externalSessionId)
  }

  resolveAgentContext(sessionId?: string, externalSessionId?: string) {
    return this.facade.resolveAgentContext(sessionId, externalSessionId)
  }

  agentSilenceTurn(input: {
    readonly sessionId?: string
    readonly externalSessionId?: string
    readonly reason?: string
  }) {
    return this.facade.agentSilenceTurn(input)
  }

  agentSend(input: AgentCliSendInput) {
    return this.facade.agentSend(input)
  }

  agentHistory(input: {
    readonly sessionId?: string
    readonly externalSessionId?: string
    readonly botId?: string
    readonly chatId?: string
    readonly threadId?: string
    readonly limit?: number
  }): Promise<{
    readonly botId: string
    readonly chatId: string
    readonly threadId?: string
    readonly messages: readonly LarkHistoryMessage[]
  }> {
    return this.facade.agentHistory(input)
  }

  agentGetMessage(input: {
    readonly sessionId?: string
    readonly externalSessionId?: string
    readonly botId?: string
    readonly messageId: string
    readonly downloadResources?: boolean
    readonly includeRaw?: boolean
  }): Promise<LarkMessageDetail | undefined> {
    return this.facade.agentGetMessage(input)
  }

  agentCreateSchedule(input: {
    readonly sessionId?: string
    readonly externalSessionId?: string
    readonly title: string
    readonly prompt: string
    readonly timing: ScheduleCreateInputLike['timing']
    readonly cwd?: string
    readonly agentPreset?: string
    readonly botId?: string
    readonly chatId?: string
    readonly deliveryMode?: LarkScheduleDeliveryMode
    readonly notifyOn?: LarkScheduleNotifyOn
  }) {
    return this.facade.agentCreateSchedule(input)
  }

  agentUpdateSchedule(
    scheduleId: string,
    input: {
      readonly title?: string
      readonly prompt?: string
      readonly timing?: ScheduleCreateInputLike['timing']
      readonly cwd?: string
      readonly agentPreset?: string
      readonly active?: boolean
    },
  ) {
    return this.facade.agentUpdateSchedule(scheduleId, input)
  }

  agentDeleteSchedule(scheduleId: string) {
    return this.facade.agentDeleteSchedule(scheduleId)
  }

  private shouldUseLoopbackSessionHandoff(base: string): boolean {
    if (!this.liveWebOrigin || !isLoopbackOrigin(base) || !isLoopbackOrigin(this.liveWebOrigin)) {
      return false
    }
    try {
      if (new URL(base).origin !== new URL(this.liveWebOrigin).origin) return false
    } catch {
      return false
    }
    const conn =
      this.liveConnection ??
      (this.ctx.get('connection' as never) as { authenticatedUrl?: (url: string) => string } | undefined)
    return typeof conn?.authenticatedUrl === 'function'
  }

  private resolveWebBaseUrl(): string {
    const explicit = this.config.publicBaseUrl.trim()
    if (explicit) return explicit.replace(/\/+$/, '')
    const webApp = this.ctx.get('webApp' as never) as { getAdvertisedUrl?: () => string } | undefined
    const advertised = webApp?.getAdvertisedUrl?.()?.trim()
    if (advertised) return advertised.replace(/\/+$/, '')
    const webServer = this.ctx.get('webServer' as never) as { getOrigin?: () => string } | undefined
    try {
      const origin = webServer?.getOrigin?.()?.trim()
      if (origin) return origin.replace(/\/+$/, '')
    } catch {
      // Listener may not be bound yet.
    }
    if (this.liveWebOrigin) return this.liveWebOrigin
    for (const list of Object.values(networkInterfaces())) {
      for (const addr of list ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return `http://${addr.address}:3880`
        }
      }
    }
    return 'http://127.0.0.1:3880'
  }
}
