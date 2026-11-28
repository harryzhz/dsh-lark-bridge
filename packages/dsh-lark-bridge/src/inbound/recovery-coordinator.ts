import {
  buildReplyCard,
  normalizeReplyText,
  resolveEffectiveCardBot,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type LarkGroupConfig,
} from '@dsh-lark/lark-core'
import { InboundMediaCache } from '../media-intake.js'
import type { AcquiredAgent, AgentDecision } from '../session-coordinator.js'
import {
  canAutoResumePendingTurn,
  inspectPersistedTurnCompletion,
} from '../turn-recovery.js'
import { reattachTurnAndCollectReply } from '../turn-runner.js'
import type { LarkPendingTurn } from '../types.js'
import type { InboundPayloadHydrator } from './payload-hydrator.js'
import type { TurnReplyDelivery } from './reply-delivery.js'
import type { TurnRoutingCoordinator } from './routing-coordinator.js'
import {
  buildExecutingTurnContext,
  canSilenceTurnByControl,
  closePendingTurnOrphanCot,
  createTraceId,
  disabledCancelSummary,
  isEligibleForNativeCot,
  type ActiveTurnRecord,
  type InboundPipelineHost,
  type QueuedWorkerTurnItem,
  type RecoveryRunContext,
  type TurnStateRegistry,
} from './turn-state-registry.js'

const SHUTDOWN_TURN_CLEANUP_TIMEOUT_MS = 2_000
const STALE_PENDING_TURN_MAX_AGE_MS = 24 * 60 * 60_000

interface PendingTurnGroup {
  lead: LarkPendingTurn
  readonly members: LarkPendingTurn[]
}

export type ReplayTurnRunner = (
  bot: LarkBotConfig,
  transport: LarkBotTransport,
  msg: InboundLarkMessage,
  decision: AgentDecision,
  groupConfig: LarkGroupConfig | undefined,
  traceId: string,
  recovery: RecoveryRunContext,
) => Promise<void>

/**
 * Coordinates shutdown/hot-reload suspension, persisted `pending_turns` recovery,
 * already-completed reply delivery, live hot-reload agent reattachment, and
 * replay fallback.
 */
export class TurnRecoveryCoordinator {
  private readonly recoveringTurnIds = new Set<string>()
  private readonly recoveryTasks = new Set<Promise<void>>()

  constructor(
    private readonly host: InboundPipelineHost,
    private readonly registry: TurnStateRegistry,
    private readonly hydrator: InboundPayloadHydrator,
    private readonly delivery: TurnReplyDelivery,
    private readonly routing: TurnRoutingCoordinator,
    private readonly runReplayTurn: ReplayTurnRunner,
  ) {}

  get recoveringCount(): number {
    return this.recoveringTurnIds.size
  }

  async waitForRecoveries(): Promise<void> {
    while (this.recoveryTasks.size > 0) {
      await Promise.allSettled([...this.recoveryTasks])
    }
  }

  async recoverStalePendingTurns(botId?: string, nowMs = Date.now()): Promise<number> {
    const stale = this.host.store.listPendingTurns().filter((item) => {
      if (botId && item.botId !== botId) return false
      return !this.registry.activeTurns.has(item.id) && !this.recoveringTurnIds.has(item.id)
    })
    if (stale.length === 0) return 0

    const groups = this.groupPendingTurnsByExecution(stale)
    let recovered = 0
    for (const group of groups) {
      recovered += await this.recoverPendingTurnGroup(group, nowMs)
    }
    return recovered
  }

  /**
   * Preserves recoverable in-flight turns in SQLite (`status: 'interrupted'`) with their
   * Feishu reaction intact so the next process resumes them seamlessly without error spam.
   */
  async suspendActiveTurnsForShutdown(
    options: { readonly preserveLiveAgents?: boolean } = {},
  ): Promise<void> {
    const preserveLiveAgents = Boolean(options.preserveLiveAgents)
    const nowMs = Date.now()
    const recoverable: ActiveTurnRecord[] = []
    const nonRecoverable: ActiveTurnRecord[] = []

    for (const record of this.registry.activeTurns.values()) {
      if (record.settled) continue
      record.settled = true
      record.reactionRemoved = true
      const canPreserveLive =
        preserveLiveAgents &&
        Boolean(record.sessionId) &&
        Boolean(record.inboundMsg) &&
        (record.targetTurn !== undefined || Boolean(record.userMessageId))
      if (canPreserveLive || canAutoResumePendingTurn(record, nowMs, { phase: 'shutdown' })) {
        recoverable.push(record)
      } else {
        nonRecoverable.push(record)
      }
    }
    this.registry.activeTurns.clear()
    this.host.onActivityChange?.()

    for (const record of recoverable) {
      record.status = 'interrupted'
      record.interruptedAtMs = nowMs
      record.interruptKind = preserveLiveAgents ? 'hot_reload' : 'graceful_shutdown'
      this.registry.persistActiveTurn(record, { force: true })
      this.host.store.recordEvent({
        botId: record.botId,
        chatId: record.chatId,
        ...(record.chatName ? { chatName: record.chatName } : {}),
        routeKey: record.routeKey,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        traceId: record.traceId,
        kind: 'lifecycle',
        summary: preserveLiveAgents
          ? '飞书桥接热更新切包，已保持后台会话运行，重载后自动续传'
          : '服务重载或停机，已保存处理中任务待重启自动恢复',
      })
    }

    for (const record of nonRecoverable) {
      this.host.store.deletePendingTurn(record.id)
    }

    const recoverableWithCot = recoverable.filter(
      (r) => Boolean(r.cotController) || Boolean(r.cotId && r.cotMessageId),
    )
    if (nonRecoverable.length === 0 && recoverableWithCot.length === 0) return

    const cotCloseTimeoutMs = Math.max(400, SHUTDOWN_TURN_CLEANUP_TIMEOUT_MS - 300)
    const recoverableCotNotice = preserveLiveAgents
      ? '服务热更新重载，正在后台继续执行'
      : '服务重启中，将自动恢复执行'

    const work = Promise.all([
      ...recoverableWithCot.map(async (record) => {
        await this.delivery.closeTurnCot(record, 'interrupted', {
          notice: recoverableCotNotice,
          timeoutMs: cotCloseTimeoutMs,
        })
        if (!record.cotController && !record.cotId) {
          this.registry.persistActiveTurn(record, { force: true })
        }
      }),
      ...nonRecoverable.map(async (record) => {
        await this.delivery.closeTurnCot(record, 'interrupted', {
          notice: '本轮执行因服务重载或停机已中断',
          timeoutMs: cotCloseTimeoutMs,
        })
        await this.delivery.deliverInterruptedTurnCleanup({
          transport: record.transport,
          turn: record,
          intermediateSentCount: record.intermediateSentCount,
          auditSummary: '本轮执行因服务重载或停机已中断',
          replyText: '本轮执行因服务重载或停机已中断，可重新回复继续。',
        })
      }),
    ])

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

  /**
   * Groups coalesced messages that shared the exact same executing DSH turn so we attach
   * only one listener and deliver a single reply while cleaning up every member's reaction.
   */
  private groupPendingTurnsByExecution(stale: readonly LarkPendingTurn[]): PendingTurnGroup[] {
    const groups: PendingTurnGroup[] = []
    const groupByTurnKey = new Map<string, PendingTurnGroup>()
    for (const item of stale) {
      const turnKey =
        item.sessionId && item.targetTurn !== undefined
          ? `${item.botId}|${item.sessionId}|turn:${item.targetTurn}`
          : item.sessionId && item.userMessageId
            ? `${item.botId}|${item.sessionId}|msg:${item.userMessageId}`
            : undefined
      if (turnKey) {
        const existing = groupByTurnKey.get(turnKey)
        if (existing) {
          existing.members.push(item)
          existing.lead = item
          continue
        }
        const entry: PendingTurnGroup = { lead: item, members: [item] }
        groupByTurnKey.set(turnKey, entry)
        groups.push(entry)
      } else {
        groups.push({ lead: item, members: [item] })
      }
    }
    return groups
  }

  private filterRecalledMembers(members: readonly LarkPendingTurn[]): {
    readonly surviving: LarkPendingTurn[]
    readonly recalledCount: number
  } {
    const surviving: LarkPendingTurn[] = []
    let recalledCount = 0
    for (const m of members) {
      if (this.registry.isMessageRecalled(m.botId, m.messageId)) {
        this.host.store.deletePendingTurn(m.id)
        if (m.cotId && m.cotMessageId) {
          const recalledTransport = this.host.connections.getTransport(m.botId)
          void closePendingTurnOrphanCot(recalledTransport, m, 'error', '原消息已撤回，已取消执行')
        }
        this.host.store.recordEvent({
          botId: m.botId,
          chatId: m.chatId,
          ...(m.chatName ? { chatName: m.chatName } : {}),
          routeKey: m.routeKey,
          ...(m.sessionId ? { sessionId: m.sessionId } : {}),
          ...(m.traceId ? { traceId: m.traceId } : {}),
          kind: 'lifecycle',
          summary: '原消息已撤回，已跳过重启恢复',
        })
        recalledCount += 1
      } else {
        surviving.push(m)
      }
    }
    return { surviving, recalledCount }
  }

  private handleOfflinePendingGroup(
    lead: LarkPendingTurn,
    survivingMembers: readonly LarkPendingTurn[],
    nowMs: number,
  ): number {
    const bot = this.host.store.getBot(lead.botId)
    const expired = nowMs - lead.startedAtMs > STALE_PENDING_TURN_MAX_AGE_MS
    if (bot?.enabled && !expired) return 0
    for (const member of survivingMembers) {
      this.host.store.deletePendingTurn(member.id)
      this.host.store.recordEvent({
        botId: member.botId,
        chatId: member.chatId,
        ...(member.chatName ? { chatName: member.chatName } : {}),
        routeKey: member.routeKey,
        ...(member.sessionId ? { sessionId: member.sessionId } : {}),
        ...(member.traceId ? { traceId: member.traceId } : {}),
        kind: 'error',
        summary: '本轮执行因服务重启中断',
      })
    }
    return survivingMembers.length
  }

  private async cleanupDisabledPendingGroup(
    transport: LarkBotTransport,
    survivingMembers: readonly LarkPendingTurn[],
    disabledScope: 'bot' | 'group',
  ): Promise<number> {
    for (const member of survivingMembers) {
      this.host.store.deletePendingTurn(member.id)
      if (member.reactionId) {
        await transport.removeReaction(member.messageId, member.reactionId).catch(() => {})
      }
      await closePendingTurnOrphanCot(
        transport,
        member,
        'error',
        disabledCancelSummary(disabledScope, '已跳过重启恢复'),
      )
      this.host.store.recordEvent({
        botId: member.botId,
        chatId: member.chatId,
        ...(member.chatName ? { chatName: member.chatName } : {}),
        routeKey: member.routeKey,
        ...(member.sessionId ? { sessionId: member.sessionId } : {}),
        ...(member.traceId ? { traceId: member.traceId } : {}),
        kind: 'lifecycle',
        summary: disabledCancelSummary(disabledScope, '已跳过重启恢复'),
      })
    }
    return survivingMembers.length
  }

  private async tryDeliverAlreadyCompletedGroup(input: {
    readonly bot: LarkBotConfig | undefined
    readonly transport: LarkBotTransport
    readonly item: LarkPendingTurn
    readonly peerItems: readonly LarkPendingTurn[]
    readonly survivingMembers: readonly LarkPendingTurn[]
    readonly groupConfig: LarkGroupConfig | undefined
    readonly totalSentIntermediates: number
  }): Promise<boolean> {
    const { bot, transport, item, peerItems, survivingMembers, groupConfig, totalSentIntermediates } =
      input
    if (!item.sessionId) return false
    const inspection = await inspectPersistedTurnCompletion(
      this.host.ctx,
      item.sessionId,
      item.messageId,
      {
        ...(item.targetTurn !== undefined ? { targetTurn: item.targetTurn } : {}),
        ...(item.userMessageId ? { userMessageId: item.userMessageId } : {}),
        skipFirstIntermediates: totalSentIntermediates,
      },
    )
    if (inspection.state !== 'completed') return false
    for (const member of survivingMembers) {
      this.host.store.deletePendingTurn(member.id)
    }
    await Promise.all(
      survivingMembers.map((member) => closePendingTurnOrphanCot(transport, member, 'done')),
    )
    await this.deliverRecoveredCompletedTurn({
      bot,
      transport,
      turn: item,
      peerTurns: peerItems,
      groupConfig,
      replyText: inspection.replyText,
      missedIntermediates: inspection.missedIntermediates,
      silencedByTool: inspection.silencedByTool,
      fromHotReload: item.interruptKind === 'hot_reload',
    })
    return true
  }

  private tryLaunchLiveReattachGroup(input: {
    readonly bot: LarkBotConfig | undefined
    readonly transport: LarkBotTransport
    readonly liveAgent: import('@deepseek-ai/dsh-agent').Agent | undefined
    readonly item: LarkPendingTurn
    readonly survivingMembers: readonly LarkPendingTurn[]
    readonly groupConfig: LarkGroupConfig | undefined
    readonly totalSentIntermediates: number
    readonly nowMs: number
    readonly releaseRecoveringIds: () => void
  }): boolean {
    const {
      bot,
      transport,
      liveAgent,
      item,
      survivingMembers,
      groupConfig,
      totalSentIntermediates,
      nowMs,
      releaseRecoveringIds,
    } = input
    const canAttemptLiveReattach = Boolean(
      liveAgent &&
        bot?.enabled &&
        item.sessionId &&
        item.inboundMsg &&
        (item.targetTurn !== undefined ||
          Boolean(item.userMessageId) ||
          item.interruptKind === 'hot_reload'),
    )
    if (!canAttemptLiveReattach || !liveAgent || !bot || !item.sessionId || !item.inboundMsg) {
      return false
    }
    const knownChatName =
      item.chatName ||
      (item.inboundMsg.chatType === 'group'
        ? this.host.store.resolveChatName(bot.id, item.inboundMsg.chatId)
        : undefined)
    const decision = this.routing.resolveDecisionForMessage(
      bot,
      item.inboundMsg,
      groupConfig,
      knownChatName,
    )
    if (decision.action !== 'agent') return false
    const task = this.reattachLiveTurn({
      bot,
      transport,
      liveAgent,
      sessionId: item.sessionId,
      lead: item,
      members: survivingMembers,
      decision,
      groupConfig,
      ...(knownChatName ? { resolvedChatName: knownChatName } : {}),
      skipFirstIntermediates: totalSentIntermediates,
      nowMs,
    })
      .catch((err) => {
        this.host.ctx.logger.warn(
          `[lark-bridge][bot=${bot.id}][msg=${item.messageId}] live hot-reload reattach failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      .finally(() => {
        this.recoveryTasks.delete(task)
        releaseRecoveringIds()
      })
    this.recoveryTasks.add(task)
    return true
  }

  private async recoverPendingTurnGroup(group: PendingTurnGroup, nowMs: number): Promise<number> {
    const members = group.members.filter(
      (m) => !this.registry.activeTurns.has(m.id) && !this.recoveringTurnIds.has(m.id),
    )
    if (members.length === 0) return 0

    const { surviving: survivingMembers, recalledCount } = this.filterRecalledMembers(members)
    if (survivingMembers.length === 0) return recalledCount

    const item = survivingMembers[survivingMembers.length - 1]!
    const peerItems = survivingMembers.slice(0, -1)
    const transport = this.host.connections.getTransport(item.botId)
    if (!transport) {
      return recalledCount + this.handleOfflinePendingGroup(item, survivingMembers, nowMs)
    }

    for (const member of survivingMembers) {
      this.recoveringTurnIds.add(member.id)
    }
    this.host.onActivityChange?.()
    let handedOffToAsyncTask = false
    const releaseRecoveringIds = () => {
      for (const member of survivingMembers) {
        this.recoveringTurnIds.delete(member.id)
      }
      this.host.onActivityChange?.()
    }

    try {
      const bot = this.host.store.getBot(item.botId)
      const groupConfig = this.host.store.getGroup(item.botId, item.chatId)
      const pendingChatType =
        item.inboundMsg?.chatType ?? (item.trigger === 'p2p' ? 'p2p' : 'group')
      const disabledScope = this.registry.getDisabledScope(item.botId, pendingChatType, item.chatId)
      if (disabledScope) {
        return (
          recalledCount +
          (await this.cleanupDisabledPendingGroup(transport, survivingMembers, disabledScope))
        )
      }

      const totalSentIntermediates = survivingMembers.reduce(
        (sum, m) => sum + (m.intermediateSentCount ?? 0),
        0,
      )

      // 0. Reclaim a surviving live host agent (from seamless `dsh-lark-bridge` hot-reload) if present.
      const liveAgent = item.sessionId
        ? this.host.sessions.reclaimLiveAgent(item.sessionId)
        : undefined

      // 1. Check whether the target turn already completed right before shutdown or during hot-reload swap.
      if (
        await this.tryDeliverAlreadyCompletedGroup({
          bot,
          transport,
          item,
          peerItems,
          survivingMembers,
          groupConfig,
          totalSentIntermediates,
        })
      ) {
        return recalledCount + survivingMembers.length
      }

      // 2. Seamless live reattach to a surviving hot-reload agent.
      if (
        this.tryLaunchLiveReattachGroup({
          bot,
          transport,
          liveAgent,
          item,
          survivingMembers,
          groupConfig,
          totalSentIntermediates,
          nowMs,
          releaseRecoveringIds,
        })
      ) {
        handedOffToAsyncTask = true
        return recalledCount + survivingMembers.length
      }

      // 3. Fallback: automatically resume eligible interrupted turns by replaying into the existing session.
      if (bot?.enabled && canAutoResumePendingTurn(item, nowMs, { phase: 'startup' })) {
        const started = this.launchReplayRecoveryTask({
          bot,
          transport,
          item,
          peerItems,
          groupConfig,
          nowMs,
          onDone: releaseRecoveringIds,
        })
        if (started) {
          handedOffToAsyncTask = true
          return recalledCount + survivingMembers.length
        }
      }

      // 4. Non-recoverable: clean up stale reactions and notify interactive turns.
      for (const member of survivingMembers) {
        this.host.store.deletePendingTurn(member.id)
      }
      await Promise.all(
        survivingMembers.map((member) =>
          closePendingTurnOrphanCot(transport, member, 'error', '本轮执行因服务重启中断'),
        ),
      )
      for (const peer of peerItems) {
        if (peer.reactionId) {
          await transport.removeReaction(peer.messageId, peer.reactionId).catch(() => {})
        }
      }
      await this.delivery.deliverInterruptedTurnCleanup({
        transport,
        turn: item,
        intermediateSentCount: totalSentIntermediates,
        auditSummary: '本轮执行因服务重启中断',
        replyText: '本轮执行因服务重启中断，可重新回复继续。',
      })
      return recalledCount + survivingMembers.length
    } finally {
      if (!handedOffToAsyncTask) {
        releaseRecoveringIds()
      }
    }
  }

  private launchReplayRecoveryTask(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly item: LarkPendingTurn
    readonly peerItems?: readonly LarkPendingTurn[]
    readonly groupConfig: LarkGroupConfig | undefined
    readonly nowMs: number
    readonly onDone?: () => void
  }): boolean {
    const { bot, transport, item, peerItems = [], groupConfig, nowMs, onDone } = input
    const replayMsg = item.inboundMsg
    if (!replayMsg) return false
    const knownChatName =
      item.chatName ||
      (replayMsg.chatType === 'group'
        ? this.host.store.resolveChatName(bot.id, replayMsg.chatId)
        : undefined)
    const decision = this.routing.resolveDecisionForMessage(bot, replayMsg, groupConfig, knownChatName)
    if (decision.action !== 'agent') return false

    const isGracefulShutdown =
      item.interruptKind === 'graceful_shutdown' || item.interruptKind === 'hot_reload'
    const nextCrashAttempts = isGracefulShutdown
      ? (item.recoveryAttempts ?? 0)
      : (item.recoveryAttempts ?? 0) + 1
    const nextGracefulAttempts = isGracefulShutdown
      ? (item.gracefulRecoveryAttempts ?? 0) + 1
      : (item.gracefulRecoveryAttempts ?? 0)
    const totalAttempts = nextCrashAttempts + nextGracefulAttempts
    const traceId = item.traceId || createTraceId()

    for (const peer of peerItems) {
      this.host.store.deletePendingTurn(peer.id)
      if (peer.reactionId) {
        void transport.removeReaction(peer.messageId, peer.reactionId).catch(() => {})
      }
      if (peer.cotId && peer.cotMessageId) {
        void closePendingTurnOrphanCot(transport, peer, 'error', '服务重启后正在自动恢复执行')
      }
    }
    if (item.cotId && item.cotMessageId) {
      void closePendingTurnOrphanCot(transport, item, 'error', '服务重启后正在自动恢复执行')
    }
    const { cotId: _staleCotId, cotMessageId: _staleCotMsgId, ...cleanItem } = item
    this.host.store.upsertPendingTurn({
      ...cleanItem,
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

    const task = this.runReplayTurn(bot, transport, replayMsg, decision, groupConfig, traceId, {
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
        this.recoveryTasks.delete(task)
        onDone?.()
      })
    this.recoveryTasks.add(task)
    return true
  }

  private async reattachLiveTurn(input: {
    readonly bot: LarkBotConfig
    readonly transport: LarkBotTransport
    readonly liveAgent: import('@deepseek-ai/dsh-agent').Agent
    readonly sessionId: string
    readonly lead: LarkPendingTurn
    readonly members: readonly LarkPendingTurn[]
    readonly decision: AgentDecision
    readonly groupConfig: LarkGroupConfig | undefined
    readonly resolvedChatName?: string
    readonly skipFirstIntermediates: number
    readonly nowMs: number
  }): Promise<void> {
    const {
      bot,
      transport,
      liveAgent,
      sessionId,
      lead,
      members,
      decision,
      groupConfig,
      resolvedChatName,
      skipFirstIntermediates,
    } = input

    const leadMsg = lead.inboundMsg!
    const traceId = lead.traceId || createTraceId()
    const boundDecision: AgentDecision = { ...decision, routeKey: lead.routeKey }
    const acquired: AcquiredAgent = {
      agent: liveAgent,
      sessionId,
      routeKey: lead.routeKey,
      isNew: false,
      disposeAfter: boundDecision.sessionMode === 'per_message',
    }

    const batchItems: QueuedWorkerTurnItem[] = members.map((member) => {
      const mMsg = member.inboundMsg ?? leadMsg
      const mCancelController = new AbortController()
      const mDecision: AgentDecision = { ...boundDecision, routeKey: member.routeKey }
      const mActiveTurn = this.registry.registerActiveTurn({
        id: member.id,
        traceId: member.traceId || traceId,
        botId: member.botId,
        chatId: member.chatId,
        ...(member.chatName || resolvedChatName ? { chatName: member.chatName || resolvedChatName } : {}),
        messageId: member.messageId,
        routeKey: member.routeKey,
        replyMode: member.replyMode,
        trigger: member.trigger,
        allowSilentEmptyReply: member.allowSilentEmptyReply,
        ...(boundDecision.silentOnly ? { silentOnly: true } : {}),
        ...(member.reactionId ? { reactionId: member.reactionId } : {}),
        startedAtMs: member.startedAtMs,
        transport,
        inboundMsg: mMsg,
        ...(member.senderName ? { senderName: member.senderName } : {}),
        cancelController: mCancelController,
        ...(member.handoffTurns ? { handoffTurns: member.handoffTurns } : {}),
        sessionId,
        ...(member.targetTurn !== undefined ? { targetTurn: member.targetTurn } : {}),
        ...(member.userMessageId ? { userMessageId: member.userMessageId } : {}),
        ...(member.lastEventSeq !== undefined ? { lastEventSeq: member.lastEventSeq } : {}),
        intermediateSentCount: member.intermediateSentCount ?? 0,
        recoveryAttempts: member.recoveryAttempts ?? 0,
        gracefulRecoveryAttempts: member.gracefulRecoveryAttempts ?? 0,
      })
      return {
        msg: mMsg,
        decision: mDecision,
        activeTurn: mActiveTurn,
        cancelController: mCancelController,
        mediaCache: new InboundMediaCache(),
        traceId: mActiveTurn.traceId,
        ...(member.senderName ? { senderName: member.senderName } : {}),
        ...(member.handoffTurns ? { handoffTurns: member.handoffTurns } : {}),
      }
    })
    const latestItem = batchItems[batchItems.length - 1]!
    const executingTurnCtx = buildExecutingTurnContext(
      bot,
      latestItem.msg,
      boundDecision,
      resolvedChatName,
    )

    // Synchronously reserve the session slot, active CLI context, and recall/disable tracking BEFORE any `await`.
    this.host.sessions.markTurnRegistered(sessionId)
    this.registry.executingTurnBySession.set(sessionId, executingTurnCtx)
    const untrackCallbacks = batchItems.map((bi) =>
      this.registry.trackInflightController(
        bot.id,
        bi.msg.chatId,
        bi.msg.chatType,
        bi.msg.messageId,
        bi.cancelController,
      ),
    )
    const untrackInflight = () => {
      for (const fn of untrackCallbacks) fn()
    }
    const linkedCancel = this.registry.createBatchCancelBinding(bot.id, () => batchItems)

    let releaseTurnSlot: (() => void) | undefined
    let shouldDisposeEphemeral = false
    let shouldArchiveEphemeral = false
    let trackedRouteKey = lead.routeKey
    let fellBackToReplay = false

    try {
      releaseTurnSlot = await this.host.sessions.acquireTurnSlot(
        sessionId,
        this.host.shutdownSignal,
        () => this.host.isDisposed(),
      )
      if (!releaseTurnSlot) {
        for (const bi of batchItems) {
          this.registry.suspendSingleTurnForRestart(bi.activeTurn, Date.now(), {
            preserveLiveAgents: true,
          })
        }
        return
      }

      this.host.store.recordEvent({
        botId: bot.id,
        chatId: lead.chatId,
        ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
        routeKey: trackedRouteKey,
        sessionId,
        traceId,
        kind: 'lifecycle',
        summary: '热更新重载完成，已无损续接后台运行中的会话',
      })

      const isSilenced = () => batchItems.some((i) => i.activeTurn.silencedByControl)
      const isBatchCancelled = () =>
        linkedCancel.signal.aborted ||
        Boolean(this.registry.getBatchDisabledScope(bot.id, batchItems)) ||
        batchItems.every((i) => this.registry.isTurnRecalled(bot.id, i))

      await Promise.all(
        members.map((member) =>
          closePendingTurnOrphanCot(transport, member, 'error', '服务热更新重载，正在继续执行'),
        ),
      )

      const cotController = isEligibleForNativeCot(boundDecision)
        ? this.delivery.createTurnCotController({
            bot,
            transport,
            msg: latestItem.msg,
            decision: boundDecision,
            activeTurn: latestItem.activeTurn,
            sessionId,
            session: liveAgent.session,
            canPublish: () =>
              !boundDecision.silentOnly &&
              !isSilenced() &&
              !isBatchCancelled() &&
              !this.host.isDisposed(),
          })
        : undefined
      if (cotController) {
        latestItem.activeTurn.cotController = cotController
      }

      const execStartedMs = Date.now()
      const result = await reattachTurnAndCollectReply(this.host.ctx, liveAgent, {
        ...(lead.targetTurn !== undefined ? { targetTurn: lead.targetTurn } : {}),
        ...(lead.userMessageId ? { expectedUserMessageId: lead.userMessageId } : {}),
        expectedFeishuMessageId: lead.messageId,
        skipFirstIntermediates,
        signal: this.host.shutdownSignal,
        cancelSignal: linkedCancel.signal,
        ...(cotController ? { onCotEvent: (ev) => cotController.push(ev) } : {}),
        onActivity: (timestampMs) => {
          for (const bi of batchItems) {
            this.registry.touchActiveTurnActivity(bi.activeTurn, timestampMs)
          }
        },
        onTurnBound: ({ turn, userMessageId }) => {
          for (const bi of batchItems) {
            let changed = false
            if (bi.activeTurn.targetTurn !== turn) {
              bi.activeTurn.targetTurn = turn
              changed = true
            }
            if (userMessageId && bi.activeTurn.userMessageId !== userMessageId) {
              bi.activeTurn.userMessageId = userMessageId
              changed = true
            }
            if (changed) this.registry.persistActiveTurn(bi.activeTurn)
          }
        },
        onEventSeq: (seq) => {
          for (const bi of batchItems) {
            if (bi.activeTurn.lastEventSeq === undefined || seq > bi.activeTurn.lastEventSeq) {
              bi.activeTurn.lastEventSeq = seq
            }
          }
        },
        onSilencedByTool: () => {
          latestItem.activeTurn.silencedByControl = true
        },
        ...(boundDecision.sendIntermediateMessages && !boundDecision.silentOnly
          ? {
              onIntermediate: this.delivery.createIntermediateDeliveryHandler({
                bot,
                transport,
                latestItem,
                decision: boundDecision,
                session: liveAgent.session,
                executingTurnCtx,
                isSuppressed: () => isSilenced() || isBatchCancelled(),
                onRoutePromoted: (nextRouteKey) => {
                  trackedRouteKey = nextRouteKey
                },
              }),
            }
          : {}),
      })

      if (result.outcome === 'not_found') {
        await this.delivery.closeBatchCot(batchItems, 'interrupted', {
          notice: '未匹配到运行中会话，已切回恢复流程',
        })
        fellBackToReplay = true
        for (const bi of batchItems) {
          bi.activeTurn.settled = true
          bi.activeTurn.reactionRemoved = true
          this.registry.activeTurns.delete(bi.activeTurn.id)
        }
        this.host.onActivityChange?.()
        if (this.registry.executingTurnBySession.get(sessionId) === executingTurnCtx) {
          this.registry.executingTurnBySession.delete(sessionId)
        }
        linkedCancel.dispose()
        this.host.sessions.markTurnFinished(sessionId)
        releaseTurnSlot()
        releaseTurnSlot = undefined

        if (canAutoResumePendingTurn(lead, Date.now(), { phase: 'startup' })) {
          this.launchReplayRecoveryTask({
            bot,
            transport,
            item: lead,
            peerItems: members.slice(0, -1),
            groupConfig,
            nowMs: Date.now(),
          })
        } else {
          for (const member of members) {
            this.host.store.deletePendingTurn(member.id)
          }
          for (const peer of members.slice(0, -1)) {
            if (peer.reactionId) {
              await transport.removeReaction(peer.messageId, peer.reactionId).catch(() => {})
            }
          }
          await this.delivery.deliverInterruptedTurnCleanup({
            transport,
            turn: lead,
            intermediateSentCount: skipFirstIntermediates,
            auditSummary: '本轮执行因服务重载中断',
            replyText: '本轮执行因服务重载中断，可重新回复继续。',
          })
        }
        return
      }

      if (result.silencedByTool) {
        latestItem.activeTurn.silencedByControl = true
      }
      await this.delivery.closeBatchCot(
        batchItems,
        isSilenced() || isBatchCancelled() ? 'interrupted' : 'done',
        isBatchCancelled() ? { notice: '执行已取消' } : {},
      )
      const execMs = Math.max(0, Date.now() - execStartedMs)
      const settlement = await this.delivery.settleBatchReply({
        bot,
        transport,
        groupConfig,
        ...(resolvedChatName ? { resolvedChatName } : {}),
        acquired,
        batchItems,
        effectiveDecision: { ...boundDecision, routeKey: trackedRouteKey },
        replyText: result.replyText,
        startedMs: lead.startedAtMs,
        queueWaitMs: 0,
        execMs,
        reattachedFromHotReload: true,
      })
      shouldDisposeEphemeral = settlement.dispose
      shouldArchiveEphemeral = settlement.archive
    } catch (err) {
      const failure = await this.delivery.handleBatchFailure({
        bot,
        transport,
        msg: leadMsg,
        decision: boundDecision,
        ...(resolvedChatName ? { resolvedChatName } : {}),
        activeTurn: latestItem.activeTurn,
        batchItems,
        acquiredRef: acquired,
        trackedSessionId: sessionId,
        err,
      })
      shouldDisposeEphemeral = failure.dispose
      shouldArchiveEphemeral = failure.archive
    } finally {
      if (!fellBackToReplay) {
        if (this.registry.executingTurnBySession.get(sessionId) === executingTurnCtx) {
          this.registry.executingTurnBySession.delete(sessionId)
        }
        linkedCancel.dispose()
        for (const bi of batchItems) {
          if (!bi.activeTurn.reactionRemoved && bi.activeTurn.reactionId) {
            bi.activeTurn.reactionRemoved = true
            await transport
              .removeReaction(bi.msg.messageId, bi.activeTurn.reactionId)
              .catch(() => {})
          }
        }
        const otherTurnsInFlight = this.host.sessions.markTurnFinished(sessionId)
        if (!otherTurnsInFlight && shouldDisposeEphemeral) {
          await this.host.sessions
            .disposeEphemeral(sessionId, trackedRouteKey, { archive: shouldArchiveEphemeral })
            .catch(() => {})
        }
        releaseTurnSlot?.()
      }
      untrackInflight()
    }
  }

  private async deliverRecoveredCompletedTurn(input: {
    readonly bot: LarkBotConfig | undefined
    readonly transport: LarkBotTransport
    readonly turn: LarkPendingTurn
    readonly peerTurns?: readonly LarkPendingTurn[]
    readonly groupConfig: LarkGroupConfig | undefined
    readonly replyText: string
    readonly missedIntermediates?: readonly string[]
    readonly silencedByTool: boolean
    readonly fromHotReload?: boolean
  }): Promise<void> {
    const {
      bot,
      transport,
      turn,
      peerTurns = [],
      groupConfig,
      replyText,
      missedIntermediates = [],
      silencedByTool,
      fromHotReload = false,
    } = input
    const effectiveSilencedByTool = silencedByTool && canSilenceTurnByControl(turn)
    const normalized = effectiveSilencedByTool
      ? ''
      : normalizeReplyText(replyText, { allowSilentSentinel: true })
    const isSilent = effectiveSilencedByTool || (turn.allowSilentEmptyReply && !normalized)
    if (turn.reactionId) {
      await transport.removeReaction(turn.messageId, turn.reactionId).catch(() => {})
    }
    for (const peer of peerTurns) {
      if (peer.reactionId) {
        await transport.removeReaction(peer.messageId, peer.reactionId).catch(() => {})
      }
    }
    const recoveredSender = this.hydrator.resolveTelemetrySender(
      turn.botId,
      transport,
      turn.inboundMsg,
      turn.senderName,
    )
    if (isSilent) {
      this.host.store.recordMetric({
        botId: turn.botId,
        chatId: turn.chatId,
        ...(turn.inboundMsg?.chatType ? { chatType: turn.inboundMsg.chatType } : {}),
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        trigger: turn.trigger,
        ...recoveredSender,
        kind: 'silent_skip',
      })
      this.host.store.recordEvent({
        botId: turn.botId,
        chatId: turn.chatId,
        ...(turn.chatName ? { chatName: turn.chatName } : {}),
        routeKey: turn.routeKey,
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
        ...(turn.traceId ? { traceId: turn.traceId } : {}),
        kind: 'silent_skip',
        summary: fromHotReload ? '热更新期间后台会话已静默完成' : '服务重启后检测到原回合已静默完成',
      })
      return
    }

    const sendIntermediateEnabled = Boolean(
      bot &&
        (groupConfig?.intermediateMessages === 'on'
          ? true
          : groupConfig?.intermediateMessages === 'off'
            ? false
            : bot.sendIntermediateMessages),
    )
    let sentMissedIntermediates = 0
    if (sendIntermediateEnabled && missedIntermediates.length > 0 && bot) {
      const cardBot = resolveEffectiveCardBot(bot, groupConfig)
      for (const part of missedIntermediates) {
        const cleanPart = normalizeReplyText(part, { allowSilentSentinel: true })
        if (!cleanPart) continue
        const card =
          cardBot.useInteractiveCard && turn.sessionId
            ? buildReplyCard({
                markdown: cleanPart,
                bot: cardBot,
                sessionUrl: this.host.sessionWebUrl(turn.sessionId),
              })
            : undefined
        await transport
          .sendReply({
            chatId: turn.chatId,
            replyToMessageId: turn.messageId,
            replyMode: turn.replyMode,
            ...(card ? { card } : { text: cleanPart }),
          })
          .then(() => {
            sentMissedIntermediates += 1
          })
          .catch(() => {})
      }
    }

    const text = normalized || (sentMissedIntermediates > 0 ? '' : '（已完成，无文本输出）')
    if (text) {
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
    }
    this.host.store.markBindingReplied(turn.routeKey)
    this.host.store.recordMetric({
      botId: turn.botId,
      chatId: turn.chatId,
      ...(turn.inboundMsg?.chatType ? { chatType: turn.inboundMsg.chatType } : {}),
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      trigger: turn.trigger,
      ...recoveredSender,
      ...(turn.chatName ? { chatName: turn.chatName } : {}),
      kind: 'replied',
      latencyMs: Date.now() - turn.startedAtMs,
    })
    const prefix = fromHotReload
      ? '热更新期间后台会话已完成，已无损续传补发'
      : '服务重启后检测到原回合已完成，已补发回复'
    this.host.store.recordEvent({
      botId: turn.botId,
      chatId: turn.chatId,
      ...(turn.chatName ? { chatName: turn.chatName } : {}),
      routeKey: turn.routeKey,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      ...(turn.traceId ? { traceId: turn.traceId } : {}),
      durationMs: Date.now() - turn.startedAtMs,
      kind: 'reply',
      summary:
        sentMissedIntermediates > 0
          ? `${prefix}（${sentMissedIntermediates} 条过程消息${text ? ` + 最终回复 ${text.length} 字` : ''}）`
          : `${prefix}（${text.length} 字）`,
    })
  }
}
