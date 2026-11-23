import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  MessageDeduplicator,
  buildReplyCard,
  buildRouteKey,
  composeLarkContextReminder,
  composeProactiveSessionReminder,
  composeTurnPrompt,
  decideLarkRouting,
  normalizeReplyText,
  resolveEffectiveCardBot,
  type GroupReplyMode,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type LarkGroupConfig,
  type SendLarkReplyResult,
} from '@dsh-lark/lark-core'
import type { BotConnectionPool } from './bot-connection-pool.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import type { AcquiredAgent, AgentDecision, SessionCoordinator } from './session-coordinator.js'
import type { SessionTitleGuard } from './session-title-guard.js'
import { handleSlashCommand } from './slash-commands.js'
import type { LarkBridgeStore } from './store.js'
import { TurnAbortedError, runTurnAndCollectReply } from './turn-runner.js'
import type { LarkPendingTurn } from './types.js'

const SHUTDOWN_TURN_CLEANUP_TIMEOUT_MS = 5_000
const STALE_PENDING_TURN_MAX_AGE_MS = 24 * 60 * 60_000

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
  readonly titleGuard: SessionTitleGuard
  readonly shutdownSignal: AbortSignal
  readonly isDisposed: () => boolean
  readonly sessionWebUrl: (sessionId: string) => string
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
      getRouteTrigger: (routeKey) => this.host.store.getBinding(routeKey)?.trigger,
      hasRouteReplied: (routeKey) => this.host.store.getBinding(routeKey)?.hasReplied !== false,
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
    let releaseTurnSlot: (() => void) | undefined
    let shouldDisposeEphemeral = false
    let shouldArchiveEphemeral = false

    try {
      const acquired = await this.host.sessions.acquireAgent(bot, msg, decision)
      acquiredRef = acquired
      trackedSessionId = acquired.sessionId
      activeTurn.sessionId = trackedSessionId
      this.persistActiveTurn(activeTurn)
      this.host.sessions.markTurnRegistered(trackedSessionId)
      if (activeTurn.settled || this.host.isDisposed()) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }

      releaseTurnSlot = await this.host.sessions.acquireTurnSlot(
        trackedSessionId,
        this.host.shutdownSignal,
        () => activeTurn.settled || this.host.isDisposed(),
      )
      if (!releaseTurnSlot) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }

      this.host.titleGuard.ensureCleanSessionTitle(
        acquired.agent.session,
        msg,
        decision.userText,
        acquired.isNew,
      )

      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        sessionId: acquired.sessionId,
        traceId,
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
      if (activeTurn.settled || this.host.isDisposed()) {
        shouldDisposeEphemeral = acquired.disposeAfter
        return
      }

      const replyText = await runTurnAndCollectReply(this.host.ctx, acquired.agent, content, {
        signal: this.host.shutdownSignal,
        ...(decision.sendIntermediateMessages
          ? {
              onIntermediate: async (stepText) => {
                if (activeTurn.silencedByControl) return
                const sent = await this.deliverIntermediateReply(
                  bot,
                  transport,
                  msg,
                  decision,
                  stepText,
                )
                if (sent) {
                  activeTurn.intermediateSentCount += 1
                  this.host.store.markBindingReplied(decision.routeKey)
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
      this.host.store.touchBinding(decision.routeKey)
      this.host.store.touchManagedSession(acquired.sessionId)
      this.host.titleGuard.ensureCleanSessionTitle(
        acquired.agent.session,
        msg,
        decision.userText,
        false,
      )

      const normalizedReply = activeTurn.silencedByControl
        ? ''
        : normalizeReplyText(replyText, {
            allowSilentSentinel: decision.allowSilentEmptyReply,
          })
      const hasFinalText = normalizedReply.length > 0
      const isSilentSkip =
        decision.allowSilentEmptyReply &&
        (activeTurn.silencedByControl || !hasFinalText) &&
        intermediateSentCount === 0

      if (isSilentSkip) {
        this.host.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'silent_skip' })
        const silentSummary = activeTurn.silencedByControl
          ? activeTurn.silenceReason
            ? `工具显式静默：${activeTurn.silenceReason}`
            : '工具显式静默，已跳过回复'
          : '判断无需回复，已静默'
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          routeKey: decision.routeKey,
          sessionId: acquired.sessionId,
          traceId,
          durationMs: latencyMs,
          kind: 'silent_skip',
          summary: silentSummary,
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
        this.host.store.markBindingReplied(decision.routeKey)
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
          routeKey: decision.routeKey,
          sessionId: acquired.sessionId,
          traceId,
          durationMs: latencyMs,
          kind: 'reply',
          summary:
            intermediateSentCount > 0
              ? `已发送 ${intermediateSentCount} 条过程消息${hasFinalText ? ` + 最终回复 ${normalizedReply.length} 字` : ''}`
              : `已回复 ${normalizedReply.length} 字`,
        })
      }

      const currentBinding = this.host.store.getBinding(decision.routeKey)
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
        const currentBinding = this.host.store.getBinding(decision.routeKey)
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
      this.host.ctx.logger.error(
        `[lark-bridge][trace=${traceId}][bot=${bot.id}][msg=${msg.messageId}] turn handling failed: ${errorMsg}`,
      )
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
        this.host.store.recordMetric({ botId: bot.id, chatId: msg.chatId, kind: 'error' })
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          ...chatName,
          routeKey: decision.routeKey,
          ...(trackedSessionId ? { sessionId: trackedSessionId } : {}),
          traceId,
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
      if (!activeTurn.reactionRemoved && reactionId) {
        activeTurn.reactionRemoved = true
        await transport.removeReaction(msg.messageId, reactionId)
      }
    }
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
      this.host.store.bindRouteAlias(decision.routeKey, aliasKey)
    }
  }
}
