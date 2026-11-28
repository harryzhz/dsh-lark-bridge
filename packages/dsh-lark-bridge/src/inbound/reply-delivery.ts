import type { Session } from '@deepseek-ai/dsh-session'
import {
  buildReplyCard,
  buildRouteKey,
  extractRouteScope,
  isLarkMessageRecalledError,
  isSilentReplySentinel,
  normalizeReplyText,
  resolveEffectiveCardBot,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type LarkGroupConfig,
  type SendLarkReplyResult,
} from '@dsh-lark/lark-core'
import { TurnCotController, closeOrphanCotBubble } from '../cot-stream-controller.js'
import type { AcquiredAgent, AgentDecision } from '../session-coordinator.js'
import { canAutoResumePendingTurn } from '../turn-recovery.js'
import { TurnAbortedError } from '../turn-runner.js'
import type { LarkPendingTurn } from '../types.js'
import type { InboundPayloadHydrator } from './payload-hydrator.js'
import {
  disabledCancelSummary,
  type ActiveTurnRecord,
  type ExecutingTurnContext,
  type InboundPipelineHost,
  type QueuedWorkerTurnItem,
  type TurnStateRegistry,
} from './turn-state-registry.js'

const UNEXPECTED_SILENT_SENTINEL_FALLBACK = '抱歉，当前消息不在我的职责范围内或暂无法直接回复。'

/**
 * Coordinates turn settlement, failure fallback, native CoT bubble lifecycle,
 * intermediate/final Feishu reply delivery, and thread-promotion route aliases.
 */
export class TurnReplyDelivery {
  constructor(
    private readonly host: InboundPipelineHost,
    private readonly registry: TurnStateRegistry,
    private readonly hydrator: InboundPayloadHydrator,
  ) {}

  createTurnCotController(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly msg: InboundLarkMessage
    readonly decision: AgentDecision
    readonly activeTurn: ActiveTurnRecord
    readonly sessionId: string
    readonly session?: Session
    readonly canPublish: () => boolean
  }): TurnCotController {
    const {
      bot,
      transport,
      msg,
      decision,
      activeTurn,
      sessionId,
      session,
      canPublish,
    } = input
    return new TurnCotController({
      transport,
      chatId: msg.chatId,
      chatType: msg.chatType,
      replyMode: decision.replyMode,
      messageId: msg.messageId,
      ...(msg.rootId ? { rootId: msg.rootId } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      threadKey: sessionId || decision.routeKey,
      runId: activeTurn.traceId,
      toolResultEnabled: decision.cotToolResultEnabled !== false,
      canPublish,
      onCreated: (created) => {
        activeTurn.cotId = created.cotId
        activeTurn.cotMessageId = created.messageId
        this.hydrator.recordSentLarkMessage(sessionId, session, created.messageId)
        this.registry.persistActiveTurn(activeTurn)
      },
      onSettled: () => {
        activeTurn.cotId = undefined
        activeTurn.cotMessageId = undefined
        activeTurn.cotController = undefined
        if (!activeTurn.settled && !this.host.isDisposed()) {
          this.registry.persistActiveTurn(activeTurn)
        }
      },
      log: (level, message) => {
        this.host.ctx.logger[level](
          `[lark-bridge][trace=${activeTurn.traceId}][bot=${bot.id}] ${message}`,
        )
      },
    })
  }

  async closeTurnCot(
    record: ActiveTurnRecord,
    status: 'done' | 'interrupted',
    options: { readonly notice?: string; readonly timeoutMs?: number } = {},
  ): Promise<void> {
    if (record.cotController) {
      const controller = record.cotController
      await controller.finish(status, options)
      if (controller.isSettled) {
        record.cotId = undefined
        record.cotMessageId = undefined
        if (record.cotController === controller) {
          record.cotController = undefined
        }
      }
      return
    }
    if (record.cotId && record.cotMessageId) {
      const cotId = record.cotId
      const messageId = record.cotMessageId
      await closeOrphanCotBubble(record.transport, {
        cotId,
        messageId,
        reason: status === 'done' ? 'done' : 'error',
        ...(options.notice ? { notice: options.notice } : {}),
      })
      record.cotId = undefined
      record.cotMessageId = undefined
    }
  }

  async closeBatchCot(
    items: readonly QueuedWorkerTurnItem[],
    status: 'done' | 'interrupted',
    options: { readonly notice?: string; readonly timeoutMs?: number } = {},
  ): Promise<void> {
    const withCot = items.filter(
      (item) =>
        Boolean(item.activeTurn.cotController) ||
        Boolean(item.activeTurn.cotId && item.activeTurn.cotMessageId),
    )
    if (withCot.length === 0) return
    await Promise.all(withCot.map((item) => this.closeTurnCot(item.activeTurn, status, options)))
  }

  shouldNotifyInterruptedTurn(
    turn: Pick<LarkPendingTurn, 'trigger' | 'allowSilentEmptyReply'> & { readonly silentOnly?: boolean },
    intermediateSentCount = 0,
  ): boolean {
    if (turn.silentOnly) return false
    if (turn.trigger === 'listener' && turn.allowSilentEmptyReply && intermediateSentCount === 0) {
      return false
    }
    return true
  }

  async deliverInterruptedTurnCleanup(input: {
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
      | 'inboundMsg'
      | 'senderName'
    > & { readonly listenerName?: string }
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
    const interruptedSender = this.hydrator.resolveTelemetrySender(
      turn.botId,
      transport,
      turn.inboundMsg,
      turn.senderName,
    )
    this.host.store.recordMetric({
      botId: turn.botId,
      chatId: turn.chatId,
      ...(turn.inboundMsg?.chatType ? { chatType: turn.inboundMsg.chatType } : {}),
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      trigger: turn.trigger,
      ...(turn.listenerName ? { listenerName: turn.listenerName } : {}),
      ...interruptedSender,
      kind: 'error',
    })
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

  /**
   * Shared intermediate-step delivery callback used by both `runAgentTurn` and
   * `reattachLiveTurn` so route promotion, `executingTurnCtx`, and active-turn
   * persistence stay identical across normal and hot-reloaded turns.
   */
  createIntermediateDeliveryHandler(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly latestItem: QueuedWorkerTurnItem
    readonly decision: AgentDecision
    readonly session?: Session
    readonly executingTurnCtx: ExecutingTurnContext
    readonly isSuppressed: () => boolean
    readonly onRoutePromoted: (nextRouteKey: string) => void
  }): (stepText: string) => Promise<void> {
    const {
      bot,
      transport,
      latestItem,
      decision,
      session,
      executingTurnCtx,
      isSuppressed,
      onRoutePromoted,
    } = input
    return async (stepText: string) => {
      if (decision.silentOnly || isSuppressed()) return
      const intermediate = await this.deliverIntermediateReply(
        bot,
        transport,
        latestItem.msg,
        decision,
        stepText,
        session,
      )
      if (!intermediate.sent) return
      const sentAtMs = Date.now()
      latestItem.activeTurn.intermediateSentCount += 1
      latestItem.activeTurn.lastActivityAtMs = sentAtMs
      latestItem.activeTurn.lastPersistedActivityAtMs = sentAtMs
      if (intermediate.routeKey !== decision.routeKey) {
        latestItem.activeTurn.routeKey = intermediate.routeKey
        executingTurnCtx.routeKey = intermediate.routeKey
        onRoutePromoted(intermediate.routeKey)
      }
      if (intermediate.threadId) {
        executingTurnCtx.threadId = intermediate.threadId
        executingTurnCtx.replyInThread = true
      }
      if (intermediate.rootId) {
        executingTurnCtx.rootId = intermediate.rootId
        if (executingTurnCtx.replyInThread) {
          executingTurnCtx.replyToMessageId = intermediate.rootId
        }
      }
      this.registry.persistActiveTurn(latestItem.activeTurn)
      this.host.store.markBindingReplied(intermediate.routeKey)
    }
  }

  async settleBatchReply(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly groupConfig: LarkGroupConfig | undefined
    readonly resolvedChatName?: string
    readonly acquired: AcquiredAgent
    readonly batchItems: readonly QueuedWorkerTurnItem[]
    readonly effectiveDecision: AgentDecision
    readonly replyText: string
    readonly startedMs: number
    readonly queueWaitMs?: number
    readonly execMs?: number
    readonly reattachedFromHotReload?: boolean
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
      queueWaitMs = 0,
      execMs = 0,
      reattachedFromHotReload = false,
    } = input
    const latestItem = batchItems[batchItems.length - 1]!
    const batchSize = batchItems.length
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}

    let anyClaimed = false
    for (const item of batchItems) {
      if (this.registry.claimActiveTurn(item.activeTurn)) anyClaimed = true
    }
    if (!anyClaimed) {
      return { dispose: acquired.disposeAfter, archive: false }
    }

    const disabledScope = this.registry.getBatchDisabledScope(bot.id, batchItems)
    if (disabledScope) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        ...chatName,
        routeKey: effectiveDecision.routeKey,
        sessionId: acquired.sessionId,
        traceId: latestItem.traceId,
        durationMs: Date.now() - startedMs,
        kind: 'lifecycle',
        summary: disabledCancelSummary(disabledScope, '已取消当前轮次并跳过回复'),
      })
      const currentBinding = this.host.store.getBinding(effectiveDecision.routeKey)
      const dispose = Boolean(
        acquired.disposeAfter || (acquired.isNew && currentBinding?.hasReplied === false),
      )
      return { dispose, archive: dispose }
    }

    const recalledItems: QueuedWorkerTurnItem[] = []
    const survivingItems: QueuedWorkerTurnItem[] = []
    for (const item of batchItems) {
      if (this.registry.isTurnRecalled(bot.id, item)) {
        item.activeTurn.reactionRemoved = true
        recalledItems.push(item)
      } else {
        survivingItems.push(item)
      }
    }
    if (survivingItems.length === 0) {
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
            ? '批次中全部消息已撤回，已取消当前轮次并跳过回复'
            : '原消息已撤回，已取消当前轮次并跳过回复',
      })
      const currentBinding = this.host.store.getBinding(effectiveDecision.routeKey)
      const dispose = Boolean(
        acquired.disposeAfter || (acquired.isNew && currentBinding?.hasReplied === false),
      )
      return { dispose, archive: dispose }
    }
    if (recalledItems.length > 0) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        ...chatName,
        routeKey: effectiveDecision.routeKey,
        sessionId: acquired.sessionId,
        traceId: latestItem.traceId,
        durationMs: Date.now() - startedMs,
        kind: 'lifecycle',
        summary: `批次中 ${recalledItems.length} 条消息已撤回，继续向其余 ${survivingItems.length} 条正常消息投递回复`,
      })
    }
    const deliveryItem = survivingItems[survivingItems.length - 1]!

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
      Boolean(effectiveDecision.silentOnly) ||
      ((Boolean(silencedItem) || (effectiveDecision.allowSilentEmptyReply && !hasFinalText)) &&
        intermediateSentCount === 0)

    const replySender = this.hydrator.resolveTelemetrySender(
      bot.id,
      transport,
      latestItem.msg,
      latestItem.senderName,
    )
    const normalizedQueueWaitMs = Math.min(latencyMs, Math.max(0, Math.round(queueWaitMs)))
    const normalizedExecMs = Math.min(latencyMs, Math.max(0, Math.round(execMs)))
    if (isSilentSkip) {
      const silenceSource = silencedItem
        ? 'control'
        : effectiveDecision.silentOnly
          ? 'delegation'
          : 'sentinel'
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        chatType: latestItem.msg.chatType,
        sessionId: acquired.sessionId,
        trigger: effectiveDecision.trigger,
        ...(effectiveDecision.listenerName ? { listenerName: effectiveDecision.listenerName } : {}),
        silenceSource,
        ...replySender,
        kind: 'silent_skip',
        latencyMs,
        queueWaitMs: normalizedQueueWaitMs,
        execMs: normalizedExecMs,
      })
      const silentSummary = silencedItem
        ? silencedItem.activeTurn.silenceReason
          ? `工具显式静默：${silencedItem.activeTurn.silenceReason}`
          : '工具显式静默，已跳过回复'
        : effectiveDecision.silentOnly
          ? '委派跟进后台观察完成，已静默跳过回复'
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
      let deliveredRouteKey = effectiveDecision.routeKey
      if (hasFinalText || intermediateSentCount === 0) {
        try {
          deliveredRouteKey = await this.deliverReply(
            bot,
            transport,
            deliveryItem.msg,
            effectiveDecision,
            acquired.sessionId,
            normalizedReply,
            groupConfig,
            fallbackText,
            acquired.agent.session,
          )
        } catch (err) {
          if (isLarkMessageRecalledError(err)) {
            deliveryItem.activeTurn.reactionRemoved = true
            this.host.store.recordEvent({
              botId: bot.id,
              chatId: deliveryItem.msg.chatId,
              ...chatName,
              routeKey: effectiveDecision.routeKey,
              sessionId: acquired.sessionId,
              traceId: deliveryItem.traceId,
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
        this.host.triage?.context.recordWorkerReply(deliveredRouteKey, normalizedReply, Date.now(), {
          chatScopeKey: `chat:${bot.id}:${latestItem.msg.chatId}`,
        })
      }
      this.host.store.markBindingReplied(deliveredRouteKey)
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        chatType: latestItem.msg.chatType,
        sessionId: acquired.sessionId,
        trigger: effectiveDecision.trigger,
        ...(effectiveDecision.listenerName ? { listenerName: effectiveDecision.listenerName } : {}),
        ...replySender,
        ...chatName,
        kind: 'replied',
        latencyMs,
        queueWaitMs: normalizedQueueWaitMs,
        execMs: normalizedExecMs,
      })
      const replyTags = [
        ...(reattachedFromHotReload ? ['热更无损续传'] : []),
        ...(batchSize > 1 ? [`合并 ${batchSize} 条消息`] : []),
        ...(normalizedQueueWaitMs >= 2_000
          ? [`含排队 ${Math.round(normalizedQueueWaitMs / 1000)}s`]
          : []),
      ]
      const batchSuffix = replyTags.length > 0 ? `（${replyTags.join('；')}）` : ''
      const replySummary =
        intermediateSentCount > 0
          ? `已发送 ${intermediateSentCount} 条过程消息${hasFinalText ? ` + 最终回复 ${normalizedReply.length} 字` : ''}`
          : interceptedSilentSentinel
            ? `已拦截非静默轮次的 <no_reply/> 并回退兜底回复（${UNEXPECTED_SILENT_SENTINEL_FALLBACK.length} 字）`
            : `已回复 ${normalizedReply.length} 字`
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: latestItem.msg.chatId,
        routeKey: deliveredRouteKey,
        sessionId: acquired.sessionId,
        traceId: latestItem.traceId,
        durationMs: latencyMs,
        kind: 'reply',
        summary: replySummary + batchSuffix,
      })
    }

    const currentBinding =
      this.host.store.getBinding(effectiveDecision.routeKey) ??
      this.host.store.getBindingBySessionId(acquired.sessionId)
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

  async handleBatchFailure(input: {
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
      const newlySuspendedItems: QueuedWorkerTurnItem[] = []
      const nowMs = Date.now()
      let suspendedCount = 0
      for (const item of batchItems) {
        if (item.activeTurn.settled) {
          if (item.activeTurn.status === 'interrupted') suspendedCount += 1
          continue
        }
        if (canAutoResumePendingTurn(item.activeTurn, nowMs, { phase: 'shutdown' })) {
          this.registry.suspendSingleTurnForRestart(item.activeTurn, nowMs)
          newlySuspendedItems.push(item)
          suspendedCount += 1
        } else {
          nonRecoverableItems.push(item)
        }
      }
      if (newlySuspendedItems.length > 0) {
        await Promise.all(
          newlySuspendedItems.map(async (item) => {
            if (!item.activeTurn.cotController && !item.activeTurn.cotId) return
            await this.closeTurnCot(item.activeTurn, 'interrupted', {
              notice: '服务重启中，将自动恢复执行',
              timeoutMs: 1_500,
            })
            if (!item.activeTurn.cotController && !item.activeTurn.cotId) {
              this.registry.persistActiveTurn(item.activeTurn, { force: true })
            }
          }),
        )
      }
      if (nonRecoverableItems.length === 0) {
        return { dispose: false, archive: false }
      }
      await this.closeBatchCot(nonRecoverableItems, 'interrupted', { notice: err.message })
      for (const item of nonRecoverableItems) {
        this.registry.claimActiveTurn(item.activeTurn)
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

    const disabledScope =
      this.registry.getBatchDisabledScope(bot.id, batchItems) ??
      (err instanceof TurnAbortedError && err.kind === 'disabled'
        ? this.registry.getDisabledScope(bot.id, targetMsg.chatType, targetMsg.chatId) ?? 'group'
        : undefined)
    const isDisabledAbort =
      (err instanceof TurnAbortedError && err.kind === 'disabled') || Boolean(disabledScope)
    if (isDisabledAbort) {
      await this.closeBatchCot(batchItems, 'interrupted', {
        notice: disabledCancelSummary(disabledScope ?? 'group', '已停止执行'),
      })
      let anyDisabledClaimed = false
      for (const item of batchItems) {
        if (this.registry.claimActiveTurn(item.activeTurn)) {
          anyDisabledClaimed = true
        }
      }
      if (anyDisabledClaimed) {
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: targetMsg.chatId,
          ...chatName,
          routeKey: targetDecision.routeKey,
          ...(trackedSessionId ? { sessionId: trackedSessionId } : {}),
          traceId: targetTurn.traceId,
          durationMs: Date.now() - targetTurn.startedAtMs,
          kind: 'lifecycle',
          summary: disabledCancelSummary(
            disabledScope ?? 'group',
            '已取消当前轮次并停止执行',
          ),
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

    const isRecalledAbort =
      (err instanceof TurnAbortedError && err.kind === 'recalled') ||
      (batchItems.length > 0 && batchItems.every((item) => this.registry.isTurnRecalled(bot.id, item)))
    if (isRecalledAbort) {
      await this.closeBatchCot(batchItems, 'interrupted', {
        notice: '原消息已撤回，已取消执行',
      })
      let anyRecalledClaimed = false
      for (const item of batchItems) {
        if (this.registry.isTurnRecalled(bot.id, item)) {
          item.activeTurn.reactionRemoved = true
        }
        if (this.registry.claimActiveTurn(item.activeTurn)) {
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
      if (this.registry.claimActiveTurn(item.activeTurn)) anyClaimed = true
    }
    if (!anyClaimed) return { dispose, archive }

    const errorMsg = err instanceof Error ? err.message : String(err)
    await this.closeBatchCot(batchItems, 'interrupted', { notice: errorMsg })
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
      const failSender = this.hydrator.resolveTelemetrySender(
        bot.id,
        transport,
        targetMsg,
        latestItem?.senderName ?? targetTurn.senderName,
      )
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: msg.chatId,
        chatType: targetMsg.chatType,
        ...(trackedSessionId ? { sessionId: trackedSessionId } : {}),
        trigger: targetDecision.trigger,
        ...(targetDecision.listenerName ? { listenerName: targetDecision.listenerName } : {}),
        ...failSender,
        kind: 'error',
        latencyMs: Math.max(0, Date.now() - targetTurn.startedAtMs),
      })
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

  private async formatReplyModelLabel(
    agentPreset: string,
    explicitModel?: string,
    runtimeProfileId?: string,
    reasoningEffort?: string,
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
    const effortText = reasoningEffort?.trim()
    const fullModel = effortText ? `${modelLabel} (${effortText})` : modelLabel
    return [runtimeLabel, fullModel].filter(Boolean).join(' · ')
  }

  async deliverIntermediateReply(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    stepText: string,
    session?: Session,
  ): Promise<{
    readonly sent: boolean
    readonly routeKey: string
    readonly rootId?: string
    readonly threadId?: string
  }> {
    const text = normalizeReplyText(stepText, {
      allowSilentSentinel: true,
    })
    if (!text) return { sent: false, routeKey: decision.routeKey }
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
    this.hydrator.recordSentLarkMessage(session?.id as string | undefined, session, sent?.messageId)
    const routeKey = this.syncReplyRouteAliases(bot, msg, decision, sent)
    return {
      sent: true,
      routeKey,
      ...(sent?.rootId ? { rootId: sent.rootId } : {}),
      ...(sent?.threadId ? { threadId: sent.threadId } : {}),
    }
  }

  async deliverReply(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    sessionId: string,
    replyText: string,
    groupConfig?: LarkGroupConfig,
    fallbackText?: string,
    session?: Session,
  ): Promise<string> {
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
            decision.reasoningEffort,
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
    this.hydrator.recordSentLarkMessage(sessionId, session, sent?.messageId)
    return this.syncReplyRouteAliases(bot, msg, decision, sent)
  }

  collectReplyAliasKeys(
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
  ): string {
    if (msg.chatType !== 'group' || decision.sessionMode !== 'thread') return decision.routeKey
    const existing = this.host.store.getBinding(decision.routeKey)
    let targetRouteKey = existing?.routeKey ?? decision.routeKey
    if (existing && sent?.threadId) {
      const existingNativeThreads = [existing.routeKey, ...(existing.aliasRouteKeys ?? [])]
        .map(extractRouteScope)
        .filter((scope) => scope.startsWith('omt_'))
      if (existingNativeThreads.length > 0 && !existingNativeThreads.includes(sent.threadId)) {
        // Invariant: never attach a second distinct native Feishu thread onto an existing thread binding.
        return existing.routeKey
      }
      const promotedRootScope =
        sent.rootId || (decision.replyMode === 'new-topic' && !msg.threadId ? msg.messageId : undefined)
      const promotedRootKey = promotedRootScope
        ? buildRouteKey(bot.larkAppId, msg.chatId, promotedRootScope)
        : undefined
      if (
        existingNativeThreads.length === 0 &&
        promotedRootKey &&
        promotedRootKey !== existing.routeKey
      ) {
        const promoted = this.host.store.promoteBindingRoute(existing.routeKey, promotedRootKey)
        if (promoted) {
          targetRouteKey = promoted.routeKey
        }
      }
    }
    for (const aliasKey of this.collectReplyAliasKeys(bot, msg, decision, sent)) {
      this.host.store.bindRouteAlias(targetRouteKey, aliasKey)
    }
    return targetRouteKey
  }
}
