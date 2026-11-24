import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  MessageDeduplicator,
  buildReplyCard,
  buildRouteKey,
  composeCoalescedUserText,
  composeLarkContextReminder,
  composeProactiveSessionReminder,
  composeRouterHandoffReminder,
  composeTurnPrompt,
  decideLarkRouting,
  isLarkMessageRecalledError,
  isSilentReplySentinel,
  normalizeReplyText,
  replaceMentionKeysWithNames,
  resolveEffectiveCardBot,
  resolveEffectiveRouterConfig,
  shouldFastBypassTriage,
  shouldRunTriage,
  type EffectiveRouterConfig,
  type GroupReplyMode,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type LarkGroupConfig,
  type RecalledLarkMessageEvent,
  type RouterHandoffTurn,
  type SendLarkReplyResult,
  type TriageHistoryEntry,
} from '@dsh-lark/lark-core'
import type { BotConnectionPool } from './bot-connection-pool.js'
import type { MemoryService } from './memory-service.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { AcquiredAgent, AgentDecision, SessionCoordinator } from './session-coordinator.js'
import type { SessionTitleGuard } from './session-title-guard.js'
import { handleSlashCommand } from './slash-commands.js'
import type { LarkBridgeStore } from './store.js'
import type { LlmTriageService } from './triage-service.js'
import {
  canAutoResumePendingTurn,
  composeRestartRecoveryReminder,
  inspectPersistedTurnCompletion,
} from './turn-recovery.js'
import { TurnAbortedError, runTurnAndCollectReply } from './turn-runner.js'
import type {
  ActiveTurnSummary,
  LarkPendingTurn,
  PendingTurnInterruptKind,
  PendingTurnStatus,
} from './types.js'

const SHUTDOWN_TURN_CLEANUP_TIMEOUT_MS = 2_000
const STALE_PENDING_TURN_MAX_AGE_MS = 24 * 60 * 60_000
const TRIAGE_HISTORY_BACKFILL_TIMEOUT_MS = 1_200
const ACTIVE_TURN_HEARTBEAT_PERSIST_INTERVAL_MS = 15_000
const RECALLED_MESSAGE_TTL_MS = 10 * 60_000
const MAX_RECALLED_MESSAGES = 2_000
const UNEXPECTED_SILENT_SENTINEL_FALLBACK = '抱歉，当前消息不在我的职责范围内或暂无法直接回复。'

function createRecalledAbortError(): TurnAbortedError {
  return new TurnAbortedError('recalled', '原消息已撤回，已取消当前轮次并停止执行')
}

function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal
  readonly dispose: () => void
} {
  const controller = new AbortController()
  const activeSignals = signals.filter((s): s is AbortSignal => Boolean(s))
  const listeners: Array<{ readonly signal: AbortSignal; readonly fn: () => void }> = []

  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason)
    }
  }

  for (const sig of activeSignals) {
    if (sig.aborted) {
      forward(sig)
      return { signal: controller.signal, dispose: () => {} }
    }
  }

  for (const sig of activeSignals) {
    const fn = () => forward(sig)
    sig.addEventListener('abort', fn, { once: true })
    listeners.push({ signal: sig, fn })
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.fn)
      }
      listeners.length = 0
    },
  }
}

export interface ActiveTurnRecord {
  readonly id: string
  readonly traceId: string
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
  readonly inboundMsg?: InboundLarkMessage
  readonly senderName?: string
  readonly cancelController?: AbortController
  handoffTurns?: readonly RouterHandoffTurn[]
  sessionId?: string
  intermediateSentCount: number
  recoveryAttempts: number
  gracefulRecoveryAttempts: number
  lastActivityAtMs: number
  lastPersistedActivityAtMs: number
  interruptedAtMs?: number
  interruptKind?: PendingTurnInterruptKind
  status: PendingTurnStatus
  silencedByControl: boolean
  silenceReason?: string
  cancelledByRecall: boolean
  settled: boolean
  reactionRemoved: boolean
}

export interface InboundPipelineHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly connections: BotConnectionPool
  readonly sessions: SessionCoordinator
  readonly memory?: MemoryService
  readonly triage?: LlmTriageService
  readonly titleGuard: SessionTitleGuard
  readonly shutdownSignal: AbortSignal
  readonly isDisposed: () => boolean
  readonly isDraining?: () => boolean
  readonly onActivityChange?: () => void
  readonly sessionWebUrl: (sessionId: string) => string
}

interface RecoveryRunContext {
  readonly pendingTurnId: string
  readonly existingReactionId?: string
  readonly previousSessionId?: string
  readonly recoveryAttempts: number
  readonly gracefulRecoveryAttempts: number
  readonly totalRecoveryAttempts: number
  readonly previousIntermediateSentCount: number
  readonly handoffTurns?: readonly RouterHandoffTurn[]
  readonly startedAtMs: number
}

interface QueuedWorkerTurnItem {
  readonly msg: InboundLarkMessage
  readonly decision: AgentDecision
  readonly activeTurn: ActiveTurnRecord
  readonly cancelController: AbortController
  readonly traceId: string
  readonly senderName?: string
  readonly handoffTurns?: readonly RouterHandoffTurn[]
  readonly triageNote?: string
  readonly recoveryReminder?: string
}

function createTraceId(): string {
  return `tr_${randomBytes(4).toString('hex')}`
}

/**
 * Orchestrates inbound message processing: dedup, traceId assignment, routing,
 * slash commands, prompt assembly, serialized agent execution, structured silence
 * control, reply delivery, route alias tracking, and crash/shutdown turn recovery.
 */
export class InboundPipeline {
  private readonly dedup = new MessageDeduplicator()
  private readonly activeTurns = new Map<string, ActiveTurnRecord>()
  private readonly recalledMessages = new Map<string, number>()
  private readonly inflightControllers = new Map<string, Set<AbortController>>()
  private readonly recoveringTurnIds = new Set<string>()
  private readonly recoveryTasks = new Set<Promise<void>>()

  constructor(private readonly host: InboundPipelineHost) {
    this.dedup.hydrate(host.store.listSeenMessages?.() ?? [])
  }

  getActiveCount(): number {
    let active = 0
    for (const turn of this.activeTurns.values()) {
      if (!turn.settled) active += 1
    }
    return active + this.recoveringTurnIds.size
  }

  listActiveTurnSummaries(nowMs = Date.now()): ActiveTurnSummary[] {
    const out: ActiveTurnSummary[] = []
    for (const turn of this.activeTurns.values()) {
      if (turn.settled) continue
      const lastActivityAtMs = turn.lastActivityAtMs || turn.startedAtMs
      out.push({
        id: turn.id,
        botId: turn.botId,
        chatId: turn.chatId,
        ...(turn.chatName ? { chatName: turn.chatName } : {}),
        messageId: turn.messageId,
        routeKey: turn.routeKey,
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        trigger: turn.trigger,
        startedAtMs: turn.startedAtMs,
        lastActivityAtMs,
        idleSec: Math.max(0, Math.round((nowMs - lastActivityAtMs) / 1000)),
        willAutoResume: canAutoResumePendingTurn(turn, nowMs, { phase: 'shutdown' }),
      })
    }
    return out.sort((a, b) => a.startedAtMs - b.startedAtMs)
  }

  async waitForRecoveries(): Promise<void> {
    while (this.recoveryTasks.size > 0) {
      await Promise.allSettled([...this.recoveryTasks])
    }
  }

  /**
   * Explicit control-plane silence command (`lark-bridge silence` / `POST /agent/silence`):
   * marks the currently running silence-eligible turn for `sessionId` so any trailing
   * model commentary is unconditionally suppressed from Feishu delivery.
   */
  markSessionTurnSilent(
    sessionId: string,
    reason?: string,
  ): { readonly matched: boolean; readonly turnId?: string; readonly allowSilent: boolean } {
    const sid = sessionId.trim()
    if (!sid) return { matched: false, allowSilent: false }
    for (const turn of this.activeTurns.values()) {
      if (turn.settled || turn.sessionId !== sid) continue
      if (!turn.allowSilentEmptyReply) {
        return { matched: true, turnId: turn.id, allowSilent: false }
      }
      turn.silencedByControl = true
      if (reason?.trim()) turn.silenceReason = reason.trim()
      return { matched: true, turnId: turn.id, allowSilent: true }
    }
    return { matched: false, allowSilent: false }
  }

  private recallKey(botId: string, messageId: string): string {
    return `${botId}:${messageId}`
  }

  private isMessageRecalled(botId: string, messageId: string, nowMs = Date.now()): boolean {
    const key = this.recallKey(botId, messageId)
    const ts = this.recalledMessages.get(key)
    if (ts === undefined) return false
    if (nowMs - ts > RECALLED_MESSAGE_TTL_MS) {
      this.recalledMessages.delete(key)
      return false
    }
    return true
  }

  private markMessageRecalled(botId: string, messageId: string, nowMs = Date.now()): boolean {
    const key = this.recallKey(botId, messageId)
    const existing = this.recalledMessages.get(key)
    if (existing !== undefined && nowMs - existing <= RECALLED_MESSAGE_TTL_MS) {
      return false
    }
    this.recalledMessages.set(key, nowMs)
    if (this.recalledMessages.size > MAX_RECALLED_MESSAGES) {
      for (const [k, ts] of this.recalledMessages) {
        if (nowMs - ts > RECALLED_MESSAGE_TTL_MS) {
          this.recalledMessages.delete(k)
        }
      }
      while (this.recalledMessages.size > MAX_RECALLED_MESSAGES) {
        const oldest = this.recalledMessages.keys().next().value
        if (!oldest) break
        this.recalledMessages.delete(oldest)
      }
    }
    return true
  }

  private trackInflightController(
    botId: string,
    messageId: string,
    controller: AbortController,
  ): () => void {
    const key = this.recallKey(botId, messageId)
    let set = this.inflightControllers.get(key)
    if (!set) {
      set = new Set<AbortController>()
      this.inflightControllers.set(key, set)
    }
    set.add(controller)
    return () => {
      const current = this.inflightControllers.get(key)
      if (!current) return
      current.delete(controller)
      if (current.size === 0) {
        this.inflightControllers.delete(key)
      }
    }
  }

  /**
   * Handles Feishu `im.message.recalled_v1` events:
   * - Records the recalled messageId to suppress late/out-of-order execution.
   * - Removes the message from triage context so future routing ignores it.
   * - Cancels any in-flight triage, queued turn, or running Agent turn for that message.
   * - Cleans up matching persisted pending turns so restarts never replay recalled messages.
   */
  handleMessageRecalled(
    botId: string,
    transport: LarkBotTransport,
    event: RecalledLarkMessageEvent,
  ): void {
    if (this.host.isDisposed()) return
    if (!this.host.connections.isActiveTransport(botId, transport)) return
    const messageId = event.messageId.trim()
    if (!messageId) return

    const firstSeen = this.markMessageRecalled(botId, messageId)
    this.host.triage?.context.removeMessage(messageId)
    if (!firstSeen) return

    const reason = createRecalledAbortError()
    const key = this.recallKey(botId, messageId)
    const controllers = this.inflightControllers.get(key)
    let matchedAny = false

    for (const turn of this.activeTurns.values()) {
      if (turn.settled || turn.botId !== botId || turn.messageId !== messageId) continue
      matchedAny = true
      turn.cancelledByRecall = true
      turn.reactionRemoved = true
      if (turn.cancelController && !turn.cancelController.signal.aborted) {
        turn.cancelController.abort(reason)
      }
    }

    if (controllers) {
      for (const ctrl of [...controllers]) {
        matchedAny = true
        if (!ctrl.signal.aborted) {
          ctrl.abort(reason)
        }
      }
    }

    // Remove matching persisted pending turns not currently driven by an active in-memory turn
    // (e.g. awaiting delayed startup recovery) so they are never replayed.
    const activeTurnIds = new Set(this.activeTurns.keys())
    for (const pending of this.host.store.listPendingTurns()) {
      if (pending.botId !== botId || pending.messageId !== messageId) continue
      if (activeTurnIds.has(pending.id)) continue
      matchedAny = true
      this.host.store.deletePendingTurn(pending.id)
      this.host.store.recordEvent({
        botId: pending.botId,
        chatId: pending.chatId,
        ...(pending.chatName ? { chatName: pending.chatName } : {}),
        routeKey: pending.routeKey,
        ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
        ...(pending.traceId ? { traceId: pending.traceId } : {}),
        kind: 'lifecycle',
        summary: '原消息已撤回，已取消待恢复轮次',
      })
    }

    if (matchedAny) {
      this.host.ctx.logger.info(
        `[lark-bridge][bot=${botId}][msg=${messageId}] message recalled; cancelling in-flight turn`,
      )
    }
  }

  async handleInbound(
    botId: string,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ): Promise<void> {
    if (this.host.isDisposed() || this.host.isDraining?.()) return
    if (!this.host.connections.isActiveTransport(botId, transport)) return
    const bot = this.host.store.getBot(botId)
    if (!bot) return

    const dedupKey = `${bot.larkAppId}:${msg.messageId}`
    if (!this.dedup.claim(dedupKey)) return
    if (this.isMessageRecalled(bot.id, msg.messageId)) {
      this.host.store.rememberSeenMessage?.(dedupKey)
      return
    }
    const traceId = createTraceId()

    const groupConfig =
      msg.chatType === 'group' ? this.host.store.getGroup(bot.id, msg.chatId) : undefined
    const knownChatName =
      msg.chatType === 'group' ? this.host.store.resolveChatName(bot.id, msg.chatId) : undefined
    const decision = this.resolveDecisionForMessage(bot, msg, groupConfig, knownChatName)

    if (decision.action === 'ignore') {
      if (
        msg.chatType === 'group' &&
        decision.reason !== 'bot_disabled' &&
        decision.reason !== 'self_message' &&
        decision.reason !== 'group_disabled'
      ) {
        this.recordIgnoredGroupContext(bot, transport, msg, groupConfig)
      }
      if (decision.reason !== 'no_matching_rule' && decision.reason !== 'self_message') {
        this.host.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'ignored' })
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          traceId,
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
      this.host.store.rememberSeenMessage?.(dedupKey)
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        routeKey: decision.routeKey,
        traceId,
        kind: 'command',
        summary: `/${decision.command.name} ${decision.command.args}`.trim(),
      })
      await handleSlashCommand(
        {
          ctx: this.host.ctx,
          store: this.host.store,
          runtimes: this.host.runtimes,
          unbindRoute: (key, opts) => this.host.sessions.unbindRoute(key, opts),
          sessionWebUrl: (sid) => this.host.sessionWebUrl(sid),
          runTurn: (agent, content) =>
            runTurnAndCollectReply(this.host.ctx, agent, content, {
              signal: this.host.shutdownSignal,
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

    this.host.store.rememberSeenMessage?.(dedupKey)
    await this.runAgentTurn(bot, transport, msg, decision, groupConfig, traceId)
  }

  private resolveDecisionForMessage(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    groupConfig: LarkGroupConfig | undefined,
    knownChatName: string | undefined,
  ) {
    const rawDecision = decideLarkRouting(bot, msg, {
      groupConfig,
      ...(knownChatName ? { chatName: knownChatName } : {}),
      hasActiveSessionForRoute: (routeKey) => Boolean(this.host.store.getBinding(routeKey)),
      hasEphemeralRouterThread: (routeKey) =>
        Boolean(this.host.triage?.context.hasEphemeralThread(routeKey)),
      getRouteTrigger: (routeKey) =>
        this.host.store.getBinding(routeKey)?.trigger ??
        this.host.triage?.context.getEphemeralThreadTrigger(routeKey),
      hasRouteReplied: (routeKey) => {
        const binding = this.host.store.getBinding(routeKey)
        if (binding) return binding.hasReplied !== false
        if (this.host.triage?.context.hasEphemeralThread(routeKey)) return true
        return true
      },
    })
    return rawDecision.action !== 'ignore'
      ? {
          ...rawDecision,
          workspaceName:
            msg.chatType === 'group'
              ? this.host.store.resolveGroupWorkspaceName(bot, groupConfig, knownChatName)
              : this.host.store.resolveBotWorkspaceName(bot),
        }
      : rawDecision
  }

  private recordIgnoredGroupContext(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    groupConfig: LarkGroupConfig | undefined,
  ): void {
    if (!this.host.triage) return
    const routerConfig = resolveEffectiveRouterConfig(bot, groupConfig)
    if (!routerConfig.enabled) return

    const text =
      replaceMentionKeysWithNames(msg.text, msg.mentions).trim() ||
      (msg.imageKeys.length > 0 ? '[图片消息]' : `[${msg.msgType}]`)
    if (!text) return

    const chatScopeKey = `chat:${bot.id}:${msg.chatId}`
    let threadRouteKey: string | undefined
    const scopeId = msg.rootId ?? msg.threadId
    if (scopeId) {
      const candidate = buildRouteKey(bot.larkAppId, msg.chatId, scopeId)
      if (
        this.host.store.getBinding(candidate) ||
        this.host.triage.context.hasEphemeralThread(candidate)
      ) {
        threadRouteKey = candidate
      }
    }

    const cachedName =
      typeof transport.getCachedUserName === 'function'
        ? transport.getCachedUserName(msg.senderOpenId)
        : undefined
    const timestampMs = msg.createTimeMs || Date.now()
    this.host.triage.context.recordChatMessage(
      chatScopeKey,
      {
        role: 'user',
        ...(cachedName ? { senderName: cachedName } : {}),
        text,
        timestampMs,
        messageId: msg.messageId,
      },
      { ...(threadRouteKey ? { routeKey: threadRouteKey } : {}), now: timestampMs },
    )

    if (!cachedName && msg.senderType === 'user' && msg.senderOpenId) {
      void this.resolveSenderName(transport, msg).then((resolvedName) => {
        if (!resolvedName || this.host.isDisposed()) return
        this.host.triage?.context.recordChatMessage(
          chatScopeKey,
          {
            role: 'user',
            senderName: resolvedName,
            text,
            timestampMs,
            messageId: msg.messageId,
          },
          { ...(threadRouteKey ? { routeKey: threadRouteKey } : {}), now: timestampMs },
        )
      })
    }
  }

  async recoverStalePendingTurns(botId?: string, nowMs = Date.now()): Promise<number> {
    const stale = this.host.store.listPendingTurns().filter((item) => {
      if (botId && item.botId !== botId) return false
      return !this.activeTurns.has(item.id) && !this.recoveringTurnIds.has(item.id)
    })
    if (stale.length === 0) return 0

    let recovered = 0
    for (const item of stale) {
      if (this.activeTurns.has(item.id) || this.recoveringTurnIds.has(item.id)) continue
      if (this.isMessageRecalled(item.botId, item.messageId)) {
        this.host.store.deletePendingTurn(item.id)
        this.host.store.recordEvent({
          botId: item.botId,
          chatId: item.chatId,
          ...(item.chatName ? { chatName: item.chatName } : {}),
          routeKey: item.routeKey,
          ...(item.sessionId ? { sessionId: item.sessionId } : {}),
          ...(item.traceId ? { traceId: item.traceId } : {}),
          kind: 'lifecycle',
          summary: '原消息已撤回，已跳过重启恢复',
        })
        recovered += 1
        continue
      }
      const transport = this.host.connections.getTransport(item.botId)
      if (!transport) {
        const bot = this.host.store.getBot(item.botId)
        const expired = nowMs - item.startedAtMs > STALE_PENDING_TURN_MAX_AGE_MS
        if (!bot?.enabled || expired) {
          this.host.store.deletePendingTurn(item.id)
          this.host.store.recordEvent({
            botId: item.botId,
            chatId: item.chatId,
            ...(item.chatName ? { chatName: item.chatName } : {}),
            routeKey: item.routeKey,
            ...(item.sessionId ? { sessionId: item.sessionId } : {}),
            ...(item.traceId ? { traceId: item.traceId } : {}),
            kind: 'error',
            summary: '本轮执行因服务重启中断',
          })
          recovered += 1
        }
        continue
      }

      this.recoveringTurnIds.add(item.id)
      this.host.onActivityChange?.()
      let handedOffToAsyncTask = false
      try {
        const bot = this.host.store.getBot(item.botId)
        const groupConfig =
          item.inboundMsg?.chatType === 'group'
            ? this.host.store.getGroup(item.botId, item.chatId)
            : this.host.store.getGroup(item.botId, item.chatId)

        // 1. Check whether the interrupted session actually finished its turn right before shutdown.
        if (item.sessionId) {
          const inspection = await inspectPersistedTurnCompletion(
            this.host.ctx,
            item.sessionId,
            item.messageId,
          )
          if (inspection.state === 'completed') {
            this.host.store.deletePendingTurn(item.id)
            await this.deliverRecoveredCompletedTurn({
              bot,
              transport,
              turn: item,
              groupConfig,
              replyText: inspection.replyText,
              silencedByTool: inspection.silencedByTool,
            })
            recovered += 1
            continue
          }
        }

        // 2. Automatically resume eligible in-flight turns within the recovery window & retry budget.
        if (bot?.enabled && canAutoResumePendingTurn(item, nowMs, { phase: 'startup' })) {
          const replayMsg = item.inboundMsg!
          const knownChatName =
            item.chatName ||
            (replayMsg.chatType === 'group'
              ? this.host.store.resolveChatName(bot.id, replayMsg.chatId)
              : undefined)
          const decision = this.resolveDecisionForMessage(bot, replayMsg, groupConfig, knownChatName)
          if (decision.action === 'agent') {
            const isGracefulShutdown = item.interruptKind === 'graceful_shutdown'
            const nextCrashAttempts = isGracefulShutdown
              ? (item.recoveryAttempts ?? 0)
              : (item.recoveryAttempts ?? 0) + 1
            const nextGracefulAttempts = isGracefulShutdown
              ? (item.gracefulRecoveryAttempts ?? 0) + 1
              : (item.gracefulRecoveryAttempts ?? 0)
            const totalAttempts = nextCrashAttempts + nextGracefulAttempts
            const traceId = item.traceId || createTraceId()
            this.host.store.upsertPendingTurn({
              ...item,
              status: 'recovering',
              recoveryAttempts: nextCrashAttempts,
              gracefulRecoveryAttempts: nextGracefulAttempts,
              lastActivityAtMs: nowMs,
              updatedAtMs: nowMs,
            })
            this.host.store.recordEvent({
              botId: bot.id,
              chatId: item.chatId,
              ...(knownChatName ? { chatName: knownChatName } : {}),
              routeKey: decision.routeKey,
              ...(item.sessionId ? { sessionId: item.sessionId } : {}),
              traceId,
              kind: 'lifecycle',
              summary: `服务重启后自动恢复处理中消息（第 ${totalAttempts} 次恢复）`,
            })

            const task = this.runAgentTurn(bot, transport, replayMsg, decision, groupConfig, traceId, {
              pendingTurnId: item.id,
              ...(item.reactionId ? { existingReactionId: item.reactionId } : {}),
              ...(item.sessionId ? { previousSessionId: item.sessionId } : {}),
              recoveryAttempts: nextCrashAttempts,
              gracefulRecoveryAttempts: nextGracefulAttempts,
              totalRecoveryAttempts: totalAttempts,
              previousIntermediateSentCount: item.intermediateSentCount ?? 0,
              ...(item.handoffTurns ? { handoffTurns: item.handoffTurns } : {}),
              startedAtMs: item.startedAtMs,
            })
              .catch((err) => {
                this.host.ctx.logger.warn(
                  `[lark-bridge][bot=${bot.id}][msg=${item.messageId}] auto-resume failed: ${err instanceof Error ? err.message : String(err)}`,
                )
              })
              .finally(() => {
                this.recoveringTurnIds.delete(item.id)
                this.recoveryTasks.delete(task)
                this.host.onActivityChange?.()
              })
            this.recoveryTasks.add(task)
            handedOffToAsyncTask = true
            recovered += 1
            continue
          }
        }

        // 3. Non-recoverable (legacy row without payload, expired window, retries exhausted, or disabled):
        //    clean up stale reaction and notify interactive turns.
        this.host.store.deletePendingTurn(item.id)
        await this.deliverInterruptedTurnCleanup({
          transport,
          turn: item,
          intermediateSentCount: item.intermediateSentCount ?? 0,
          auditSummary: '本轮执行因服务重启中断',
          replyText: '本轮执行因服务重启中断，可重新回复继续。',
        })
        recovered += 1
      } finally {
        if (!handedOffToAsyncTask) {
          this.recoveringTurnIds.delete(item.id)
          this.host.onActivityChange?.()
        }
      }
    }
    return recovered
  }

  /**
   * Preserves recoverable in-flight turns in SQLite (`status: 'interrupted'`) with their
   * Feishu reaction intact so the next process resumes them seamlessly without error spam.
   * Only non-recoverable turns (missing payload or retries already exhausted) are cleaned up
   * and reported as interrupted.
   */
  async suspendActiveTurnsForShutdown(): Promise<void> {
    const nowMs = Date.now()
    const recoverable: ActiveTurnRecord[] = []
    const nonRecoverable: ActiveTurnRecord[] = []

    for (const record of this.activeTurns.values()) {
      if (record.settled) continue
      record.settled = true
      record.reactionRemoved = true
      if (canAutoResumePendingTurn(record, nowMs, { phase: 'shutdown' })) {
        recoverable.push(record)
      } else {
        nonRecoverable.push(record)
      }
    }
    this.activeTurns.clear()
    this.host.onActivityChange?.()

    for (const record of recoverable) {
      record.status = 'interrupted'
      record.interruptedAtMs = nowMs
      record.interruptKind = 'graceful_shutdown'
      this.persistActiveTurn(record, { force: true })
      this.host.store.recordEvent({
        botId: record.botId,
        chatId: record.chatId,
        ...(record.chatName ? { chatName: record.chatName } : {}),
        routeKey: record.routeKey,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        traceId: record.traceId,
        kind: 'lifecycle',
        summary: '服务重载或停机，已保存处理中任务待重启自动恢复',
      })
    }

    if (nonRecoverable.length === 0) return
    for (const record of nonRecoverable) {
      this.host.store.deletePendingTurn(record.id)
    }

    const work = Promise.all(
      nonRecoverable.map((record) =>
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

  async cleanupActiveTurnsOnShutdown(): Promise<void> {
    await this.suspendActiveTurnsForShutdown()
  }

  private async deliverRecoveredCompletedTurn(input: {
    readonly bot: LarkBotConfig | undefined
    readonly transport: LarkBotTransport
    readonly turn: LarkPendingTurn
    readonly groupConfig: LarkGroupConfig | undefined
    readonly replyText: string
    readonly silencedByTool: boolean
  }): Promise<void> {
    const { bot, transport, turn, groupConfig, replyText, silencedByTool } = input
    const normalized = silencedByTool
      ? ''
      : normalizeReplyText(replyText, { allowSilentSentinel: true })
    const isSilent = turn.allowSilentEmptyReply && (silencedByTool || !normalized)
    if (turn.reactionId) {
      await transport.removeReaction(turn.messageId, turn.reactionId).catch(() => {})
    }
    if (isSilent) {
      this.host.store.recordMetric({ botId: turn.botId, chatId: turn.chatId, kind: 'silent_skip' })
      this.host.store.recordEvent({
        botId: turn.botId,
        chatId: turn.chatId,
        ...(turn.chatName ? { chatName: turn.chatName } : {}),
        routeKey: turn.routeKey,
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        ...(turn.traceId ? { traceId: turn.traceId } : {}),
        kind: 'silent_skip',
        summary: '服务重启后检测到原回合已静默完成',
      })
      return
    }

    const text = normalized || '（已完成，无文本输出）'
    const useCard = bot
      ? resolveEffectiveCardBot(bot, groupConfig).useInteractiveCard
      : false
    const card =
      useCard && bot && turn.sessionId
        ? buildReplyCard({
            markdown: text,
            bot: resolveEffectiveCardBot(bot, groupConfig),
            sessionUrl: this.host.sessionWebUrl(turn.sessionId),
          })
        : undefined
    await transport
      .sendReply({
        chatId: turn.chatId,
        replyToMessageId: turn.messageId,
        replyMode: turn.replyMode,
        ...(card ? { card } : { text }),
      })
      .catch(() => {})
    this.host.store.markBindingReplied(turn.routeKey)
    this.host.store.recordMetric({
      botId: turn.botId,
      chatId: turn.chatId,
      ...(turn.chatName ? { chatName: turn.chatName } : {}),
      kind: 'replied',
      latencyMs: Date.now() - turn.startedAtMs,
    })
    this.host.store.recordEvent({
      botId: turn.botId,
      chatId: turn.chatId,
      ...(turn.chatName ? { chatName: turn.chatName } : {}),
      routeKey: turn.routeKey,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(turn.traceId ? { traceId: turn.traceId } : {}),
      durationMs: Date.now() - turn.startedAtMs,
      kind: 'reply',
      summary: `服务重启后检测到原回合已完成，已补发回复（${text.length} 字）`,
    })
  }

  private async runAgentTurn(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    groupConfig: LarkGroupConfig | undefined,
    traceId: string,
    recovery?: RecoveryRunContext,
  ): Promise<void> {
    const startedMs = recovery?.startedAtMs ?? Date.now()
    const resolvedChatName =
      decision.chatName || this.host.store.resolveChatName(bot.id, msg.chatId)
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}
    if (!recovery) {
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        kind: 'inbound',
        now: startedMs,
      })
      if (decision.trigger === 'listener') {
        this.host.store.recordMetric({
          botId: bot.id,
          chatId: msg.chatId,
          kind: 'listener',
          now: startedMs,
        })
      }
    }

    const routerConfig = resolveEffectiveRouterConfig(bot, groupConfig)
    const msgCancelController = new AbortController()
    const untrackInflight = this.trackInflightController(
      bot.id,
      msg.messageId,
      msgCancelController,
    )
    const isSelfRecalled = () =>
      msgCancelController.signal.aborted || this.isMessageRecalled(bot.id, msg.messageId)
    const recordPreTurnRecall = (summary: string) => {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        traceId,
        kind: 'lifecycle',
        summary,
      })
    }

    try {
      if (isSelfRecalled()) {
        recordPreTurnRecall('原消息已撤回，已取消当前轮次并停止执行')
        return
      }

      const senderName = await this.resolveSenderName(transport, msg)
      if (isSelfRecalled()) {
        recordPreTurnRecall('原消息已撤回，已取消当前轮次并停止执行')
        return
      }

      const chatScopeKey = `chat:${bot.id}:${msg.chatId}`
      let triageNote: string | undefined
      let triageSessionId: string | undefined

      if (!recovery && this.host.triage && shouldRunTriage(decision, routerConfig)) {
        const triageOutcome = await this.evaluateAndHandleTriage({
          bot,
          transport,
          msg,
          decision,
          groupConfig,
          routerConfig,
          ...(senderName ? { senderName } : {}),
          ...(resolvedChatName ? { resolvedChatName } : {}),
          chatScopeKey,
          traceId,
          startedMs,
          cancelSignal: msgCancelController.signal,
        })
        if (triageOutcome.handled || this.host.isDisposed()) return
        if (isSelfRecalled()) {
          recordPreTurnRecall('原消息已撤回，已取消当前轮次并停止执行')
          return
        }
        triageNote = triageOutcome.triageNote
        triageSessionId = triageOutcome.triageSessionId
      } else if (!recovery && this.host.triage && msg.chatType === 'group') {
        this.host.triage.context.recordInboundMessage(chatScopeKey, decision.routeKey, {
          role: 'user',
          ...(senderName ? { senderName } : {}),
          text: decision.userText,
          timestampMs: startedMs,
          messageId: msg.messageId,
        })
      }

      if (isSelfRecalled()) {
        recordPreTurnRecall('原消息已撤回，已取消当前轮次并停止执行')
        return
      }

      const reaction = decision.receivedReactionEmoji
      const reactionId = recovery?.existingReactionId
        ? recovery.existingReactionId
        : reaction
          ? await transport.addReaction(msg.messageId, reaction)
          : undefined
      if (this.host.isDisposed()) {
        if (!recovery && reactionId) await transport.removeReaction(msg.messageId, reactionId)
        return
      }
      if (isSelfRecalled()) {
        recordPreTurnRecall('原消息已撤回，已取消当前轮次并停止执行')
        return
      }

      const activeTurn = this.registerActiveTurn({
        ...(recovery ? { id: recovery.pendingTurnId } : {}),
        traceId,
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
        inboundMsg: msg,
        ...(senderName ? { senderName } : {}),
        cancelController: msgCancelController,
        ...(recovery?.handoffTurns ? { handoffTurns: recovery.handoffTurns } : {}),
        intermediateSentCount: recovery?.previousIntermediateSentCount ?? 0,
        recoveryAttempts: recovery?.recoveryAttempts ?? 0,
        gracefulRecoveryAttempts: recovery?.gracefulRecoveryAttempts ?? 0,
      })

      let trackedSessionId: string | undefined
      let acquiredRef: AcquiredAgent | undefined
      let leaderRegistered = false
      let releaseTurnSlot: (() => void) | undefined
      let finishBatch: (() => void) | undefined
      let shouldDisposeEphemeral = false
      let shouldArchiveEphemeral = false
      let batchItems: readonly QueuedWorkerTurnItem[] = [
        {
          msg,
          decision,
          activeTurn,
          cancelController: msgCancelController,
          traceId,
          ...(senderName ? { senderName } : {}),
          ...(recovery?.handoffTurns ? { handoffTurns: recovery.handoffTurns } : {}),
          ...(triageNote ? { triageNote } : {}),
        },
      ]

      try {
        const acquired = await this.host.sessions.acquireAgent(bot, msg, decision)
        acquiredRef = acquired
        trackedSessionId = acquired.sessionId
        activeTurn.sessionId = trackedSessionId

        if (isSelfRecalled() || activeTurn.cancelledByRecall) {
          this.settleRecalledTurn(activeTurn, '原消息已撤回，已取消当前轮次并停止执行')
          shouldDisposeEphemeral = Boolean(acquired.disposeAfter || acquired.isNew)
          shouldArchiveEphemeral = shouldDisposeEphemeral
          return
        }

        const handoff = this.host.triage?.context.consumeEphemeralHandoff(decision.routeKey)
        if (handoff && decision.sessionMode === 'thread') {
          for (const aliasKey of handoff.aliasRouteKeys) {
            this.host.store.bindRouteAlias(decision.routeKey, aliasKey)
          }
        }
        const effectiveHandoffTurns =
          handoff?.turns.length ? handoff.turns : recovery?.handoffTurns
        if (effectiveHandoffTurns && effectiveHandoffTurns.length > 0) {
          activeTurn.handoffTurns = effectiveHandoffTurns
        }
        this.persistActiveTurn(activeTurn)
        if (triageSessionId) {
          this.host.store.linkTriageHandoffSession?.(triageSessionId, acquired.sessionId)
        }

        const recoveryReminder =
          recovery &&
          recovery.previousSessionId &&
          acquired.sessionId === recovery.previousSessionId &&
          !acquired.isNew
            ? composeRestartRecoveryReminder({
                attempt: recovery.totalRecoveryAttempts,
                intermediateSentCount: recovery.previousIntermediateSentCount,
              })
            : undefined

        const selfItem: QueuedWorkerTurnItem = {
          msg,
          decision,
          activeTurn,
          cancelController: msgCancelController,
          traceId,
          ...(senderName ? { senderName } : {}),
          ...(effectiveHandoffTurns?.length ? { handoffTurns: effectiveHandoffTurns } : {}),
          ...(triageNote ? { triageNote } : {}),
          ...(recoveryReminder ? { recoveryReminder } : {}),
        }
        batchItems = [selfItem]

        if (activeTurn.settled || this.host.isDisposed()) {
          shouldDisposeEphemeral = acquired.disposeAfter
          return
        }

        const allowCoalesce =
          routerConfig.coalesceQueuedMessages && decision.sessionMode !== 'per_message'
        const slot = await this.host.sessions.acquireCoalescedTurnSlot(trackedSessionId, selfItem, {
          coalesce: allowCoalesce,
          signal: this.host.shutdownSignal,
          itemSignal: msgCancelController.signal,
          isAborted: () =>
            activeTurn.settled ||
            activeTurn.cancelledByRecall ||
            isSelfRecalled() ||
            this.host.isDisposed(),
          onLeaderRegistered: () => {
            leaderRegistered = true
            this.host.sessions.markTurnRegistered(trackedSessionId!)
          },
        })

        if (slot.role === 'follower') {
          // Leader owns execution, reply delivery, activeTurn settlement, and reaction cleanup.
          batchItems = []
          return
        }
        if (slot.role === 'aborted') {
          batchItems = slot.orphanedItems
          const abortNowMs = Date.now()
          let anyRecalled = false
          for (const orphaned of slot.orphanedItems) {
            if (this.isTurnRecalled(bot.id, orphaned)) {
              anyRecalled = true
              this.settleRecalledTurn(orphaned.activeTurn, '原消息已撤回，已取消排队轮次')
            } else if (
              this.host.isDisposed() &&
              canAutoResumePendingTurn(orphaned.activeTurn, abortNowMs, { phase: 'shutdown' })
            ) {
              this.suspendSingleTurnForRestart(orphaned.activeTurn, abortNowMs)
            } else {
              this.claimActiveTurn(orphaned.activeTurn)
            }
          }
          const currentBinding = this.host.store.getBinding(decision.routeKey)
          shouldDisposeEphemeral = Boolean(
            acquired.disposeAfter ||
              (anyRecalled && acquired.isNew && currentBinding?.hasReplied === false),
          )
          shouldArchiveEphemeral = Boolean(anyRecalled && shouldDisposeEphemeral)
          return
        }

        if (slot.abandonedItems && slot.abandonedItems.length > 0) {
          for (const abandoned of slot.abandonedItems) {
            if (this.isTurnRecalled(bot.id, abandoned)) {
              this.settleRecalledTurn(abandoned.activeTurn, '原消息已撤回，已从合并队列移除')
            } else {
              this.claimActiveTurn(abandoned.activeTurn)
            }
          }
        }

        releaseTurnSlot = slot.release
        finishBatch = slot.finishBatch
        batchItems = slot.items

        const latestItem = batchItems[batchItems.length - 1] ?? selfItem
        const batchSize = batchItems.length
        const effectiveDecision: AgentDecision =
          batchSize === 1
            ? latestItem.decision
            : {
                ...latestItem.decision,
                allowSilentEmptyReply: batchItems.every((i) => i.decision.allowSilentEmptyReply),
                autoCloseAfterCompletion: batchItems.every(
                  (i) => i.decision.autoCloseAfterCompletion,
                ),
              }

        this.host.titleGuard.ensureCleanSessionTitle(
          acquired.agent.session,
          latestItem.msg,
          latestItem.decision.userText,
          acquired.isNew,
        )

        const inboundBaseSummary = `${effectiveDecision.listenerName ? `监听「${effectiveDecision.listenerName}」` : effectiveDecision.trigger} → ${effectiveDecision.agentPreset} · ${effectiveDecision.workspaceName}`
        const inboundTags = [
          ...(recovery ? [`重启自动恢复 #${recovery.totalRecoveryAttempts}`] : []),
          ...(triageNote ? [triageNote] : []),
          ...(batchSize > 1 ? [`合并 ${batchSize} 条排队消息`] : []),
        ]
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          ...chatName,
          routeKey: effectiveDecision.routeKey,
          sessionId: acquired.sessionId,
          traceId: latestItem.traceId,
          kind: 'inbound',
          summary:
            inboundTags.length > 0
              ? `${inboundBaseSummary}（${inboundTags.join('；')}）`
              : inboundBaseSummary,
        })

        const content = await this.buildBatchPrompt(
          bot,
          transport,
          batchItems,
          effectiveDecision,
          acquired.isNew,
          resolvedChatName,
        )
        if (batchItems.some((i) => this.isTurnRecalled(bot.id, i))) {
          throw createRecalledAbortError()
        }
        if (batchItems.every((i) => i.activeTurn.settled) || this.host.isDisposed()) {
          shouldDisposeEphemeral = acquired.disposeAfter
          return
        }

        const linkedCancel = linkAbortSignals(batchItems.map((i) => i.cancelController.signal))
        const isSilenced = () => batchItems.some((i) => i.activeTurn.silencedByControl)
        const isBatchRecalled = () =>
          linkedCancel.signal.aborted || batchItems.some((i) => this.isTurnRecalled(bot.id, i))
        let replyText: string
        try {
          replyText = await runTurnAndCollectReply(this.host.ctx, acquired.agent, content, {
            signal: this.host.shutdownSignal,
            cancelSignal: linkedCancel.signal,
            onActivity: (timestampMs) => {
              for (const item of batchItems) {
                this.touchActiveTurnActivity(item.activeTurn, timestampMs)
              }
            },
            ...(effectiveDecision.sendIntermediateMessages
              ? {
                  onIntermediate: async (stepText) => {
                    if (isSilenced() || isBatchRecalled()) return
                    const sent = await this.deliverIntermediateReply(
                      bot,
                      transport,
                      latestItem.msg,
                      effectiveDecision,
                      stepText,
                    )
                    if (sent) {
                      const sentAtMs = Date.now()
                      latestItem.activeTurn.intermediateSentCount += 1
                      latestItem.activeTurn.lastActivityAtMs = sentAtMs
                      latestItem.activeTurn.lastPersistedActivityAtMs = sentAtMs
                      this.persistActiveTurn(latestItem.activeTurn)
                      this.host.store.markBindingReplied(effectiveDecision.routeKey)
                    }
                  },
                }
              : {}),
          })
        } finally {
          linkedCancel.dispose()
        }

        const settlement = await this.settleBatchReply({
          bot,
          transport,
          groupConfig,
          resolvedChatName,
          acquired,
          batchItems,
          effectiveDecision,
          replyText,
          startedMs,
        })
        shouldDisposeEphemeral = settlement.dispose
        shouldArchiveEphemeral = settlement.archive
      } catch (err) {
        const failure = await this.handleBatchFailure({
          bot,
          transport,
          msg,
          decision,
          resolvedChatName,
          activeTurn,
          batchItems,
          acquiredRef,
          trackedSessionId,
          err,
        })
        shouldDisposeEphemeral = failure.dispose
        shouldArchiveEphemeral = failure.archive
      } finally {
        for (const item of batchItems) {
          if (!item.activeTurn.reactionRemoved && item.activeTurn.reactionId) {
            item.activeTurn.reactionRemoved = true
            await transport
              .removeReaction(item.msg.messageId, item.activeTurn.reactionId)
              .catch(() => {})
          }
        }
        finishBatch?.()
        let otherTurnsInFlight = false
        if (trackedSessionId && leaderRegistered) {
          otherTurnsInFlight = this.host.sessions.markTurnFinished(trackedSessionId)
        }
        if (trackedSessionId && !otherTurnsInFlight && shouldDisposeEphemeral) {
          await this.host.sessions
            .disposeEphemeral(trackedSessionId, decision.routeKey, {
              archive: shouldArchiveEphemeral,
            })
            .catch(() => {})
        }
        releaseTurnSlot?.()
      }
    } finally {
      untrackInflight()
    }
  }

  private async settleBatchReply(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly groupConfig: LarkGroupConfig | undefined
    readonly resolvedChatName?: string
    readonly acquired: AcquiredAgent
    readonly batchItems: readonly QueuedWorkerTurnItem[]
    readonly effectiveDecision: AgentDecision
    readonly replyText: string
    readonly startedMs: number
  }): Promise<{ readonly dispose: boolean; readonly archive: boolean }> {
    const {
      bot,
      transport,
      groupConfig,
      resolvedChatName,
      acquired,
      batchItems,
      effectiveDecision,
      replyText,
      startedMs,
    } = input
    const latestItem = batchItems[batchItems.length - 1]!
    const batchSize = batchItems.length
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}

    let anyClaimed = false
    for (const item of batchItems) {
      if (this.claimActiveTurn(item.activeTurn)) anyClaimed = true
    }
    if (!anyClaimed) {
      return { dispose: acquired.disposeAfter, archive: false }
    }

    if (batchItems.some((item) => this.isTurnRecalled(bot.id, item))) {
      for (const item of batchItems) {
        if (this.isTurnRecalled(bot.id, item)) {
          item.activeTurn.reactionRemoved = true
        }
      }
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        ...chatName,
        routeKey: effectiveDecision.routeKey,
        sessionId: acquired.sessionId,
        traceId: latestItem.traceId,
        durationMs: Date.now() - startedMs,
        kind: 'lifecycle',
        summary:
          batchSize > 1
            ? '批次中存在已撤回消息，已取消当前轮次并跳过回复'
            : '原消息已撤回，已取消当前轮次并跳过回复',
      })
      const currentBinding = this.host.store.getBinding(effectiveDecision.routeKey)
      const dispose = Boolean(
        acquired.disposeAfter || (acquired.isNew && currentBinding?.hasReplied === false),
      )
      return { dispose, archive: dispose }
    }

    const intermediateSentCount = batchItems.reduce(
      (sum, item) => sum + item.activeTurn.intermediateSentCount,
      0,
    )
    const latencyMs = Date.now() - startedMs
    this.host.store.touchBinding(effectiveDecision.routeKey)
    this.host.store.touchManagedSession(acquired.sessionId)
    this.host.titleGuard.ensureCleanSessionTitle(
      acquired.agent.session,
      latestItem.msg,
      latestItem.decision.userText,
      false,
    )

    const silencedItem = batchItems.find((i) => i.activeTurn.silencedByControl)
    const interceptedSilentSentinel =
      !silencedItem &&
      !effectiveDecision.allowSilentEmptyReply &&
      isSilentReplySentinel(replyText)
    const normalizedReply = silencedItem
      ? ''
      : normalizeReplyText(replyText, {
          allowSilentSentinel: true,
        })
    const hasFinalText = normalizedReply.length > 0
    const isSilentSkip =
      effectiveDecision.allowSilentEmptyReply &&
      (Boolean(silencedItem) || !hasFinalText) &&
      intermediateSentCount === 0

    if (isSilentSkip) {
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        kind: 'silent_skip',
      })
      const silentSummary = silencedItem
        ? silencedItem.activeTurn.silenceReason
          ? `工具显式静默：${silencedItem.activeTurn.silenceReason}`
          : '工具显式静默，已跳过回复'
        : '判断无需回复，已静默'
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        routeKey: effectiveDecision.routeKey,
        sessionId: acquired.sessionId,
        traceId: latestItem.traceId,
        durationMs: latencyMs,
        kind: 'silent_skip',
        summary: silentSummary,
      })
    } else {
      if (interceptedSilentSentinel) {
        this.host.ctx.logger.warn(
          `[lark-bridge][trace=${latestItem.traceId}][bot=${bot.id}][session=${acquired.sessionId}] intercepted silent sentinel on non-silent turn (trigger=${effectiveDecision.trigger})`,
        )
      }
      const fallbackText = interceptedSilentSentinel
        ? UNEXPECTED_SILENT_SENTINEL_FALLBACK
        : undefined
      if (hasFinalText || intermediateSentCount === 0) {
        try {
          await this.deliverReply(
            bot,
            transport,
            latestItem.msg,
            effectiveDecision,
            acquired.sessionId,
            normalizedReply,
            groupConfig,
            fallbackText,
          )
        } catch (err) {
          if (isLarkMessageRecalledError(err)) {
            latestItem.activeTurn.reactionRemoved = true
            this.host.store.recordEvent({
              botId: bot.id,
              chatId: latestItem.msg.chatId,
              ...chatName,
              routeKey: effectiveDecision.routeKey,
              sessionId: acquired.sessionId,
              traceId: latestItem.traceId,
              durationMs: Date.now() - startedMs,
              kind: 'lifecycle',
              summary: '目标消息已撤回（230006），已取消回复投递',
            })
            const currentBinding = this.host.store.getBinding(effectiveDecision.routeKey)
            const dispose = Boolean(
              acquired.disposeAfter || (acquired.isNew && currentBinding?.hasReplied === false),
            )
            return { dispose, archive: dispose }
          }
          throw err
        }
      }
      if (hasFinalText && latestItem.msg.chatType === 'group') {
        this.host.triage?.context.recordWorkerReply(effectiveDecision.routeKey, normalizedReply, Date.now(), {
          chatScopeKey: `chat:${bot.id}:${latestItem.msg.chatId}`,
        })
      }
      this.host.store.markBindingReplied(effectiveDecision.routeKey)
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        ...chatName,
        kind: 'replied',
        latencyMs,
      })
      const batchSuffix = batchSize > 1 ? `（合并 ${batchSize} 条消息）` : ''
      const replySummary =
        intermediateSentCount > 0
          ? `已发送 ${intermediateSentCount} 条过程消息${hasFinalText ? ` + 最终回复 ${normalizedReply.length} 字` : ''}`
          : interceptedSilentSentinel
            ? `已拦截非静默轮次的 <no_reply/> 并回退兜底回复（${UNEXPECTED_SILENT_SENTINEL_FALLBACK.length} 字）`
            : `已回复 ${normalizedReply.length} 字`
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        routeKey: effectiveDecision.routeKey,
        sessionId: acquired.sessionId,
        traceId: latestItem.traceId,
        durationMs: latencyMs,
        kind: 'reply',
        summary: replySummary + batchSuffix,
      })
    }

    const currentBinding = this.host.store.getBinding(effectiveDecision.routeKey)
    const isNeverRepliedListener =
      isSilentSkip &&
      effectiveDecision.trigger === 'listener' &&
      (acquired.isNew || currentBinding?.hasReplied === false)
    const dispose = Boolean(
      acquired.disposeAfter || effectiveDecision.autoCloseAfterCompletion || isNeverRepliedListener,
    )
    const archive = dispose && isSilentSkip && (acquired.isNew || isNeverRepliedListener)
    return { dispose, archive }
  }

  private async handleBatchFailure(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly msg: InboundLarkMessage
    readonly decision: AgentDecision
    readonly resolvedChatName?: string
    readonly activeTurn: ActiveTurnRecord
    readonly batchItems: readonly QueuedWorkerTurnItem[]
    readonly acquiredRef: AcquiredAgent | undefined
    readonly trackedSessionId: string | undefined
    readonly err: unknown
  }): Promise<{ readonly dispose: boolean; readonly archive: boolean }> {
    const {
      bot,
      transport,
      msg,
      decision,
      resolvedChatName,
      activeTurn,
      batchItems,
      acquiredRef,
      trackedSessionId,
      err,
    } = input
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}
    const latestItem = batchItems[batchItems.length - 1]
    const targetTurn = latestItem?.activeTurn ?? activeTurn
    const targetMsg = latestItem?.msg ?? msg
    const targetDecision = latestItem?.decision ?? decision
    const totalIntermediate = batchItems.reduce(
      (sum, item) => sum + item.activeTurn.intermediateSentCount,
      0,
    )

    let dispose = false
    let archive = false
    if (acquiredRef) {
      const currentBinding = this.host.store.getBinding(targetDecision.routeKey)
      const isSilentFailedListener =
        !this.shouldNotifyInterruptedTurn(targetTurn, totalIntermediate) &&
        (acquiredRef.isNew || currentBinding?.hasReplied === false)
      if (acquiredRef.disposeAfter || isSilentFailedListener) {
        dispose = true
        archive = isSilentFailedListener
      }
    }

    const isRestartAbort =
      err instanceof TurnAbortedError && (err.kind === 'disposed' || err.kind === 'interrupted')
    if (isRestartAbort) {
      const nonRecoverableItems: QueuedWorkerTurnItem[] = []
      const nowMs = Date.now()
      let suspendedCount = 0
      for (const item of batchItems) {
        if (item.activeTurn.settled) {
          if (item.activeTurn.status === 'interrupted') suspendedCount += 1
          continue
        }
        if (canAutoResumePendingTurn(item.activeTurn, nowMs, { phase: 'shutdown' })) {
          this.suspendSingleTurnForRestart(item.activeTurn, nowMs)
          suspendedCount += 1
        } else {
          nonRecoverableItems.push(item)
        }
      }
      if (nonRecoverableItems.length === 0) {
        return { dispose: false, archive: false }
      }
      // Fall through to interrupt-cleanup only for non-recoverable turns.
      for (const item of nonRecoverableItems) {
        this.claimActiveTurn(item.activeTurn)
        item.activeTurn.reactionRemoved = true
        if (item.activeTurn !== targetTurn && item.activeTurn.reactionId) {
          await transport
            .removeReaction(item.msg.messageId, item.activeTurn.reactionId)
            .catch(() => {})
        }
      }
      const fallbackTurn = nonRecoverableItems[nonRecoverableItems.length - 1]!.activeTurn
      await this.deliverInterruptedTurnCleanup({
        transport,
        turn: fallbackTurn,
        intermediateSentCount: totalIntermediate,
        auditSummary: err.message,
        replyText: `${err.message}，可重新回复继续。`,
      })
      if (suspendedCount > 0) {
        return { dispose: false, archive: false }
      }
      return { dispose, archive }
    }

    const isRecalledAbort =
      (err instanceof TurnAbortedError && err.kind === 'recalled') ||
      batchItems.some((item) => this.isTurnRecalled(bot.id, item))
    if (isRecalledAbort) {
      let anyRecalledClaimed = false
      for (const item of batchItems) {
        if (this.isTurnRecalled(bot.id, item)) {
          item.activeTurn.reactionRemoved = true
        }
        if (this.claimActiveTurn(item.activeTurn)) {
          anyRecalledClaimed = true
        }
      }
      if (anyRecalledClaimed) {
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: targetMsg.chatId,
          ...chatName,
          routeKey: targetDecision.routeKey,
          ...(trackedSessionId ? { sessionId: trackedSessionId } : {}),
          traceId: targetTurn.traceId,
          durationMs: Date.now() - targetTurn.startedAtMs,
          kind: 'lifecycle',
          summary:
            batchItems.length > 1
              ? '批次中存在已撤回消息，已取消当前轮次并停止执行'
              : '原消息已撤回，已取消当前轮次并停止执行',
        })
      }
      if (acquiredRef) {
        if (acquiredRef.disposeAfter || (acquiredRef.isNew && totalIntermediate === 0)) {
          dispose = true
          archive = true
        }
      }
      return { dispose, archive }
    }

    let anyClaimed = false
    for (const item of batchItems) {
      if (this.claimActiveTurn(item.activeTurn)) anyClaimed = true
    }
    if (!anyClaimed) return { dispose, archive }

    const errorMsg = err instanceof Error ? err.message : String(err)
    this.host.ctx.logger.error(
      `[lark-bridge][trace=${targetTurn.traceId}][bot=${bot.id}][msg=${targetMsg.messageId}] turn handling failed: ${errorMsg}`,
    )
    if (err instanceof TurnAbortedError) {
      for (const item of batchItems) {
        item.activeTurn.reactionRemoved = true
        if (item.activeTurn !== targetTurn && item.activeTurn.reactionId) {
          await transport
            .removeReaction(item.msg.messageId, item.activeTurn.reactionId)
            .catch(() => {})
        }
      }
      await this.deliverInterruptedTurnCleanup({
        transport,
        turn: targetTurn,
        intermediateSentCount: totalIntermediate,
        auditSummary: errorMsg,
        replyText: `${errorMsg}，可重新回复继续。`,
      })
    } else {
      this.host.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'error' })
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: targetDecision.routeKey,
        ...(trackedSessionId ? { sessionId: trackedSessionId } : {}),
        traceId: targetTurn.traceId,
        kind: 'error',
        summary: errorMsg,
      })
      if (this.shouldNotifyInterruptedTurn(targetTurn, totalIntermediate)) {
        await transport
          .sendReply({
            chatId: msg.chatId,
            replyToMessageId: targetMsg.messageId,
            replyMode: targetDecision.replyMode,
            text: `执行异常：${errorMsg}`,
          })
          .catch(() => {})
      }
    }
    return { dispose, archive }
  }

  private async evaluateAndHandleTriage(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly msg: InboundLarkMessage
    readonly decision: AgentDecision
    readonly groupConfig?: LarkGroupConfig
    readonly routerConfig: EffectiveRouterConfig
    readonly senderName?: string
    readonly resolvedChatName?: string
    readonly chatScopeKey: string
    readonly traceId: string
    readonly startedMs: number
    readonly cancelSignal?: AbortSignal
  }): Promise<{
    readonly handled: boolean
    readonly triageNote?: string
    readonly triageSessionId?: string
  }> {
    const {
      bot,
      transport,
      msg,
      decision,
      groupConfig,
      routerConfig,
      senderName,
      resolvedChatName,
      chatScopeKey,
      traceId,
      startedMs,
      cancelSignal,
    } = input
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}
    const isRecalled = () =>
      Boolean(cancelSignal?.aborted) || this.isMessageRecalled(bot.id, msg.messageId)

    const bypass = shouldFastBypassTriage(msg, decision, routerConfig.bypass)
    if (bypass.bypass) {
      if (isRecalled()) {
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          ...chatName,
          routeKey: decision.routeKey,
          traceId,
          kind: 'lifecycle',
          summary: '原消息已撤回，已取消当前轮次并停止执行',
        })
        return { handled: true }
      }
      this.host.triage?.context.recordInboundMessage(chatScopeKey, decision.routeKey, {
        role: 'user',
        ...(senderName ? { senderName } : {}),
        text: decision.userText,
        timestampMs: startedMs,
        messageId: msg.messageId,
      })
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        traceId,
        kind: 'triage',
        summary: `规则直通：${bypass.reason || '直通主运行时'}`,
      })
      return { handled: false, ...(bypass.reason ? { triageNote: bypass.reason } : {}) }
    }

    await this.hydrateTriageContextIfNeeded({
      bot,
      transport,
      msg,
      decision,
      routerConfig,
      chatScopeKey,
    })

    if (isRecalled()) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        traceId,
        kind: 'lifecycle',
        summary: '原消息已撤回，已取消分流并停止执行',
      })
      return { handled: true }
    }

    const existingBinding = this.host.store.getBinding(decision.routeKey)
    const hasActiveWorker = Boolean(existingBinding)
    const workerBusy = existingBinding
      ? this.host.sessions.getActorState(existingBinding.sessionId) === 'running'
      : false

    const linkedTriageSignal = linkAbortSignals([this.host.shutdownSignal, cancelSignal])
    let result: Awaited<ReturnType<LlmTriageService['evaluate']>>
    try {
      result = await this.host.triage!.evaluate({
        bot,
        ...(groupConfig ? { group: groupConfig } : {}),
        msg,
        decision,
        routerConfig,
        ...(senderName ? { senderName } : {}),
        ...(resolvedChatName ? { resolvedChatName } : {}),
        hasActiveWorker,
        workerBusy,
        traceId,
        signal: linkedTriageSignal.signal,
      })
    } finally {
      linkedTriageSignal.dispose()
    }

    if (isRecalled()) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
        traceId,
        durationMs: result.durationMs,
        kind: 'lifecycle',
        summary: '原消息已撤回，已取消分流并停止执行',
      })
      return { handled: true }
    }

    this.host.triage!.context.recordInboundMessage(chatScopeKey, decision.routeKey, {
      role: 'user',
      ...(senderName ? { senderName } : {}),
      text: decision.userText,
      timestampMs: startedMs,
      messageId: msg.messageId,
    })

    if (this.host.isDisposed()) return { handled: true }

    if (result.verdict.action === 'silent') {
      this.host.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'silent_skip' })
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
        traceId,
        durationMs: result.durationMs,
        kind: 'silent_skip',
        summary: `智能分流静默：${result.verdict.reason}`,
      })
      return { handled: true }
    }

    if (result.verdict.action === 'quick_reply' && !hasActiveWorker && result.verdict.replyText) {
      const replyText = normalizeReplyText(result.verdict.replyText, { allowSilentSentinel: true })
      if (replyText) {
        const sent = await transport.sendReply({
          chatId: msg.chatId,
          replyToMessageId: msg.messageId,
          replyMode: decision.replyMode,
          text: replyText,
        })
        if (decision.sessionMode === 'thread') {
          const aliasRouteKeys = this.collectReplyAliasKeys(bot, msg, decision, sent)
          this.host.triage!.context.recordEphemeralQuickReply({
            routeKey: decision.routeKey,
            chatScopeKey,
            aliasRouteKeys,
            trigger: decision.trigger,
            ...(senderName ? { senderName } : {}),
            userText: decision.userText,
            routerReply: replyText,
          })
        } else {
          this.host.triage!.context.recordChatMessage(chatScopeKey, {
            role: 'router',
            text: replyText,
            timestampMs: Date.now(),
            ...(sent?.messageId ? { messageId: sent.messageId } : {}),
          })
        }
        const latencyMs = Date.now() - startedMs
        this.host.store.recordMetric({
          botId: bot.id,
          chatId: msg.chatId,
          ...chatName,
          kind: 'replied',
          latencyMs,
        })
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          ...chatName,
          routeKey: decision.routeKey,
          ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
          traceId,
          durationMs: latencyMs,
          kind: 'reply',
          summary: `智能分流快回（${replyText.length} 字）：${result.verdict.reason}`,
        })
        return { handled: true }
      }
    }

    const prefix = result.verdict.fallback ? '分流回退直通' : '分流转交'
    if (result.triageSessionId) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        sessionId: result.triageSessionId,
        traceId,
        durationMs: result.durationMs,
        kind: 'triage',
        summary: `${prefix}：${result.verdict.reason}`,
      })
    }
    return {
      handled: false,
      triageNote: `${prefix}：${result.verdict.reason}（${result.durationMs}ms）`,
      ...(result.triageSessionId ? { triageSessionId: result.triageSessionId } : {}),
    }
  }

  private async resolveSenderName(
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ): Promise<string | undefined> {
    if (
      msg.senderType !== 'user' ||
      !msg.senderOpenId ||
      typeof transport.resolveUserSummary !== 'function'
    ) {
      return undefined
    }
    const summary = await transport.resolveUserSummary(msg.senderOpenId).catch(() => undefined)
    if (summary?.name && summary.name !== msg.senderOpenId) {
      return summary.name
    }
    return undefined
  }

  private async hydrateTriageContextIfNeeded(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly msg: InboundLarkMessage
    readonly decision: AgentDecision
    readonly routerConfig: EffectiveRouterConfig
    readonly chatScopeKey: string
  }): Promise<void> {
    const triage = this.host.triage
    if (!triage || input.routerConfig.recentMessageCount <= 0) return
    if (typeof input.transport.listMessages !== 'function') return

    const ttlMs = input.routerConfig.contextTtlMinutes * 60_000
    const maxCount = input.routerConfig.recentMessageCount
    const botOpenId = input.transport.state?.botOpenId ?? input.msg.botOpenId
    const threadAnchor = input.msg.threadId ?? input.msg.rootId
    const targetScopeKey = threadAnchor ? input.decision.routeKey : input.chatScopeKey

    if (triage.context.hasHydratedScope(targetScopeKey)) return
    const existing = triage.context.getRecentMessages(
      threadAnchor ? input.decision.routeKey : '',
      threadAnchor ? '' : input.chatScopeKey,
      { ttlMs, maxCount },
    )
    if (existing.length >= maxCount) {
      triage.context.markScopeHydrated(targetScopeKey)
      return
    }

    const fetchWithTimeout = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          input.transport.listMessages({
            chatId: input.msg.chatId,
            ...(threadAnchor ? { threadId: threadAnchor } : {}),
            limit: Math.min(maxCount + 4, 20),
          }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), TRIAGE_HISTORY_BACKFILL_TIMEOUT_MS)
            timer.unref?.()
          }),
        ])
      } catch {
        return undefined
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const fetched = await fetchWithTimeout()
    triage.context.markScopeHydrated(targetScopeKey)
    if (!fetched || fetched.length === 0) return

    const nowMs = Date.now()
    const entries: TriageHistoryEntry[] = []
    for (const item of fetched) {
      if (!item.messageId || item.messageId === input.msg.messageId) continue
      const text = item.text?.trim()
      if (!text) continue
      const ts = item.createTimeMs || nowMs
      if (nowMs - ts > 24 * 60 * 60_000) continue
      const isSelfBot =
        item.senderType === 'bot' &&
        Boolean(
          (botOpenId && item.senderOpenId === botOpenId) ||
            item.senderOpenId === input.bot.larkAppId,
        )
      entries.push({
        role: isSelfBot ? 'worker' : 'user',
        ...(!isSelfBot && item.senderName ? { senderName: item.senderName } : {}),
        text,
        timestampMs: ts,
        messageId: item.messageId,
      })
    }
    if (entries.length > 0) {
      triage.context.hydrateScopeHistory(targetScopeKey, entries, nowMs)
    }
  }

  private suspendSingleTurnForRestart(record: ActiveTurnRecord, nowMs = Date.now()): void {
    if (record.settled) return
    record.settled = true
    record.reactionRemoved = true
    record.status = 'interrupted'
    record.interruptedAtMs = nowMs
    record.interruptKind = 'graceful_shutdown'
    this.activeTurns.delete(record.id)
    this.persistActiveTurn(record, { force: true })
    this.host.store.recordEvent({
      botId: record.botId,
      chatId: record.chatId,
      ...(record.chatName ? { chatName: record.chatName } : {}),
      routeKey: record.routeKey,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      traceId: record.traceId,
      kind: 'lifecycle',
      summary: '服务重载或停机，已保存处理中任务待重启自动恢复',
    })
    this.host.onActivityChange?.()
  }

  private touchActiveTurnActivity(record: ActiveTurnRecord, nowMs = Date.now()): void {
    if (record.settled || this.host.isDisposed()) return
    record.lastActivityAtMs = nowMs
    if (nowMs - record.lastPersistedActivityAtMs >= ACTIVE_TURN_HEARTBEAT_PERSIST_INTERVAL_MS) {
      record.lastPersistedActivityAtMs = nowMs
      this.persistActiveTurn(record)
    }
  }

  private isTurnRecalled(botId: string, item: Pick<QueuedWorkerTurnItem, 'msg' | 'activeTurn' | 'cancelController'>): boolean {
    return (
      item.activeTurn.cancelledByRecall ||
      item.cancelController.signal.aborted ||
      this.isMessageRecalled(botId, item.msg.messageId)
    )
  }

  private settleRecalledTurn(record: ActiveTurnRecord, summary: string): void {
    record.cancelledByRecall = true
    record.reactionRemoved = true
    if (!this.claimActiveTurn(record)) return
    this.host.store.recordEvent({
      botId: record.botId,
      chatId: record.chatId,
      ...(record.chatName ? { chatName: record.chatName } : {}),
      routeKey: record.routeKey,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      traceId: record.traceId,
      durationMs: Date.now() - record.startedAtMs,
      kind: 'lifecycle',
      summary,
    })
  }

  private registerActiveTurn(
    input: Omit<
      ActiveTurnRecord,
      | 'id'
      | 'silencedByControl'
      | 'cancelledByRecall'
      | 'settled'
      | 'reactionRemoved'
      | 'status'
      | 'lastActivityAtMs'
      | 'lastPersistedActivityAtMs'
      | 'interruptedAtMs'
      | 'interruptKind'
    > & { readonly id?: string },
  ): ActiveTurnRecord {
    const nowMs = Date.now()
    const record: ActiveTurnRecord = {
      ...input,
      id: input.id || randomUUID(),
      status: 'running',
      lastActivityAtMs: nowMs,
      lastPersistedActivityAtMs: nowMs,
      silencedByControl: false,
      cancelledByRecall: false,
      settled: false,
      reactionRemoved: false,
    }
    this.activeTurns.set(record.id, record)
    this.persistActiveTurn(record)
    this.host.onActivityChange?.()
    return record
  }

  private persistActiveTurn(
    record: ActiveTurnRecord,
    options: { readonly force?: boolean } = {},
  ): void {
    if (!options.force && (record.settled || this.host.isDisposed())) return
    this.host.store.upsertPendingTurn({
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
      ...(record.traceId ? { traceId: record.traceId } : {}),
      startedAtMs: record.startedAtMs,
      status: record.status,
      ...(record.inboundMsg ? { inboundMsg: record.inboundMsg } : {}),
      ...(record.senderName ? { senderName: record.senderName } : {}),
      intermediateSentCount: record.intermediateSentCount,
      recoveryAttempts: record.recoveryAttempts,
      gracefulRecoveryAttempts: record.gracefulRecoveryAttempts,
      ...(record.handoffTurns && record.handoffTurns.length > 0
        ? { handoffTurns: record.handoffTurns }
        : {}),
      lastActivityAtMs: record.lastActivityAtMs,
      ...(record.interruptedAtMs !== undefined ? { interruptedAtMs: record.interruptedAtMs } : {}),
      ...(record.interruptKind ? { interruptKind: record.interruptKind } : {}),
      updatedAtMs: Date.now(),
    })
  }

  private claimActiveTurn(record: ActiveTurnRecord): boolean {
    if (record.settled) return false
    record.settled = true
    this.activeTurns.delete(record.id)
    this.host.store.deletePendingTurn(record.id)
    this.host.onActivityChange?.()
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
      | 'traceId'
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
    this.host.store.recordMetric({ botId: turn.botId, chatId: turn.chatId, kind: 'error' })
    this.host.store.recordEvent({
      botId: turn.botId,
      chatId: turn.chatId,
      ...(turn.chatName ? { chatName: turn.chatName } : {}),
      routeKey: turn.routeKey,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(turn.traceId ? { traceId: turn.traceId } : {}),
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

  private async buildBatchPrompt(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    items: readonly QueuedWorkerTurnItem[],
    effectiveDecision: AgentDecision,
    isNewSession: boolean,
    resolvedChatName?: string,
  ): Promise<ContentBlock[]> {
    const primary = items[items.length - 1]!
    const reminders: string[] = []

    if (isNewSession && effectiveDecision.roleReminder) {
      reminders.push(effectiveDecision.roleReminder)
    }
    if (isNewSession) {
      const proactiveReminder = composeProactiveSessionReminder({
        botId: bot.id,
        workingDir: effectiveDecision.workingDir,
        config: bot.experimental.proactive,
      })
      if (proactiveReminder) reminders.push(proactiveReminder)

      const memoryReminder = this.host.memory?.composeFirstTurnReminder(
        {
          botId: bot.id,
          chatId: primary.msg.chatId,
          workingDir: effectiveDecision.workingDir,
        },
        { includeWhenEmpty: Boolean(bot.experimental.dreaming.enabled) },
      )
      if (memoryReminder) reminders.push(memoryReminder)
    }

    const handoffTurns = items.flatMap((i) => i.handoffTurns ?? [])
    const handoffReminder = composeRouterHandoffReminder(handoffTurns)
    if (handoffReminder) reminders.push(handoffReminder)

    for (const item of items) {
      if (item.recoveryReminder) reminders.push(item.recoveryReminder)
    }

    reminders.push(
      composeLarkContextReminder({
        bot,
        botOpenId: transport.state?.botOpenId ?? primary.msg.botOpenId,
        msg: primary.msg,
        ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
        ...(primary.senderName ? { senderName: primary.senderName } : {}),
        trigger: effectiveDecision.trigger,
        allowSilentEmptyReply: effectiveDecision.allowSilentEmptyReply,
        replyMode: effectiveDecision.replyMode,
        useCard: effectiveDecision.useCard,
        includeFullGuide: isNewSession,
      }),
    )

    const seenReminders = new Set<string>()
    for (const item of items) {
      for (const r of item.decision.turnReminders) {
        if (!seenReminders.has(r)) {
          seenReminders.add(r)
          reminders.push(r)
        }
      }
    }

    const combinedUserText =
      items.length === 1
        ? primary.decision.userText
        : composeCoalescedUserText(
            items.map((item) => ({
              messageId: item.msg.messageId,
              ...(item.senderName ? { senderName: item.senderName } : {}),
              ...(item.msg.senderOpenId ? { senderOpenId: item.msg.senderOpenId } : {}),
              text: item.decision.userText,
              timestampMs: item.msg.createTimeMs,
            })),
          )

    const text = composeTurnPrompt(reminders, combinedUserText)
    const blocks: ContentBlock[] = [{ type: 'text', text }]

    for (const item of items) {
      for (const imageKey of item.msg.imageKeys) {
        const data = await transport.downloadImageAsBase64(item.msg.messageId, imageKey)
        if (data) {
          blocks.push({ type: 'image', mediaType: 'image/png', data } as unknown as ContentBlock)
        }
      }
    }
    return blocks
  }

  private async formatReplyModelLabel(
    agentPreset: string,
    explicitModel?: string,
    runtimeProfileId?: string,
  ): Promise<string> {
    const runtimeList = await this.host.runtimes.list().catch(() => [])
    const runtimeOpt = runtimeList.find((r) => r.id === agentPreset)
    const baseRuntimeLabel = runtimeOpt?.name ?? agentPreset
    const profileOpt = runtimeProfileId
      ? runtimeOpt?.profiles?.find((p) => p.id === runtimeProfileId)
      : undefined
    const runtimeLabel = runtimeProfileId
      ? `${baseRuntimeLabel} (${profileOpt?.name ?? runtimeProfileId})`
      : baseRuntimeLabel
    const launch = await this.host.runtimes
      .resolveAgentLaunch({
        agentPreset,
        ...(runtimeProfileId ? { runtimeProfileId } : {}),
        ...(explicitModel ? { explicitModel } : {}),
      })
      .catch(() => undefined)
    const modelId =
      launch?.model ||
      explicitModel ||
      (await this.host.runtimes
        .resolveDefaultModel(agentPreset, runtimeOpt?.defaultModel, runtimeProfileId)
        .catch(() => runtimeOpt?.defaultModel))
    if (!modelId) return runtimeLabel
    const provider =
      launch?.provider ?? runtimeOpt?.providerId ?? this.host.runtimes.providerFor(agentPreset)
    let modelLabel = modelId
    if (runtimeProfileId) {
      const profileModels = await this.host.runtimes
        .modelsForRuntime(agentPreset, runtimeProfileId)
        .catch(() => undefined)
      const hit = profileModels?.find((m) => m.id === modelId)
      if (hit?.name) modelLabel = hit.name
    }
    if (
      modelLabel === modelId &&
      provider &&
      typeof this.host.ctx.llm?.resolveModelInfo === 'function'
    ) {
      const resolved = await this.host.ctx.llm
        .resolveModelInfo(provider, modelId)
        .catch(() => undefined)
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
      allowSilentSentinel: true,
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
    fallbackText?: string,
  ): Promise<void> {
    const text =
      normalizeReplyText(replyText, { allowSilentSentinel: true }) ||
      fallbackText ||
      '（已完成，无文本输出）'
    const cardBot = resolveEffectiveCardBot(
      bot,
      msg.chatType === 'group' ? groupConfig : undefined,
    )
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
          sessionUrl: this.host.sessionWebUrl(sessionId),
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

  private collectReplyAliasKeys(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    sent: SendLarkReplyResult | undefined,
  ): string[] {
    if (msg.chatType !== 'group' || decision.sessionMode !== 'thread') return []
    const scopes = new Set<string>()
    if (sent?.rootId) scopes.add(sent.rootId)
    if (sent?.threadId) scopes.add(sent.threadId)
    if (decision.replyMode === 'new-topic' && !msg.threadId && msg.messageId) {
      scopes.add(msg.messageId)
    }
    if (decision.replyMode === 'chat' && sent?.messageId) {
      scopes.add(sent.messageId)
    }
    return [...scopes].map((scope) => buildRouteKey(bot.larkAppId, msg.chatId, scope))
  }

  private syncReplyRouteAliases(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    sent: SendLarkReplyResult | undefined,
  ): void {
    for (const aliasKey of this.collectReplyAliasKeys(bot, msg, decision, sent)) {
      this.host.store.bindRouteAlias(decision.routeKey, aliasKey)
    }
  }
}
