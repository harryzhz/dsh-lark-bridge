import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  isGroupEnabled,
  type GroupReplyMode,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotTransport,
  type LarkGroupConfig,
  type RecalledLarkMessageEvent,
  type RouterHandoffTurn,
  type TriageActiveListenerSummary,
} from '@dsh-lark/lark-core'
import type { BotConnectionPool } from '../bot-connection-pool.js'
import type { IssuedConsoleLoginLink } from '../console-login.js'
import { closeOrphanCotBubble, type TurnCotController } from '../cot-stream-controller.js'
import type { ListenerDebounceBuffer } from '../listener-debounce.js'
import type { ImageRefTarget, InboundMediaCache, PrefetchedQuotedMessage } from '../media-intake.js'
import type { MemoryService } from '../memory-service.js'
import type { RuntimeCatalog } from '../runtime-catalog.js'
import type { RuntimeConcurrencyLimiter } from '../runtime-concurrency.js'
import type { AgentDecision, SessionCoordinator } from '../session-coordinator.js'
import type { SessionTitleGuard } from '../session-title-guard.js'
import type { LarkBridgeStore } from '../store.js'
import type { LlmTriageService } from '../triage-service.js'
import { canAutoResumePendingTurn } from '../turn-recovery.js'
import { TurnAbortedError } from '../turn-runner.js'
import type {
  ActiveTurnSummary,
  LarkPendingTurn,
  PendingTurnInterruptKind,
  PendingTurnStatus,
} from '../types.js'

const ACTIVE_TURN_HEARTBEAT_PERSIST_INTERVAL_MS = 15_000
const RECALLED_MESSAGE_TTL_MS = 10 * 60_000
const MAX_RECALLED_MESSAGES = 2_000

export type DisableCancelScope = 'group' | 'bot'

export function createTraceId(): string {
  return `tr_${randomBytes(4).toString('hex')}`
}

export function createRecalledAbortError(): TurnAbortedError {
  return new TurnAbortedError('recalled', '原消息已撤回，已取消当前轮次并停止执行')
}

export function createDisabledAbortError(scope: DisableCancelScope): TurnAbortedError {
  return new TurnAbortedError(
    'disabled',
    scope === 'bot'
      ? '智能体已停用，已取消当前轮次并停止执行'
      : '群聊响应开关已关闭，已取消当前轮次并停止执行',
  )
}

export function disabledCancelSummary(scope: DisableCancelScope, suffix: string): string {
  return `${scope === 'bot' ? '智能体已停用' : '群聊响应开关已关闭'}，${suffix}`
}

export function canSilenceTurnByControl(
  turn: Pick<ActiveTurnRecord, 'allowSilentEmptyReply' | 'trigger'>,
): boolean {
  return turn.allowSilentEmptyReply || turn.trigger === 'active-thread'
}

export function isEligibleForNativeCot(decision: AgentDecision): boolean {
  return (
    Boolean(decision.cotEnabled) &&
    !decision.silentOnly &&
    !decision.allowSilentEmptyReply
  )
}

export interface InflightCancelEntry {
  readonly botId: string
  readonly chatId: string
  readonly chatType: string
  readonly messageId: string
  readonly controller: AbortController
}

export function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
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

export interface ExecutingTurnContext {
  readonly botId: string
  readonly larkAppId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly chatName?: string
  readonly workingDir?: string
  routeKey: string
  readonly messageId: string
  rootId?: string
  threadId?: string
  readonly replyMode: GroupReplyMode
  replyToMessageId?: string
  replyInThread: boolean
}

export function buildExecutingTurnContext(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  decision: AgentDecision,
  chatName?: string,
): ExecutingTurnContext {
  const chatType: 'p2p' | 'group' = msg.chatType === 'p2p' ? 'p2p' : 'group'
  let replyToMessageId: string | undefined
  let replyInThread = false
  if (chatType === 'group') {
    if (msg.threadId) {
      replyToMessageId = msg.rootId ?? msg.messageId
      replyInThread = true
    } else if (decision.replyMode === 'new-topic') {
      replyToMessageId = msg.messageId
      replyInThread = true
    } else if (decision.replyMode === 'reply') {
      replyToMessageId = msg.messageId
      replyInThread = false
    }
  }
  return {
    botId: bot.id,
    larkAppId: bot.larkAppId,
    chatId: msg.chatId,
    chatType,
    ...(chatName ? { chatName } : {}),
    ...(decision.workingDir ? { workingDir: decision.workingDir } : {}),
    routeKey: decision.routeKey,
    messageId: msg.messageId,
    ...(msg.rootId ? { rootId: msg.rootId } : {}),
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    replyMode: decision.replyMode,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    replyInThread,
  }
}

export interface ActiveTurnRecord {
  readonly id: string
  readonly traceId: string
  readonly botId: string
  readonly chatId: string
  readonly chatName?: string
  readonly messageId: string
  routeKey: string
  readonly replyMode: GroupReplyMode
  readonly trigger: string
  readonly allowSilentEmptyReply: boolean
  readonly silentOnly?: boolean
  readonly reactionId?: string
  readonly startedAtMs: number
  readonly transport: LarkBotTransport
  readonly inboundMsg?: InboundLarkMessage
  readonly senderName?: string
  readonly cancelController?: AbortController
  handoffTurns?: readonly RouterHandoffTurn[]
  sessionId?: string
  targetTurn?: number
  userMessageId?: string
  lastEventSeq?: number
  cotId?: string
  cotMessageId?: string
  cotController?: TurnCotController
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
  cancelledByDisable?: DisableCancelScope
  settled: boolean
  reactionRemoved: boolean
}

export interface InboundPipelineHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly connections: BotConnectionPool
  readonly sessions: SessionCoordinator
  readonly runtimeLimiter?: RuntimeConcurrencyLimiter
  readonly listenerDebounceEnabled?: boolean
  readonly listenerDebounceOverrideMs?: number
  readonly memory?: MemoryService
  readonly triage?: LlmTriageService
  readonly titleGuard: SessionTitleGuard
  readonly shutdownSignal: AbortSignal
  readonly isDisposed: () => boolean
  readonly isDraining?: () => boolean
  readonly onActivityChange?: () => void
  readonly onTriageRecorded?: (input: {
    readonly botId: string
    readonly chatId: string
    readonly chatType?: 'group' | 'p2p'
    readonly triageSessionId?: string
    readonly traceId?: string
    readonly senderOpenId?: string
    readonly senderUnionId?: string
    readonly senderName?: string
    readonly senderType?: 'user' | 'bot'
    readonly action: 'silent' | 'quick_reply' | 'handoff'
    readonly fallback?: boolean
    readonly errorCode?: string
    readonly provider?: string
    readonly model?: string
    readonly durationMs: number
    readonly usage?: import('@deepseek-ai/dsh-llm').TokenUsage
  }) => void
  readonly sessionWebUrl: (sessionId: string) => string
  readonly issueConsoleLoginLink?: (input: {
    readonly botId: string
    readonly botName: string
    readonly adminOpenId: string
  }) => IssuedConsoleLoginLink | undefined
}

export interface RecoveryRunContext {
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

export interface QueuedWorkerTurnItem {
  readonly msg: InboundLarkMessage
  readonly decision: AgentDecision
  readonly activeTurn: ActiveTurnRecord
  readonly cancelController: AbortController
  readonly mediaCache: InboundMediaCache
  readonly extraImageTargets?: readonly ImageRefTarget[]
  readonly prefetchedQuote?: PrefetchedQuotedMessage
  readonly traceId: string
  readonly senderName?: string
  readonly handoffTurns?: readonly RouterHandoffTurn[]
  readonly triageNote?: string
  readonly recoveryReminder?: string
}

export interface DebouncedInboundItem {
  readonly bot: LarkBotConfig
  readonly transport: LarkBotTransport
  readonly msg: InboundLarkMessage
  readonly decision: AgentDecision
  readonly groupConfig: LarkGroupConfig | undefined
  readonly traceId: string
  readonly receivedAtMs: number
}

export interface DebouncedTurnRunOptions {
  readonly extraImageTargets?: readonly ImageRefTarget[]
  readonly debouncedCount?: number
  readonly startedAtMs?: number
}

export function composeDebouncedListenerUserText(
  items: ReadonlyArray<{
    readonly messageId: string
    readonly senderName?: string
    readonly senderOpenId?: string
    readonly text: string
  }>,
): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]!.text
  const lines = [`以下 ${items.length} 条群内连续消息在短时间内相继到达，请结合上下文统一判断并处理：`]
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    const who = item.senderName || item.senderOpenId || '成员'
    lines.push(`[${i + 1}] ${who} (message_id="${item.messageId}"): ${item.text || '[空消息]'}`)
  }
  return lines.join('\n')
}

export async function closePendingTurnOrphanCot(
  transport: LarkBotTransport | undefined,
  turn: Pick<LarkPendingTurn, 'cotId' | 'cotMessageId'>,
  reason: 'done' | 'error',
  notice?: string,
): Promise<void> {
  if (!transport || !turn.cotId || !turn.cotMessageId) return
  await closeOrphanCotBubble(transport, {
    cotId: turn.cotId,
    messageId: turn.cotMessageId,
    reason,
    ...(notice ? { notice } : {}),
  })
}

/**
 * Layer-0 shared turn state registry & cancellation control plane.
 * Owns `activeTurns`, `executingTurnBySession`, `recalledMessages`, and
 * `inflightCancels` so execution, triage, reply delivery, and recovery
 * collaborators stay acyclic.
 */
export class TurnStateRegistry {
  readonly activeTurns = new Map<string, ActiveTurnRecord>()
  readonly executingTurnBySession = new Map<string, ExecutingTurnContext>()
  private readonly recalledMessages = new Map<string, number>()
  private readonly inflightCancels = new Set<InflightCancelEntry>()

  constructor(private readonly host: InboundPipelineHost) {}

  getExecutingTurnContext(sessionId: string): ExecutingTurnContext | undefined {
    const sid = sessionId.trim()
    return sid ? this.executingTurnBySession.get(sid) : undefined
  }

  countActiveUnsettled(): number {
    let active = 0
    for (const turn of this.activeTurns.values()) {
      if (!turn.settled) active += 1
    }
    return active
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

  markSessionTurnSilent(
    sessionId: string,
    reason?: string,
  ): { readonly matched: boolean; readonly turnId?: string; readonly allowSilent: boolean } {
    const sid = sessionId.trim()
    if (!sid) return { matched: false, allowSilent: false }
    const matching: ActiveTurnRecord[] = []
    for (const turn of this.activeTurns.values()) {
      if (turn.settled || turn.sessionId !== sid) continue
      matching.push(turn)
    }
    if (matching.length === 0) return { matched: false, allowSilent: false }
    const first = matching[0]!
    if (matching.some((turn) => !canSilenceTurnByControl(turn))) {
      return { matched: true, turnId: first.id, allowSilent: false }
    }
    const trimmedReason = reason?.trim()
    for (const turn of matching) {
      turn.silencedByControl = true
      if (trimmedReason) turn.silenceReason = trimmedReason
    }
    return { matched: true, turnId: first.id, allowSilent: true }
  }

  listActiveChatListeners(
    botId: string,
    chatId: string,
    excludeMessageId: string,
    nowMs = Date.now(),
  ): TriageActiveListenerSummary[] {
    const out: Array<TriageActiveListenerSummary & { readonly startedAtMs: number }> = []
    for (const turn of this.activeTurns.values()) {
      if (turn.settled) continue
      if (turn.botId !== botId || turn.chatId !== chatId) continue
      if (turn.trigger !== 'listener') continue
      if (turn.messageId === excludeMessageId) continue
      const rawPreview =
        turn.inboundMsg?.text?.trim() ||
        (turn.inboundMsg && turn.inboundMsg.imageKeys.length > 0 ? '[图片消息]' : '[监听消息]')
      const cleanPreview = rawPreview.replace(/\s+/g, ' ').trim()
      out.push({
        ...(turn.senderName ? { senderName: turn.senderName } : {}),
        preview: cleanPreview.length > 80 ? `${cleanPreview.slice(0, 80)}…` : cleanPreview,
        elapsedSec: Math.max(0, Math.round((nowMs - turn.startedAtMs) / 1000)),
        startedAtMs: turn.startedAtMs,
      })
    }
    return out
      .sort((a, b) => b.startedAtMs - a.startedAtMs)
      .slice(0, 3)
      .map(({ startedAtMs: _ignore, ...rest }) => rest)
  }

  private recallKey(botId: string, messageId: string): string {
    return `${botId}:${messageId}`
  }

  isMessageRecalled(botId: string, messageId: string, nowMs = Date.now()): boolean {
    const key = this.recallKey(botId, messageId)
    const ts = this.recalledMessages.get(key)
    if (ts === undefined) return false
    if (nowMs - ts > RECALLED_MESSAGE_TTL_MS) {
      this.recalledMessages.delete(key)
      return false
    }
    return true
  }

  markMessageRecalled(botId: string, messageId: string, nowMs = Date.now()): boolean {
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

  trackInflightController(
    botId: string,
    chatId: string,
    chatType: string,
    messageId: string,
    controller: AbortController,
  ): () => void {
    const entry: InflightCancelEntry = { botId, chatId, chatType, messageId, controller }
    this.inflightCancels.add(entry)
    return () => {
      this.inflightCancels.delete(entry)
    }
  }

  getDisabledScope(
    botId: string,
    chatType: string,
    chatId: string,
  ): DisableCancelScope | undefined {
    const currentBot = this.host.store.getBot(botId)
    if (!currentBot || !currentBot.enabled) return 'bot'
    if (chatType === 'group') {
      const currentGroup = this.host.store.getGroup(botId, chatId)
      if (!isGroupEnabled(currentBot, currentGroup)) return 'group'
    }
    return undefined
  }

  isSignalDisabled(signal?: AbortSignal): boolean {
    return Boolean(
      signal?.aborted &&
        signal.reason instanceof TurnAbortedError &&
        signal.reason.kind === 'disabled',
    )
  }

  getTurnDisabledScope(
    botId: string,
    item: Pick<QueuedWorkerTurnItem, 'msg' | 'activeTurn'>,
  ): DisableCancelScope | undefined {
    return (
      item.activeTurn.cancelledByDisable ??
      this.getDisabledScope(botId, item.msg.chatType, item.msg.chatId)
    )
  }

  getBatchDisabledScope(
    botId: string,
    items: readonly Pick<QueuedWorkerTurnItem, 'msg' | 'activeTurn'>[],
  ): DisableCancelScope | undefined {
    for (const item of items) {
      const scope = this.getTurnDisabledScope(botId, item)
      if (scope) return scope
    }
    return undefined
  }

  isTurnRecalled(
    botId: string,
    item: Pick<QueuedWorkerTurnItem, 'msg' | 'activeTurn' | 'cancelController'>,
  ): boolean {
    if (item.activeTurn.cancelledByRecall || this.isMessageRecalled(botId, item.msg.messageId)) {
      return true
    }
    return (
      item.cancelController.signal.aborted &&
      !item.activeTurn.cancelledByDisable &&
      !this.isSignalDisabled(item.cancelController.signal)
    )
  }

  /**
   * Links per-item cancel controllers of a coalesced batch into a single batch
   * cancel signal: any disable abort fires immediately, whereas recall only
   * aborts when every member in the batch has been recalled.
   */
  createBatchCancelBinding(
    botId: string,
    getBatchItems: () => readonly QueuedWorkerTurnItem[],
  ): { readonly signal: AbortSignal; readonly dispose: () => void } {
    const batchCancelController = new AbortController()
    const cancelListeners: Array<{ readonly signal: AbortSignal; readonly fn: () => void }> = []
    const evaluate = (source: AbortSignal) => {
      if (batchCancelController.signal.aborted) return
      if (this.isSignalDisabled(source)) {
        batchCancelController.abort(source.reason)
        return
      }
      if (getBatchItems().every((i) => this.isTurnRecalled(botId, i))) {
        batchCancelController.abort(source.reason)
      }
    }
    for (const item of getBatchItems()) {
      const sig = item.cancelController.signal
      if (sig.aborted) {
        evaluate(sig)
      } else {
        const fn = () => evaluate(sig)
        sig.addEventListener('abort', fn, { once: true })
        cancelListeners.push({ signal: sig, fn })
      }
    }
    return {
      signal: batchCancelController.signal,
      dispose: () => {
        for (const entry of cancelListeners) {
          entry.signal.removeEventListener('abort', entry.fn)
        }
        cancelListeners.length = 0
      },
    }
  }

  cancelDisabledTurns(
    botId: string,
    chatId: string | undefined,
    listenerDebounce: ListenerDebounceBuffer<DebouncedInboundItem>,
  ): number {
    if (this.host.isDisposed()) return 0
    const normalizedBotId = botId.trim()
    const normalizedChatId = chatId?.trim() || undefined
    if (!normalizedBotId) return 0

    let cancelled = 0
    const abortedControllers = new Set<AbortController>()

    const droppedDebounced = listenerDebounce.cancelScope(normalizedBotId, normalizedChatId)
    if (droppedDebounced > 0) {
      cancelled += droppedDebounced
      this.host.onActivityChange?.()
    }

    for (const turn of this.activeTurns.values()) {
      if (turn.settled || turn.botId !== normalizedBotId) continue
      if (normalizedChatId && turn.chatId !== normalizedChatId) continue
      const chatType = turn.inboundMsg?.chatType ?? (turn.trigger === 'p2p' ? 'p2p' : 'group')
      const scope = this.getDisabledScope(turn.botId, chatType, turn.chatId)
      if (!scope) continue
      turn.cancelledByDisable = scope
      cancelled += 1
      if (turn.cancelController && !turn.cancelController.signal.aborted) {
        abortedControllers.add(turn.cancelController)
        turn.cancelController.abort(createDisabledAbortError(scope))
      }
    }

    for (const entry of [...this.inflightCancels]) {
      if (entry.botId !== normalizedBotId) continue
      if (normalizedChatId && entry.chatId !== normalizedChatId) continue
      if (abortedControllers.has(entry.controller) || entry.controller.signal.aborted) continue
      const scope = this.getDisabledScope(entry.botId, entry.chatType, entry.chatId)
      if (!scope) continue
      cancelled += 1
      abortedControllers.add(entry.controller)
      entry.controller.abort(createDisabledAbortError(scope))
    }

    const activeTurnIds = new Set(this.activeTurns.keys())
    const transport = this.host.connections.getTransport(normalizedBotId)
    for (const pending of this.host.store.listPendingTurns()) {
      if (pending.botId !== normalizedBotId) continue
      if (normalizedChatId && pending.chatId !== normalizedChatId) continue
      if (activeTurnIds.has(pending.id)) continue
      const chatType = pending.inboundMsg?.chatType ?? (pending.trigger === 'p2p' ? 'p2p' : 'group')
      const scope = this.getDisabledScope(pending.botId, chatType, pending.chatId)
      if (!scope) continue
      cancelled += 1
      this.host.store.deletePendingTurn(pending.id)
      if (pending.reactionId && transport) {
        void transport.removeReaction(pending.messageId, pending.reactionId).catch(() => {})
      }
      if (pending.cotId && pending.cotMessageId && transport) {
        void closePendingTurnOrphanCot(
          transport,
          pending,
          'error',
          disabledCancelSummary(scope, '已取消执行'),
        )
      }
      this.host.store.recordEvent({
        botId: pending.botId,
        chatId: pending.chatId,
        ...(pending.chatName ? { chatName: pending.chatName } : {}),
        routeKey: pending.routeKey,
        ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
        ...(pending.traceId ? { traceId: pending.traceId } : {}),
        kind: 'lifecycle',
        summary: disabledCancelSummary(scope, '已取消待恢复轮次'),
      })
    }

    if (cancelled > 0) {
      this.host.ctx.logger.info(
        `[lark-bridge][bot=${normalizedBotId}]${normalizedChatId ? `[chat=${normalizedChatId}]` : ''} scope disabled; cancelled ${cancelled} in-flight/queued turn(s)`,
      )
    }
    return cancelled
  }

  handleMessageRecalled(
    botId: string,
    transport: LarkBotTransport,
    event: RecalledLarkMessageEvent,
    listenerDebounce: ListenerDebounceBuffer<DebouncedInboundItem>,
  ): void {
    if (this.host.isDisposed()) return
    if (!this.host.connections.isActiveTransport(botId, transport)) return
    const messageId = event.messageId.trim()
    if (!messageId) return

    const firstSeen = this.markMessageRecalled(botId, messageId)
    this.host.triage?.context.removeMessage(messageId)
    if (!firstSeen) return

    const reason = createRecalledAbortError()
    let matchedAny = false

    if (listenerDebounce.cancelMessage(botId, messageId)) {
      matchedAny = true
      this.host.onActivityChange?.()
      this.host.store.recordEvent({
        botId,
        chatId: event.chatId,
        kind: 'lifecycle',
        summary: '原消息已撤回，已取消防抖缓冲中的监听消息',
      })
    }

    for (const turn of this.activeTurns.values()) {
      if (turn.settled || turn.botId !== botId || turn.messageId !== messageId) continue
      matchedAny = true
      turn.cancelledByRecall = true
      turn.reactionRemoved = true
      if (turn.cancelController && !turn.cancelController.signal.aborted) {
        turn.cancelController.abort(reason)
      }
    }

    for (const entry of [...this.inflightCancels]) {
      if (entry.botId !== botId || entry.messageId !== messageId) continue
      matchedAny = true
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(reason)
      }
    }

    const activeTurnIds = new Set(this.activeTurns.keys())
    for (const pending of this.host.store.listPendingTurns()) {
      if (pending.botId !== botId || pending.messageId !== messageId) continue
      if (activeTurnIds.has(pending.id)) continue
      matchedAny = true
      this.host.store.deletePendingTurn(pending.id)
      if (pending.cotId && pending.cotMessageId) {
        void closePendingTurnOrphanCot(
          transport,
          pending,
          'error',
          '原消息已撤回，已取消执行',
        )
      }
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

  touchActiveTurnActivity(record: ActiveTurnRecord, nowMs = Date.now()): void {
    if (record.settled || this.host.isDisposed()) return
    record.lastActivityAtMs = nowMs
    if (nowMs - record.lastPersistedActivityAtMs >= ACTIVE_TURN_HEARTBEAT_PERSIST_INTERVAL_MS) {
      record.lastPersistedActivityAtMs = nowMs
      this.persistActiveTurn(record)
    }
  }

  settleDisabledTurn(
    record: ActiveTurnRecord,
    scope: DisableCancelScope,
    summary: string,
  ): void {
    record.cancelledByDisable = scope
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

  settleRecalledTurn(record: ActiveTurnRecord, summary: string): void {
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

  suspendSingleTurnForRestart(
    record: ActiveTurnRecord,
    nowMs = Date.now(),
    options: { readonly preserveLiveAgents?: boolean } = {},
  ): void {
    if (record.settled) return
    const preserveLiveAgents = Boolean(options.preserveLiveAgents)
    record.settled = true
    record.reactionRemoved = true
    record.status = 'interrupted'
    record.interruptedAtMs = nowMs
    record.interruptKind = preserveLiveAgents ? 'hot_reload' : 'graceful_shutdown'
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
      summary: preserveLiveAgents
        ? '飞书桥接热更新切包，已保持后台会话运行，重载后自动续传'
        : '服务重载或停机，已保存处理中任务待重启自动恢复',
    })
    this.host.onActivityChange?.()
  }

  registerActiveTurn(
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

  persistActiveTurn(
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
      ...(record.targetTurn !== undefined ? { targetTurn: record.targetTurn } : {}),
      ...(record.userMessageId ? { userMessageId: record.userMessageId } : {}),
      ...(record.lastEventSeq !== undefined ? { lastEventSeq: record.lastEventSeq } : {}),
      ...(record.cotId ? { cotId: record.cotId } : {}),
      ...(record.cotMessageId ? { cotMessageId: record.cotMessageId } : {}),
      updatedAtMs: Date.now(),
    })
  }

  claimActiveTurn(record: ActiveTurnRecord): boolean {
    if (record.settled) return false
    record.settled = true
    this.activeTurns.delete(record.id)
    this.host.store.deletePendingTurn(record.id)
    this.host.onActivityChange?.()
    return true
  }

  /**
   * Settles queued turns that were orphaned or abandoned while waiting for a
   * coalesced session slot, returning true if any item was cancelled by disable
   * or message recall.
   */
  settleAbandonedQueueItems(
    botId: string,
    items: readonly QueuedWorkerTurnItem[],
    mode: 'orphaned' | 'abandoned',
    nowMs = Date.now(),
  ): boolean {
    let anyCancelled = false
    const disableSuffix = mode === 'orphaned' ? '已取消排队轮次' : '已从合并队列移除'
    const recallSummary =
      mode === 'orphaned' ? '原消息已撤回，已取消排队轮次' : '原消息已撤回，已从合并队列移除'
    for (const item of items) {
      const disabledScope = this.getTurnDisabledScope(botId, item)
      if (disabledScope) {
        anyCancelled = true
        this.settleDisabledTurn(
          item.activeTurn,
          disabledScope,
          disabledCancelSummary(disabledScope, disableSuffix),
        )
      } else if (this.isTurnRecalled(botId, item)) {
        anyCancelled = true
        this.settleRecalledTurn(item.activeTurn, recallSummary)
      } else if (
        mode === 'orphaned' &&
        this.host.isDisposed() &&
        canAutoResumePendingTurn(item.activeTurn, nowMs, { phase: 'shutdown' })
      ) {
        this.suspendSingleTurnForRestart(item.activeTurn, nowMs)
      } else {
        this.claimActiveTurn(item.activeTurn)
      }
    }
    return anyCancelled
  }

  /**
   * Filters recalled items out of an active coalesced batch, settling any
   * recalled items in-place. Returns `{ allRecalled: true }` when no surviving
   * items remain.
   */
  pruneRecalledBatchItems(
    botId: string,
    items: readonly QueuedWorkerTurnItem[],
  ): { readonly allRecalled: boolean; readonly surviving: readonly QueuedWorkerTurnItem[] } {
    const recalled: QueuedWorkerTurnItem[] = []
    const surviving: QueuedWorkerTurnItem[] = []
    for (const item of items) {
      if (this.isTurnRecalled(botId, item)) {
        recalled.push(item)
      } else {
        surviving.push(item)
      }
    }
    if (recalled.length === 0) return { allRecalled: false, surviving: items }
    if (surviving.length === 0) return { allRecalled: true, surviving: [] }
    for (const item of recalled) {
      this.settleRecalledTurn(item.activeTurn, '原消息已撤回，已从合并批次移除')
    }
    return { allRecalled: false, surviving }
  }
}
