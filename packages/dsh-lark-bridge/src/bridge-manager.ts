import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord,
  pluginRecordOf,
  type Session,
  type SessionEvent,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  LarkBotTransport,
  LarkPlatformManager,
  MessageDeduplicator,
  buildLarkPostPayload,
  buildReplyCard,
  buildRouteKey,
  composeLarkContextReminder,
  composeProactiveSessionReminder,
  composeTurnPrompt,
  decideLarkRouting,
  expandWorkingDir,
  extractPureUserIntent,
  hasInjectedPromptMarkup,
  normalizeReplyText,
  resolveEffectiveAgentRuntime,
  resolveEffectiveCardBot,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  slugifyBotId,
  trimInvisibleText,
  type DiscoveredLarkChat,
  type GroupReplyMode,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotProfile,
  type LarkBotStatus,
  type LarkChatMember,
  type LarkGroupConfig,
  type LarkHistoryMessage,
  type LarkMessageDetail,
  type LarkQrJobView,
  type LarkReminderItem,
  type LarkReminderOrigin,
  type LarkUserSearchHit,
  type ReplyCardImage,
  type SendLarkReplyResult,
  type SubstituteTarget,
} from '@dsh-lark/lark-core'
import {
  ensureCliAuthEndpoint,
  installLocalCliAndSkill,
  type CliAuthEndpoint,
} from './cli-support.js'
import { LarkDirectoryEnricher } from './directory-enrichment.js'
import { DreamingService } from './dreaming-service.js'
import { assertExistingWorkingDirectory } from './fs-browser.js'
import { ProactiveReminderService } from './reminder-service.js'
import { RuntimeCatalog } from './runtime-catalog.js'
import { ScheduleNotifier, type ScheduleCreateInputLike } from './schedule-notifier.js'
import { LoopbackSessionHandoff, isLoopbackOrigin } from './session-handoff.js'
import { LarkSessionViewerService } from './session-viewer.js'
import { handleSlashCommand } from './slash-commands.js'
import type { LarkBridgeStore } from './store.js'
import { TurnAbortedError, runTurnAndCollectReply } from './turn-runner.js'
import {
  LARK_ORIGIN_RECORD_TYPE,
  type LarkBridgeConfig,
  type LarkPendingTurn,
  type LarkScheduleDeliveryMode,
  type LarkScheduleNotifyOn,
  type LarkScheduleTarget,
  type LarkSessionBinding,
} from './types.js'
import { WorkspaceGrouping } from './workspace-grouping.js'

type AgentDecision = Extract<ReturnType<typeof decideLarkRouting>, { action: 'agent' }>

interface ManagedTransport {
  readonly config: LarkBotConfig
  readonly transport: LarkBotTransport
}

interface AcquiredAgent {
  readonly agent: Agent
  readonly sessionId: string
  readonly isNew: boolean
  readonly disposeAfter: boolean
}

interface ActiveTurnRecord {
  readonly id: string
  readonly botId: string
  readonly chatId: string
  readonly chatName?: string
  readonly messageId: string
  readonly routeKey: string
  readonly replyMode: GroupReplyMode
  readonly trigger: string
  readonly allowSilentEmptyReply: boolean
  readonly reactionId?: string
  readonly startedAtMs: number
  readonly transport: LarkBotTransport
  sessionId?: string
  intermediateSentCount: number
  settled: boolean
  reactionRemoved: boolean
}

const SHUTDOWN_TURN_CLEANUP_TIMEOUT_MS = 5_000
const STALE_PENDING_TURN_MAX_AGE_MS = 24 * 60 * 60_000

export interface AgentCliSendInput {
  readonly sessionId?: string
  readonly botId?: string
  readonly chatId?: string
  readonly userOpenId?: string
  readonly replyToMessageId?: string
  readonly replyInThread?: boolean
  readonly title?: string
  readonly text?: string
  readonly textOnly?: boolean
  readonly card?: Record<string, unknown>
  readonly mentions?: readonly { openId: string; name?: string }[]
  readonly images?: readonly { fileName?: string; dataBase64: string; alt?: string; mode?: ReplyCardImage['mode'] }[]
  readonly files?: readonly { fileName: string; dataBase64: string }[]
}

const DEFAULT_HISTORICAL_ARCHIVE_MS = 60 * 60_000

function extractMessageScope(routeKey: string): string | undefined {
  const parts = routeKey.split(':')
  const scope = parts.slice(2).join(':')
  return scope.startsWith('om_') ? scope : undefined
}

function extractBindingReplyAnchor(
  binding: Pick<LarkSessionBinding, 'routeKey' | 'aliasRouteKeys'>,
): string | undefined {
  if (binding.aliasRouteKeys) {
    for (let i = binding.aliasRouteKeys.length - 1; i >= 0; i -= 1) {
      const candidate = extractMessageScope(binding.aliasRouteKeys[i]!)
      if (candidate) return candidate
    }
  }
  return extractMessageScope(binding.routeKey)
}

/**
 * Owns Lark long connections, Open Platform & OAuth workflows, engineered
 * `<system_reminder>` injection, CLI auth & agent endpoints, and session lifecycle.
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
  private readonly directoryEnricher: LarkDirectoryEnricher
  private readonly transports = new Map<string, ManagedTransport>()
  /** Serializes concurrent `syncBot(botId)` calls so a bot never spawns duplicate WSClients. */
  private readonly botSyncQueues = new Map<string, Promise<void>>()
  /** Live DSH agent handles keyed by `sessionId` (decoupled from route aliases). */
  private readonly handles = new Map<string, AgentHandle>()
  /** Serializes concurrent first-turn session creations for the same routeKey. */
  private readonly pendingAcquires = new Map<string, Promise<AcquiredAgent>>()
  /** Serializes concurrent agent turns targeting the same sessionId in FIFO order. */
  private readonly sessionTurnQueues = new Map<string, Promise<void>>()
  private readonly inFlightTurns = new Map<string, number>()
  private readonly activeTurns = new Map<string, ActiveTurnRecord>()
  private readonly shutdownController = new AbortController()
  private readonly dedup = new MessageDeduplicator()
  private readonly workspaces: WorkspaceGrouping
  private readonly disposers: Array<() => void> = []
  private readonly preserveLocalDescriptionBots = new Set<string>()
  private readonly hydratedProfileBots = new Set<string>()
  private liveWebOrigin = ''
  private liveConnection?: { authenticatedUrl?: (baseUrl: string) => string }
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: LarkBridgeConfig,
    readonly store: LarkBridgeStore,
  ) {
    this.dedup.hydrate(store.listSeenMessages?.() ?? [])
    this.runtimes = new RuntimeCatalog(ctx)
    this.workspaces = new WorkspaceGrouping(ctx, store)
    this.platform = new LarkPlatformManager(config.dataDir)
    this.sessionViewer = new LarkSessionViewerService(ctx, store)
    this.directoryEnricher = new LarkDirectoryEnricher(this.platform, () => this.store.listBots())
    this.cliAuth = ensureCliAuthEndpoint(config.dataDir, config.publicBaseUrl)
    this.schedules = new ScheduleNotifier({
      ctx,
      store,
      workspaces: this.workspaces,
      getBotOpenId: (botId) => this.transports.get(botId)?.transport.state.botOpenId,
      sendScheduleMessage: (input) => this.sendScheduleMessage(input),
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
      sendOriginCard: (origin, card) => this.sendOriginCard(origin, card),
      patchOriginCard: (botId, messageId, card) => this.patchOriginCard(botId, messageId, card),
      deliverReminderOutput: (input) => this.deliverReminderOutput(input),
    })
  }

  async start(): Promise<void> {
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
    this.installSessionTitleGuard()
    await this.workspaces.reconcileBindings()

    for (const bot of this.store.listBots()) {
      if (!bot.enabled) continue
      await this.startBot(bot).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this.ctx.logger.error(`[lark-bridge] failed to start bot "${bot.name}": ${message}`)
        this.store.recordEvent({ botId: bot.id, kind: 'error', summary: `启动失败：${message}` })
      })
    }

    await this.recoverStalePendingTurns().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] stale pending turn recovery warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    void this.schedules.refreshScheduleContextCache()
    void this.reconcileHistoricalSessions().catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] historical session reconciliation warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    if (this.config.idleSweepIntervalMs > 0) {
      this.idleTimer = setInterval(() => void this.sweepIdleBindings(), this.config.idleSweepIntervalMs)
      this.idleTimer.unref?.()
    }
  }

  async stop(): Promise<void> {
    this.disposed = true
    this.shutdownController.abort()
    await this.cleanupActiveTurnsOnShutdown()
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
    await Promise.all([...this.transports.values()].map((m) => m.transport.stop().catch(() => {})))
    this.transports.clear()
    await Promise.all([...this.handles.values()].map((h) => h.dispose().catch(() => {})))
    this.handles.clear()
    this.store.flushSeenMessages?.()
    this.store.flushConfigSnapshot?.()
  }

  async recoverStalePendingTurns(botId?: string, nowMs = Date.now()): Promise<number> {
    const stale = this.store.listPendingTurns().filter((item) => {
      if (botId && item.botId !== botId) return false
      return !this.activeTurns.has(item.id)
    })
    if (stale.length === 0) return 0

    let recovered = 0
    for (const item of stale) {
      const transport = this.transports.get(item.botId)?.transport
      if (!transport) {
        const bot = this.store.getBot(item.botId)
        const expired = nowMs - item.startedAtMs > STALE_PENDING_TURN_MAX_AGE_MS
        if (!bot?.enabled || expired) {
          this.store.deletePendingTurn(item.id)
          this.store.recordEvent({
            botId: item.botId,
            chatId: item.chatId,
            ...(item.chatName ? { chatName: item.chatName } : {}),
            routeKey: item.routeKey,
            ...(item.sessionId ? { sessionId: item.sessionId } : {}),
            kind: 'error',
            summary: '本轮执行因服务重启中断',
          })
          recovered += 1
        }
        continue
      }

      this.store.deletePendingTurn(item.id)
      await this.deliverInterruptedTurnCleanup({
        transport,
        turn: item,
        intermediateSentCount: 0,
        auditSummary: '本轮执行因服务重启中断',
        replyText: '本轮执行因服务重启中断，可重新回复继续。',
      })
      recovered += 1
    }
    return recovered
  }

  private registerActiveTurn(
    input: Omit<ActiveTurnRecord, 'id' | 'intermediateSentCount' | 'settled' | 'reactionRemoved'>,
  ): ActiveTurnRecord {
    const record: ActiveTurnRecord = {
      id: randomUUID(),
      ...input,
      intermediateSentCount: 0,
      settled: false,
      reactionRemoved: false,
    }
    this.activeTurns.set(record.id, record)
    this.persistActiveTurn(record)
    return record
  }

  private persistActiveTurn(record: ActiveTurnRecord): void {
    if (record.settled || this.disposed) return
    this.store.upsertPendingTurn({
      id: record.id,
      botId: record.botId,
      chatId: record.chatId,
      ...(record.chatName ? { chatName: record.chatName } : {}),
      messageId: record.messageId,
      routeKey: record.routeKey,
      replyMode: record.replyMode,
      trigger: record.trigger,
      allowSilentEmptyReply: record.allowSilentEmptyReply,
      ...(record.reactionId ? { reactionId: record.reactionId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      startedAtMs: record.startedAtMs,
    })
  }

  private claimActiveTurn(record: ActiveTurnRecord): boolean {
    if (record.settled) return false
    record.settled = true
    this.activeTurns.delete(record.id)
    this.store.deletePendingTurn(record.id)
    return true
  }

  private shouldNotifyInterruptedTurn(
    turn: Pick<LarkPendingTurn, 'trigger' | 'allowSilentEmptyReply'>,
    intermediateSentCount = 0,
  ): boolean {
    if (turn.trigger === 'listener' && turn.allowSilentEmptyReply && intermediateSentCount === 0) {
      return false
    }
    return true
  }

  private async deliverInterruptedTurnCleanup(input: {
    readonly transport: LarkBotTransport
    readonly turn: Pick<
      LarkPendingTurn,
      | 'botId'
      | 'chatId'
      | 'chatName'
      | 'messageId'
      | 'routeKey'
      | 'replyMode'
      | 'trigger'
      | 'allowSilentEmptyReply'
      | 'reactionId'
      | 'sessionId'
    >
    readonly intermediateSentCount: number
    readonly auditSummary: string
    readonly replyText: string
    readonly removeReaction?: boolean
  }): Promise<void> {
    const { transport, turn, intermediateSentCount, auditSummary, replyText } = input
    const tasks: Array<Promise<unknown>> = []
    if (input.removeReaction !== false && turn.reactionId) {
      tasks.push(transport.removeReaction(turn.messageId, turn.reactionId).catch(() => {}))
    }
    this.store.recordMetric({ botId: turn.botId, chatId: turn.chatId, kind: 'error' })
    this.store.recordEvent({
      botId: turn.botId,
      chatId: turn.chatId,
      ...(turn.chatName ? { chatName: turn.chatName } : {}),
      routeKey: turn.routeKey,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      kind: 'error',
      summary: auditSummary,
    })
    if (this.shouldNotifyInterruptedTurn(turn, intermediateSentCount)) {
      tasks.push(
        transport
          .sendReply({
            chatId: turn.chatId,
            replyToMessageId: turn.messageId,
            replyMode: turn.replyMode,
            text: replyText,
          })
          .catch(() => {}),
      )
    }
    await Promise.all(tasks)
  }

  private async cleanupActiveTurnsOnShutdown(): Promise<void> {
    const claimed: ActiveTurnRecord[] = []
    for (const record of this.activeTurns.values()) {
      if (record.settled) continue
      record.settled = true
      record.reactionRemoved = true
      claimed.push(record)
    }
    this.activeTurns.clear()
    for (const record of claimed) {
      this.store.deletePendingTurn(record.id)
    }
    if (claimed.length === 0) return

    const work = Promise.all(
      claimed.map((record) =>
        this.deliverInterruptedTurnCleanup({
          transport: record.transport,
          turn: record,
          intermediateSentCount: record.intermediateSentCount,
          auditSummary: '本轮执行因服务重载或停机已中断',
          replyText: '本轮执行因服务重载或停机已中断，可重新回复继续。',
        }),
      ),
    )

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_TURN_CLEANUP_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  listBotStatuses(): LarkBotStatus[] {
    const bindings = this.store.listBindings()
    return this.store.listBots().map((bot) => {
      const state = this.transports.get(bot.id)?.transport.state
      const avatarUrl = state?.avatarUrl || bot.avatarUrl || undefined
      return {
        botId: bot.id,
        larkAppId: bot.larkAppId,
        name: bot.name,
        ...(avatarUrl ? { avatarUrl } : {}),
        enabled: bot.enabled,
        connected: state?.connected ?? false,
        ...(state?.botOpenId ? { botOpenId: state.botOpenId } : {}),
        ...(state?.startedAtMs ? { startedAtMs: state.startedAtMs } : {}),
        ...(state?.lastEventAtMs ? { lastEventAtMs: state.lastEventAtMs } : {}),
        ...(state?.lastError ? { lastError: state.lastError } : {}),
        activeBindings: bindings.filter((b) => b.botId === bot.id).length,
      }
    })
  }

  async hydrateAllowedUserProfiles(bot: LarkBotConfig): Promise<SubstituteTarget[]> {
    return this.hydrateUserProfiles(bot, bot.allowedUsers, bot.allowedUserProfiles, 'allowedUserProfiles')
  }

  async hydrateAdminUserProfiles(bot: LarkBotConfig): Promise<SubstituteTarget[]> {
    return this.hydrateUserProfiles(bot, bot.adminUsers, bot.adminUserProfiles, 'adminUserProfiles')
  }

  private async hydrateUserProfiles(
    bot: LarkBotConfig,
    userIds: readonly string[],
    existingProfiles: readonly SubstituteTarget[],
    profileField: 'allowedUserProfiles' | 'adminUserProfiles',
  ): Promise<SubstituteTarget[]> {
    if (userIds.length === 0) return []
    const byId = new Map<string, SubstituteTarget>()
    for (const p of existingProfiles) byId.set(p.openId, p)
    for (const p of [...bot.allowedUserProfiles, ...bot.adminUserProfiles, ...bot.substituteMode.targets]) {
      const prev = byId.get(p.openId)
      if (!prev || (!prev.avatarUrl && p.avatarUrl)) byId.set(p.openId, { ...prev, ...p })
    }

    const liveTransport = this.transports.get(bot.id)?.transport
    let mutated = false
    const result: SubstituteTarget[] = []
    for (const openId of userIds) {
      let profile = byId.get(openId)
      if ((!profile || !profile.avatarUrl) && liveTransport) {
        const resolved = await liveTransport
          .resolveUserSummary(openId, profile?.name !== openId ? profile?.name : undefined)
          .catch(() => undefined)
        if (resolved && (resolved.name !== openId || resolved.avatarUrl)) {
          const nextProfile: SubstituteTarget = {
            ...(profile ?? {}),
            ...resolved,
          }
          if (
            !profile ||
            profile.name !== nextProfile.name ||
            profile.avatarUrl !== nextProfile.avatarUrl
          ) {
            profile = nextProfile
            mutated = true
          }
        }
      }
      if (profile && !profile.avatarUrl && profile.name && !profile.name.startsWith('ou_')) {
        const dirHits = await this.directoryEnricher.searchByQueries([profile.name], bot.id)
        const matched =
          dirHits.find((h) => h.openId === openId && h.avatarUrl) ??
          (() => {
            const byName = dirHits.filter((h) => h.name === profile!.name && h.avatarUrl)
            return byName.length === 1 ? byName[0] : undefined
          })()
        if (matched?.avatarUrl) {
          profile = {
            ...profile,
            ...(matched.email && !profile.email ? { email: matched.email } : {}),
            avatarUrl: matched.avatarUrl,
          }
          mutated = true
        }
      }
      result.push(profile ?? { openId, name: openId })
    }

    if (mutated) {
      const latestBot = this.store.getBot(bot.id) ?? bot
      this.store.upsertBot({
        ...latestBot,
        [profileField]: result.filter((p) => p.name !== p.openId),
      })
    }
    return result
  }

  private async resolveNewBotRuntimeDefaults(rawBody: Record<string, unknown>): Promise<{
    readonly defaultWorkingDir: string
    readonly workspaceName: string
    readonly agentPreset: string
    readonly runtimeProfileId?: string
    readonly model?: string
    readonly reasoningEffort?: string
  }> {
    const workspaceName =
      typeof rawBody.workspaceName === 'string' ? rawBody.workspaceName.trim() : ''
    const defaultWorkingDir =
      (typeof rawBody.defaultWorkingDir === 'string' && rawBody.defaultWorkingDir.trim()) || '~'
    assertExistingWorkingDirectory(defaultWorkingDir)
    const requestedPreset =
      typeof rawBody.agentPreset === 'string' ? rawBody.agentPreset.trim() : ''
    let agentPreset = requestedPreset
    if (!agentPreset) {
      const availableRuntimes = await this.runtimes.list().catch(() => [])
      agentPreset =
        availableRuntimes.find((r) => r.isDefault)?.id ?? availableRuntimes[0]?.id ?? 'standard'
    }
    const runtimeProfileId =
      typeof rawBody.runtimeProfileId === 'string' && rawBody.runtimeProfileId.trim()
        ? rawBody.runtimeProfileId.trim()
        : undefined
    const model =
      typeof rawBody.model === 'string' && rawBody.model.trim() ? rawBody.model.trim() : undefined
    const reasoningEffort =
      typeof rawBody.reasoningEffort === 'string' && rawBody.reasoningEffort.trim()
        ? rawBody.reasoningEffort.trim()
        : undefined
    return {
      defaultWorkingDir,
      workspaceName,
      agentPreset,
      ...(runtimeProfileId ? { runtimeProfileId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }

  private allocateUniqueBotId(baseId: string, larkAppId: string): string {
    let finalId = baseId
    let suffix = 2
    while (this.store.getBot(finalId) && this.store.getBot(finalId)?.larkAppId !== larkAppId) {
      finalId = `${baseId}-${suffix}`
      suffix += 1
    }
    return finalId
  }

  async startAutoCreateBot(rawBody: Record<string, unknown>): Promise<LarkQrJobView> {
    const mode = rawBody.mode === 'device_flow' ? 'device_flow' : 'open_platform'
    const name = typeof rawBody.name === 'string' ? rawBody.name.trim() : ''
    const description = typeof rawBody.description === 'string' ? rawBody.description.trim() : ''
    const requestedId = typeof rawBody.id === 'string' ? rawBody.id.trim() : ''
    const defaults = await this.resolveNewBotRuntimeDefaults(rawBody)

    return this.platform.startAutoCreateBot(
      {
        mode,
        ...(requestedId ? { id: requestedId } : {}),
        name,
        description,
      },
      async (created) => {
        const finalId = this.allocateUniqueBotId(created.id, created.larkAppId)
        const saved = this.store.upsertBot({
          id: finalId,
          name: created.name,
          description: created.description,
          larkAppId: created.larkAppId,
          larkAppSecret: created.larkAppSecret,
          enabled: true,
          defaultWorkingDir: defaults.defaultWorkingDir,
          workspaceName: defaults.workspaceName,
          agentPreset: defaults.agentPreset,
          ...(defaults.runtimeProfileId ? { runtimeProfileId: defaults.runtimeProfileId } : {}),
          ...(defaults.model ? { model: defaults.model } : {}),
          ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
        })
        await this.syncBot(saved.id)
      },
    )
  }

  async importExistingOpenPlatformBot(rawBody: Record<string, unknown>): Promise<LarkBotConfig> {
    const larkAppId = typeof rawBody.larkAppId === 'string' ? rawBody.larkAppId.trim() : ''
    if (!larkAppId) {
      throw new Error('请选择要接入的飞书应用')
    }
    const existing = this.store.listBots().find((b) => b.larkAppId === larkAppId)
    if (existing) {
      throw new Error(`该飞书应用已接入为智能体「${existing.name}」`)
    }
    const defaults = await this.resolveNewBotRuntimeDefaults(rawBody)
    const creds = await this.platform.fetchOpenPlatformAppCredentials(larkAppId)
    const requestedId = typeof rawBody.id === 'string' ? rawBody.id.trim() : ''
    const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : ''
    const requestedDescription =
      typeof rawBody.description === 'string' ? rawBody.description.trim() : ''
    const name = requestedName || creds.name || larkAppId
    const description = requestedDescription || creds.description || ''
    const baseId = requestedId || slugifyBotId(name, larkAppId)
    const finalId = this.allocateUniqueBotId(baseId, creds.appId)

    const saved = this.store.upsertBot({
      id: finalId,
      name,
      description,
      avatarUrl: creds.avatarUrl ?? '',
      larkAppId: creds.appId,
      larkAppSecret: creds.appSecret,
      enabled: true,
      defaultWorkingDir: defaults.defaultWorkingDir,
      workspaceName: defaults.workspaceName,
      agentPreset: defaults.agentPreset,
      ...(defaults.runtimeProfileId ? { runtimeProfileId: defaults.runtimeProfileId } : {}),
      ...(defaults.model ? { model: defaults.model } : {}),
      ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    })
    await this.syncBot(saved.id)
    if (!saved.description.trim() || !saved.avatarUrl.trim()) {
      await this.ensureBotProfileHydrated(saved.id)
    }
    return this.store.getBot(saved.id) ?? saved
  }

  async syncBot(
    botId: string,
    options: { readonly preserveLocalDescription?: boolean } = {},
  ): Promise<void> {
    const prev = this.botSyncQueues.get(botId) ?? Promise.resolve()
    const run = prev
      .catch(() => {})
      .then(() => this.syncBotSerialized(botId, options))
    this.botSyncQueues.set(botId, run)
    try {
      await run
    } finally {
      if (this.botSyncQueues.get(botId) === run) {
        this.botSyncQueues.delete(botId)
      }
    }
  }

  private async syncBotSerialized(
    botId: string,
    options: { readonly preserveLocalDescription?: boolean } = {},
  ): Promise<void> {
    const existing = this.transports.get(botId)
    if (existing) {
      this.transports.delete(botId)
      await existing.transport.stop().catch(() => {})
    }
    const bot = this.store.getBot(botId)
    if (!bot || this.disposed) return
    await this.workspaces.syncBot(bot)
    await this.workspaces.reconcileBindings()
    if (bot.enabled && !this.disposed) {
      if (options.preserveLocalDescription) {
        this.preserveLocalDescriptionBots.add(botId)
      }
      try {
        await this.startBot(bot)
      } finally {
        this.preserveLocalDescriptionBots.delete(botId)
      }
    }
  }

  async ensureBotProfileHydrated(botId: string): Promise<void> {
    if (this.hydratedProfileBots.has(botId)) return
    const bot = this.store.getBot(botId)
    if (!bot) return
    if (bot.avatarUrl.trim() && bot.description.trim()) {
      this.hydratedProfileBots.add(botId)
      return
    }
    this.hydratedProfileBots.add(botId)
    await this.syncBotProfile(botId).catch(() => undefined)
  }

  async syncBotProfile(botId: string): Promise<LarkBotProfile | undefined> {
    const bot = this.store.getBot(botId)
    if (!bot) return undefined
    const transport = this.transportFor(bot)
    const remote = await transport.fetchBotProfile()
    const fallback =
      !remote.description || !remote.avatarUrl
        ? await this.platform.fetchBotAppProfile(bot.larkAppId)
        : undefined
    const merged: LarkBotProfile = {
      ...(remote.openId ? { openId: remote.openId } : {}),
      ...(remote.name || fallback?.name ? { name: remote.name || fallback?.name } : {}),
      ...(remote.avatarUrl || fallback?.avatarUrl
        ? { avatarUrl: remote.avatarUrl || fallback?.avatarUrl }
        : {}),
      ...(remote.description || fallback?.description
        ? { description: remote.description || fallback?.description }
        : {}),
    }
    this.hydratedProfileBots.add(botId)
    this.store.updateBotProfile(botId, merged)
    return merged
  }

  async listGroupMembers(
    botId: string,
    chatId: string,
    options: { readonly includeAvatars?: boolean } = {},
  ): Promise<LarkChatMember[]> {
    const bot = this.store.getBot(botId)
    if (!bot) return []
    const includeAvatars = options.includeAvatars !== false
    const uat = includeAvatars
      ? await this.platform.getValidUserAccessToken(bot.id, bot.larkAppId, bot.larkAppSecret)
      : undefined
    return this.transportFor(bot).listChatMembersAndBots(chatId, {
      ...(uat ? { userAccessToken: uat } : {}),
      ...(includeAvatars
        ? {
            userDirectoryLookup: (queries) => this.directoryEnricher.searchByQueries(queries, bot.id),
            resolveBotAvatar: async (groupBot) => {
              const allBots = this.store.listBots()
              const peer = allBots.find((candidate) => {
                if (groupBot.larkAppId && candidate.larkAppId === groupBot.larkAppId) return true
                const st = this.transports.get(candidate.id)?.transport.state
                if (st?.botOpenId && st.botOpenId === groupBot.openId) return true
                if (st?.remoteBotName && st.remoteBotName === groupBot.name) return true
                return candidate.name === groupBot.name
              })
              if (peer) {
                if (!peer.avatarUrl) {
                  await this.ensureBotProfileHydrated(peer.id)
                }
                const refreshedPeer = this.store.getBot(peer.id) ?? peer
                const peerAvatar =
                  this.transports.get(peer.id)?.transport.state.avatarUrl || refreshedPeer.avatarUrl
                if (peerAvatar) return peerAvatar
              }
              return this.directoryEnricher.resolveAppAvatar(groupBot.larkAppId)
            },
          }
        : {}),
    })
  }

  async searchUsers(botId: string, query: string): Promise<LarkUserSearchHit[]> {
    const bot = this.store.getBot(botId)
    if (!bot) return []
    const uat = await this.platform.getValidUserAccessToken(bot.id, bot.larkAppId, bot.larkAppSecret)
    return this.transportFor(bot).searchUsers(query, uat, (queries) =>
      this.directoryEnricher.searchByQueries(queries, bot.id),
    )
  }

  async syncJoinedChats(targetBotId?: string): Promise<DiscoveredLarkChat[]> {
    const entries = targetBotId
      ? [this.transports.get(targetBotId)].filter((v): v is ManagedTransport => Boolean(v))
      : [...this.transports.values()]
    const results: DiscoveredLarkChat[] = []
    for (const entry of entries) {
      try {
        const chats = await entry.transport.listJoinedChats()
        this.store.mergeDiscoveredChats(entry.config.id, chats)
        results.push(...chats)
      } catch (err) {
        this.ctx.logger.warn(
          `[lark-bridge] syncJoinedChats(${entry.config.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return results
  }

  async syncGroupWorkspace(botId: string, chatId: string): Promise<void> {
    await this.workspaces.syncGroup(botId, chatId)
    await this.workspaces.reconcileBindings()
  }

  async unbindRoute(routeKey: string, options: { archive?: boolean } = {}): Promise<boolean> {
    const removed = this.store.deleteBinding(routeKey)
    if (!removed) return false
    const handle = this.handles.get(removed.sessionId)
    if (handle) {
      this.handles.delete(removed.sessionId)
      await handle.dispose().catch(() => {})
    }
    if (options.archive) {
      await this.archiveManagedSession(removed.sessionId)
    }
    return true
  }

  /**
   * Record the live HTTP origin bound by `ctx.webServer` (essential for DSH Desktop
   * where the listener uses an OS-assigned loopback port) and refresh `cli-endpoint.json`
   * when no explicit `publicBaseUrl` was configured.
   */
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

  listArchivedSessionIds(): string[] {
    return this.workspaces.listArchivedSessionIds()
  }

  // ── Agent CLI Context & Operations ──────────────────────────────────────────

  resolveAgentContext(sessionId?: string): {
    readonly sessionId?: string
    readonly bound: boolean
    readonly source?: 'session_binding' | 'schedule_session' | 'reminder_session' | 'default_bot'
    readonly botId?: string
    readonly botName?: string
    readonly larkAppId?: string
    readonly botOpenId?: string
    readonly chatId?: string
    readonly chatName?: string
    readonly routeKey?: string
    readonly replyToMessageId?: string
    readonly scheduleContext?: ReturnType<ScheduleNotifier['getActiveSessionContext']>
    readonly bots: readonly LarkBotStatus[]
    readonly groups: ReturnType<LarkBridgeStore['listGroupViews']>
  } {
    const bots = this.listBotStatuses()
    const groups = this.store.listGroupViews()
    const sid = sessionId?.trim() || undefined

    if (sid) {
      const binding = this.store.listBindings().find((b) => b.sessionId === sid)
      if (binding) {
        const botStatus = bots.find((b) => b.botId === binding.botId)
        const replyToMessageId = extractBindingReplyAnchor(binding)
        return {
          sessionId: sid,
          bound: true,
          source: 'session_binding',
          botId: binding.botId,
          botName: binding.botName ?? binding.botId,
          larkAppId: binding.larkAppId,
          ...(botStatus?.botOpenId ? { botOpenId: botStatus.botOpenId } : {}),
          chatId: binding.chatId,
          ...(binding.chatName ? { chatName: binding.chatName } : {}),
          routeKey: binding.routeKey,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          bots,
          groups,
        }
      }

      const reminder = this.store.listReminders('all').find((r) => r.lastSessionId === sid)
      if (reminder) {
        const bot = this.store.getBot(reminder.origin.botId)
        const botStatus = bots.find((b) => b.botId === reminder.origin.botId)
        const chatId = reminder.origin.chatId
        const chatName =
          reminder.origin.chatName ||
          (chatId ? this.store.resolveChatName(reminder.origin.botId, chatId) : undefined)
        return {
          sessionId: sid,
          bound: true,
          source: 'reminder_session',
          botId: reminder.origin.botId,
          botName: bot?.name ?? reminder.origin.botName ?? reminder.origin.botId,
          larkAppId: bot?.larkAppId ?? reminder.origin.larkAppId,
          ...(botStatus?.botOpenId ? { botOpenId: botStatus.botOpenId } : {}),
          ...(chatId ? { chatId } : {}),
          ...(chatName ? { chatName } : {}),
          routeKey: `reminder:${reminder.id}`,
          ...(reminder.origin.replyToMessageId
            ? { replyToMessageId: reminder.origin.replyToMessageId }
            : {}),
          bots,
          groups,
        }
      }

      const schedCtx = this.schedules.getActiveSessionContext(sid)
      if (schedCtx && schedCtx.targets.length > 0) {
        const primary = schedCtx.targets[0]!
        const bot = this.store.getBot(primary.botId)
        const botStatus = bots.find((b) => b.botId === primary.botId)
        const chatName = this.store.resolveChatName(primary.botId, primary.chatId)
        return {
          sessionId: sid,
          bound: true,
          source: 'schedule_session',
          botId: primary.botId,
          ...(bot ? { botName: bot.name, larkAppId: bot.larkAppId } : {}),
          ...(botStatus?.botOpenId ? { botOpenId: botStatus.botOpenId } : {}),
          chatId: primary.chatId,
          ...(chatName ? { chatName } : {}),
          scheduleContext: schedCtx,
          bots,
          groups,
        }
      }
    }

    const defaultBot = bots.find((b) => b.enabled && b.connected) ?? bots[0]
    return {
      ...(sid ? { sessionId: sid } : {}),
      bound: false,
      ...(defaultBot
        ? {
            source: 'default_bot',
            botId: defaultBot.botId,
            botName: defaultBot.name,
            larkAppId: defaultBot.larkAppId,
            ...(defaultBot.botOpenId ? { botOpenId: defaultBot.botOpenId } : {}),
          }
        : {}),
      bots,
      groups,
    }
  }

  async agentSend(input: AgentCliSendInput): Promise<{
    readonly messageIds: readonly string[]
    readonly botId: string
    readonly targetId: string
  }> {
    const ctxInfo = this.resolveAgentContext(input.sessionId)
    const botId = input.botId?.trim() || ctxInfo.botId
    if (!botId) throw new Error('No botId specified and no active bot available')
    const bot = this.store.getBot(botId)
    if (!bot) throw new Error(`Bot "${botId}" not found`)
    const transport = this.transportFor(bot)

    const userOpenId = input.userOpenId?.trim() || undefined
    const chatId = userOpenId ? undefined : input.chatId?.trim() || ctxInfo.chatId
    const explicitReplyTo = input.replyToMessageId?.trim() || undefined
    const replyToMessageId =
      explicitReplyTo ||
      (!input.chatId && !userOpenId && ctxInfo.replyToMessageId ? ctxInfo.replyToMessageId : undefined)
    const replyInThread = input.replyInThread ?? Boolean(ctxInfo.replyToMessageId && !explicitReplyTo)

    if (!userOpenId && !chatId && !replyToMessageId) {
      throw new Error('Target chatId (--chat), userOpenId (--user), or bound session is required')
    }

    const receiveIdType: 'open_id' | 'chat_id' = userOpenId ? 'open_id' : 'chat_id'
    const receiveId = userOpenId ?? chatId
    const messageIds: string[] = []

    const uploadedImages: ReplyCardImage[] = []
    for (const img of input.images ?? []) {
      const buf = Buffer.from(img.dataBase64, 'base64')
      const imgKey = await transport.uploadImageBuffer(buf)
      uploadedImages.push({
        imgKey,
        ...(img.alt || img.fileName ? { alt: img.alt || img.fileName } : {}),
        ...(img.mode ? { mode: img.mode } : {}),
      })
    }

    let markdown = trimInvisibleText(input.text ?? '')
    if (input.mentions && input.mentions.length > 0) {
      const mentionPrefix = input.mentions
        .filter((m) => m.openId.trim())
        .map((m) => `<at id="${m.openId.trim()}">${m.name?.trim() || ''}</at>`)
        .join(' ')
      if (mentionPrefix) {
        markdown = markdown ? `${mentionPrefix} ${markdown}` : mentionPrefix
      }
    }

    if (input.card) {
      const sent = await transport.sendProactiveMessage({
        receiveIdType,
        ...(receiveId ? { receiveId } : {}),
        ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
        msgType: 'interactive',
        content: JSON.stringify(input.card),
      })
      if (sent.messageId) messageIds.push(sent.messageId)
    } else if (markdown || input.title || uploadedImages.length > 0) {
      if (!markdown && !input.title && uploadedImages.length === 1 && input.textOnly) {
        const sent = await transport.sendProactiveMessage({
          receiveIdType,
          ...(receiveId ? { receiveId } : {}),
          ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
          msgType: 'image',
          content: JSON.stringify({ image_key: uploadedImages[0]!.imgKey }),
        })
        if (sent.messageId) messageIds.push(sent.messageId)
      } else if (input.textOnly && uploadedImages.length === 0 && !input.title) {
        const sent = await transport.sendProactiveMessage({
          receiveIdType,
          ...(receiveId ? { receiveId } : {}),
          ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
          msgType: 'post',
          content: JSON.stringify(buildLarkPostPayload(markdown)),
        })
        if (sent.messageId) messageIds.push(sent.messageId)
      } else {
        const group = chatId ? this.store.getGroup(bot.id, chatId) : undefined
        const card = buildReplyCard({
          ...(input.title ? { title: input.title } : {}),
          markdown: markdown || ' ',
          bot: resolveEffectiveCardBot(bot, group),
          ...(input.sessionId ? { sessionUrl: this.sessionWebUrl(input.sessionId) } : {}),
          ...(uploadedImages.length > 0 ? { images: uploadedImages } : {}),
        })
        const sent = await transport.sendProactiveMessage({
          receiveIdType,
          ...(receiveId ? { receiveId } : {}),
          ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
          msgType: 'interactive',
          content: JSON.stringify(card),
        })
        if (sent.messageId) messageIds.push(sent.messageId)
      }
    }

    for (const f of input.files ?? []) {
      const buf = Buffer.from(f.dataBase64, 'base64')
      const uploaded = await transport.uploadFileBuffer(buf, f.fileName)
      const sent = await transport.sendProactiveMessage({
        receiveIdType,
        ...(receiveId ? { receiveId } : {}),
        ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
        msgType: 'file',
        content: JSON.stringify({ file_key: uploaded.fileKey }),
      })
      if (sent.messageId) messageIds.push(sent.messageId)
    }

    return {
      messageIds,
      botId: bot.id,
      targetId: receiveId ?? replyToMessageId ?? '',
    }
  }

  async agentHistory(input: {
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
    const ctxInfo = this.resolveAgentContext(input.sessionId)
    const botId = input.botId?.trim() || ctxInfo.botId
    if (!botId) throw new Error('No botId specified and no active bot available')
    const bot = this.store.getBot(botId)
    if (!bot) throw new Error(`Bot "${botId}" not found`)
    const chatId = input.chatId?.trim() || ctxInfo.chatId
    if (!chatId) throw new Error('chatId is required (--chat oc_xxx or run inside a bound Lark session)')
    const threadId =
      input.threadId === 'none'
        ? undefined
        : input.threadId?.trim() || (!input.chatId ? ctxInfo.replyToMessageId : undefined)
    const messages = await this.transportFor(bot).listMessages({
      chatId,
      ...(threadId ? { threadId } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    })
    return {
      botId,
      chatId,
      ...(threadId ? { threadId } : {}),
      messages,
    }
  }

  async agentGetMessage(input: {
    readonly sessionId?: string
    readonly botId?: string
    readonly messageId: string
    readonly downloadResources?: boolean
    readonly includeRaw?: boolean
  }): Promise<LarkMessageDetail | undefined> {
    const ctxInfo = this.resolveAgentContext(input.sessionId)
    const botId = input.botId?.trim() || ctxInfo.botId
    if (!botId) throw new Error('No botId specified and no active bot available')
    const bot = this.store.getBot(botId)
    if (!bot) throw new Error(`Bot "${botId}" not found`)
    return this.transportFor(bot).getMessageDetail(input.messageId, {
      downloadResources: input.downloadResources,
      includeRaw: input.includeRaw,
    })
  }

  async agentCreateSchedule(input: {
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
    const ctxInfo = this.resolveAgentContext(input.sessionId)
    const explicitBotId = input.botId?.trim() || undefined
    if (explicitBotId && !this.store.getBot(explicitBotId)) {
      throw new Error(`未找到智能体 "${explicitBotId}"`)
    }
    const botId = explicitBotId || ctxInfo.botId
    const chatId = input.chatId?.trim() || ctxInfo.chatId
    const bot = botId ? this.store.getBot(botId) : undefined
    const group = bot && chatId ? this.store.getGroup(bot.id, chatId) : undefined
    const sessionBinding =
      !explicitBotId && !input.chatId?.trim() && input.sessionId?.trim()
        ? this.store.listBindings().find((b) => b.sessionId === input.sessionId!.trim())
        : undefined
    const rawCwd =
      input.cwd?.trim() ||
      (bot ? resolveEffectiveWorkingDir(bot, group) : sessionBinding?.workingDir)
    const resolvedPreset =
      input.agentPreset?.trim() ||
      (bot ? resolveEffectiveAgentRuntime(bot, group).agentPreset : sessionBinding?.agentPreset)
    const targets: LarkScheduleTarget[] = botId && chatId ? [{ botId, chatId }] : []
    return this.schedules.createAndBind({
      title: input.title,
      prompt: input.prompt,
      timing: input.timing,
      ...(botId ? { botId } : {}),
      ...(rawCwd ? { cwd: rawCwd } : {}),
      ...(resolvedPreset ? { agentPreset: resolvedPreset } : {}),
      ...(targets.length > 0 ? { targets } : {}),
      ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
      ...(input.notifyOn ? { notifyOn: input.notifyOn } : {}),
    })
  }

  // ── Session Sweep & Lifecycle ───────────────────────────────────────────────

  async sweepIdleBindings(): Promise<number> {
    const now = Date.now()
    let archivedCount = 0

    for (const binding of this.store.listBindings()) {
      if (!binding.idleCloseMs || now - binding.lastActivityMs < binding.idleCloseMs) continue
      await this.unbindRoute(binding.routeKey, { archive: true })
      archivedCount += 1
      this.store.recordEvent({
        botId: binding.botId,
        chatId: binding.chatId,
        routeKey: binding.routeKey,
        sessionId: binding.sessionId,
        kind: 'lifecycle',
        summary: '会话空闲超时，已自动归档',
      })
    }

    const activeBoundSessionIds = new Set(this.store.listBindings().map((b) => b.sessionId))
    for (const ms of this.store.listExpiredManagedSessions(now)) {
      if (activeBoundSessionIds.has(ms.sessionId)) continue
      const didArchive = await this.archiveManagedSession(ms.sessionId)
      if (didArchive) {
        archivedCount += 1
        this.store.recordEvent({
          botId: ms.botId,
          chatId: ms.chatId,
          ...(ms.routeKey ? { routeKey: ms.routeKey } : {}),
          sessionId: ms.sessionId,
          kind: 'lifecycle',
          summary: '过期会话已自动归档',
        })
      }
    }

    return archivedCount
  }

  private transportFor(bot: LarkBotConfig): LarkBotTransport {
    return this.transports.get(bot.id)?.transport ?? new LarkBotTransport(bot, { onMessage: () => {} })
  }

  private async archiveManagedSession(sessionId: string): Promise<boolean> {
    await this.reminders.disposeSessionHandle(sessionId).catch(() => {})
    const archived = await this.workspaces.archiveSession(sessionId)
    this.store.markSessionArchived(sessionId)
    return archived
  }

  private async startBot(bot: LarkBotConfig): Promise<void> {
    if (this.disposed) return
    const prev = this.transports.get(bot.id)
    if (prev) {
      this.transports.delete(bot.id)
      await prev.transport.stop().catch(() => {})
    }
    if (this.disposed) return

    const transport: LarkBotTransport = new LarkBotTransport(bot, {
      onMessage: (msg) => this.handleInbound(bot.id, transport, msg),
      onCardAction: async (action) => {
        const toast = await this.reminders.handleCardAction(action.actionValue, {
          ...(action.operatorOpenId ? { operatorOpenId: action.operatorOpenId } : {}),
        })
        return toast ? { toast } : undefined
      },
      onChatMembershipChange: () => {
        void this.syncJoinedChats(bot.id)
      },
      onBotProfile: (profile) => {
        this.hydratedProfileBots.add(bot.id)
        this.store.updateBotProfile(bot.id, profile, {
          preserveNonEmptyDescription: this.preserveLocalDescriptionBots.has(bot.id),
        })
      },
      logger: (level, message) =>
        this.ctx.logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](
          `[lark-bridge] ${message}`,
        ),
    })
    this.transports.set(bot.id, { config: bot, transport })
    try {
      await transport.start()
    } catch (err) {
      if (this.transports.get(bot.id)?.transport === transport) {
        this.transports.delete(bot.id)
      }
      await transport.stop().catch(() => {})
      throw err
    }
    if (this.disposed || this.transports.get(bot.id)?.transport !== transport) {
      await transport.stop().catch(() => {})
      return
    }
    this.store.recordEvent({
      botId: bot.id,
      kind: 'lifecycle',
      summary: `长连接已就绪（${bot.larkAppId}）`,
    })
    await this.workspaces.syncBot(bot)
    void this.syncJoinedChats(bot.id)
    void this.recoverStalePendingTurns(bot.id).catch((err) => {
      this.ctx.logger.warn(
        `[lark-bridge] bot "${bot.name}" pending turn recovery warning: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  private async handleInbound(
    botId: string,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ): Promise<void> {
    if (this.disposed) return
    const managed = this.transports.get(botId)
    if (managed && managed.transport !== transport) return
    const bot = this.store.getBot(botId)
    if (!bot) return
    const dedupKey = `${bot.larkAppId}:${msg.messageId}`
    if (!this.dedup.claim(dedupKey)) return

    const groupConfig = msg.chatType === 'group' ? this.store.getGroup(bot.id, msg.chatId) : undefined
    const knownChatName =
      msg.chatType === 'group' ? this.store.resolveChatName(bot.id, msg.chatId) : undefined
    const rawDecision = decideLarkRouting(bot, msg, {
      groupConfig,
      ...(knownChatName ? { chatName: knownChatName } : {}),
      hasActiveSessionForRoute: (routeKey) => Boolean(this.store.getBinding(routeKey)),
      getRouteTrigger: (routeKey) => this.store.getBinding(routeKey)?.trigger,
      hasRouteReplied: (routeKey) => this.store.getBinding(routeKey)?.hasReplied !== false,
    })
    const decision =
      rawDecision.action !== 'ignore'
        ? {
            ...rawDecision,
            workspaceName:
              msg.chatType === 'group'
                ? this.store.resolveGroupWorkspaceName(bot, groupConfig, knownChatName)
                : this.store.resolveBotWorkspaceName(bot),
          }
        : rawDecision

    if (decision.action === 'ignore') {
      if (decision.reason !== 'no_matching_rule' && decision.reason !== 'self_message') {
        this.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'ignored' })
        this.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          kind: 'ignored',
          summary: `规则过滤（${decision.reason}）`,
        })
      }
      return
    }

    const reply = (text: string) =>
      transport.sendReply({
        chatId: msg.chatId,
        replyToMessageId: msg.messageId,
        replyMode: decision.replyMode,
        text,
      })

    if (decision.action === 'command') {
      this.store.rememberSeenMessage?.(dedupKey)
      this.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        routeKey: decision.routeKey,
        kind: 'command',
        summary: `/${decision.command.name} ${decision.command.args}`.trim(),
      })
      await handleSlashCommand(
        {
          ctx: this.ctx,
          store: this.store,
          runtimes: this.runtimes,
          unbindRoute: (key, opts) => this.unbindRoute(key, opts),
          sessionWebUrl: (sid) => this.sessionWebUrl(sid),
          runTurn: (agent, content) =>
            runTurnAndCollectReply(this.ctx, agent, content, {
              signal: this.shutdownController.signal,
            }),
        },
        {
          bot,
          ...(groupConfig ? { group: groupConfig } : {}),
          chatType: msg.chatType,
          ...(msg.senderOpenId ? { senderOpenId: msg.senderOpenId } : {}),
          command: decision.command,
          routeKey: decision.routeKey,
          workingDir: decision.workingDir,
          workspaceName: decision.workspaceName,
          reply: async (text) => {
            await reply(text)
          },
        },
      )
      return
    }

    this.store.rememberSeenMessage?.(dedupKey)
    await this.runAgentTurn(bot, transport, msg, decision, groupConfig)
  }

  private async acquireSessionTurnSlot(
    sessionId: string,
    activeTurn: ActiveTurnRecord,
  ): Promise<(() => void) | undefined> {
    const prev = this.sessionTurnQueues.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(() => next)
    this.sessionTurnQueues.set(sessionId, tail)

    const releaseOnce = () => {
      release()
      if (this.sessionTurnQueues.get(sessionId) === tail) {
        this.sessionTurnQueues.delete(sessionId)
      }
    }

    let onAbort: (() => void) | undefined
    const aborted = new Promise<'aborted'>((resolve) => {
      if (this.shutdownController.signal.aborted || this.disposed || activeTurn.settled) {
        resolve('aborted')
        return
      }
      onAbort = () => resolve('aborted')
      this.shutdownController.signal.addEventListener('abort', onAbort, { once: true })
    })

    const outcome = await Promise.race([prev.then(() => 'ready' as const), aborted])
    if (onAbort) {
      this.shutdownController.signal.removeEventListener('abort', onAbort)
    }
    if (outcome === 'aborted' || this.disposed || activeTurn.settled) {
      releaseOnce()
      return undefined
    }
    return releaseOnce
  }

  private async runAgentTurn(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    groupConfig?: LarkGroupConfig,
  ): Promise<void> {
    const startedMs = Date.now()
    const resolvedChatName = decision.chatName || this.store.resolveChatName(bot.id, msg.chatId)
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}
    this.store.recordMetric({ botId: bot.id, chatId: msg.chatId, ...chatName, kind: 'inbound', now: startedMs })
    if (decision.trigger === 'listener') {
      this.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'listener', now: startedMs })
    }

    const reaction = decision.receivedReactionEmoji
    const reactionId = reaction ? await transport.addReaction(msg.messageId, reaction) : undefined
    if (this.disposed) {
      if (reactionId) await transport.removeReaction(msg.messageId, reactionId)
      return
    }

    const activeTurn = this.registerActiveTurn({
      botId: bot.id,
      chatId: msg.chatId,
      ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
      messageId: msg.messageId,
      routeKey: decision.routeKey,
      replyMode: decision.replyMode,
      trigger: decision.trigger,
      allowSilentEmptyReply: decision.allowSilentEmptyReply,
      ...(reactionId ? { reactionId } : {}),
      startedAtMs: startedMs,
      transport,
    })
    let trackedSessionId: string | undefined
    let acquiredRef: AcquiredAgent | undefined
    let releaseTurnSlot: (() => void) | undefined
    let shouldDisposeEphemeral = false
    let shouldArchiveEphemeral = false

    try {
      const acquired = await this.acquireAgent(bot, msg, decision)
      acquiredRef = acquired
      trackedSessionId = acquired.sessionId
      activeTurn.sessionId = trackedSessionId
      this.persistActiveTurn(activeTurn)
      this.inFlightTurns.set(trackedSessionId, (this.inFlightTurns.get(trackedSessionId) ?? 0) + 1)
      if (activeTurn.settled || this.disposed) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }

      releaseTurnSlot = await this.acquireSessionTurnSlot(trackedSessionId, activeTurn)
      if (!releaseTurnSlot) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }

      this.ensureCleanSessionTitle(acquired.agent.session, msg, decision, acquired.isNew)

      this.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        sessionId: acquired.sessionId,
        kind: 'inbound',
        summary: `${decision.listenerName ? `监听「${decision.listenerName}」` : decision.trigger} → ${decision.agentPreset} · ${decision.workspaceName}`,
      })

      const content = await this.buildPrompt(
        bot,
        transport,
        msg,
        decision,
        acquired.isNew,
        resolvedChatName,
      )
      if (activeTurn.settled || this.disposed) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }
      const replyText = await runTurnAndCollectReply(this.ctx, acquired.agent, content, {
        signal: this.shutdownController.signal,
        ...(decision.sendIntermediateMessages
          ? {
              onIntermediate: async (stepText) => {
                const sent = await this.deliverIntermediateReply(bot, transport, msg, decision, stepText)
                if (sent) {
                  activeTurn.intermediateSentCount += 1
                  this.store.markBindingReplied(decision.routeKey)
                }
              },
            }
          : {}),
      })
      if (!this.claimActiveTurn(activeTurn)) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }

      const intermediateSentCount = activeTurn.intermediateSentCount
      const latencyMs = Date.now() - startedMs
      this.store.touchBinding(decision.routeKey)
      this.store.touchManagedSession(acquired.sessionId)
      this.ensureCleanSessionTitle(acquired.agent.session, msg, decision, false)

      const normalizedReply = normalizeReplyText(replyText, {
        allowSilentSentinel: decision.allowSilentEmptyReply,
      })
      const hasFinalText = normalizedReply.length > 0
      const isSilentSkip =
        decision.allowSilentEmptyReply && !hasFinalText && intermediateSentCount === 0
      if (isSilentSkip) {
        this.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'silent_skip' })
        this.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          routeKey: decision.routeKey,
          sessionId: acquired.sessionId,
          durationMs: latencyMs,
          kind: 'silent_skip',
          summary: '判断无需回复，已静默',
        })
      } else {
        if (hasFinalText || intermediateSentCount === 0) {
          await this.deliverReply(
            bot,
            transport,
            msg,
            decision,
            acquired.sessionId,
            normalizedReply,
            groupConfig,
          )
        }
        this.store.markBindingReplied(decision.routeKey)
        this.store.recordMetric({ botId: bot.id, chatId: msg.chatId, ...chatName, kind: 'replied', latencyMs })
        this.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          routeKey: decision.routeKey,
          sessionId: acquired.sessionId,
          durationMs: latencyMs,
          kind: 'reply',
          summary:
            intermediateSentCount > 0
              ? `已发送 ${intermediateSentCount} 条过程消息${hasFinalText ? ` + 最终回复 ${normalizedReply.length} 字` : ''}`
              : `已回复 ${normalizedReply.length} 字`,
        })
      }

      const currentBinding = this.store.getBinding(decision.routeKey)
      const isNeverRepliedListener =
        isSilentSkip &&
        decision.trigger === 'listener' &&
        (acquired.isNew || currentBinding?.hasReplied === false)
      if (acquired.disposeAfter || decision.autoCloseAfterCompletion || isNeverRepliedListener) {
        shouldDisposeEphemeral = true
        shouldArchiveEphemeral = isSilentSkip && (acquired.isNew || isNeverRepliedListener)
      }
    } catch (err) {
      if (acquiredRef) {
        const currentBinding = this.store.getBinding(decision.routeKey)
        const isSilentFailedListener =
          !this.shouldNotifyInterruptedTurn(activeTurn, activeTurn.intermediateSentCount) &&
          (acquiredRef.isNew || currentBinding?.hasReplied === false)
        if (acquiredRef.disposeAfter || isSilentFailedListener) {
          shouldDisposeEphemeral = true
          shouldArchiveEphemeral = isSilentFailedListener
        }
      }
      if (!this.claimActiveTurn(activeTurn)) return
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.ctx.logger.error(`[lark-bridge] turn handling failed: ${errorMsg}`)
      if (err instanceof TurnAbortedError) {
        activeTurn.reactionRemoved = true
        await this.deliverInterruptedTurnCleanup({
          transport,
          turn: activeTurn,
          intermediateSentCount: activeTurn.intermediateSentCount,
          auditSummary: errorMsg,
          replyText: `${errorMsg}，可重新回复继续。`,
        })
      } else {
        this.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'error' })
        this.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          ...chatName,
          routeKey: decision.routeKey,
          ...(trackedSessionId ? { sessionId: trackedSessionId } : {}),
          kind: 'error',
          summary: errorMsg,
        })
        if (this.shouldNotifyInterruptedTurn(activeTurn, activeTurn.intermediateSentCount)) {
          await transport
            .sendReply({
              chatId: msg.chatId,
              replyToMessageId: msg.messageId,
              replyMode: decision.replyMode,
              text: `执行异常：${errorMsg}`,
            })
            .catch(() => {})
        }
      }
    } finally {
      let otherTurnsInFlight = false
      if (trackedSessionId) {
        const nextCount = (this.inFlightTurns.get(trackedSessionId) ?? 1) - 1
        if (nextCount <= 0) {
          this.inFlightTurns.delete(trackedSessionId)
        } else {
          this.inFlightTurns.set(trackedSessionId, nextCount)
          otherTurnsInFlight = true
        }
      }
      if (trackedSessionId && !otherTurnsInFlight && shouldDisposeEphemeral) {
        const handle = this.handles.get(trackedSessionId)
        this.handles.delete(trackedSessionId)
        if (this.store.getBinding(decision.routeKey)?.sessionId === trackedSessionId) {
          this.store.deleteBinding(decision.routeKey)
        }
        if (handle) {
          await handle.dispose().catch(() => {})
        }
        if (shouldArchiveEphemeral) {
          await this.archiveManagedSession(trackedSessionId).catch(() => {})
        }
      }
      releaseTurnSlot?.()
      if (!activeTurn.reactionRemoved && reactionId) {
        activeTurn.reactionRemoved = true
        await transport.removeReaction(msg.messageId, reactionId)
      }
    }
  }

  private async buildPrompt(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    isNewSession: boolean,
    resolvedChatName?: string,
  ): Promise<ContentBlock[]> {
    const reminders: string[] = []
    let senderName: string | undefined
    if (
      msg.senderType === 'user' &&
      msg.senderOpenId &&
      typeof transport.resolveUserSummary === 'function'
    ) {
      const summary = await transport.resolveUserSummary(msg.senderOpenId).catch(() => undefined)
      if (summary?.name && summary.name !== msg.senderOpenId) {
        senderName = summary.name
      }
    }

    if (isNewSession && decision.roleReminder) {
      reminders.push(decision.roleReminder)
    }
    if (isNewSession) {
      const proactiveReminder = composeProactiveSessionReminder({
        botId: bot.id,
        workingDir: decision.workingDir,
        config: bot.experimental.proactive,
      })
      if (proactiveReminder) reminders.push(proactiveReminder)
    }

    reminders.push(
      composeLarkContextReminder({
        bot,
        botOpenId: transport.state?.botOpenId ?? msg.botOpenId,
        msg,
        ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
        ...(senderName ? { senderName } : {}),
        replyMode: decision.replyMode,
        useCard: decision.useCard,
        includeFullGuide: isNewSession,
      }),
    )
    reminders.push(...decision.turnReminders)

    const text = composeTurnPrompt(reminders, decision.userText)
    const blocks: ContentBlock[] = [{ type: 'text', text }]

    for (const imageKey of msg.imageKeys) {
      const data = await transport.downloadImageAsBase64(msg.messageId, imageKey)
      if (data) {
        blocks.push({ type: 'image', mediaType: 'image/png', data } as unknown as ContentBlock)
      }
    }
    return blocks
  }

  private async formatReplyModelLabel(
    agentPreset: string,
    explicitModel?: string,
    runtimeProfileId?: string,
  ): Promise<string> {
    const runtimeList = await this.runtimes.list().catch(() => [])
    const runtimeOpt = runtimeList.find((r) => r.id === agentPreset)
    const baseRuntimeLabel = runtimeOpt?.name ?? agentPreset
    const profileOpt = runtimeProfileId
      ? runtimeOpt?.profiles?.find((p) => p.id === runtimeProfileId)
      : undefined
    const runtimeLabel = runtimeProfileId
      ? `${baseRuntimeLabel} (${profileOpt?.name ?? runtimeProfileId})`
      : baseRuntimeLabel
    const launch = await this.runtimes
      .resolveAgentLaunch({
        agentPreset,
        ...(runtimeProfileId ? { runtimeProfileId } : {}),
        ...(explicitModel ? { explicitModel } : {}),
      })
      .catch(() => undefined)
    const modelId =
      launch?.model ||
      explicitModel ||
      (await this.runtimes
        .resolveDefaultModel(agentPreset, runtimeOpt?.defaultModel, runtimeProfileId)
        .catch(() => runtimeOpt?.defaultModel))
    if (!modelId) return runtimeLabel
    const provider = launch?.provider ?? runtimeOpt?.providerId ?? this.runtimes.providerFor(agentPreset)
    let modelLabel = modelId
    if (runtimeProfileId) {
      const profileModels = await this.runtimes
        .modelsForRuntime(agentPreset, runtimeProfileId)
        .catch(() => undefined)
      const hit = profileModels?.find((m) => m.id === modelId)
      if (hit?.name) modelLabel = hit.name
    }
    if (modelLabel === modelId && provider && typeof this.ctx.llm?.resolveModelInfo === 'function') {
      const resolved = await this.ctx.llm.resolveModelInfo(provider, modelId).catch(() => undefined)
      if (resolved?.name) modelLabel = resolved.name
    }
    return [runtimeLabel, modelLabel].filter(Boolean).join(' · ')
  }

  private async deliverIntermediateReply(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    stepText: string,
  ): Promise<boolean> {
    const text = normalizeReplyText(stepText, {
      allowSilentSentinel: decision.allowSilentEmptyReply,
    })
    if (!text) return false
    const card = decision.useCard
      ? buildReplyCard({
          markdown: text,
          bot: { ...bot, dshSessionLinkInCard: false, replyFooterEnabled: false },
        })
      : undefined
    const sent = await transport.sendReply({
      chatId: msg.chatId,
      replyToMessageId: msg.messageId,
      replyMode: decision.replyMode,
      ...(card ? { card } : { text }),
    })
    this.syncReplyRouteAliases(bot, msg, decision, sent)
    return true
  }

  private async deliverReply(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    sessionId: string,
    replyText: string,
    groupConfig?: LarkGroupConfig,
  ): Promise<void> {
    const text = normalizeReplyText(replyText) || '（已完成，无文本输出）'
    const cardBot = resolveEffectiveCardBot(bot, msg.chatType === 'group' ? groupConfig : undefined)
    const modelLabel =
      decision.useCard && cardBot.replyFooterEnabled && cardBot.replyFooterModel
        ? await this.formatReplyModelLabel(
            decision.agentPreset,
            decision.model,
            decision.runtimeProfileId,
          )
        : ''
    const card = decision.useCard
      ? buildReplyCard({
          markdown: text,
          bot: cardBot,
          modelLabel,
          sessionUrl: this.sessionWebUrl(sessionId),
        })
      : undefined
    const sent = await transport.sendReply({
      chatId: msg.chatId,
      replyToMessageId: msg.messageId,
      replyMode: decision.replyMode,
      ...(card ? { card } : { text }),
    })
    this.syncReplyRouteAliases(bot, msg, decision, sent)
  }

  /**
   * Keeps thread-scoped sessions anchored across Feishu reply topology changes:
   * - When a quoted reply is promoted to a new Feishu topic (`reply_in_thread: true`),
   *   Feishu re-roots the topic on `msg.messageId` (`sent.rootId`) and assigns `sent.threadId`;
   * - When replying directly into the main chat (`replyMode: 'chat'`), binds `sent.messageId`
   *   so quoting the bot's reply seamlessly continues the same session.
   */
  private syncReplyRouteAliases(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    sent: SendLarkReplyResult | undefined,
  ): void {
    if (msg.chatType !== 'group' || decision.sessionMode !== 'thread') return
    const scopes = new Set<string>()
    if (sent?.rootId) scopes.add(sent.rootId)
    if (sent?.threadId) scopes.add(sent.threadId)
    if (decision.replyMode === 'new-topic' && !msg.threadId && msg.messageId) {
      scopes.add(msg.messageId)
    }
    if (decision.replyMode === 'chat' && sent?.messageId) {
      scopes.add(sent.messageId)
    }
    for (const scope of scopes) {
      const aliasKey = buildRouteKey(bot.larkAppId, msg.chatId, scope)
      this.store.bindRouteAlias(decision.routeKey, aliasKey)
    }
  }

  private async acquireAgent(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
  ): Promise<AcquiredAgent> {
    const reuseSession = decision.sessionMode !== 'per_message'
    if (!reuseSession) {
      return this.acquireAgentUnlocked(bot, msg, decision, false)
    }

    while (true) {
      const lockKey = this.store.getBinding(decision.routeKey)?.routeKey ?? decision.routeKey
      const inflight = this.pendingAcquires.get(lockKey)
      if (inflight) {
        await inflight.catch(() => undefined)
        continue
      }
      const task = this.acquireAgentUnlocked(bot, msg, decision, true)
      this.pendingAcquires.set(lockKey, task)
      try {
        return await task
      } finally {
        if (this.pendingAcquires.get(lockKey) === task) {
          this.pendingAcquires.delete(lockKey)
        }
      }
    }
  }

  private async acquireAgentUnlocked(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    reuseSession: boolean,
  ): Promise<AcquiredAgent> {
    const existing = reuseSession ? this.store.getBinding(decision.routeKey) : undefined
    if (existing) {
      const targetCwd = expandWorkingDir(decision.workingDir) || decision.workingDir
      const existingCwd = expandWorkingDir(existing.workingDir) || existing.workingDir
      const profileChanged = (existing.runtimeProfileId ?? '') !== (decision.runtimeProfileId ?? '')
      if (existing.agentPreset !== decision.agentPreset || profileChanged || existingCwd !== targetCwd) {
        await this.unbindRoute(existing.routeKey, { archive: false })
      } else {
        const resumed = await this.resumeAgent(bot, existing, decision)
        if (resumed) return resumed
      }
    }

    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const launch = await this.runtimes.resolveAgentLaunch({
      agentPreset: decision.agentPreset,
      ...(decision.runtimeProfileId ? { runtimeProfileId: decision.runtimeProfileId } : {}),
      ...(bot.provider ? { explicitProvider: bot.provider } : {}),
      ...(decision.model ? { explicitModel: decision.model } : {}),
      ...(decision.reasoningEffort ? { explicitReasoningEffort: decision.reasoningEffort } : {}),
      requireNativeModel: true,
    })
    const resolvedCwd = expandWorkingDir(decision.workingDir) || decision.workingDir
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: resolvedCwd, agentPreset: decision.agentPreset },
      agentOptions: {
        ...(launch.provider ? { provider: launch.provider } : {}),
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
      },
      setup: async (agentCtx, agent) => {
        await launch.mountPreset(agentCtx, agent)
        const isP2p = msg.chatType === 'p2p'
        const replyAnchor = msg.rootId ?? msg.threadId ?? msg.messageId
        appendPluginRecord(agent.session, LARK_ORIGIN_RECORD_TYPE, {
          botId: bot.id,
          botName: bot.name,
          larkAppId: bot.larkAppId,
          chatType: isP2p ? 'p2p' : 'group',
          chatId: msg.chatId,
          ...(decision.chatName ? { chatName: decision.chatName } : {}),
          ...(!isP2p && decision.replyMode !== 'chat' ? { replyToMessageId: replyAnchor } : {}),
          ...(isP2p && msg.senderOpenId ? { userOpenId: msg.senderOpenId } : {}),
          workspaceName: decision.workspaceName,
          routeKey: decision.routeKey,
          trigger: decision.trigger,
          ...(decision.listenerName ? { listenerName: decision.listenerName } : {}),
        })
      },
    })
    this.schedules.instrumentAgent(handle.agent)
    await this.workspaces.attachSession(resolvedCwd, decision.workspaceName, sessionId)
    this.handles.set(sessionId, handle)

    const now = Date.now()
    const idleCloseMs = decision.idleCloseMs
    this.store.upsertManagedSession({
      sessionId,
      botId: bot.id,
      chatId: msg.chatId,
      routeKey: decision.routeKey,
      trigger: decision.trigger,
      createdAtMs: now,
      lastActivityMs: now,
      ...(idleCloseMs ? { idleCloseMs } : {}),
    })
    if (reuseSession) {
      this.store.upsertBinding(this.createBinding(bot, msg, decision, sessionId, resolvedCwd))
    }
    return { agent: handle.agent, sessionId, isNew: true, disposeAfter: !reuseSession }
  }

  private async resumeAgent(
    bot: LarkBotConfig,
    binding: LarkSessionBinding,
    decision: AgentDecision,
  ): Promise<AcquiredAgent | undefined> {
    const sessionId = brandString<SessionId>(binding.sessionId)
    const launch = await this.runtimes.resolveAgentLaunch({
      agentPreset: decision.agentPreset,
      ...(decision.runtimeProfileId ? { runtimeProfileId: decision.runtimeProfileId } : {}),
      ...(bot.provider ? { explicitProvider: bot.provider } : {}),
      ...(decision.model ? { explicitModel: decision.model } : {}),
      ...(decision.reasoningEffort ? { explicitReasoningEffort: decision.reasoningEffort } : {}),
      requireNativeModel: true,
    })
    let agent = this.ctx.agents.get(sessionId)
    if (!agent) {
      try {
        const handle = await this.ctx.agents.resume(
          launch.isExternal
            ? { resumeSessionId: sessionId }
            : {
                resumeSessionId: sessionId,
                agentOptions: {
                  ...(launch.provider ? { provider: launch.provider } : {}),
                  ...(launch.model ? { model: launch.model } : {}),
                  ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
                },
                setup: async (agentCtx) => {
                  await launch.mountPreset(agentCtx)
                },
              },
        )
        this.handles.set(binding.sessionId, handle)
        agent = handle.agent
      } catch {
        this.store.deleteBinding(binding.routeKey)
        return undefined
      }
    }

    const modelChanged = (binding.model ?? '') !== (decision.model ?? '')
    const effortChanged = (binding.reasoningEffort ?? '') !== (decision.reasoningEffort ?? '')
    if ((modelChanged || effortChanged) && agent.model?.select) {
      const provider =
        agent.model.current?.()?.provider ??
        launch.provider ??
        this.runtimes.providerFor(decision.agentPreset) ??
        bot.provider
      const targetModel = decision.model ?? launch.model ?? agent.model.current?.()?.model
      if (provider && targetModel) {
        try {
          agent.model.select({
            provider,
            model: targetModel,
            ...(decision.reasoningEffort
              ? { reasoningEffort: brandString<ReasoningEffortId>(decision.reasoningEffort) }
              : {}),
          })
        } catch {
          // Ignore if native adapter does not support runtime hot-select.
        }
      }
      this.store.upsertBinding({
        ...binding,
        ...(decision.model ? { model: decision.model } : { model: undefined }),
        ...(decision.reasoningEffort
          ? { reasoningEffort: decision.reasoningEffort }
          : { reasoningEffort: undefined }),
      })
    }

    this.schedules.instrumentAgent(agent)
    await this.workspaces.attachSession(decision.workingDir, decision.workspaceName, binding.sessionId)
    return { agent, sessionId: binding.sessionId, isNew: false, disposeAfter: false }
  }

  private createBinding(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    sessionId: string,
    workingDir: string,
  ): LarkSessionBinding {
    const now = Date.now()
    const isP2p = msg.chatType === 'p2p'
    return {
      routeKey: decision.routeKey,
      botId: bot.id,
      botName: bot.name,
      larkAppId: bot.larkAppId,
      chatType: isP2p ? 'p2p' : 'group',
      chatId: msg.chatId,
      ...(decision.chatName ? { chatName: decision.chatName } : {}),
      ...(isP2p && msg.senderOpenId ? { userOpenId: msg.senderOpenId } : {}),
      workspaceName: decision.workspaceName,
      sessionId,
      agentPreset: decision.agentPreset,
      ...(decision.runtimeProfileId ? { runtimeProfileId: decision.runtimeProfileId } : {}),
      ...(decision.model ? { model: decision.model } : {}),
      ...(decision.reasoningEffort ? { reasoningEffort: decision.reasoningEffort } : {}),
      workingDir,
      trigger: decision.trigger,
      ...(decision.listenerName ? { listenerName: decision.listenerName } : {}),
      hasReplied: decision.trigger !== 'listener',
      createdAtMs: now,
      lastActivityMs: now,
      ...(decision.idleCloseMs ? { idleCloseMs: decision.idleCloseMs } : {}),
    }
  }

  private ensureCleanSessionTitle(
    session: Session,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    isNew: boolean,
  ): void {
    const titleService = this.titleService()
    if (!titleService?.rename) return

    const pure = extractPureUserIntent(decision.userText || msg.text)
    const candidate = (pure || (msg.imageKeys.length > 0 ? '图片消息' : '')).slice(0, 60)
    if (!candidate) return

    const current = titleService.get?.(session)?.title?.trim() ?? ''
    const isTrivialGreeting = /^(hi|hello|hey|你好|您好|在吗|测试|test)$/i.test(current)
    const shouldWrite =
      isNew ||
      !current ||
      hasInjectedPromptMarkup(current) ||
      (isTrivialGreeting && candidate.length > 6 && !/^(hi|hello|hey|你好|您好|在吗|测试|test)$/i.test(candidate))

    if (shouldWrite && candidate !== current) {
      try {
        titleService.rename(session, candidate)
      } catch {
        // Ignore if session closed.
      }
    }
  }

  private installSessionTitleGuard(): void {
    const wrapTitleProvider = (rawSvc: unknown) => {
      const svc = rawSvc as
        | {
            registration?: {
              provider?: {
                __larkSanitized?: boolean
                generate: (req: {
                  messages: ReadonlyArray<{ seq: unknown; text: string }>
                  [k: string]: unknown
                }) => Promise<unknown>
              }
            }
          }
        | undefined
      const provider = svc?.registration?.provider
      if (provider && !provider.__larkSanitized && typeof provider.generate === 'function') {
        const origGenerate = provider.generate.bind(provider)
        provider.__larkSanitized = true
        provider.generate = (req) => {
          const cleanedMessages = req.messages.map((m) => {
            if (!hasInjectedPromptMarkup(m.text) && !m.text.includes('<user_message>')) return m
            const pure = extractPureUserIntent(m.text)
            return pure ? { ...m, text: pure } : m
          })
          return origGenerate({ ...req, messages: cleanedMessages })
        }
      }
    }
    wrapTitleProvider(this.titleService())
    if (typeof this.ctx.inject === 'function') {
      this.ctx.inject(['sessionTitle' as never], (tCtx) => {
        wrapTitleProvider((tCtx as Context).get('sessionTitle' as never))
      })
    }

    const off = this.ctx.on(
      'session/event',
      (session: Session, event: SessionEvent) => {
        const rawEvent = event as unknown as { type: string; data?: { title?: string } }
        if (rawEvent.type !== 'session/title') return
        const rawTitle = rawEvent.data?.title ?? ''
        if (!hasInjectedPromptMarkup(rawTitle)) return
        const repaired = this.deriveCleanTitleFromEvents(session.snapshotEvents())
        if (!repaired || repaired === rawTitle) return
        try {
          this.titleService()?.rename?.(session, repaired)
        } catch {
          // Ignore if session is closing.
        }
      },
      { global: true },
    )
    this.disposers.push(off)
  }

  private deriveCleanTitleFromEvents(events: readonly SessionEvent[]): string | undefined {
    for (const ev of events) {
      if (ev.type !== 'user/message') continue
      const content = (ev.data as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content ?? []
      const rawText = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
      const pure = extractPureUserIntent(rawText)
      if (pure) return pure.slice(0, 60)
    }
    return undefined
  }

  private async reconcileHistoricalSessions(): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (!persistence) return

    const activeBoundSessionIds = new Set(this.store.listBindings().map((b) => b.sessionId))
    const sessionIds = this.workspaces.listWorkspaceSessionIds()
    const now = Date.now()
    const bots = this.store.listBots()
    const defaultIdleMs =
      bots.length > 0 && bots[0]!.idleCloseMinutes > 0
        ? bots[0]!.idleCloseMinutes * 60_000
        : DEFAULT_HISTORICAL_ARCHIVE_MS

    for (const sid of sessionIds) {
      let events: readonly SessionEvent[] = []
      let headerCreatedAt = 0
      try {
        const handle = await persistence.open(brandString<SessionId>(sid), 'read')
        headerCreatedAt = handle.header?.createdAt ?? 0
        try {
          const readRes = await handle.read(0, 200)
          events = readRes.events
        } finally {
          await handle.close().catch(() => {})
        }
      } catch {
        continue
      }
      if (events.length === 0) continue

      let latestTitle = ''
      let lastTimestampMs = 0
      let isBridgeSession = false
      for (const ev of events) {
        const rawEv = ev as unknown as {
          type: string
          time?: number
          timestamp?: number
          data?: { title?: string; content?: ReadonlyArray<{ text?: string }> }
        }
        const evTime =
          typeof rawEv.time === 'number'
            ? rawEv.time
            : typeof rawEv.timestamp === 'number'
              ? rawEv.timestamp
              : 0
        if (rawEv.type !== 'session/title' && evTime > lastTimestampMs) {
          lastTimestampMs = evTime
        }
        const rec = pluginRecordOf(ev as never) as { type?: string } | undefined
        if (rec?.type?.endsWith('/origin')) {
          isBridgeSession = true
        }
        if (rawEv.type === 'user/message') {
          const txt = (rawEv.data?.content ?? []).map((c) => c.text ?? '').join('\n')
          if (hasInjectedPromptMarkup(txt) || txt.includes('<user_message>')) {
            isBridgeSession = true
          }
        }
        if (rawEv.type === 'session/title') {
          latestTitle = rawEv.data?.title ?? ''
        }
      }
      if (lastTimestampMs === 0) {
        lastTimestampMs = headerCreatedAt
      }

      if (latestTitle && hasInjectedPromptMarkup(latestTitle)) {
        const clean = this.deriveCleanTitleFromEvents(events)
        if (clean) {
          try {
            const live = this.ctx.agents.get(brandString<SessionId>(sid))
            if (live) {
              this.titleService()?.rename?.(live.session, clean)
            } else {
              const resumed = await this.ctx.agents.resume({ resumeSessionId: brandString<SessionId>(sid) })
              try {
                this.titleService()?.rename?.(resumed.agent.session, clean)
              } finally {
                await resumed.dispose().catch(() => {})
              }
            }
            this.ctx.logger.info(`[lark-bridge] repaired polluted session title for ${sid} -> "${clean}"`)
          } catch {
            // Best-effort historical title repair.
          }
        }
      }

      if (isBridgeSession && !activeBoundSessionIds.has(sid) && lastTimestampMs > 0) {
        const managed = this.store.getManagedSession?.(sid)
        const archiveThresholdMs = managed
          ? managed.idleCloseMs && managed.idleCloseMs > 0
            ? managed.idleCloseMs
            : Number.POSITIVE_INFINITY
          : Math.min(defaultIdleMs, DEFAULT_HISTORICAL_ARCHIVE_MS)
        if (now - lastTimestampMs >= archiveThresholdMs) {
          await this.archiveManagedSession(sid)
        }
      }
    }
  }

  private titleService():
    | {
        get?: (s: Session) => { title?: string; source?: { kind?: string } } | undefined
        rename?: (s: Session, nextTitle: string) => unknown
      }
    | undefined {
    return this.ctx.get('sessionTitle' as never) as
      | {
          get?: (s: Session) => { title?: string; source?: { kind?: string } } | undefined
          rename?: (s: Session, nextTitle: string) => unknown
        }
      | undefined
  }

  private async replaceRouteBinding(next: LarkSessionBinding): Promise<void> {
    const prev = this.store.getBinding(next.routeKey)
    this.store.upsertBinding(next)
    if (
      prev &&
      prev.routeKey === next.routeKey &&
      prev.sessionId !== next.sessionId &&
      (this.inFlightTurns.get(prev.sessionId) ?? 0) === 0
    ) {
      const oldHandle = this.handles.get(prev.sessionId)
      if (oldHandle) {
        this.handles.delete(prev.sessionId)
        await oldHandle.dispose().catch(() => {})
      }
    }
  }

  private async sendScheduleMessage(input: {
    readonly botId: string
    readonly chatId: string
    readonly deliveryMode: LarkScheduleDeliveryMode
    readonly replyToMessageId?: string
    readonly scheduleTitle: string
    readonly markdown: string
    readonly isError: boolean
    readonly isIntermediate?: boolean
    readonly sessionId: string
  }): Promise<void> {
    const bot = this.store.getBot(input.botId)
    if (!bot) throw new Error(`bot "${input.botId}" not found`)
    const group = this.store.getGroup(bot.id, input.chatId)
    const transport = this.transportFor(bot)
    const cardTitle = input.isError
      ? `自动化任务异常 · ${input.scheduleTitle}`
      : input.isIntermediate
        ? `自动化任务进展 · ${input.scheduleTitle}`
        : `自动化任务 · ${input.scheduleTitle}`
    const cardBot = resolveEffectiveCardBot(bot, group)
    const now = Date.now()
    const idleMinutes = group?.idleCloseMinutes ?? bot.idleCloseMinutes
    if (!input.isIntermediate) {
      this.store.upsertManagedSession({
        sessionId: input.sessionId,
        botId: bot.id,
        chatId: input.chatId,
        routeKey: buildRouteKey(
          bot.larkAppId,
          input.chatId,
          input.replyToMessageId || `schedule:${input.sessionId}`,
        ),
        trigger: 'schedule',
        createdAtMs: now,
        lastActivityMs: now,
        ...(idleMinutes > 0 ? { idleCloseMs: idleMinutes * 60_000 } : {}),
      })
    }
    const card = buildReplyCard({
      title: cardTitle,
      template: input.isError ? 'orange' : 'blue',
      markdown: input.markdown,
      bot: input.isIntermediate
        ? { ...cardBot, dshSessionLinkInCard: false, replyFooterEnabled: false }
        : cardBot,
      ...(input.isIntermediate ? {} : { sessionUrl: this.sessionWebUrl(input.sessionId) }),
    })
    const inThread = Boolean(input.replyToMessageId && input.deliveryMode === 'thread')
    const sent = await transport.sendReply({
      chatId: input.chatId,
      ...(inThread
        ? { replyToMessageId: input.replyToMessageId!, replyMode: 'new-topic' as const }
        : { replyMode: 'chat' as const }),
      card,
    })
    if (input.isIntermediate) return
    const scopeId = inThread ? input.replyToMessageId! : sent.messageId
    if (scopeId) {
      const liveSession = (
        this.ctx.sessions as unknown as { get?: (id: SessionId) => Agent['session'] | undefined }
      ).get?.(brandString<SessionId>(input.sessionId))
      const rawDir = liveSession?.header.cwd || group?.workingDir.trim() || bot.defaultWorkingDir
      const chatName = this.store.resolveChatName(bot.id, input.chatId)
      const effectiveRuntime = resolveEffectiveAgentRuntime(bot, group)
      const bindingPreset = liveSession?.header.agentPreset ?? effectiveRuntime.agentPreset
      await this.replaceRouteBinding({
        routeKey: buildRouteKey(bot.larkAppId, input.chatId, scopeId),
        botId: bot.id,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        chatId: input.chatId,
        ...(chatName ? { chatName } : {}),
        workspaceName: this.store.resolveGroupWorkspaceName(bot, group, chatName),
        sessionId: input.sessionId,
        agentPreset: bindingPreset,
        ...(effectiveRuntime.runtimeProfileId && effectiveRuntime.agentPreset === bindingPreset
          ? { runtimeProfileId: effectiveRuntime.runtimeProfileId }
          : {}),
        workingDir: expandWorkingDir(rawDir) || rawDir,
        trigger: 'schedule',
        createdAtMs: now,
        lastActivityMs: now,
        ...(idleMinutes > 0 ? { idleCloseMs: idleMinutes * 60_000 } : {}),
      })
      if (sent.threadId) {
        this.store.bindRouteAlias(
          buildRouteKey(bot.larkAppId, input.chatId, scopeId),
          buildRouteKey(bot.larkAppId, input.chatId, sent.threadId),
        )
      }
    }
  }

  private async sendOriginCard(
    origin: LarkReminderOrigin,
    card: Record<string, unknown>,
  ): Promise<{ readonly messageId?: string }> {
    const bot = this.store.getBot(origin.botId)
    if (!bot) return {}
    const transport = this.transportFor(bot)
    if (origin.chatType === 'p2p' && origin.userOpenId) {
      const sent = await transport.sendProactiveMessage({
        receiveIdType: 'open_id',
        receiveId: origin.userOpenId,
        msgType: 'interactive',
        content: JSON.stringify(card),
      })
      return { ...(sent.messageId ? { messageId: sent.messageId } : {}) }
    }
    if (!origin.chatId) return {}
    const inThread = Boolean(origin.deliveryMode === 'thread' && origin.replyToMessageId)
    const sent = await transport.sendReply({
      chatId: origin.chatId,
      ...(inThread
        ? { replyToMessageId: origin.replyToMessageId!, replyMode: 'new-topic' as const }
        : { replyMode: 'chat' as const }),
      card,
    })
    return { ...(sent.messageId ? { messageId: sent.messageId } : {}) }
  }

  private async patchOriginCard(
    botId: string,
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const bot = this.store.getBot(botId)
    if (!bot) return
    await this.transportFor(bot).patchMessageCard(messageId, card)
  }

  private async deliverReminderOutput(input: {
    readonly item: LarkReminderItem
    readonly sessionId: string
    readonly markdown: string
    readonly isError: boolean
  }): Promise<{ readonly messageId?: string }> {
    const { item, sessionId, isError } = input
    const bot = this.store.getBot(item.origin.botId)
    if (!bot) return {}
    const transport = this.transportFor(bot)

    let markdown = input.markdown.trim()
    if (item.origin.chatType === 'group' && item.mentions.length > 0) {
      const missingMentions = item.mentions.filter(
        (m) => m.openId.trim() && !markdown.includes(`id="${m.openId.trim()}"`),
      )
      if (missingMentions.length > 0) {
        const prefix = missingMentions
          .map((m) => `<at id="${m.openId.trim()}">${m.name.trim() || ''}</at>`)
          .join(' ')
        markdown = `${prefix}\n\n${markdown}`
      }
    }

    const cardTitle = isError
      ? `提醒事项异常 · ${item.title}`
      : item.worktree
        ? `主动跟进与代码待审 · ${item.title}`
        : `主动跟进提醒 · ${item.title}`

    if (item.origin.chatType === 'p2p' && item.origin.userOpenId) {
      const card = buildReplyCard({
        title: cardTitle,
        template: isError ? 'orange' : 'blue',
        markdown,
        bot: resolveEffectiveCardBot(bot),
        sessionUrl: this.sessionWebUrl(sessionId),
      })
      const sent = await transport.sendProactiveMessage({
        receiveIdType: 'open_id',
        receiveId: item.origin.userOpenId,
        msgType: 'interactive',
        content: JSON.stringify(card),
      })
      return { ...(sent.messageId ? { messageId: sent.messageId } : {}) }
    }

    if (!item.origin.chatId) return {}
    const chatId = item.origin.chatId
    const group = this.store.getGroup(bot.id, chatId)
    const card = buildReplyCard({
      title: cardTitle,
      template: isError ? 'orange' : 'blue',
      markdown,
      bot: resolveEffectiveCardBot(bot, group),
      sessionUrl: this.sessionWebUrl(sessionId),
    })
    const inThread = Boolean(item.origin.deliveryMode === 'thread' && item.origin.replyToMessageId)
    const sent = await transport.sendReply({
      chatId,
      ...(inThread
        ? { replyToMessageId: item.origin.replyToMessageId!, replyMode: 'new-topic' as const }
        : { replyMode: 'chat' as const }),
      card,
    })

    const scopeId = inThread ? item.origin.replyToMessageId! : sent.messageId
    if (scopeId) {
      const now = Date.now()
      const idleMinutes = group?.idleCloseMinutes ?? bot.idleCloseMinutes
      const runtime = resolveEffectiveAgentRuntime(bot, group)
      const rawDir = item.workingDir || group?.workingDir.trim() || bot.defaultWorkingDir
      const chatName = this.store.resolveChatName(bot.id, chatId)
      const reminderRouteKey = buildRouteKey(bot.larkAppId, chatId, scopeId)
      await this.replaceRouteBinding({
        routeKey: reminderRouteKey,
        botId: bot.id,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        chatType: 'group',
        chatId,
        ...(chatName ? { chatName } : {}),
        workspaceName: this.store.resolveGroupWorkspaceName(bot, group, chatName),
        sessionId,
        agentPreset: runtime.agentPreset,
        ...(runtime.runtimeProfileId ? { runtimeProfileId: runtime.runtimeProfileId } : {}),
        workingDir: expandWorkingDir(rawDir) || rawDir,
        trigger: 'reminder',
        createdAtMs: now,
        lastActivityMs: now,
        ...(idleMinutes > 0 ? { idleCloseMs: idleMinutes * 60_000 } : {}),
      })
      if (sent.threadId) {
        this.store.bindRouteAlias(
          reminderRouteKey,
          buildRouteKey(bot.larkAppId, chatId, sent.threadId),
        )
      }
    }
    return { ...(sent.messageId ? { messageId: sent.messageId } : {}) }
  }
}
