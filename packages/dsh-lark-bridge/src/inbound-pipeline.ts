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
  isSilentReplySentinel,
  normalizeReplyText,
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
  type RouterHandoffTurn,
  type SendLarkReplyResult,
} from '@dsh-lark/lark-core'
import type { BotConnectionPool } from './bot-connection-pool.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { AcquiredAgent, AgentDecision, SessionCoordinator } from './session-coordinator.js'
import type { SessionTitleGuard } from './session-title-guard.js'
import { handleSlashCommand } from './slash-commands.js'
import type { LarkBridgeStore } from './store.js'
import type { LlmTriageService } from './triage-service.js'
import { TurnAbortedError, runTurnAndCollectReply } from './turn-runner.js'
import type { LarkPendingTurn } from './types.js'

const SHUTDOWN_TURN_CLEANUP_TIMEOUT_MS = 5_000
const STALE_PENDING_TURN_MAX_AGE_MS = 24 * 60 * 60_000
const UNEXPECTED_SILENT_SENTINEL_FALLBACK = '抱歉，当前消息不在我的职责范围内或暂无法直接回复。'

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
  sessionId?: string
  intermediateSentCount: number
  silencedByControl: boolean
  silenceReason?: string
  settled: boolean
  reactionRemoved: boolean
}

export interface InboundPipelineHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly connections: BotConnectionPool
  readonly sessions: SessionCoordinator
  readonly triage?: LlmTriageService
  readonly titleGuard: SessionTitleGuard
  readonly shutdownSignal: AbortSignal
  readonly isDisposed: () => boolean
  readonly sessionWebUrl: (sessionId: string) => string
}

interface QueuedWorkerTurnItem {
  readonly msg: InboundLarkMessage
  readonly decision: AgentDecision
  readonly activeTurn: ActiveTurnRecord
  readonly traceId: string
  readonly senderName?: string
  readonly handoffTurns?: readonly RouterHandoffTurn[]
  readonly triageNote?: string
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

  constructor(private readonly host: InboundPipelineHost) {
    this.dedup.hydrate(host.store.listSeenMessages?.() ?? [])
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

  async handleInbound(
    botId: string,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ): Promise<void> {
    if (this.host.isDisposed()) return
    if (!this.host.connections.isActiveTransport(botId, transport)) return
    const bot = this.host.store.getBot(botId)
    if (!bot) return

    const dedupKey = `${bot.larkAppId}:${msg.messageId}`
    if (!this.dedup.claim(dedupKey)) return
    const traceId = createTraceId()

    const groupConfig =
      msg.chatType === 'group' ? this.host.store.getGroup(bot.id, msg.chatId) : undefined
    const knownChatName =
      msg.chatType === 'group' ? this.host.store.resolveChatName(bot.id, msg.chatId) : undefined
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
    const decision =
      rawDecision.action !== 'ignore'
        ? {
            ...rawDecision,
            workspaceName:
              msg.chatType === 'group'
                ? this.host.store.resolveGroupWorkspaceName(bot, groupConfig, knownChatName)
                : this.host.store.resolveBotWorkspaceName(bot),
          }
        : rawDecision

    if (decision.action === 'ignore') {
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

  async recoverStalePendingTurns(botId?: string, nowMs = Date.now()): Promise<number> {
    const stale = this.host.store.listPendingTurns().filter((item) => {
      if (botId && item.botId !== botId) return false
      return !this.activeTurns.has(item.id)
    })
    if (stale.length === 0) return 0

    let recovered = 0
    for (const item of stale) {
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

      this.host.store.deletePendingTurn(item.id)
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

  async cleanupActiveTurnsOnShutdown(): Promise<void> {
    const claimed: ActiveTurnRecord[] = []
    for (const record of this.activeTurns.values()) {
      if (record.settled) continue
      record.settled = true
      record.reactionRemoved = true
      claimed.push(record)
    }
    this.activeTurns.clear()
    for (const record of claimed) {
      this.host.store.deletePendingTurn(record.id)
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

  private async runAgentTurn(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    groupConfig: LarkGroupConfig | undefined,
    traceId: string,
  ): Promise<void> {
    const startedMs = Date.now()
    const resolvedChatName =
      decision.chatName || this.host.store.resolveChatName(bot.id, msg.chatId)
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}
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

    const routerConfig = resolveEffectiveRouterConfig(bot, groupConfig)
    const senderName = await this.resolveSenderName(transport, msg)
    const chatScopeKey = `chat:${bot.id}:${msg.chatId}`
    let triageNote: string | undefined
    let triageSessionId: string | undefined

    if (this.host.triage && shouldRunTriage(decision, routerConfig)) {
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
      })
      if (triageOutcome.handled || this.host.isDisposed()) return
      triageNote = triageOutcome.triageNote
      triageSessionId = triageOutcome.triageSessionId
    } else if (this.host.triage && msg.chatType === 'group') {
      this.host.triage.context.recordInboundMessage(chatScopeKey, decision.routeKey, {
        role: 'user',
        ...(senderName ? { senderName } : {}),
        text: decision.userText,
        timestampMs: startedMs,
      })
    }

    const reaction = decision.receivedReactionEmoji
    const reactionId = reaction ? await transport.addReaction(msg.messageId, reaction) : undefined
    if (this.host.isDisposed()) {
      if (reactionId) await transport.removeReaction(msg.messageId, reactionId)
      return
    }

    const activeTurn = this.registerActiveTurn({
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
        traceId,
        ...(senderName ? { senderName } : {}),
        ...(triageNote ? { triageNote } : {}),
      },
    ]

    try {
      const acquired = await this.host.sessions.acquireAgent(bot, msg, decision)
      acquiredRef = acquired
      trackedSessionId = acquired.sessionId
      activeTurn.sessionId = trackedSessionId
      this.persistActiveTurn(activeTurn)
      if (triageSessionId) {
        this.host.store.linkTriageHandoffSession?.(triageSessionId, acquired.sessionId)
      }

      const handoff = this.host.triage?.context.consumeEphemeralHandoff(decision.routeKey)
      if (handoff && decision.sessionMode === 'thread') {
        for (const aliasKey of handoff.aliasRouteKeys) {
          this.host.store.bindRouteAlias(decision.routeKey, aliasKey)
        }
      }
      const selfItem: QueuedWorkerTurnItem = {
        msg,
        decision,
        activeTurn,
        traceId,
        ...(senderName ? { senderName } : {}),
        ...(handoff?.turns.length ? { handoffTurns: handoff.turns } : {}),
        ...(triageNote ? { triageNote } : {}),
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
        isAborted: () => activeTurn.settled || this.host.isDisposed(),
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
        for (const orphaned of slot.orphanedItems) {
          this.claimActiveTurn(orphaned.activeTurn)
        }
        shouldDisposeEphemeral = acquired.disposeAfter
        return
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
      if (batchItems.every((i) => i.activeTurn.settled) || this.host.isDisposed()) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }

      const isSilenced = () => batchItems.some((i) => i.activeTurn.silencedByControl)
      const replyText = await runTurnAndCollectReply(this.host.ctx, acquired.agent, content, {
        signal: this.host.shutdownSignal,
        ...(effectiveDecision.sendIntermediateMessages
          ? {
              onIntermediate: async (stepText) => {
                if (isSilenced()) return
                const sent = await this.deliverIntermediateReply(
                  bot,
                  transport,
                  latestItem.msg,
                  effectiveDecision,
                  stepText,
                )
                if (sent) {
                  latestItem.activeTurn.intermediateSentCount += 1
                  this.host.store.markBindingReplied(effectiveDecision.routeKey)
                }
              },
            }
          : {}),
      })

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
      }
      if (hasFinalText && latestItem.msg.chatType === 'group') {
        this.host.triage?.context.recordWorkerReply(effectiveDecision.routeKey, normalizedReply)
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
    } = input
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}

    const bypass = shouldFastBypassTriage(msg, decision)
    if (bypass.bypass) {
      this.host.triage?.context.recordInboundMessage(chatScopeKey, decision.routeKey, {
        role: 'user',
        ...(senderName ? { senderName } : {}),
        text: decision.userText,
        timestampMs: startedMs,
      })
      return { handled: false, ...(bypass.reason ? { triageNote: bypass.reason } : {}) }
    }

    const existingBinding = this.host.store.getBinding(decision.routeKey)
    const hasActiveWorker = Boolean(existingBinding)
    const workerBusy = existingBinding
      ? this.host.sessions.getActorState(existingBinding.sessionId) === 'running'
      : false

    const result = await this.host.triage!.evaluate({
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
      signal: this.host.shutdownSignal,
    })

    this.host.triage!.context.recordInboundMessage(chatScopeKey, decision.routeKey, {
      role: 'user',
      ...(senderName ? { senderName } : {}),
      text: decision.userText,
      timestampMs: startedMs,
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
            aliasRouteKeys,
            trigger: decision.trigger,
            ...(senderName ? { senderName } : {}),
            userText: decision.userText,
            routerReply: replyText,
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

  private registerActiveTurn(
    input: Omit<
      ActiveTurnRecord,
      'id' | 'intermediateSentCount' | 'silencedByControl' | 'settled' | 'reactionRemoved'
    >,
  ): ActiveTurnRecord {
    const record: ActiveTurnRecord = {
      id: randomUUID(),
      ...input,
      intermediateSentCount: 0,
      silencedByControl: false,
      settled: false,
      reactionRemoved: false,
    }
    this.activeTurns.set(record.id, record)
    this.persistActiveTurn(record)
    return record
  }

  private persistActiveTurn(record: ActiveTurnRecord): void {
    if (record.settled || this.host.isDisposed()) return
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
    })
  }

  private claimActiveTurn(record: ActiveTurnRecord): boolean {
    if (record.settled) return false
    record.settled = true
    this.activeTurns.delete(record.id)
    this.host.store.deletePendingTurn(record.id)
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
    }

    const handoffTurns = items.flatMap((i) => i.handoffTurns ?? [])
    const handoffReminder = composeRouterHandoffReminder(handoffTurns)
    if (handoffReminder) reminders.push(handoffReminder)

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
