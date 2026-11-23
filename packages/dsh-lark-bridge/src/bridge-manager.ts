import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  LarkPlatformManager,
  type DiscoveredLarkChat,
  type InboundLarkMessage,
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
import { AgentToolFacade, type AgentCliSendInput } from './agent-tool-facade.js'
import { BotConnectionPool } from './bot-connection-pool.js'
import { ensureCliAuthEndpoint, installLocalCliAndSkill, type CliAuthEndpoint } from './cli-support.js'
import { buildBridgeDiagnostics, type BridgeDiagnosticsPayload } from './diagnostics.js'
import { LarkDirectoryEnricher } from './directory-enrichment.js'
import { DreamingService } from './dreaming-service.js'
import { InboundPipeline } from './inbound-pipeline.js'
import { InstanceLock } from './instance-lock.js'
import { ProactiveReminderService } from './reminder-service.js'
import { RuntimeCatalog } from './runtime-catalog.js'
import { ScheduleNotifier, type ScheduleCreateInputLike } from './schedule-notifier.js'
import { SessionCoordinator } from './session-coordinator.js'
import { LoopbackSessionHandoff, isLoopbackOrigin } from './session-handoff.js'
import { SessionTitleGuard } from './session-title-guard.js'
import { LarkSessionViewerService } from './session-viewer.js'
import type { SplitBrainDetector } from './split-brain-detector.js'
import type { LarkBridgeStore } from './store.js'
import { runTurnAndCollectReply } from './turn-runner.js'
import type {
  LarkBridgeConfig,
  LarkScheduleDeliveryMode,
  LarkScheduleNotifyOn,
} from './types.js'
import { WorkspaceGrouping } from './workspace-grouping.js'

export type { AgentCliSendInput } from './agent-tool-facade.js'

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
  readonly dreaming: DreamingService
  readonly reminders: ProactiveReminderService
  readonly platform: LarkPlatformManager
  readonly cliAuth: CliAuthEndpoint
  readonly sessionHandoff = new LoopbackSessionHandoff()
  readonly sessionViewer: LarkSessionViewerService
  readonly connections: BotConnectionPool
  readonly sessions: SessionCoordinator
  readonly inbound: InboundPipeline
  readonly facade: AgentToolFacade
  readonly titleGuard: SessionTitleGuard
  readonly splitBrain: SplitBrainDetector

  private readonly instanceLock: InstanceLock
  private readonly directoryEnricher: LarkDirectoryEnricher
  private readonly workspaces: WorkspaceGrouping
  private readonly shutdownController = new AbortController()
  private readonly disposers: Array<() => void> = []
  private readonly startedAtMs = Date.now()
  private liveWebOrigin = ''
  private liveConnection?: { authenticatedUrl?: (baseUrl: string) => string }
  private idleTimer: ReturnType<typeof setInterval> | null = null
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
      onCardAction: async (action) => {
        const toast = await this.reminders.handleCardAction(action.actionValue, {
          ...(action.operatorOpenId ? { operatorOpenId: action.operatorOpenId } : {}),
        })
        return toast ? { toast } : undefined
      },
      onBotReady: (botId) => {
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

    this.inbound = new InboundPipeline({
      ctx,
      store,
      runtimes: this.runtimes,
      connections: this.connections,
      sessions: this.sessions,
      titleGuard: this.titleGuard,
      shutdownSignal: this.shutdownController.signal,
      isDisposed: () => this.disposed,
      sessionWebUrl: (sid) => this.sessionWebUrl(sid),
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
    })

    this.schedules = new ScheduleNotifier({
      ctx,
      store,
      workspaces: this.workspaces,
      getBotOpenId: (botId) => this.connections.getTransport(botId)?.state.botOpenId,
      sendScheduleMessage: (input) => this.facade.sendScheduleMessage(input),
    })

    this.dreaming = new DreamingService({
      ctx,
      dataDir: config.dataDir,
      store,
      runtimes: this.runtimes,
      workspaces: this.workspaces,
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
      runTurn: (agent, content) =>
        runTurnAndCollectReply(this.ctx, agent, content, {
          signal: this.shutdownController.signal,
        }),
      sendOriginCard: (origin, card) => this.facade.sendOriginCard(origin, card),
      patchOriginCard: (botId, messageId, card) =>
        this.facade.patchOriginCard(botId, messageId, card),
      deliverReminderOutput: (input) => this.facade.deliverReminderOutput(input),
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
    if (this.config.enableInstanceLock !== false) {
      const lockStatus = this.instanceLock.acquire()
      if (lockStatus.recoveredStaleLock) {
        this.ctx.logger.warn(
          `[lark-bridge] recovered stale instance lock from PID=${lockStatus.recoveredStaleLock.pid} (${lockStatus.recoveredStaleLock.host})`,
        )
      }
    }

    this.sessionViewer.attachToHost()
    if (this.config.autoInstallCliAndSkill !== false) {
      installLocalCliAndSkill(this.config.dataDir, this.cliAuth.endpointFile, this.ctx.logger)
    }

    this.schedules.start()
    this.dreaming.start(this.config.idleSweepIntervalMs > 0 ? 60_000 : 0)
    await this.reminders.recoverStaleRunningReminders().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] stale reminder recovery warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    this.reminders.start(this.config.idleSweepIntervalMs > 0 ? 30_000 : 0)
    this.disposers.push(this.titleGuard.install())
    await this.workspaces.reconcileBindings()

    await this.connections.startAllEnabled()

    await this.inbound.recoverStalePendingTurns().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] stale pending turn recovery warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    void this.schedules.refreshScheduleContextCache()
    void this.titleGuard.reconcileHistoricalSessions().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] historical session reconciliation warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    if (this.config.idleSweepIntervalMs > 0) {
      this.idleTimer = setInterval(
        () => void this.sweepIdleBindings(),
        this.config.idleSweepIntervalMs,
      )
      this.idleTimer.unref?.()
    }
  }

  async stop(): Promise<void> {
    this.disposed = true
    this.shutdownController.abort()
    await this.inbound.cleanupActiveTurnsOnShutdown()
    this.sessionHandoff.dispose()
    this.sessionViewer.dispose()
    this.schedules.stop()
    this.dreaming.stop()
    await this.reminders.stop()
    while (this.disposers.length > 0) {
      this.disposers.pop()?.()
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    await this.connections.stopAll()
    await this.sessions.disposeAll()
    this.store.flushSeenMessages?.()
    this.store.flushConfigSnapshot?.()
    this.instanceLock.release()
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

  clearSplitBrainAlert(botId: string): boolean {
    return this.splitBrain.clearAlert(botId)
  }

  // ── Bot Connection & Directory Facade ────────────────────────────────────

  listBotStatuses(): LarkBotStatus[] {
    return this.connections.listBotStatuses()
  }

  syncBot(
    botId: string,
    options: { readonly preserveLocalDescription?: boolean } = {},
  ): Promise<void> {
    return this.connections.syncBot(botId, options)
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

  importExistingOpenPlatformBot(rawBody: Record<string, unknown>): Promise<LarkBotConfig> {
    return this.connections.importExistingOpenPlatformBot(rawBody)
  }

  async syncGroupWorkspace(botId: string, chatId: string): Promise<void> {
    await this.workspaces.syncGroup(botId, chatId)
    await this.workspaces.reconcileBindings()
  }

  // ── Session Lifecycle Facade ─────────────────────────────────────────────

  unbindRoute(routeKey: string, options: { archive?: boolean } = {}): Promise<boolean> {
    return this.sessions.unbindRoute(routeKey, options)
  }

  sweepIdleBindings(now = Date.now()): Promise<number> {
    return this.sessions.sweepIdleBindings(now)
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

  sessionWebUrl(sessionId: string): string {
    const base = this.resolveWebBaseUrl()
    if (this.shouldUseLoopbackSessionHandoff(base)) {
      return this.sessionHandoff.buildUrl(base, sessionId)
    }
    if (!isLoopbackOrigin(base) && this.sessionViewer.canViewSession(sessionId)) {
      return this.sessionViewer.buildViewerUrl(base, sessionId)
    }
    return `${base}/#session=${encodeURIComponent(sessionId)}`
  }

  // ── Agent CLI Tool Facade ────────────────────────────────────────────────

  resolveAgentContext(sessionId?: string) {
    return this.facade.resolveAgentContext(sessionId)
  }

  agentSilenceTurn(input: { readonly sessionId?: string; readonly reason?: string }) {
    return this.facade.agentSilenceTurn(input)
  }

  agentSend(input: AgentCliSendInput) {
    return this.facade.agentSend(input)
  }

  agentHistory(input: {
    readonly sessionId?: string
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
    readonly botId?: string
    readonly messageId: string
    readonly downloadResources?: boolean
    readonly includeRaw?: boolean
  }): Promise<LarkMessageDetail | undefined> {
    return this.facade.agentGetMessage(input)
  }

  agentCreateSchedule(input: {
    readonly sessionId?: string
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
