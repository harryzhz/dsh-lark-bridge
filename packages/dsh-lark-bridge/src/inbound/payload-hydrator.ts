import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import {
  composeCoalescedUserText,
  composeLarkContextReminder,
  composeProactiveSessionReminder,
  composeRouterHandoffReminder,
  composeTurnPrompt,
  extractInjectedLarkMessageIdsFromText,
  type EffectiveRouterConfig,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type TriageHistoryEntry,
} from '@dsh-lark/lark-core'
import type { ImageRefTarget, InboundMediaCache } from '../media-intake.js'
import type { AgentDecision } from '../session-coordinator.js'
import { LARK_SENT_MESSAGE_RECORD_TYPE } from '../types.js'
import type {
  DebouncedInboundItem,
  DebouncedTurnRunOptions,
  InboundPipelineHost,
  QueuedWorkerTurnItem,
} from './turn-state-registry.js'
import { composeDebouncedListenerUserText } from './turn-state-registry.js'

const TRIAGE_HISTORY_BACKFILL_TIMEOUT_MS = 1_200
const MAX_BATCH_IMAGES = 10
const MAX_TRACKED_SESSIONS = 1_000

export function collectSessionInjectedMessageIds(session?: Session): Set<string> {
  const ids = new Set<string>()
  if (!session || typeof session.snapshotEvents !== 'function') return ids
  for (const ev of session.snapshotEvents()) {
    const raw = ev as { type?: unknown; data?: Record<string, unknown> }
    if (raw.type === 'user/message') {
      const data = raw.data as
        | {
            content?: ReadonlyArray<{ type?: unknown; text?: unknown }>
            message?: { content?: ReadonlyArray<{ type?: unknown; text?: unknown }> }
          }
        | undefined
      const blocks = data?.content ?? data?.message?.content ?? []
      for (const b of blocks) {
        if (b && b.type === 'text' && typeof b.text === 'string') {
          extractInjectedLarkMessageIdsFromText(b.text, ids)
        }
      }
      continue
    }
    if (raw.type === LARK_SENT_MESSAGE_RECORD_TYPE) {
      const msgId = raw.data?.messageId
      if (typeof msgId === 'string' && msgId.trim()) ids.add(msgId.trim())
      continue
    }
    if (raw.type === 'plugin/record' && raw.data?.type === LARK_SENT_MESSAGE_RECORD_TYPE) {
      const payload = raw.data?.data as { messageId?: unknown } | undefined
      if (typeof payload?.messageId === 'string' && payload.messageId.trim()) {
        ids.add(payload.messageId.trim())
      }
    }
  }
  return ids
}

/**
 * Hydrates inbound turn payloads: resolves sender identity/telemetry, backfills
 * cold triage history, tracks injected/sent Feishu message IDs for quote dedup,
 * enforces bounded image admission, and assembles prompt blocks.
 */
export class InboundPayloadHydrator {
  private readonly sentMessageIdsBySession = new Map<string, Set<string>>()

  constructor(private readonly host: InboundPipelineHost) {}

  resolveTelemetrySender(
    botId: string,
    transport: LarkBotTransport,
    msg?: InboundLarkMessage,
    resolvedName?: string,
  ): {
    readonly senderId?: string
    readonly senderName?: string
    readonly senderType?: 'user' | 'bot'
  } {
    if (!msg) {
      const fallbackName = resolvedName?.trim()
      return fallbackName ? { senderName: fallbackName, senderType: 'user' } : {}
    }
    const openId = msg.senderOpenId?.trim() || ''
    const cached =
      openId && typeof transport.getCachedUserProfile === 'function'
        ? transport.getCachedUserProfile(openId)
        : undefined
    const stored =
      openId && (!cached?.name || !cached?.unionId || !cached?.avatarUrl)
        ? this.host.store.getSenderProfile?.(botId, openId)
        : undefined
    const unionId = msg.senderUnionId?.trim() || cached?.unionId?.trim() || stored?.unionId?.trim() || ''
    const senderType: 'user' | 'bot' = msg.senderType === 'bot' ? 'bot' : 'user'
    const peerBot =
      senderType === 'bot' && openId
        ? this.host.connections.listBotStatuses?.().find((s) => s.botOpenId === openId)
        : undefined
    const cleanName =
      resolvedName?.trim() ||
      cached?.name?.trim() ||
      stored?.name?.trim() ||
      peerBot?.name?.trim() ||
      ''
    const avatarUrl = cached?.avatarUrl || stored?.avatarUrl || peerBot?.avatarUrl
    const senderId = unionId || openId
    if (openId && (unionId || cleanName || avatarUrl || senderType === 'bot')) {
      this.host.store.upsertSenderProfile?.({
        botId,
        openId,
        ...(unionId ? { unionId } : {}),
        ...(cleanName ? { name: cleanName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        senderType,
      })
    }
    return {
      ...(senderId ? { senderId } : {}),
      ...(cleanName ? { senderName: cleanName } : {}),
      ...(senderId || cleanName ? { senderType } : {}),
    }
  }

  async resolveSenderName(
    botId: string,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ): Promise<string | undefined> {
    const openId = msg.senderOpenId?.trim()
    if (!openId) return undefined
    const isGroupChat = msg.chatType !== 'p2p' && Boolean(msg.chatId?.trim())

    if (msg.senderType === 'bot') {
      const groupProfile =
        isGroupChat && typeof this.host.connections.resolveGroupMemberProfile === 'function'
          ? await this.host.connections
              .resolveGroupMemberProfile(botId, msg.chatId, openId, { includeAvatars: false })
              .catch(() => undefined)
          : undefined
      const peerBot = this.host.connections
        .listBotStatuses?.()
        .find((s) => s.botOpenId === openId)
      const cleanName = groupProfile?.name?.trim() || peerBot?.name?.trim() || undefined
      const avatarUrl = groupProfile?.avatarUrl || peerBot?.avatarUrl
      const unionId = msg.senderUnionId?.trim() || undefined
      if (unionId || cleanName || avatarUrl) {
        this.host.store.upsertSenderProfile?.({
          botId,
          openId,
          ...(unionId ? { unionId } : {}),
          ...(cleanName ? { name: cleanName } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
          senderType: 'bot',
        })
      }
      return cleanName
    }

    const summary =
      typeof transport.resolveUserSummary === 'function'
        ? await transport.resolveUserSummary(openId).catch(() => undefined)
        : undefined
    let cleanName = summary?.name && summary.name !== openId ? summary.name.trim() : undefined
    let avatarUrl = summary?.avatarUrl
    const unionId = msg.senderUnionId?.trim() || summary?.unionId?.trim() || undefined

    // Fallback to group member directory when Contact API is outside app scope (e.g. 41050)
    if (
      !cleanName &&
      isGroupChat &&
      typeof this.host.connections.resolveGroupMemberProfile === 'function'
    ) {
      const groupProfile = await this.host.connections
        .resolveGroupMemberProfile(botId, msg.chatId, openId, { includeAvatars: false })
        .catch(() => undefined)
      if (groupProfile?.name?.trim()) {
        cleanName = groupProfile.name.trim()
      }
      if (!avatarUrl && groupProfile?.avatarUrl) {
        avatarUrl = groupProfile.avatarUrl
      }
    }

    if (unionId || cleanName || avatarUrl) {
      this.host.store.upsertSenderProfile?.({
        botId,
        openId,
        ...(unionId ? { unionId } : {}),
        ...(cleanName ? { name: cleanName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        senderType: 'user',
      })
    }
    return cleanName
  }

  async hydrateTriageContextIfNeeded(input: {
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

  collectInjectedMessageIds(sessionId?: string, session?: Session): Set<string> {
    const ids = collectSessionInjectedMessageIds(session)
    if (sessionId) {
      const mem = this.sentMessageIdsBySession.get(sessionId)
      if (mem) {
        for (const id of mem) ids.add(id)
      }
    }
    return ids
  }

  isMessageAlreadyInRouteSession(routeKey: string, messageId: string): boolean {
    const cleanId = messageId.trim()
    if (!cleanId) return false
    const binding = this.host.store.getBinding(routeKey)
    if (!binding) return false
    const liveAgent = this.host.ctx.agents?.get?.(binding.sessionId as never)
    const ids = this.collectInjectedMessageIds(binding.sessionId, liveAgent?.session)
    return ids.has(cleanId)
  }

  recordSentLarkMessage(
    sessionId: string | undefined,
    session: Session | undefined,
    messageId: string | undefined,
  ): void {
    const cleanId = messageId?.trim()
    if (!cleanId) return
    const sid = sessionId?.trim() || (session?.id as string | undefined)
    if (sid) {
      let bucket = this.sentMessageIdsBySession.get(sid)
      if (!bucket) {
        bucket = new Set<string>()
        this.sentMessageIdsBySession.set(sid, bucket)
        if (this.sentMessageIdsBySession.size > MAX_TRACKED_SESSIONS) {
          const oldest = this.sentMessageIdsBySession.keys().next().value
          if (oldest) this.sentMessageIdsBySession.delete(oldest)
        }
      }
      bucket.add(cleanId)
    }
    if (!session) return
    try {
      appendPluginRecord(session, LARK_SENT_MESSAGE_RECORD_TYPE, { messageId: cleanId })
    } catch {
      // Best-effort durable dedup tracking; never fail reply delivery.
    }
  }

  async buildBatchPrompt(
    bot: LarkBotConfig,
    transport: LarkBotTransport,
    items: readonly QueuedWorkerTurnItem[],
    effectiveDecision: AgentDecision,
    isNewSession: boolean,
    resolvedChatName?: string,
    sessionId?: string,
    session?: Session,
  ): Promise<ContentBlock[]> {
    const primary = items[items.length - 1]!
    const reminders: string[] = []
    const sessionInjectedIds = isNewSession
      ? new Set<string>()
      : this.collectInjectedMessageIds(sessionId, session)
    const batchOwnMessageIds = new Set<string>(
      items.map((item) => item.msg.messageId).filter((id): id is string => Boolean(id)),
    )
    const earlierBatchMessageIds = new Set<string>(
      items
        .slice(0, -1)
        .map((item) => item.msg.messageId)
        .filter((id): id is string => Boolean(id)),
    )
    const primaryQuoteAlreadyInSession = Boolean(
      primary.msg.parentId &&
        (sessionInjectedIds.has(primary.msg.parentId) ||
          earlierBatchMessageIds.has(primary.msg.parentId)),
    )

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

      const memoryQueryParts = [
        ...items.map((item) => item.decision.userText.trim()).filter(Boolean),
        primary.prefetchedQuote?.text?.trim() ?? '',
      ].filter(Boolean)
      const memoryQueryText = memoryQueryParts.join('\n') || undefined

      const memoryReminder = this.host.memory?.composeFirstTurnReminder(
        {
          botId: bot.id,
          chatId: primary.msg.chatId,
          workingDir: effectiveDecision.workingDir,
        },
        {
          includeWhenEmpty: Boolean(bot.experimental.dreaming.enabled),
          ...(memoryQueryText ? { queryText: memoryQueryText } : {}),
        },
      )
      if (memoryReminder) reminders.push(memoryReminder)
    }

    const handoffTurns = items.flatMap((i) => i.handoffTurns ?? [])
    const handoffReminder = composeRouterHandoffReminder(handoffTurns)
    if (handoffReminder) reminders.push(handoffReminder)

    for (const item of items) {
      if (item.recoveryReminder) reminders.push(item.recoveryReminder)
    }

    const primaryQuote = primaryQuoteAlreadyInSession ? undefined : primary.prefetchedQuote
    const admittedQuoteBlocks: ContentBlock[] = []
    const admittedMessageBlocks: ContentBlock[] = []
    const seenImageKeys = new Set<string>()

    const collectFromCache = async (
      cache: InboundMediaCache,
      targets: readonly ImageRefTarget[],
      dest: ContentBlock[],
    ): Promise<number> => {
      const remaining = MAX_BATCH_IMAGES - (admittedQuoteBlocks.length + admittedMessageBlocks.length)
      if (remaining <= 0) return 0
      const pending: ImageRefTarget[] = []
      for (const t of targets) {
        if (pending.length >= remaining) break
        const k = `${t.messageId}:${t.imageKey}`
        if (seenImageKeys.has(k)) continue
        seenImageKeys.add(k)
        pending.push(t)
      }
      if (pending.length === 0) return 0
      const admitted = await cache.admitImages(this.host.ctx, transport, pending)
      dest.push(...admitted.blocks)
      return admitted.blocks.length
    }

    let primaryQuoteAttachedImages = 0
    for (const item of items) {
      if (item.prefetchedQuote && item.prefetchedQuote.imageKeys.length > 0) {
        const quoteId = item.prefetchedQuote.messageId
        if (sessionInjectedIds.has(quoteId) || batchOwnMessageIds.has(quoteId)) {
          continue
        }
        const count = await collectFromCache(
          item.mediaCache,
          item.prefetchedQuote.imageKeys.map((imageKey) => ({
            messageId: quoteId,
            imageKey,
          })),
          admittedQuoteBlocks,
        )
        if (item === primary) primaryQuoteAttachedImages = count
      }
    }
    for (const item of items) {
      if (item.extraImageTargets && item.extraImageTargets.length > 0) {
        await collectFromCache(item.mediaCache, item.extraImageTargets, admittedMessageBlocks)
      }
      if (item.msg.imageKeys.length > 0) {
        await collectFromCache(
          item.mediaCache,
          item.msg.imageKeys.map((imageKey) => ({
            messageId: item.msg.messageId,
            imageKey,
          })),
          admittedMessageBlocks,
        )
      }
    }

    reminders.push(
      composeLarkContextReminder({
        bot,
        botOpenId: transport.state?.botOpenId ?? primary.msg.botOpenId,
        ...(sessionId ? { sessionId } : {}),
        msg: primary.msg,
        ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
        ...(primary.senderName ? { senderName: primary.senderName } : {}),
        trigger: effectiveDecision.trigger,
        allowSilentEmptyReply: effectiveDecision.allowSilentEmptyReply,
        replyMode: effectiveDecision.replyMode,
        useCard: effectiveDecision.useCard,
        includeFullGuide: isNewSession,
        ...(primaryQuoteAlreadyInSession ? { quoteAlreadyInSession: true } : {}),
        ...(primaryQuote
          ? {
              prefetchedQuote: {
                messageId: primaryQuote.messageId,
                msgType: primaryQuote.msgType,
                ...(primaryQuote.senderName ? { senderName: primaryQuote.senderName } : {}),
                ...(primaryQuote.senderType ? { senderType: primaryQuote.senderType } : {}),
                ...(primaryQuote.text ? { text: primaryQuote.text } : {}),
                imageCount: primaryQuote.imageKeys.length,
                attachedImageCount: primaryQuoteAttachedImages,
                hasUnfetchedResources: primaryQuote.hasNonImageResources,
              },
            }
          : {}),
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
    return [{ type: 'text', text }, ...admittedQuoteBlocks, ...admittedMessageBlocks]
  }

  /**
   * Merges a debounced burst of passive-listener messages into a single
   * coalesced inbound payload, preserving mentions, reminders, extra images,
   * and triage context entries for earlier messages in the burst.
   */
  async mergeDebouncedListenerBatch(live: readonly DebouncedInboundItem[]): Promise<{
    readonly mergedMsg: InboundLarkMessage
    readonly mergedDecision: AgentDecision
    readonly debouncedOptions: DebouncedTurnRunOptions
    readonly resolvedChatName?: string
  }> {
    const head = live[0]!
    const tail = live[live.length - 1]!
    const senderNames = await Promise.all(
      live.map((item) => this.resolveSenderName(item.bot.id, item.transport, item.msg)),
    )

    const mergedUserText = composeDebouncedListenerUserText(
      live.map((item, idx) => ({
        messageId: item.msg.messageId,
        ...(senderNames[idx] ? { senderName: senderNames[idx] } : {}),
        ...(item.msg.senderOpenId ? { senderOpenId: item.msg.senderOpenId } : {}),
        text: item.decision.userText,
      })),
    )

    const seenReminders = new Set<string>()
    const mergedReminders: string[] = []
    for (const item of live) {
      for (const r of item.decision.turnReminders) {
        if (!seenReminders.has(r)) {
          seenReminders.add(r)
          mergedReminders.push(r)
        }
      }
    }

    const seenMentions = new Set<string>()
    const mergedMentions = [...tail.msg.mentions]
    for (const m of tail.msg.mentions) {
      seenMentions.add(m.openId || m.key)
    }
    for (let i = 0; i < live.length - 1; i += 1) {
      for (const m of live[i]!.msg.mentions) {
        const key = m.openId || m.key
        if (!seenMentions.has(key)) {
          seenMentions.add(key)
          mergedMentions.push(m)
        }
      }
    }

    const extraImageTargets: ImageRefTarget[] = []
    for (let i = 0; i < live.length - 1; i += 1) {
      const item = live[i]!
      for (const imageKey of item.msg.imageKeys) {
        extraImageTargets.push({ messageId: item.msg.messageId, imageKey })
      }
      if (this.host.triage && item.msg.chatType === 'group') {
        this.host.triage.context.recordChatMessage(
          `chat:${item.bot.id}:${item.msg.chatId}`,
          {
            role: 'user',
            ...(senderNames[i] ? { senderName: senderNames[i] } : {}),
            text: item.decision.userText,
            timestampMs: item.receivedAtMs,
            messageId: item.msg.messageId,
          },
          { now: item.receivedAtMs },
        )
      }
    }

    const mergedMsg: InboundLarkMessage = {
      ...tail.msg,
      mentions: mergedMentions,
    }
    const mergedDecision: AgentDecision = {
      ...tail.decision,
      allowSilentEmptyReply: live.every((i) => i.decision.allowSilentEmptyReply),
      autoCloseAfterCompletion: live.every((i) => i.decision.autoCloseAfterCompletion),
      ...(live.every((i) => Boolean(i.decision.silentOnly)) ? { silentOnly: true } : {}),
      turnReminders: mergedReminders,
      userText: mergedUserText,
      promptText: composeTurnPrompt(mergedReminders, mergedUserText),
    }

    const resolvedChatName =
      mergedDecision.chatName || this.host.store.resolveChatName(tail.bot.id, tail.msg.chatId)
    return {
      mergedMsg,
      mergedDecision,
      ...(resolvedChatName ? { resolvedChatName } : {}),
      debouncedOptions: {
        ...(extraImageTargets.length > 0 ? { extraImageTargets } : {}),
        debouncedCount: live.length,
        startedAtMs: head.receivedAtMs,
      },
    }
  }
}
