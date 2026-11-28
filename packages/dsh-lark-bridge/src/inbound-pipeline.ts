import {
  MessageDeduplicator,
  resolveEffectiveRouterConfig,
  shouldRunTriage,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type LarkGroupConfig,
  type RecalledLarkMessageEvent,
} from '@dsh-lark/lark-core'
import { InboundPayloadHydrator } from './inbound/payload-hydrator.js'
import { TurnRecoveryCoordinator } from './inbound/recovery-coordinator.js'
import { TurnReplyDelivery } from './inbound/reply-delivery.js'
import {
  TurnRoutingCoordinator,
  applyPinnedBindingRuntime,
} from './inbound/routing-coordinator.js'
import {
  TurnStateRegistry,
  buildExecutingTurnContext,
  createDisabledAbortError,
  createRecalledAbortError,
  createTraceId,
  disabledCancelSummary,
  isEligibleForNativeCot,
  linkAbortSignals,
  type ActiveTurnRecord,
  type DebouncedInboundItem,
  type DebouncedTurnRunOptions,
  type DisableCancelScope,
  type ExecutingTurnContext,
  type InboundPipelineHost,
  type QueuedWorkerTurnItem,
  type RecoveryRunContext,
} from './inbound/turn-state-registry.js'
import {
  ListenerDebounceBuffer,
  type DebouncedListenerEntry,
} from './listener-debounce.js'
import { InboundMediaCache } from './media-intake.js'
import {
  buildRuntimeConcurrencyKey,
  type ConcurrencyLease,
} from './runtime-concurrency.js'
import type { AcquiredAgent, AgentDecision } from './session-coordinator.js'
import { handleSlashCommand } from './slash-commands.js'
import { composeRestartRecoveryReminder } from './turn-recovery.js'
import { TurnAbortedError, runTurnAndCollectReply } from './turn-runner.js'
import type { ActiveTurnSummary } from './types.js'

export type { ActiveTurnRecord, ExecutingTurnContext, InboundPipelineHost }

/**
 * Top-level orchestrator for Feishu inbound message handling.
 * Delegates orthogonal concerns to cohesive collaborators under `./inbound/`:
 * - `TurnStateRegistry` (active turns, recall/disable cancellation, persistence)
 * - `InboundPayloadHydrator` (sender/quote/media hydration, dedup & prompt assembly)
 * - `TurnReplyDelivery` (settlement, failure fallback, CoT & Feishu delivery)
 * - `TurnRoutingCoordinator` (rule routing, Smart Triage, 3-tier weighted targets)
 * - `TurnRecoveryCoordinator` (shutdown suspension, hot-reload reattach, replay)
 */
export class InboundPipeline {
  private readonly dedup = new MessageDeduplicator()
  private readonly listenerDebounce: ListenerDebounceBuffer<DebouncedInboundItem>
  private readonly registry: TurnStateRegistry
  private readonly hydrator: InboundPayloadHydrator
  private readonly delivery: TurnReplyDelivery
  private readonly routing: TurnRoutingCoordinator
  private readonly recovery: TurnRecoveryCoordinator

  constructor(private readonly host: InboundPipelineHost) {
    this.dedup.hydrate(host.store.listSeenMessages?.() ?? [])
    this.registry = new TurnStateRegistry(host)
    this.hydrator = new InboundPayloadHydrator(host)
    this.delivery = new TurnReplyDelivery(host, this.registry, this.hydrator)
    this.routing = new TurnRoutingCoordinator(host, this.registry, this.hydrator, this.delivery)
    this.recovery = new TurnRecoveryCoordinator(
      host,
      this.registry,
      this.hydrator,
      this.delivery,
      this.routing,
      (bot, transport, msg, decision, groupConfig, traceId, recoveryCtx) =>
        this.runAgentTurn(bot, transport, msg, decision, groupConfig, traceId, recoveryCtx),
    )
    this.listenerDebounce = new ListenerDebounceBuffer<DebouncedInboundItem>((entries) =>
      this.flushDebouncedListeners(entries),
    )
  }

  /** Preserved getter for white-box resilience tests inspecting active turn timestamps. */
  private get activeTurns(): Map<string, ActiveTurnRecord> {
    return this.registry.activeTurns
  }

  /** Preserved delegate for white-box observability tests exercising sender resolution. */
  private resolveSenderName(
    botId: string,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ): Promise<string | undefined> {
    return this.hydrator.resolveSenderName(botId, transport, msg)
  }

  getExecutingTurnContext(sessionId: string): ExecutingTurnContext | undefined {
    return this.registry.getExecutingTurnContext(sessionId)
  }

  flushListenerDebounce(): void {
    this.listenerDebounce.flushAll()
  }

  getActiveCount(): number {
    return (
      this.registry.countActiveUnsettled() +
      this.recovery.recoveringCount +
      this.listenerDebounce.pendingCount
    )
  }

  listActiveTurnSummaries(nowMs = Date.now()): ActiveTurnSummary[] {
    return this.registry.listActiveTurnSummaries(nowMs)
  }

  async waitForRecoveries(): Promise<void> {
    await this.recovery.waitForRecoveries()
  }

  markSessionTurnSilent(
    sessionId: string,
    reason?: string,
  ): { readonly matched: boolean; readonly turnId?: string; readonly allowSilent: boolean } {
    return this.registry.markSessionTurnSilent(sessionId, reason)
  }

  cancelDisabledTurns(botId: string, chatId?: string): number {
    return this.registry.cancelDisabledTurns(botId, chatId, this.listenerDebounce)
  }

  handleMessageRecalled(
    botId: string,
    transport: LarkBotTransport,
    event: RecalledLarkMessageEvent,
  ): void {
    this.registry.handleMessageRecalled(botId, transport, event, this.listenerDebounce)
  }

  async recoverStalePendingTurns(botId?: string, nowMs = Date.now()): Promise<number> {
    return await this.recovery.recoverStalePendingTurns(botId, nowMs)
  }

  async suspendActiveTurnsForShutdown(
    options: { readonly preserveLiveAgents?: boolean } = {},
  ): Promise<void> {
    this.listenerDebounce.dispose()
    await this.recovery.suspendActiveTurnsForShutdown(options)
  }

  async cleanupActiveTurnsOnShutdown(): Promise<void> {
    await this.suspendActiveTurnsForShutdown()
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
    if (this.registry.isMessageRecalled(bot.id, msg.messageId)) {
      this.host.store.rememberSeenMessage?.(dedupKey)
      return
    }
    const traceId = createTraceId()

    const groupConfig =
      msg.chatType === 'group' ? this.host.store.getGroup(bot.id, msg.chatId) : undefined
    const knownChatName =
      msg.chatType === 'group' ? this.host.store.resolveChatName(bot.id, msg.chatId) : undefined
    const decision = this.routing.resolveDecisionForMessage(bot, msg, groupConfig, knownChatName)

    if (decision.action === 'ignore') {
      if (
        msg.chatType === 'group' &&
        decision.reason !== 'bot_disabled' &&
        decision.reason !== 'self_message' &&
        decision.reason !== 'group_disabled'
      ) {
        this.routing.recordIgnoredGroupContext(bot, transport, msg, groupConfig)
      }
      if (decision.reason !== 'no_matching_rule' && decision.reason !== 'self_message') {
        const senderMeta = this.hydrator.resolveTelemetrySender(bot.id, transport, msg)
        this.host.store.recordMetric({
          botId: bot.id,
          chatId: msg.chatId,
          chatType: msg.chatType,
          ...senderMeta,
          kind: 'ignored',
        })
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
          ...(this.host.issueConsoleLoginLink
            ? { issueConsoleLoginLink: (req) => this.host.issueConsoleLoginLink!(req) }
            : {}),
          runTurn: (agent, content) =>
            runTurnAndCollectReply(this.host.ctx, agent, content, {
              signal: this.host.shutdownSignal,
            }),
        },
        {
          bot,
          ...(groupConfig ? { group: groupConfig } : {}),
          chatType: msg.chatType,
          chatId: msg.chatId,
          ...(msg.senderOpenId ? { senderOpenId: msg.senderOpenId } : {}),
          senderType: msg.senderType,
          command: decision.command,
          routeKey: decision.routeKey,
          workingDir: decision.workingDir,
          workspaceName: decision.workspaceName,
          reply: async (text) => {
            await reply(text)
          },
          sendDirectMessage: async (openId, text) => {
            await transport.sendProactiveMessage({
              receiveIdType: 'open_id',
              receiveId: openId,
              msgType: 'text',
              content: JSON.stringify({ text }),
            })
          },
        },
      )
      return
    }

    this.host.store.rememberSeenMessage?.(dedupKey)
    const effectiveDebounceMs = this.resolveEffectiveListenerDebounceMs(decision)
    if (decision.trigger === 'listener' && !msg.threadId && effectiveDebounceMs > 0) {
      const bucketKey = `${bot.id}:${msg.chatId}:${msg.senderType}:${decision.silentOnly ? 'delegation' : 'listener'}`
      const pending = this.listenerDebounce.enqueue({
        bucketKey,
        botId: bot.id,
        chatId: msg.chatId,
        messageId: msg.messageId,
        debounceMs: effectiveDebounceMs,
        payload: {
          bot,
          transport,
          msg,
          decision,
          groupConfig,
          traceId,
          receivedAtMs: Date.now(),
        },
      })
      this.host.onActivityChange?.()
      await pending
      return
    }
    await this.runAgentTurn(bot, transport, msg, decision, groupConfig, traceId)
  }

  private resolveEffectiveListenerDebounceMs(decision: AgentDecision): number {
    if (decision.trigger !== 'listener') return 0
    const ruleMs = decision.listenerDebounceMs ?? 0
    if (ruleMs <= 0) return 0
    if (this.host.listenerDebounceOverrideMs !== undefined) {
      return Math.max(0, Math.floor(this.host.listenerDebounceOverrideMs))
    }
    if (this.host.listenerDebounceEnabled === false) return 0
    return ruleMs
  }

  private async flushDebouncedListeners(
    entries: readonly DebouncedListenerEntry<DebouncedInboundItem>[],
  ): Promise<void> {
    this.host.onActivityChange?.()
    if (entries.length === 0 || this.host.isDisposed()) return

    const live: DebouncedInboundItem[] = []
    for (const entry of entries) {
      const item = entry.payload
      if (!this.host.connections.isActiveTransport(item.bot.id, item.transport)) continue
      if (this.registry.isMessageRecalled(item.bot.id, item.msg.messageId)) continue
      if (this.registry.getDisabledScope(item.bot.id, item.msg.chatType, item.msg.chatId)) continue
      live.push(item)
    }
    if (live.length === 0) return

    if (live.length === 1) {
      const single = live[0]!
      await this.runAgentTurn(
        single.bot,
        single.transport,
        single.msg,
        single.decision,
        single.groupConfig,
        single.traceId,
        undefined,
        { startedAtMs: single.receivedAtMs },
      )
      return
    }

    const tail = live[live.length - 1]!
    const { mergedMsg, mergedDecision, debouncedOptions, resolvedChatName } =
      await this.hydrator.mergeDebouncedListenerBatch(live)
    this.host.store.recordEvent({
      botId: tail.bot.id,
      chatId: tail.msg.chatId,
      ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
      routeKey: mergedDecision.routeKey,
      traceId: tail.traceId,
      kind: 'lifecycle',
      summary: `主动监听防抖合并 ${live.length} 条连续消息`,
    })

    await this.runAgentTurn(
      tail.bot,
      tail.transport,
      mergedMsg,
      mergedDecision,
      tail.groupConfig,
      tail.traceId,
      undefined,
      debouncedOptions,
    )
  }

  private async runAgentTurn(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
    decision: AgentDecision,
    groupConfig: LarkGroupConfig | undefined,
    traceId: string,
    recovery?: RecoveryRunContext,
    debounced?: DebouncedTurnRunOptions,
  ): Promise<void> {
    const startedMs = recovery?.startedAtMs ?? debounced?.startedAtMs ?? Date.now()
    const resolvedChatName =
      decision.chatName || this.host.store.resolveChatName(bot.id, msg.chatId)
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}
    if (!recovery) {
      const inboundSender = this.hydrator.resolveTelemetrySender(bot.id, transport, msg)
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: msg.chatId,
        chatType: msg.chatType,
        trigger: decision.trigger,
        ...(decision.listenerName ? { listenerName: decision.listenerName } : {}),
        ...inboundSender,
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
    const mediaCache = new InboundMediaCache()
    const msgCancelController = new AbortController()
    const untrackInflight = this.registry.trackInflightController(
      bot.id,
      msg.chatId,
      msg.chatType,
      msg.messageId,
      msgCancelController,
    )
    const getSelfDisabledScope = (): DisableCancelScope | undefined =>
      this.registry.getDisabledScope(bot.id, msg.chatType, msg.chatId)
    const isSelfRecalled = () =>
      this.registry.isMessageRecalled(bot.id, msg.messageId) ||
      (msgCancelController.signal.aborted &&
        !this.registry.isSignalDisabled(msgCancelController.signal))
    const recordPreTurnCancel = (summary: string) => {
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
    const cleanupRecoveryReactionIfNeeded = async () => {
      if (recovery?.existingReactionId) {
        await transport.removeReaction(msg.messageId, recovery.existingReactionId).catch(() => {})
      }
    }

    try {
      const preDisabled = getSelfDisabledScope()
      if (preDisabled) {
        await cleanupRecoveryReactionIfNeeded()
        recordPreTurnCancel(disabledCancelSummary(preDisabled, '已取消当前轮次并停止执行'))
        return
      }
      if (isSelfRecalled()) {
        recordPreTurnCancel('原消息已撤回，已取消当前轮次并停止执行')
        return
      }

      const hasExistingBindingForTriage = Boolean(this.host.store.getBinding(decision.routeKey))
      const needsTriage =
        !recovery &&
        Boolean(this.host.triage) &&
        shouldRunTriage(decision, routerConfig, { hasActiveWorker: hasExistingBindingForTriage })
      const skipQuotePrefetch = Boolean(
        msg.parentId &&
          !needsTriage &&
          this.hydrator.isMessageAlreadyInRouteSession(decision.routeKey, msg.parentId),
      )

      const [senderName, prefetchedQuote] = await Promise.all([
        this.hydrator.resolveSenderName(bot.id, transport, msg),
        msg.parentId && !skipQuotePrefetch
          ? mediaCache.prefetchQuotedMessage(transport, msg.parentId, {
              signal: msgCancelController.signal,
            })
          : Promise.resolve(undefined),
      ])
      const postSenderDisabled = getSelfDisabledScope()
      if (postSenderDisabled) {
        await cleanupRecoveryReactionIfNeeded()
        recordPreTurnCancel(disabledCancelSummary(postSenderDisabled, '已取消当前轮次并停止执行'))
        return
      }
      if (isSelfRecalled()) {
        recordPreTurnCancel('原消息已撤回，已取消当前轮次并停止执行')
        return
      }

      const chatScopeKey = `chat:${bot.id}:${msg.chatId}`
      let triageNote: string | undefined
      let triageSessionId: string | undefined
      let routedDecision: AgentDecision = decision

      if (
        !recovery &&
        this.host.triage &&
        shouldRunTriage(decision, routerConfig, {
          hasActiveWorker: Boolean(this.host.store.getBinding(decision.routeKey)),
        })
      ) {
        const triageOutcome = await this.routing.evaluateAndHandleTriage({
          bot,
          transport,
          msg,
          decision,
          groupConfig,
          routerConfig,
          mediaCache,
          ...(debounced?.extraImageTargets?.length
            ? { extraImageTargets: debounced.extraImageTargets }
            : {}),
          ...(prefetchedQuote ? { prefetchedQuote } : {}),
          ...(senderName ? { senderName } : {}),
          ...(resolvedChatName ? { resolvedChatName } : {}),
          chatScopeKey,
          traceId,
          startedMs,
          cancelSignal: msgCancelController.signal,
        })
        if (triageOutcome.handled || this.host.isDisposed()) return
        const postTriageDisabled = getSelfDisabledScope()
        if (postTriageDisabled) {
          recordPreTurnCancel(disabledCancelSummary(postTriageDisabled, '已取消当前轮次并停止执行'))
          return
        }
        if (isSelfRecalled()) {
          recordPreTurnCancel('原消息已撤回，已取消当前轮次并停止执行')
          return
        }
        triageNote = triageOutcome.triageNote
        triageSessionId = triageOutcome.triageSessionId
        if (triageOutcome.routedRuntime) {
          const rt = triageOutcome.routedRuntime
          routedDecision = {
            ...decision,
            agentPreset: rt.agentPreset,
            ...(rt.runtimeProfileId
              ? { runtimeProfileId: rt.runtimeProfileId }
              : { runtimeProfileId: undefined }),
            ...(rt.model ? { model: rt.model } : { model: undefined }),
            ...(rt.reasoningEffort
              ? { reasoningEffort: rt.reasoningEffort }
              : { reasoningEffort: undefined }),
            runtimePinned: true,
            routedTier: rt.tier,
          }
        }
      } else if (!recovery && this.host.triage && msg.chatType === 'group') {
        this.host.triage.context.recordInboundMessage(chatScopeKey, decision.routeKey, {
          role: 'user',
          ...(senderName ? { senderName } : {}),
          text: decision.userText,
          timestampMs: startedMs,
          messageId: msg.messageId,
        })
      }

      const preReactionDisabled = getSelfDisabledScope()
      if (preReactionDisabled) {
        recordPreTurnCancel(disabledCancelSummary(preReactionDisabled, '已取消当前轮次并停止执行'))
        return
      }
      if (isSelfRecalled()) {
        recordPreTurnCancel('原消息已撤回，已取消当前轮次并停止执行')
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
      const postReactionDisabled = getSelfDisabledScope()
      if (postReactionDisabled) {
        if (!recovery && reactionId) {
          await transport.removeReaction(msg.messageId, reactionId).catch(() => {})
        }
        recordPreTurnCancel(disabledCancelSummary(postReactionDisabled, '已取消当前轮次并停止执行'))
        return
      }
      if (isSelfRecalled()) {
        recordPreTurnCancel('原消息已撤回，已取消当前轮次并停止执行')
        return
      }

      const activeTurn = this.registry.registerActiveTurn({
        ...(recovery ? { id: recovery.pendingTurnId } : {}),
        traceId,
        botId: bot.id,
        chatId: msg.chatId,
        ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
        messageId: msg.messageId,
        routeKey: decision.routeKey,
        replyMode: decision.replyMode,
        trigger: decision.trigger,
        ...(decision.listenerName ? { listenerName: decision.listenerName } : {}),
        allowSilentEmptyReply: decision.allowSilentEmptyReply,
        ...(decision.silentOnly ? { silentOnly: true } : {}),
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
      let trackedRouteKey = routedDecision.routeKey
      let boundDecision: AgentDecision = routedDecision
      let acquiredRef: AcquiredAgent | undefined
      let leaderRegistered = false
      let releaseTurnSlot: (() => void) | undefined
      let runtimeLease: ConcurrencyLease | undefined
      let disposeBatchCancel: (() => void) | undefined
      let finishBatch: (() => void) | undefined
      let shouldDisposeEphemeral = false
      let shouldArchiveEphemeral = false
      let batchItems: readonly QueuedWorkerTurnItem[] = [
        {
          msg,
          decision: routedDecision,
          activeTurn,
          cancelController: msgCancelController,
          mediaCache,
          ...(debounced?.extraImageTargets?.length
            ? { extraImageTargets: debounced.extraImageTargets }
            : {}),
          ...(prefetchedQuote ? { prefetchedQuote } : {}),
          traceId,
          ...(senderName ? { senderName } : {}),
          ...(recovery?.handoffTurns ? { handoffTurns: recovery.handoffTurns } : {}),
          ...(triageNote ? { triageNote } : {}),
        },
      ]

      try {
        const acquired = await this.host.sessions.acquireAgent(bot, msg, routedDecision)
        acquiredRef = acquired
        trackedSessionId = acquired.sessionId
        activeTurn.sessionId = trackedSessionId
        const activeBinding = this.host.store.getBinding(acquired.routeKey)
        boundDecision = applyPinnedBindingRuntime(routedDecision, acquired.routeKey, activeBinding)
        if (boundDecision !== routedDecision) {
          trackedRouteKey = acquired.routeKey
          activeTurn.routeKey = acquired.routeKey
        }

        const postAcquireDisabled = activeTurn.cancelledByDisable ?? getSelfDisabledScope()
        if (postAcquireDisabled) {
          this.registry.settleDisabledTurn(
            activeTurn,
            postAcquireDisabled,
            disabledCancelSummary(postAcquireDisabled, '已取消当前轮次并停止执行'),
          )
          shouldDisposeEphemeral = Boolean(acquired.disposeAfter || acquired.isNew)
          shouldArchiveEphemeral = shouldDisposeEphemeral
          return
        }
        if (isSelfRecalled() || activeTurn.cancelledByRecall) {
          this.registry.settleRecalledTurn(activeTurn, '原消息已撤回，已取消当前轮次并停止执行')
          shouldDisposeEphemeral = Boolean(acquired.disposeAfter || acquired.isNew)
          shouldArchiveEphemeral = shouldDisposeEphemeral
          return
        }

        const peekedHandoff = boundDecision.ephemeralHandoffRouteKey
          ? this.host.triage?.context.peekEphemeralHandoff(boundDecision.ephemeralHandoffRouteKey)
          : undefined
        const consumedHandoff = !boundDecision.ephemeralHandoffRouteKey
          ? this.host.triage?.context.consumeEphemeralHandoff(boundDecision.routeKey)
          : undefined
        if (
          consumedHandoff &&
          boundDecision.sessionMode === 'thread' &&
          boundDecision.routeKey === decision.routeKey
        ) {
          for (const aliasKey of consumedHandoff.aliasRouteKeys) {
            this.host.store.bindRouteAlias(boundDecision.routeKey, aliasKey)
          }
        }
        const handoff = peekedHandoff ?? consumedHandoff
        const effectiveHandoffTurns =
          handoff?.turns.length ? handoff.turns : recovery?.handoffTurns
        if (effectiveHandoffTurns && effectiveHandoffTurns.length > 0) {
          activeTurn.handoffTurns = effectiveHandoffTurns
        }
        this.registry.persistActiveTurn(activeTurn)
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
          decision: boundDecision,
          activeTurn,
          cancelController: msgCancelController,
          mediaCache,
          ...(debounced?.extraImageTargets?.length
            ? { extraImageTargets: debounced.extraImageTargets }
            : {}),
          ...(prefetchedQuote ? { prefetchedQuote } : {}),
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

        const buildEffectiveDecision = (items: readonly QueuedWorkerTurnItem[]): AgentDecision => {
          const tail = items[items.length - 1] ?? selfItem
          return items.length === 1
            ? tail.decision
            : {
                ...tail.decision,
                allowSilentEmptyReply: items.every((i) => i.decision.allowSilentEmptyReply),
                autoCloseAfterCompletion: items.every((i) => i.decision.autoCloseAfterCompletion),
                silentOnly: items.every((i) => Boolean(i.decision.silentOnly)),
              }
        }

        const allowCoalesce =
          routerConfig.coalesceQueuedMessages && boundDecision.sessionMode !== 'per_message'
        const sessionSlotWaitStartMs = Date.now()
        const slot = await this.host.sessions.acquireCoalescedTurnSlot(trackedSessionId, selfItem, {
          coalesce: allowCoalesce,
          signal: this.host.shutdownSignal,
          itemSignal: msgCancelController.signal,
          isAborted: () =>
            activeTurn.settled ||
            activeTurn.cancelledByRecall ||
            Boolean(activeTurn.cancelledByDisable) ||
            Boolean(getSelfDisabledScope()) ||
            isSelfRecalled() ||
            this.host.isDisposed(),
          onLeaderRegistered: () => {
            leaderRegistered = true
            this.host.sessions.markTurnRegistered(trackedSessionId!)
          },
        })

        if (slot.role === 'follower') {
          batchItems = []
          return
        }
        if (slot.role === 'aborted') {
          batchItems = slot.orphanedItems
          const anyCancelled = this.registry.settleAbandonedQueueItems(
            bot.id,
            slot.orphanedItems,
            'orphaned',
          )
          const currentBinding = this.host.store.getBinding(trackedRouteKey)
          shouldDisposeEphemeral = Boolean(
            acquired.disposeAfter ||
              (anyCancelled && acquired.isNew && currentBinding?.hasReplied === false),
          )
          shouldArchiveEphemeral = Boolean(anyCancelled && shouldDisposeEphemeral)
          return
        }

        if (slot.abandonedItems && slot.abandonedItems.length > 0) {
          this.registry.settleAbandonedQueueItems(bot.id, slot.abandonedItems, 'abandoned')
        }

        releaseTurnSlot = slot.release
        finishBatch = slot.finishBatch
        batchItems = slot.items
        const sessionWaitMs = Math.max(0, Date.now() - sessionSlotWaitStartMs)

        const preExecDisabled = this.registry.getBatchDisabledScope(bot.id, batchItems)
        if (preExecDisabled) {
          throw createDisabledAbortError(preExecDisabled)
        }

        const pruneRecalledFromBatch = (): boolean => {
          const pruned = this.registry.pruneRecalledBatchItems(bot.id, batchItems)
          if (pruned.allRecalled) return true
          batchItems = pruned.surviving
          return false
        }

        if (pruneRecalledFromBatch()) {
          throw createRecalledAbortError()
        }

        let latestItem = batchItems[batchItems.length - 1] ?? selfItem
        const batchSize = batchItems.length
        let effectiveDecision: AgentDecision = buildEffectiveDecision(batchItems)

        const linkedCancel = this.registry.createBatchCancelBinding(bot.id, () => batchItems)
        disposeBatchCancel = linkedCancel.dispose
        const isSilenced = () => batchItems.some((i) => i.activeTurn.silencedByControl)
        const isBatchCancelled = () =>
          linkedCancel.signal.aborted ||
          Boolean(this.registry.getBatchDisabledScope(bot.id, batchItems)) ||
          batchItems.every((i) => this.registry.isTurnRecalled(bot.id, i))

        if (this.host.runtimeLimiter) {
          const limiterSignal = linkAbortSignals([this.host.shutdownSignal, linkedCancel.signal])
          try {
            const concurrencyKey =
              typeof this.host.runtimes.resolveConcurrencyKey === 'function'
                ? this.host.runtimes.resolveConcurrencyKey(
                    effectiveDecision.agentPreset,
                    effectiveDecision.runtimeProfileId,
                  )
                : buildRuntimeConcurrencyKey(
                    effectiveDecision.agentPreset,
                    effectiveDecision.runtimeProfileId,
                  )
            runtimeLease = await this.host.runtimeLimiter.acquire({
              runtimeKey: concurrencyKey,
              priority: effectiveDecision.trigger === 'listener' ? 'background' : 'interactive',
              signal: limiterSignal.signal,
              isAborted: () => isBatchCancelled() || this.host.isDisposed(),
            })
          } finally {
            limiterSignal.dispose()
          }
          if (!runtimeLease) {
            const waitDisabled = this.registry.getBatchDisabledScope(bot.id, batchItems)
            if (waitDisabled) {
              throw createDisabledAbortError(waitDisabled)
            }
            if (batchItems.every((i) => this.registry.isTurnRecalled(bot.id, i))) {
              throw createRecalledAbortError()
            }
            throw new TurnAbortedError('disposed', '服务正在关闭，已取消排队轮次')
          }
        }

        const postLimiterDisabled = this.registry.getBatchDisabledScope(bot.id, batchItems)
        if (postLimiterDisabled) {
          throw createDisabledAbortError(postLimiterDisabled)
        }
        if (pruneRecalledFromBatch()) {
          throw createRecalledAbortError()
        }
        latestItem = batchItems[batchItems.length - 1] ?? latestItem
        effectiveDecision = buildEffectiveDecision(batchItems)

        const queueWaitMs = Math.max(0, Math.round(sessionWaitMs + (runtimeLease?.waitMs ?? 0)))

        this.host.titleGuard.ensureCleanSessionTitle(
          acquired.agent.session,
          latestItem.msg,
          latestItem.decision.userText,
          acquired.isNew,
        )

        const inboundBaseSummary = `${effectiveDecision.listenerName ? `监听「${effectiveDecision.listenerName}」` : effectiveDecision.trigger} → ${effectiveDecision.agentPreset} · ${effectiveDecision.workspaceName}`
        const inboundTags = [
          ...(recovery ? [`重启自动恢复 #${recovery.totalRecoveryAttempts}`] : []),
          ...(debounced?.debouncedCount && debounced.debouncedCount > 1
            ? [`防抖合并 ${debounced.debouncedCount} 条消息`]
            : []),
          ...(triageNote ? [triageNote] : []),
          ...(batchSize > 1 ? [`合并 ${batchSize} 条排队消息`] : []),
          ...(runtimeLease && runtimeLease.waitMs >= 1_000
            ? [`并发排队 ${Math.round(runtimeLease.waitMs / 1000)}s`]
            : []),
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

        const content = await this.hydrator.buildBatchPrompt(
          bot,
          transport,
          batchItems,
          effectiveDecision,
          acquired.isNew,
          resolvedChatName,
          acquired.sessionId,
          acquired.agent.session,
        )
        const postPromptDisabled = this.registry.getBatchDisabledScope(bot.id, batchItems)
        if (postPromptDisabled) {
          throw createDisabledAbortError(postPromptDisabled)
        }
        if (pruneRecalledFromBatch()) {
          throw createRecalledAbortError()
        }
        latestItem = batchItems[batchItems.length - 1] ?? latestItem
        effectiveDecision = buildEffectiveDecision(batchItems)
        if (batchItems.every((i) => i.activeTurn.settled) || this.host.isDisposed()) {
          shouldDisposeEphemeral = acquired.disposeAfter
          return
        }

        const executingTurnCtx = buildExecutingTurnContext(
          bot,
          latestItem.msg,
          effectiveDecision,
          resolvedChatName,
        )
        this.registry.executingTurnBySession.set(acquired.sessionId, executingTurnCtx)
        const cotController = isEligibleForNativeCot(effectiveDecision)
          ? this.delivery.createTurnCotController({
              bot,
              transport,
              msg: latestItem.msg,
              decision: effectiveDecision,
              activeTurn: latestItem.activeTurn,
              sessionId: acquired.sessionId,
              session: acquired.agent.session,
              canPublish: () =>
                !effectiveDecision.silentOnly &&
                !isSilenced() &&
                !isBatchCancelled() &&
                !this.host.isDisposed(),
            })
          : undefined
        if (cotController) {
          latestItem.activeTurn.cotController = cotController
        }
        const execStartedMs = Date.now()
        let replyText: string
        let execMs = 0
        try {
          replyText = await runTurnAndCollectReply(this.host.ctx, acquired.agent, content, {
            signal: this.host.shutdownSignal,
            cancelSignal: linkedCancel.signal,
            ...(cotController ? { onCotEvent: (ev) => cotController.push(ev) } : {}),
            onUserMessageSubmitted: (userMessageId) => {
              for (const item of batchItems) {
                item.activeTurn.sessionId = acquired.sessionId
                item.activeTurn.userMessageId = userMessageId
                this.registry.persistActiveTurn(item.activeTurn)
              }
            },
            onTurnBound: ({ turn, userMessageId }) => {
              for (const item of batchItems) {
                let changed = false
                if (item.activeTurn.sessionId !== acquired.sessionId) {
                  item.activeTurn.sessionId = acquired.sessionId
                  changed = true
                }
                if (item.activeTurn.targetTurn !== turn) {
                  item.activeTurn.targetTurn = turn
                  changed = true
                }
                if (userMessageId && item.activeTurn.userMessageId !== userMessageId) {
                  item.activeTurn.userMessageId = userMessageId
                  changed = true
                }
                if (changed) this.registry.persistActiveTurn(item.activeTurn)
              }
            },
            onEventSeq: (seq) => {
              for (const item of batchItems) {
                if (item.activeTurn.lastEventSeq === undefined || seq > item.activeTurn.lastEventSeq) {
                  item.activeTurn.lastEventSeq = seq
                }
              }
            },
            onActivity: (timestampMs) => {
              for (const item of batchItems) {
                this.registry.touchActiveTurnActivity(item.activeTurn, timestampMs)
              }
            },
            ...(effectiveDecision.sendIntermediateMessages && !effectiveDecision.silentOnly
              ? {
                  onIntermediate: this.delivery.createIntermediateDeliveryHandler({
                    bot,
                    transport,
                    latestItem,
                    decision: effectiveDecision,
                    session: acquired.agent.session,
                    executingTurnCtx,
                    isSuppressed: () => isSilenced() || isBatchCancelled(),
                    onRoutePromoted: (nextRouteKey) => {
                      trackedRouteKey = nextRouteKey
                    },
                  }),
                }
              : {}),
          })
          execMs = Math.max(0, Date.now() - execStartedMs)
        } finally {
          if (this.registry.executingTurnBySession.get(acquired.sessionId) === executingTurnCtx) {
            this.registry.executingTurnBySession.delete(acquired.sessionId)
          }
          linkedCancel.dispose()
          disposeBatchCancel = undefined
        }

        await this.delivery.closeBatchCot(
          batchItems,
          isSilenced() || isBatchCancelled() ? 'interrupted' : 'done',
          isBatchCancelled() ? { notice: '执行已取消' } : {},
        )

        const settlement = await this.delivery.settleBatchReply({
          bot,
          transport,
          groupConfig,
          ...(resolvedChatName ? { resolvedChatName } : {}),
          acquired,
          batchItems,
          effectiveDecision,
          replyText,
          startedMs,
          queueWaitMs,
          execMs,
        })
        shouldDisposeEphemeral = settlement.dispose
        shouldArchiveEphemeral = settlement.archive
      } catch (err) {
        if (!(err instanceof TurnAbortedError)) {
          this.routing.markTierTargetCooldown(
            boundDecision.agentPreset,
            boundDecision.runtimeProfileId,
            boundDecision.model,
          )
        }
        const failure = await this.delivery.handleBatchFailure({
          bot,
          transport,
          msg,
          decision: boundDecision,
          ...(resolvedChatName ? { resolvedChatName } : {}),
          activeTurn,
          batchItems,
          acquiredRef,
          trackedSessionId,
          err,
        })
        shouldDisposeEphemeral = failure.dispose
        shouldArchiveEphemeral = failure.archive
      } finally {
        disposeBatchCancel?.()
        runtimeLease?.release()
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
            .disposeEphemeral(trackedSessionId, trackedRouteKey, {
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
}
