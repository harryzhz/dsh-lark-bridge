import {
  buildRouteKey,
  decideLarkRouting,
  hasConfiguredTierRouting,
  isLarkMessageRecalledError,
  normalizeReplyText,
  replaceMentionKeysWithNames,
  resolveEffectiveRouterConfig,
  selectWeightedTierTarget,
  shouldFastBypassTriage,
  type EffectiveRouterConfig,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type LarkGroupConfig,
  type SendLarkReplyResult,
  type TaskDifficultyTier,
  type TierRoutingTarget,
} from '@dsh-lark/lark-core'
import type { ImageRefTarget, InboundMediaCache, PrefetchedQuotedMessage } from '../media-intake.js'
import { buildRuntimeConcurrencyKey } from '../runtime-concurrency.js'
import { bindingHasNativeThread, type AgentDecision } from '../session-coordinator.js'
import type { LlmTriageService } from '../triage-service.js'
import type { LarkSessionBinding } from '../types.js'
import type { InboundPayloadHydrator } from './payload-hydrator.js'
import type { TurnReplyDelivery } from './reply-delivery.js'
import {
  disabledCancelSummary,
  linkAbortSignals,
  type InboundPipelineHost,
  type TurnStateRegistry,
} from './turn-state-registry.js'

const TIER_TARGET_COOLDOWN_MS = 60_000

export interface RoutedTierSelection {
  readonly tier: TaskDifficultyTier
  readonly agentPreset: string
  readonly runtimeProfileId?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly summary: string
}

function tierDisplayName(tier: TaskDifficultyTier): string {
  if (tier === 'lite') return '轻量'
  if (tier === 'standard') return '标准'
  return '深度'
}

function tierTargetCooldownKey(
  agentPreset: string,
  runtimeProfileId?: string,
  model?: string,
): string {
  return `${agentPreset.trim().toLowerCase()}::${(runtimeProfileId ?? '').trim().toLowerCase()}::${(model ?? '').trim().toLowerCase()}`
}

/**
 * Applies persisted binding routeKey & runtime pinning (from `/model` or
 * 3-tier routing) onto a turn's effective `AgentDecision`.
 */
export function applyPinnedBindingRuntime(
  decision: AgentDecision,
  acquiredRouteKey: string,
  activeBinding: LarkSessionBinding | undefined,
): AgentDecision {
  if (acquiredRouteKey === decision.routeKey && !activeBinding?.runtimePinned) {
    return decision
  }
  return {
    ...decision,
    routeKey: acquiredRouteKey,
    ...(activeBinding?.runtimePinned
      ? {
          agentPreset: activeBinding.agentPreset,
          ...(activeBinding.runtimeProfileId
            ? { runtimeProfileId: activeBinding.runtimeProfileId }
            : { runtimeProfileId: undefined }),
          ...(activeBinding.model ? { model: activeBinding.model } : { model: undefined }),
          ...(activeBinding.reasoningEffort
            ? { reasoningEffort: activeBinding.reasoningEffort }
            : { reasoningEffort: undefined }),
          runtimePinned: true,
          ...(activeBinding.routedTier ? { routedTier: activeBinding.routedTier } : {}),
        }
      : {}),
  }
}

/**
 * Coordinates rule-based routing decisions, Smart Triage evaluation, quick-reply
 * handoffs, and 3-tier weighted runtime routing with failure cooldowns.
 */
export class TurnRoutingCoordinator {
  private readonly tierTargetCooldowns = new Map<string, number>()

  constructor(
    private readonly host: InboundPipelineHost,
    private readonly registry: TurnStateRegistry,
    private readonly hydrator: InboundPayloadHydrator,
    private readonly delivery: TurnReplyDelivery,
  ) {}

  resolveDecisionForMessage(
    bot: LarkBotConfig,
    msg: InboundLarkMessage,
    groupConfig: LarkGroupConfig | undefined,
    knownChatName: string | undefined,
  ) {
    const rawDecision = decideLarkRouting(bot, msg, {
      groupConfig,
      ...(knownChatName ? { chatName: knownChatName } : {}),
      hasActiveSessionForRoute: (routeKey) => Boolean(this.host.store.getBinding(routeKey)),
      isRouteBoundToNativeThread: (routeKey) => {
        const binding = this.host.store.getBinding(routeKey)
        return Boolean(binding && bindingHasNativeThread(binding))
      },
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

  recordIgnoredGroupContext(
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

    if (!cachedName && msg.senderOpenId) {
      void this.hydrator.resolveSenderName(bot.id, transport, msg).then((resolvedName) => {
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

  markTierTargetCooldown(
    agentPreset: string,
    runtimeProfileId?: string,
    model?: string,
    now = Date.now(),
  ): void {
    const key = tierTargetCooldownKey(agentPreset, runtimeProfileId, model)
    this.tierTargetCooldowns.set(key, now + TIER_TARGET_COOLDOWN_MS)
  }

  isTierTargetInCooldown(target: TierRoutingTarget, now = Date.now()): boolean {
    const key = tierTargetCooldownKey(target.agentPreset, target.runtimeProfileId, target.model)
    const until = this.tierTargetCooldowns.get(key)
    if (!until) return false
    if (now >= until) {
      this.tierTargetCooldowns.delete(key)
      return false
    }
    return true
  }

  async selectTierRoutedTarget(
    tier: TaskDifficultyTier,
    routerConfig: EffectiveRouterConfig,
  ): Promise<RoutedTierSelection | undefined> {
    if (!hasConfiguredTierRouting(routerConfig)) return undefined
    const runtimeList = await this.host.runtimes.list().catch(() => [])
    const availableById = new Map(runtimeList.map((r) => [r.id, r]))
    const picked = selectWeightedTierTarget({
      tier,
      tierRouting: routerConfig.tierRouting,
      isAvailable: (target) => {
        if (availableById.size === 0) return true
        const rt = availableById.get(target.agentPreset)
        return Boolean(rt && !rt.broken)
      },
      hasConcurrencyCapacity: (target) => {
        if (!this.host.runtimeLimiter) return true
        const key =
          typeof this.host.runtimes.resolveConcurrencyKey === 'function'
            ? this.host.runtimes.resolveConcurrencyKey(
                target.agentPreset,
                target.runtimeProfileId || undefined,
              )
            : buildRuntimeConcurrencyKey(
                target.agentPreset,
                target.runtimeProfileId || undefined,
              )
        return this.host.runtimeLimiter.hasCapacity(key)
      },
      isInCooldown: (target) => this.isTierTargetInCooldown(target),
    })
    if (!picked) return undefined

    const { target } = picked
    const rt = availableById.get(target.agentPreset)
    const rtName = rt?.name ?? target.agentPreset
    const profName = target.runtimeProfileId
      ? rt?.profiles?.find((p) => p.id === target.runtimeProfileId)?.name ?? target.runtimeProfileId
      : ''
    const runtimeDesc = profName ? `${rtName} (${profName})` : rtName
    const modelDesc = target.model
      ? target.reasoningEffort
        ? `${target.model} (${target.reasoningEffort})`
        : target.model
      : target.reasoningEffort
        ? `默认模型 (${target.reasoningEffort})`
        : '默认模型'
    const hints: string[] = []
    if (picked.avoidedBusy) hints.push('避让繁忙')
    if (picked.avoidedCooldown) hints.push('避让冷却')
    const hintSuffix = hints.length > 0 ? ` · ${hints.join('/')}` : ''

    return {
      tier,
      agentPreset: target.agentPreset,
      ...(target.runtimeProfileId ? { runtimeProfileId: target.runtimeProfileId } : {}),
      ...(target.model ? { model: target.model } : {}),
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      summary: `${tierDisplayName(tier)}档 [${tier}] → ${runtimeDesc} · ${modelDesc}${hintSuffix}`,
    }
  }

  async evaluateAndHandleTriage(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly msg: InboundLarkMessage
    readonly decision: AgentDecision
    readonly groupConfig?: LarkGroupConfig
    readonly routerConfig: EffectiveRouterConfig
    readonly mediaCache: InboundMediaCache
    readonly extraImageTargets?: readonly ImageRefTarget[]
    readonly prefetchedQuote?: PrefetchedQuotedMessage
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
    readonly routedRuntime?: RoutedTierSelection
  }> {
    const {
      bot,
      transport,
      msg,
      decision,
      groupConfig,
      routerConfig,
      mediaCache,
      extraImageTargets = [],
      prefetchedQuote,
      senderName,
      resolvedChatName,
      chatScopeKey,
      traceId,
      startedMs,
      cancelSignal,
    } = input
    const chatName = resolvedChatName ? { chatName: resolvedChatName } : {}
    const getDisabledScope = () => this.registry.getDisabledScope(bot.id, msg.chatType, msg.chatId)
    const isRecalled = () =>
      this.registry.isMessageRecalled(bot.id, msg.messageId) ||
      (Boolean(cancelSignal?.aborted) && !this.registry.isSignalDisabled(cancelSignal))

    const quotedImageTargets: ImageRefTarget[] =
      prefetchedQuote?.imageKeys.map((imageKey) => ({
        messageId: prefetchedQuote.messageId,
        imageKey,
      })) ?? []
    const currentImageTargets: ImageRefTarget[] = msg.imageKeys.map((imageKey) => ({
      messageId: msg.messageId,
      imageKey,
    }))
    const allTriageImageTargets: ImageRefTarget[] = [
      ...quotedImageTargets,
      ...extraImageTargets,
      ...currentImageTargets,
    ]

    const initialBinding = this.host.store.getBinding(decision.routeKey)
    const fastBypass = shouldFastBypassTriage(msg, decision, routerConfig.bypass, {
      maxTriageImages: routerConfig.maxTriageImages,
      extraImageCount: quotedImageTargets.length + extraImageTargets.length,
    })
    const bypass = fastBypass.bypass
      ? fastBypass
      : decision.trigger === 'mention' && Boolean(initialBinding)
        ? {
            bypass: true,
            reason: '显式 @ 智能体且话题已有活跃会话，直通主运行时',
          }
        : fastBypass
    if (bypass.bypass) {
      const bypassDisabled = getDisabledScope()
      if (bypassDisabled) {
        this.host.store.recordEvent({
          botId: bot.id,
          chatId: msg.chatId,
          ...chatName,
          routeKey: decision.routeKey,
          traceId,
          kind: 'lifecycle',
          summary: disabledCancelSummary(bypassDisabled, '已取消当前轮次并停止执行'),
        })
        return { handled: true }
      }
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
      let bypassRouted: RoutedTierSelection | undefined
      if (
        !initialBinding &&
        hasConfiguredTierRouting(routerConfig) &&
        routerConfig.tierRouting.bypassTier !== 'default'
      ) {
        bypassRouted = await this.selectTierRoutedTarget(
          routerConfig.tierRouting.bypassTier,
          routerConfig,
        )
      }
      const bypassSummary = bypassRouted
        ? `规则直通：${bypass.reason || '直通主运行时'}（${bypassRouted.summary}）`
        : `规则直通：${bypass.reason || '直通主运行时'}`
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        traceId,
        kind: 'triage',
        summary: bypassSummary,
      })
      return {
        handled: false,
        ...(bypass.reason ? { triageNote: bypassSummary } : {}),
        ...(bypassRouted ? { routedRuntime: bypassRouted } : {}),
      }
    }

    await this.hydrator.hydrateTriageContextIfNeeded({
      bot,
      transport,
      msg,
      decision,
      routerConfig,
      chatScopeKey,
    })

    const preTriageDisabled = getDisabledScope()
    if (preTriageDisabled) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        traceId,
        kind: 'lifecycle',
        summary: disabledCancelSummary(preTriageDisabled, '已取消分流并停止执行'),
      })
      return { handled: true }
    }
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

    const activeChatListeners =
      decision.trigger === 'listener'
        ? this.registry.listActiveChatListeners(bot.id, msg.chatId, msg.messageId)
        : []

    const linkedTriageSignal = linkAbortSignals([this.host.shutdownSignal, cancelSignal])
    let result: Awaited<ReturnType<LlmTriageService['evaluate']>>
    try {
      const totalImageCount =
        Math.max(msg.imageKeys.length, msg.msgType === 'image' ? 1 : 0) +
        quotedImageTargets.length +
        extraImageTargets.length
      result = await this.host.triage!.evaluate({
        bot,
        ...(groupConfig ? { group: groupConfig } : {}),
        msg,
        decision,
        routerConfig,
        ...(senderName ? { senderName } : {}),
        ...(resolvedChatName ? { resolvedChatName } : {}),
        ...(prefetchedQuote
          ? {
              quotedMessage: {
                messageId: prefetchedQuote.messageId,
                msgType: prefetchedQuote.msgType,
                ...(prefetchedQuote.senderName ? { senderName: prefetchedQuote.senderName } : {}),
                ...(prefetchedQuote.text ? { text: prefetchedQuote.text } : {}),
                imageCount: prefetchedQuote.imageKeys.length,
              },
            }
          : {}),
        ...(totalImageCount > 0
          ? {
              totalImageCount,
              loadImages: (sig) =>
                mediaCache.admitImages(this.host.ctx, transport, allTriageImageTargets, {
                  maxCount: routerConfig.maxTriageImages,
                  ...(sig ? { signal: sig } : {}),
                }),
            }
          : {}),
        hasActiveWorker,
        workerBusy,
        ...(activeChatListeners.length > 0 ? { activeChatListeners } : {}),
        traceId,
        signal: linkedTriageSignal.signal,
      })
    } finally {
      linkedTriageSignal.dispose()
    }

    const postTriageDisabled = getDisabledScope()
    if (postTriageDisabled) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
        traceId,
        durationMs: result.durationMs,
        kind: 'lifecycle',
        summary: disabledCancelSummary(postTriageDisabled, '已取消分流并停止执行'),
      })
      return { handled: true }
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

    const triageSender = this.hydrator.resolveTelemetrySender(bot.id, transport, msg, senderName)
    this.host.onTriageRecorded?.({
      botId: bot.id,
      chatId: msg.chatId,
      chatType: msg.chatType === 'p2p' ? 'p2p' : 'group',
      ...(result.triageSessionId ? { triageSessionId: result.triageSessionId } : {}),
      traceId,
      ...(msg.senderOpenId ? { senderOpenId: msg.senderOpenId } : {}),
      ...(msg.senderUnionId ? { senderUnionId: msg.senderUnionId } : {}),
      ...(triageSender.senderName ? { senderName: triageSender.senderName } : {}),
      ...(triageSender.senderType ? { senderType: triageSender.senderType } : {}),
      action: result.verdict.action,
      ...(result.verdict.fallback ? { fallback: true } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.model ? { model: result.model } : {}),
      durationMs: result.durationMs,
      ...(result.usage ? { usage: result.usage } : {}),
    })

    if (
      decision.trigger !== 'mention' &&
      (result.verdict.action === 'silent' ||
        (decision.silentOnly && result.verdict.action === 'quick_reply'))
    ) {
      this.host.store.recordMetric({
        botId: bot.id,
        chatId: msg.chatId,
        chatType: msg.chatType,
        ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
        trigger: decision.trigger,
        ...triageSender,
        kind: 'silent_skip',
      })
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

    if (
      !decision.silentOnly &&
      result.verdict.action === 'quick_reply' &&
      !hasActiveWorker &&
      result.verdict.replyText
    ) {
      const replyText = normalizeReplyText(result.verdict.replyText, { allowSilentSentinel: true })
      if (replyText) {
        let sent: SendLarkReplyResult | undefined
        try {
          sent = await transport.sendReply({
            chatId: msg.chatId,
            replyToMessageId: msg.messageId,
            replyMode: decision.replyMode,
            text: replyText,
          })
        } catch (err) {
          if (isLarkMessageRecalledError(err)) {
            this.registry.markMessageRecalled(bot.id, msg.messageId)
            this.host.store.recordEvent({
              botId: bot.id,
              chatId: msg.chatId,
              ...chatName,
              routeKey: decision.routeKey,
              ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
              traceId,
              durationMs: Date.now() - startedMs,
              kind: 'lifecycle',
              summary: '目标消息已撤回（230006），已取消分流快回',
            })
            return { handled: true }
          }
          throw err
        }
        if (decision.sessionMode === 'thread') {
          const aliasRouteKeys = this.delivery.collectReplyAliasKeys(bot, msg, decision, sent)
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
          chatType: msg.chatType,
          ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
          trigger: 'triage',
          ...triageSender,
          ...chatName,
          kind: 'replied',
          latencyMs,
          queueWaitMs: 0,
          execMs: latencyMs,
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

    let routedRuntime: RoutedTierSelection | undefined
    if (
      !hasActiveWorker &&
      !decision.silentOnly &&
      !result.verdict.fallback &&
      hasConfiguredTierRouting(routerConfig)
    ) {
      const targetTier: TaskDifficultyTier = result.verdict.tier ?? 'standard'
      routedRuntime = await this.selectTierRoutedTarget(targetTier, routerConfig)
    }

    const prefix = result.verdict.fallback ? '分流回退直通' : '分流转交'
    const fallbackDiag = result.verdict.fallback
      ? (() => {
          const modelRef = [result.provider, result.model].filter(Boolean).join('/')
          const head = [result.errorCode, modelRef].filter(Boolean).join(' · ')
          const body = result.errorMessage?.trim()
          if (head && body) return ` [${head}: ${body}]`
          if (head) return ` [${head}]`
          if (body) return ` [${body}]`
          return ''
        })()
      : ''
    const routedSuffix = routedRuntime ? `（${routedRuntime.summary}）` : ''
    if (result.triageSessionId || fallbackDiag || routedRuntime) {
      this.host.store.recordEvent({
        botId: bot.id,
        chatId: msg.chatId,
        ...chatName,
        routeKey: decision.routeKey,
        ...(result.triageSessionId ? { sessionId: result.triageSessionId } : {}),
        traceId,
        durationMs: result.durationMs,
        kind: 'triage',
        summary: `${prefix}：${result.verdict.reason}${routedSuffix}${fallbackDiag}`,
      })
    }
    return {
      handled: false,
      triageNote: `${prefix}：${result.verdict.reason}${routedSuffix}${fallbackDiag}（${result.durationMs}ms）`,
      ...(result.triageSessionId ? { triageSessionId: result.triageSessionId } : {}),
      ...(routedRuntime ? { routedRuntime } : {}),
    }
  }
}
