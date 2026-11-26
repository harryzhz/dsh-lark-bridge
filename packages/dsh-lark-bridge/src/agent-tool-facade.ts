import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  buildLarkPostPayload,
  buildReplyCard,
  buildRouteKey,
  expandWorkingDir,
  formatReminderOutputWithMentions,
  resolveEffectiveAgentRuntime,
  resolveEffectiveCardBot,
  resolveEffectiveWorkingDir,
  trimInvisibleText,
  type LarkBotStatus,
  type LarkHistoryMessage,
  type LarkMessageDetail,
  type LarkReminderItem,
  type LarkReminderOrigin,
  type ReplyCardImage,
} from '@dsh-lark/lark-core'
import type { BotConnectionPool } from './bot-connection-pool.js'
import type { InboundPipeline } from './inbound-pipeline.js'
import type { ProactiveReminderService } from './reminder-service.js'
import type { ScheduleCreateInputLike, ScheduleNotifier } from './schedule-notifier.js'
import type { SessionCoordinator } from './session-coordinator.js'
import type { LarkBridgeStore } from './store.js'
import type {
  LarkScheduleDeliveryMode,
  LarkScheduleNotifyOn,
  LarkScheduleTarget,
  LarkSessionBinding,
} from './types.js'

export class SessionIdentityError extends Error {
  readonly code: 'session_identity_mismatch' | 'unresolved_session_context'
  readonly status: number

  constructor(
    code: 'session_identity_mismatch' | 'unresolved_session_context',
    message: string,
    status: number,
  ) {
    super(message)
    this.name = 'SessionIdentityError'
    this.code = code
    this.status = status
  }
}

export interface ResolvedCliSessionIdentity {
  readonly canonicalSessionId?: string
  readonly provided: boolean
  readonly unresolved: boolean
  readonly rawSessionId?: string
  readonly externalSessionId?: string
}

export interface AgentCliSendInput {
  readonly sessionId?: string
  readonly externalSessionId?: string
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
  readonly images?: readonly {
    fileName?: string
    dataBase64: string
    alt?: string
    mode?: ReplyCardImage['mode']
  }[]
  readonly files?: readonly { fileName: string; dataBase64: string }[]
}

export interface AgentToolFacadeHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly connections: BotConnectionPool
  readonly sessions: SessionCoordinator
  readonly inbound: InboundPipeline
  readonly getSchedules: () => ScheduleNotifier
  readonly getReminders: () => ProactiveReminderService
  readonly sessionWebUrl: (sessionId: string) => string
  readonly resolveExternalSessionId?: (externalId: string) => string | undefined
}

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
 * Serves `lark-bridge` CLI / HTTP agent endpoints and proactive outbound delivery
 * for scheduled jobs and reminders.
 */
export class AgentToolFacade {
  constructor(private readonly host: AgentToolFacadeHost) {}

  /**
   * Normalize CLI-supplied session identifiers, translating `ext:<externalId>`
   * tokens (emitted by multiplexed external runtimes) into canonical DSH
   * `sessionId` values via `externalRuntimes` / durable SQLite index.
   */
  canonicalizeSessionId(rawSessionId?: string): string | undefined {
    const trimmed = rawSessionId?.trim()
    if (!trimmed) return undefined
    if (trimmed.startsWith('ext:')) {
      const externalId = trimmed.slice(4).trim()
      if (!externalId) return undefined
      return this.host.resolveExternalSessionId?.(externalId)
    }
    return trimmed
  }

  /**
   * Resolve and cross-validate CLI session identity (`DSH_SESSION_ID` / `ext:<id>`
   * vs ambient `ANTIGRAVITY_CONVERSATION_ID` header). Fails closed with HTTP 409
   * when both identities resolve to different canonical DSH sessions so cross-process
   * environment hijacks can never route messages or writes into another conversation.
   */
  resolveCliSessionIdentity(
    rawSessionId?: string,
    externalSessionId?: string,
  ): ResolvedCliSessionIdentity {
    const trimmedRaw = rawSessionId?.trim() || undefined
    const trimmedExtHeader = externalSessionId?.trim() || undefined
    const provided = Boolean(trimmedRaw || trimmedExtHeader)
    if (!provided) {
      return { provided: false, unresolved: false }
    }

    const effectiveRaw = trimmedRaw ?? `ext:${trimmedExtHeader!}`
    let primaryCanonical: string | undefined
    let rawExtToken: string | undefined
    if (trimmedRaw) {
      if (trimmedRaw.startsWith('ext:')) {
        rawExtToken = trimmedRaw.slice(4).trim() || undefined
        primaryCanonical = rawExtToken
          ? this.host.resolveExternalSessionId?.(rawExtToken)
          : undefined
      } else {
        primaryCanonical = trimmedRaw
      }
    }

    const extCanonical = trimmedExtHeader
      ? trimmedExtHeader === rawExtToken
        ? primaryCanonical
        : this.host.resolveExternalSessionId?.(trimmedExtHeader)
      : undefined

    if (primaryCanonical && extCanonical && primaryCanonical !== extCanonical) {
      const boundBotId =
        this.host.store.getBindingBySessionId?.(primaryCanonical)?.botId ??
        this.host.store.getBindingBySessionId?.(extCanonical)?.botId ??
        'system'
      this.host.store.recordEvent?.({
        botId: boundBotId,
        sessionId: primaryCanonical,
        kind: 'error',
        summary: `拦截到会话身份冲突（防串路）：sessionId=${primaryCanonical} 与外部会话 ${trimmedExtHeader}（归属 ${extCanonical}）不一致`,
      })
      throw new SessionIdentityError(
        'session_identity_mismatch',
        `会话身份冲突（防串路已拦截）：当前环境 sessionId (${primaryCanonical}) 与外部运行时会话 (${trimmedExtHeader} -> ${extCanonical}) 不一致，已拒绝执行`,
        409,
      )
    }

    const canonicalSessionId = primaryCanonical ?? extCanonical
    return {
      ...(canonicalSessionId ? { canonicalSessionId } : {}),
      provided: true,
      unresolved: !canonicalSessionId,
      rawSessionId: effectiveRaw,
      ...(trimmedExtHeader ? { externalSessionId: trimmedExtHeader } : {}),
    }
  }

  resolveAgentContext(sessionId?: string, externalSessionId?: string): {
    readonly sessionId?: string
    readonly unresolvedSessionId?: string
    readonly bound: boolean
    readonly source?: 'session_binding' | 'schedule_session' | 'reminder_session' | 'default_bot'
    readonly botId?: string
    readonly botName?: string
    readonly larkAppId?: string
    readonly botOpenId?: string
    readonly chatId?: string
    readonly chatName?: string
    readonly workingDir?: string
    readonly routeKey?: string
    readonly replyToMessageId?: string
    readonly replyInThread?: boolean
    readonly threadId?: string
    readonly scheduleContext?: ReturnType<ScheduleNotifier['getActiveSessionContext']>
    readonly bots: readonly LarkBotStatus[]
    readonly groups: ReturnType<LarkBridgeStore['listGroupViews']>
  } {
    const bots = this.host.connections.listBotStatuses()
    const groups = this.host.store.listGroupViews()
    const identity = this.resolveCliSessionIdentity(sessionId, externalSessionId)
    const sid = identity.canonicalSessionId

    if (sid) {
      // Ground truth during an active interactive turn: anchor CLI sends/history/reminders
      // to the exact currently executing turn rather than guessing from static binding aliases.
      const executingTurn = this.host.inbound.getExecutingTurnContext?.(sid)
      if (executingTurn) {
        const bot = this.host.store.getBot(executingTurn.botId)
        const botStatus = bots.find((b) => b.botId === executingTurn.botId)
        const chatName =
          executingTurn.chatName ||
          this.host.store.resolveChatName(executingTurn.botId, executingTurn.chatId)
        const workingDir = this.resolveContextWorkingDir(
          executingTurn.botId,
          executingTurn.chatId,
          executingTurn.workingDir,
        )
        return {
          sessionId: sid,
          bound: true,
          source: 'session_binding',
          botId: executingTurn.botId,
          botName: bot?.name ?? executingTurn.botId,
          larkAppId: bot?.larkAppId ?? executingTurn.larkAppId,
          ...(botStatus?.botOpenId ? { botOpenId: botStatus.botOpenId } : {}),
          chatId: executingTurn.chatId,
          ...(chatName ? { chatName } : {}),
          ...(workingDir ? { workingDir } : {}),
          routeKey: executingTurn.routeKey,
          ...(executingTurn.replyToMessageId
            ? { replyToMessageId: executingTurn.replyToMessageId }
            : {}),
          replyInThread: executingTurn.replyInThread,
          ...(executingTurn.threadId ? { threadId: executingTurn.threadId } : {}),
          bots,
          groups,
        }
      }

      const binding = this.host.store.listBindings().find((b) => b.sessionId === sid)
      if (binding) {
        const botStatus = bots.find((b) => b.botId === binding.botId)
        const replyToMessageId = extractBindingReplyAnchor(binding)
        const threadAlias = (binding.aliasRouteKeys ?? [])
          .map((k) => k.split(':').slice(2).join(':'))
          .find((scope) => scope.startsWith('omt_'))
        const workingDir = this.resolveContextWorkingDir(
          binding.botId,
          binding.chatId,
          binding.workingDir,
        )
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
          ...(workingDir ? { workingDir } : {}),
          routeKey: binding.routeKey,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(replyToMessageId ? { replyInThread: true } : {}),
          ...(threadAlias ? { threadId: threadAlias } : {}),
          bots,
          groups,
        }
      }

      const reminder = this.host.store.listReminders('all').find((r) => r.lastSessionId === sid)
      if (reminder) {
        const bot = this.host.store.getBot(reminder.origin.botId)
        const botStatus = bots.find((b) => b.botId === reminder.origin.botId)
        const chatId = reminder.origin.chatId
        const chatName =
          reminder.origin.chatName ||
          (chatId ? this.host.store.resolveChatName(reminder.origin.botId, chatId) : undefined)
        const workingDir = this.resolveContextWorkingDir(
          reminder.origin.botId,
          chatId,
          reminder.workingDir,
        )
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
          ...(workingDir ? { workingDir } : {}),
          routeKey: `reminder:${reminder.id}`,
          ...(reminder.origin.replyToMessageId
            ? { replyToMessageId: reminder.origin.replyToMessageId }
            : {}),
          bots,
          groups,
        }
      }

      const schedCtx = this.host.getSchedules().getActiveSessionContext?.(sid)
      if (schedCtx && schedCtx.targets.length > 0) {
        const primary = schedCtx.targets[0]!
        const bot = this.host.store.getBot(primary.botId)
        const botStatus = bots.find((b) => b.botId === primary.botId)
        const chatName = this.host.store.resolveChatName(primary.botId, primary.chatId)
        const liveSession = (
          this.host.ctx.sessions as unknown as { get?: (id: SessionId) => Agent['session'] | undefined }
        )?.get?.(brandString<SessionId>(sid))
        const workingDir = this.resolveContextWorkingDir(
          primary.botId,
          primary.chatId,
          liveSession?.header.cwd,
        )
        return {
          sessionId: sid,
          bound: true,
          source: 'schedule_session',
          botId: primary.botId,
          ...(bot ? { botName: bot.name, larkAppId: bot.larkAppId } : {}),
          ...(botStatus?.botOpenId ? { botOpenId: botStatus.botOpenId } : {}),
          chatId: primary.chatId,
          ...(chatName ? { chatName } : {}),
          ...(workingDir ? { workingDir } : {}),
          scheduleContext: schedCtx,
          bots,
          groups,
        }
      }
    }

    // Fail-closed when a caller supplied a session identity (DSH_SESSION_ID or ext:<id>)
    // that did not resolve to any bound session/reminder/schedule: never silently attribute
    // it to `default_bot` (`bots[0]`), which causes cross-bot sends/memory/reminder leaks.
    if (identity.provided) {
      return {
        ...(sid ? { sessionId: sid } : {}),
        ...(identity.rawSessionId ? { unresolvedSessionId: identity.rawSessionId } : {}),
        bound: false,
        bots,
        groups,
      }
    }

    const defaultBot = bots.find((b) => b.enabled && b.connected) ?? bots[0]
    const defaultWorkingDir = defaultBot
      ? this.resolveContextWorkingDir(defaultBot.botId)
      : undefined
    return {
      bound: false,
      ...(defaultBot
        ? {
            source: 'default_bot',
            botId: defaultBot.botId,
            botName: defaultBot.name,
            larkAppId: defaultBot.larkAppId,
            ...(defaultBot.botOpenId ? { botOpenId: defaultBot.botOpenId } : {}),
            ...(defaultWorkingDir ? { workingDir: defaultWorkingDir } : {}),
          }
        : {}),
      bots,
      groups,
    }
  }

  private resolveContextWorkingDir(
    botId?: string,
    chatId?: string,
    explicitWorkingDir?: string,
  ): string | undefined {
    const direct = explicitWorkingDir?.trim()
    if (direct) return expandWorkingDir(direct) || direct
    if (!botId) return undefined
    const bot = this.host.store.getBot(botId)
    if (!bot) return undefined
    const group = chatId ? this.host.store.getGroup(bot.id, chatId) : undefined
    const effective = resolveEffectiveWorkingDir(bot, group).trim()
    return effective ? expandWorkingDir(effective) || effective : undefined
  }

  /**
   * Structured control-plane silence command (`lark-bridge silence --reason ...`).
   * Decouples control decision from assistant prose so silent listener/reminder turns
   * never leak accidental trailing commentary to Feishu.
   */
  agentSilenceTurn(input: {
    readonly sessionId?: string
    readonly externalSessionId?: string
    readonly reason?: string
  }): {
    readonly silenced: boolean
    readonly source?: 'interactive' | 'reminder'
    readonly turnId?: string
    readonly reason?: string
    readonly message: string
  } {
    const identity = this.resolveCliSessionIdentity(input.sessionId, input.externalSessionId)
    const sid = identity.canonicalSessionId
    if (!sid) {
      throw new Error('sessionId is required (--session <id> or run inside an active DSH session)')
    }
    const reason = input.reason?.trim() || undefined
    const interactive = this.host.inbound.markSessionTurnSilent(sid, reason)
    if (interactive.matched) {
      if (!interactive.allowSilent) {
        return {
          silenced: false,
          source: 'interactive',
          ...(interactive.turnId ? { turnId: interactive.turnId } : {}),
          message: '当前轮次不允许静默跳过（非旁听/静默模式）',
        }
      }
      return {
        silenced: true,
        source: 'interactive',
        ...(interactive.turnId ? { turnId: interactive.turnId } : {}),
        ...(reason ? { reason } : {}),
        message: '已标记本轮静默跳过，不会向飞书发送回复',
      }
    }

    const reminderMarked = this.host.getReminders().markSessionSilent?.(sid, reason) ?? false
    if (reminderMarked) {
      return {
        silenced: true,
        source: 'reminder',
        ...(reason ? { reason } : {}),
        message: '已标记本次提醒无需打扰，完成后将静默归档',
      }
    }

    return {
      silenced: false,
      message: `未找到会话 ${sid} 对应的进行中静默轮次`,
    }
  }

  async agentSend(input: AgentCliSendInput): Promise<{
    readonly messageIds: readonly string[]
    readonly botId: string
    readonly targetId: string
    readonly sessionId?: string
    readonly routeKey?: string
    readonly replyToMessageId?: string
    readonly replyInThread?: boolean
  }> {
    const identity = this.resolveCliSessionIdentity(input.sessionId, input.externalSessionId)
    const ctxInfo = this.resolveAgentContext(input.sessionId, input.externalSessionId)
    const explicitBotId = input.botId?.trim() || undefined
    if (identity.provided && !ctxInfo.bound && !explicitBotId) {
      throw new SessionIdentityError(
        'unresolved_session_context',
        `无法解析当前会话上下文（${identity.rawSessionId}），已拒绝回退到默认智能体以防止串路；请显式指定 --bot 与 --chat/--user 或检查会话绑定`,
        400,
      )
    }
    const botId = explicitBotId || ctxInfo.botId
    if (!botId) throw new Error('No botId specified and no active bot available')
    const bot = this.host.store.getBot(botId)
    if (!bot) throw new Error(`Bot "${botId}" not found`)
    const transport = this.host.connections.transportFor(bot)

    const userOpenId = input.userOpenId?.trim() || undefined
    const chatId = userOpenId ? undefined : input.chatId?.trim() || ctxInfo.chatId
    const explicitReplyTo = input.replyToMessageId?.trim() || undefined
    const usingImplicitReplyTo = Boolean(!explicitReplyTo && !input.chatId && !userOpenId && ctxInfo.replyToMessageId)
    const replyToMessageId =
      explicitReplyTo || (usingImplicitReplyTo ? ctxInfo.replyToMessageId : undefined)
    const replyInThread =
      input.replyInThread ??
      (usingImplicitReplyTo ? (ctxInfo.replyInThread ?? true) : false)

    if (!userOpenId && !chatId && !replyToMessageId) {
      throw new Error('Target chatId (--chat), userOpenId (--user), or bound session is required')
    }

    const canonicalSessionId = identity.canonicalSessionId
    const receiveIdType: 'open_id' | 'chat_id' = userOpenId ? 'open_id' : 'chat_id'
    const receiveId = userOpenId ?? chatId
    const messageIds: string[] = []
    const syncImplicitThreadAlias = (sent: { readonly threadId?: string } | undefined) => {
      if (!usingImplicitReplyTo || !replyInThread || !sent?.threadId || !chatId || !ctxInfo.routeKey) {
        return
      }
      this.host.store.bindRouteAlias(
        ctxInfo.routeKey,
        buildRouteKey(bot.larkAppId, chatId, sent.threadId),
      )
    }

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
      syncImplicitThreadAlias(sent)
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
        syncImplicitThreadAlias(sent)
        if (sent.messageId) messageIds.push(sent.messageId)
      } else if (input.textOnly && uploadedImages.length === 0 && !input.title) {
        const sent = await transport.sendProactiveMessage({
          receiveIdType,
          ...(receiveId ? { receiveId } : {}),
          ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
          msgType: 'post',
          content: JSON.stringify(buildLarkPostPayload(markdown)),
        })
        syncImplicitThreadAlias(sent)
        if (sent.messageId) messageIds.push(sent.messageId)
      } else {
        const group = chatId ? this.host.store.getGroup(bot.id, chatId) : undefined
        const card = buildReplyCard({
          ...(input.title ? { title: input.title } : {}),
          markdown: markdown || ' ',
          bot: resolveEffectiveCardBot(bot, group),
          ...(canonicalSessionId ? { sessionUrl: this.host.sessionWebUrl(canonicalSessionId) } : {}),
          ...(uploadedImages.length > 0 ? { images: uploadedImages } : {}),
        })
        const sent = await transport.sendProactiveMessage({
          receiveIdType,
          ...(receiveId ? { receiveId } : {}),
          ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
          msgType: 'interactive',
          content: JSON.stringify(card),
        })
        syncImplicitThreadAlias(sent)
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
      syncImplicitThreadAlias(sent)
      if (sent.messageId) messageIds.push(sent.messageId)
    }

    if (messageIds.length > 0) {
      const modeLabel = input.card ? 'card' : input.textOnly ? 'text' : 'reply-card'
      const targetDesc = userOpenId
        ? `user=${userOpenId}`
        : replyToMessageId
          ? `replyTo=${replyToMessageId}${replyInThread ? '(thread)' : ''}`
          : `chat=${chatId ?? ''}`
      this.host.store.recordEvent?.({
        botId: bot.id,
        ...(chatId ? { chatId } : {}),
        ...(ctxInfo.routeKey ? { routeKey: ctxInfo.routeKey } : {}),
        ...(canonicalSessionId ? { sessionId: canonicalSessionId } : {}),
        kind: 'reply',
        summary: `CLI 主动发送（${modeLabel}，${messageIds.length} 条，${targetDesc}，${markdown.length} 字）`,
      })
    }

    return {
      messageIds,
      botId: bot.id,
      targetId: receiveId ?? replyToMessageId ?? '',
      ...(canonicalSessionId ? { sessionId: canonicalSessionId } : {}),
      ...(ctxInfo.routeKey ? { routeKey: ctxInfo.routeKey } : {}),
      ...(replyToMessageId ? { replyToMessageId, replyInThread } : {}),
    }
  }

  async agentHistory(input: {
    readonly sessionId?: string
    readonly externalSessionId?: string
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
    const identity = this.resolveCliSessionIdentity(input.sessionId, input.externalSessionId)
    const ctxInfo = this.resolveAgentContext(input.sessionId, input.externalSessionId)
    const explicitBotId = input.botId?.trim() || undefined
    if (identity.provided && !ctxInfo.bound && !explicitBotId) {
      throw new SessionIdentityError(
        'unresolved_session_context',
        `无法解析当前会话上下文（${identity.rawSessionId}），已拒绝回退到默认智能体读取历史；请显式指定 --bot 与 --chat`,
        400,
      )
    }
    const botId = explicitBotId || ctxInfo.botId
    if (!botId) throw new Error('No botId specified and no active bot available')
    const bot = this.host.store.getBot(botId)
    if (!bot) throw new Error(`Bot "${botId}" not found`)
    const chatId = input.chatId?.trim() || ctxInfo.chatId
    if (!chatId) {
      throw new Error('chatId is required (--chat oc_xxx or run inside a bound Lark session)')
    }
    const threadId =
      input.threadId === 'none'
        ? undefined
        : input.threadId?.trim() ||
          (!input.chatId ? (ctxInfo.threadId ?? ctxInfo.replyToMessageId) : undefined)
    const messages = await this.host.connections.transportFor(bot).listMessages({
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
    readonly externalSessionId?: string
    readonly botId?: string
    readonly messageId: string
    readonly downloadResources?: boolean
    readonly includeRaw?: boolean
  }): Promise<LarkMessageDetail | undefined> {
    const identity = this.resolveCliSessionIdentity(input.sessionId, input.externalSessionId)
    const ctxInfo = this.resolveAgentContext(input.sessionId, input.externalSessionId)
    const explicitBotId = input.botId?.trim() || undefined
    if (identity.provided && !ctxInfo.bound && !explicitBotId) {
      throw new SessionIdentityError(
        'unresolved_session_context',
        `无法解析当前会话上下文（${identity.rawSessionId}），已拒绝回退到默认智能体读取消息；请显式指定 --bot`,
        400,
      )
    }
    const botId = explicitBotId || ctxInfo.botId
    if (!botId) throw new Error('No botId specified and no active bot available')
    const bot = this.host.store.getBot(botId)
    if (!bot) throw new Error(`Bot "${botId}" not found`)
    return this.host.connections.transportFor(bot).getMessageDetail(input.messageId, {
      downloadResources: input.downloadResources,
      includeRaw: input.includeRaw,
    })
  }

  async agentCreateSchedule(input: {
    readonly sessionId?: string
    readonly externalSessionId?: string
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
    const identity = this.resolveCliSessionIdentity(input.sessionId, input.externalSessionId)
    const ctxInfo = this.resolveAgentContext(input.sessionId, input.externalSessionId)
    const explicitBotId = input.botId?.trim() || undefined
    if (identity.provided && !ctxInfo.bound && !explicitBotId) {
      throw new SessionIdentityError(
        'unresolved_session_context',
        `无法解析当前会话上下文（${identity.rawSessionId}），已拒绝回退到默认智能体创建定时任务；请显式指定 --bot 与 --chat`,
        400,
      )
    }
    if (explicitBotId && !this.host.store.getBot(explicitBotId)) {
      throw new Error(`未找到智能体 "${explicitBotId}"`)
    }
    const botId = explicitBotId || ctxInfo.botId
    const chatId = input.chatId?.trim() || ctxInfo.chatId
    const bot = botId ? this.host.store.getBot(botId) : undefined
    const group = bot && chatId ? this.host.store.getGroup(bot.id, chatId) : undefined
    const canonicalSessionId = identity.canonicalSessionId
    const sessionBinding =
      !explicitBotId && !input.chatId?.trim() && canonicalSessionId
        ? this.host.store.listBindings().find((b) => b.sessionId === canonicalSessionId)
        : undefined
    const rawCwd =
      input.cwd?.trim() ||
      (bot ? resolveEffectiveWorkingDir(bot, group) : sessionBinding?.workingDir)
    const resolvedPreset =
      input.agentPreset?.trim() ||
      (bot ? resolveEffectiveAgentRuntime(bot, group).agentPreset : sessionBinding?.agentPreset)
    const targets: LarkScheduleTarget[] = botId && chatId ? [{ botId, chatId }] : []
    return this.host.getSchedules().createAndBind({
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

  async agentUpdateSchedule(
    scheduleId: string,
    input: {
      readonly title?: string
      readonly prompt?: string
      readonly timing?: ScheduleCreateInputLike['timing']
      readonly cwd?: string
      readonly agentPreset?: string
      readonly active?: boolean
    },
  ) {
    return this.host.getSchedules().updateSchedule(scheduleId, input)
  }

  async agentDeleteSchedule(scheduleId: string) {
    return this.host.getSchedules().deleteSchedule(scheduleId)
  }

  async sendScheduleMessage(input: {
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
    const bot = this.host.store.getBot(input.botId)
    if (!bot) throw new Error(`bot "${input.botId}" not found`)
    const group = this.host.store.getGroup(bot.id, input.chatId)
    const transport = this.host.connections.transportFor(bot)
    const cardTitle = input.isError
      ? `自动化任务异常 · ${input.scheduleTitle}`
      : input.isIntermediate
        ? `自动化任务进展 · ${input.scheduleTitle}`
        : `自动化任务 · ${input.scheduleTitle}`
    const cardBot = resolveEffectiveCardBot(bot, group)
    const now = Date.now()
    const idleMinutes = group?.idleCloseMinutes ?? bot.idleCloseMinutes
    if (!input.isIntermediate) {
      this.host.store.upsertManagedSession({
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
      ...(input.isIntermediate ? {} : { sessionUrl: this.host.sessionWebUrl(input.sessionId) }),
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
        this.host.ctx.sessions as unknown as { get?: (id: SessionId) => Agent['session'] | undefined }
      ).get?.(brandString<SessionId>(input.sessionId))
      const rawDir = liveSession?.header.cwd || group?.workingDir.trim() || bot.defaultWorkingDir
      const chatName = this.host.store.resolveChatName(bot.id, input.chatId)
      const effectiveRuntime = resolveEffectiveAgentRuntime(bot, group)
      const bindingPreset = liveSession?.header.agentPreset ?? effectiveRuntime.agentPreset
      await this.host.sessions.replaceRouteBinding({
        routeKey: buildRouteKey(bot.larkAppId, input.chatId, scopeId),
        botId: bot.id,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        chatId: input.chatId,
        ...(chatName ? { chatName } : {}),
        workspaceName: this.host.store.resolveGroupWorkspaceName(bot, group, chatName),
        sessionId: input.sessionId,
        agentPreset: bindingPreset,
        ...(effectiveRuntime.runtimeProfileId && effectiveRuntime.agentPreset === bindingPreset
          ? { runtimeProfileId: effectiveRuntime.runtimeProfileId }
          : {}),
        ...(effectiveRuntime.model && effectiveRuntime.agentPreset === bindingPreset
          ? { model: effectiveRuntime.model }
          : {}),
        ...(effectiveRuntime.reasoningEffort && effectiveRuntime.agentPreset === bindingPreset
          ? { reasoningEffort: effectiveRuntime.reasoningEffort }
          : {}),
        workingDir: expandWorkingDir(rawDir) || rawDir,
        trigger: 'schedule',
        createdAtMs: now,
        lastActivityMs: now,
        ...(idleMinutes > 0 ? { idleCloseMs: idleMinutes * 60_000 } : {}),
      })
      if (sent.threadId) {
        this.host.store.bindRouteAlias(
          buildRouteKey(bot.larkAppId, input.chatId, scopeId),
          buildRouteKey(bot.larkAppId, input.chatId, sent.threadId),
        )
      }
    }
  }

  async sendOriginCard(
    origin: LarkReminderOrigin,
    card: Record<string, unknown>,
  ): Promise<{ readonly messageId?: string }> {
    const bot = this.host.store.getBot(origin.botId)
    if (!bot) return {}
    const transport = this.host.connections.transportFor(bot)
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

  async patchOriginCard(
    botId: string,
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    const bot = this.host.store.getBot(botId)
    if (!bot) return
    await this.host.connections.transportFor(bot).patchMessageCard(messageId, card)
  }

  async resolveMemberName(
    botId: string,
    _chatId: string,
    openId: string,
  ): Promise<string | undefined> {
    const cleanOpenId = openId.trim()
    if (!cleanOpenId) return undefined
    const transport = this.host.connections.getTransport(botId)
    if (!transport) return undefined
    const cached = transport.getCachedUserName?.(cleanOpenId)?.trim()
    if (cached && cached !== cleanOpenId) return cached
    const summary = await transport.resolveUserSummary?.(cleanOpenId).catch(() => undefined)
    const name = summary?.name?.trim()
    return name && name !== cleanOpenId ? name : undefined
  }

  async deliverReminderOutput(input: {
    readonly item: LarkReminderItem
    readonly sessionId: string
    readonly markdown: string
    readonly isError: boolean
  }): Promise<{ readonly messageId?: string; readonly deliveredMarkdown?: string }> {
    const { item, sessionId, isError } = input
    const bot = this.host.store.getBot(item.origin.botId)
    if (!bot) return {}
    const transport = this.host.connections.transportFor(bot)

    let effectiveMentions = item.mentions
    if (
      item.origin.chatType === 'group' &&
      effectiveMentions.length === 0 &&
      item.origin.chatId &&
      !/<at\s+(?:user_id|id)\s*=/i.test(input.markdown) &&
      bot.adminUsers.length > 0
    ) {
      // Best-effort safety net for legacy pre-upgrade group reminders created without mentions:
      // if any configured bot admin is a member of the target group, mention them instead of sending bare.
      const members = await this.host.connections
        .listGroupMembers(bot.id, item.origin.chatId)
        .catch(() => [])
      const adminInGroup = members.find((m) => bot.adminUsers.includes(m.openId))
      if (adminInGroup) {
        effectiveMentions = [{ openId: adminInGroup.openId, name: adminInGroup.name }]
      }
    }

    const markdown = formatReminderOutputWithMentions({
      chatType: item.origin.chatType,
      markdown: input.markdown,
      mentions: effectiveMentions,
      ccMentions: item.ccMentions,
    })

    const cardTitle = isError
      ? `提醒事项异常 · ${item.title}`
      : item.worktree
        ? `主动跟进与代码待审 · ${item.title}`
        : item.kind === 'delegation'
          ? `委派事项跟进 · ${item.title}`
          : `主动跟进提醒 · ${item.title}`

    if (item.origin.chatType === 'p2p' && item.origin.userOpenId) {
      const card = buildReplyCard({
        title: cardTitle,
        template: isError ? 'orange' : 'blue',
        markdown,
        bot: resolveEffectiveCardBot(bot),
        sessionUrl: this.host.sessionWebUrl(sessionId),
      })
      const sent = await transport.sendProactiveMessage({
        receiveIdType: 'open_id',
        receiveId: item.origin.userOpenId,
        msgType: 'interactive',
        content: JSON.stringify(card),
      })
      return { ...(sent.messageId ? { messageId: sent.messageId } : {}), deliveredMarkdown: markdown }
    }

    if (!item.origin.chatId) return {}
    const chatId = item.origin.chatId
    const group = this.host.store.getGroup(bot.id, chatId)
    const card = buildReplyCard({
      title: cardTitle,
      template: isError ? 'orange' : 'blue',
      markdown,
      bot: resolveEffectiveCardBot(bot, group),
      sessionUrl: this.host.sessionWebUrl(sessionId),
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
      const chatName = this.host.store.resolveChatName(bot.id, chatId)
      const reminderRouteKey = buildRouteKey(bot.larkAppId, chatId, scopeId)
      await this.host.sessions.replaceRouteBinding({
        routeKey: reminderRouteKey,
        botId: bot.id,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        chatType: 'group',
        chatId,
        ...(chatName ? { chatName } : {}),
        workspaceName: this.host.store.resolveGroupWorkspaceName(bot, group, chatName),
        sessionId,
        agentPreset: runtime.agentPreset,
        ...(runtime.runtimeProfileId ? { runtimeProfileId: runtime.runtimeProfileId } : {}),
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
        workingDir: expandWorkingDir(rawDir) || rawDir,
        trigger: 'reminder',
        createdAtMs: now,
        lastActivityMs: now,
        ...(idleMinutes > 0 ? { idleCloseMs: idleMinutes * 60_000 } : {}),
      })
      if (sent.threadId) {
        this.host.store.bindRouteAlias(
          reminderRouteKey,
          buildRouteKey(bot.larkAppId, chatId, sent.threadId),
        )
      }
    }
    return { ...(sent.messageId ? { messageId: sent.messageId } : {}), deliveredMarkdown: markdown }
  }
}
