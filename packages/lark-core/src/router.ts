import {
  parseSlashCommand,
  replaceMentionKeysWithNames,
  stripBotMentions,
} from './message-parser.js'
import { SILENT_REPLY_SENTINEL } from './reply-text.js'
import {
  resolveEffectiveAgentRuntime,
  resolveEffectiveCotConfig,
  resolveEffectiveReactionEmoji,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  type GroupListenerRule,
  type GroupReplyMode,
  type GroupSessionMode,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkGroupConfig,
  type LarkMention,
  type MentionTriggerMode,
  type RoutingDecision,
  type RoutingRuntimeContext,
} from './types.js'

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unwrapSystemReminder(block: string): string {
  const trimmed = block.trim()
  const match = /^<system_reminder>\s*([\s\S]*?)\s*<\/system_reminder>$/i.exec(trimmed)
  return match?.[1]?.trim() ?? trimmed
}

export function composeSystemReminder(
  sections: readonly (string | undefined)[],
): string | undefined {
  const active = sections
    .map((s) => (s ? unwrapSystemReminder(s) : ''))
    .filter(Boolean)
  if (active.length === 0) return undefined
  return `<system_reminder>\n${active.join('\n\n')}\n</system_reminder>`
}

export function buildRouteKey(
  larkAppId: string,
  chatId: string,
  scopeId: string,
): string {
  return `${larkAppId}:${chatId}:${scopeId}`
}

export function extractRouteScope(routeKey: string): string {
  const parts = routeKey.split(':')
  return parts.slice(2).join(':')
}

export function isNativeThreadRouteKey(routeKey: string): boolean {
  return extractRouteScope(routeKey).startsWith('omt_')
}

function resolveGroupReplyMode(bot: LarkBotConfig, group?: LarkGroupConfig): GroupReplyMode {
  if (group && group.replyMode !== 'inherit') return group.replyMode
  return bot.groupReplyMode
}

function resolveReplyModeInContext(
  configured: GroupReplyMode,
  msg: InboundLarkMessage,
): GroupReplyMode {
  return msg.threadId ? 'new-topic' : configured
}

interface ResolvedSessionRoute {
  readonly routeKey: string
  readonly ephemeralHandoffRouteKey?: string
}

function resolveActiveThreadLookupKey(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  runtime: RoutingRuntimeContext,
): string {
  const isRouteActive = (key: string) =>
    runtime.hasActiveSessionForRoute(key) || Boolean(runtime.hasEphemeralRouterThread?.(key))
  // Already inside a native Feishu thread (`omt_*`): match rootId first, then threadId fallback.
  if (msg.threadId) {
    const primaryAnchor = msg.rootId ?? msg.threadId
    const primaryKey = buildRouteKey(bot.larkAppId, msg.chatId, primaryAnchor)
    if (isRouteActive(primaryKey)) return primaryKey
    if (msg.rootId && msg.threadId !== msg.rootId) {
      const threadIdKey = buildRouteKey(bot.larkAppId, msg.chatId, msg.threadId)
      if (isRouteActive(threadIdKey)) return threadIdKey
    }
    return primaryKey
  }
  // Main-stream quote reply (no threadId): never match a root whose session already promoted
  // into an independent native Feishu thread, otherwise sibling quotes hijack that thread.
  if (msg.rootId) {
    const rootKey = buildRouteKey(bot.larkAppId, msg.chatId, msg.rootId)
    if (runtime.isRouteBoundToNativeThread?.(rootKey)) {
      return buildRouteKey(bot.larkAppId, msg.chatId, msg.messageId)
    }
    return rootKey
  }
  return buildRouteKey(bot.larkAppId, msg.chatId, msg.messageId)
}

function resolveSessionRoute(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  sessionMode: GroupSessionMode,
  replyMode: GroupReplyMode,
  runtime: RoutingRuntimeContext,
): ResolvedSessionRoute {
  if (sessionMode !== 'thread') {
    return {
      routeKey: buildRouteKey(bot.larkAppId, msg.chatId, routeScopeForSessionMode(sessionMode, msg)),
    }
  }
  if (msg.threadId || !msg.rootId) {
    return { routeKey: resolveActiveThreadLookupKey(bot, msg, runtime) }
  }
  const rootKey = buildRouteKey(bot.larkAppId, msg.chatId, msg.rootId)
  const selfKey = buildRouteKey(bot.larkAppId, msg.chatId, msg.messageId)
  if (runtime.isRouteBoundToNativeThread?.(rootKey)) {
    return { routeKey: selfKey }
  }
  const hasUnpromotedWorker = runtime.hasActiveSessionForRoute(rootKey)
  if (replyMode === 'new-topic' && !hasUnpromotedWorker) {
    // Replying with `reply_in_thread: true` to a main-stream quote reply unconditionally spawns a
    // brand-new Feishu thread rooted at `msg.messageId`. Bind directly to `selfKey` so concurrent
    // or repeated sibling quotes off the same root never merge into one session.
    const hasEphemeral = Boolean(runtime.hasEphemeralRouterThread?.(rootKey))
    return {
      routeKey: selfKey,
      ...(hasEphemeral ? { ephemeralHandoffRouteKey: rootKey } : {}),
    }
  }
  return { routeKey: rootKey }
}

function resolveGroupSessionMode(
  bot: LarkBotConfig,
  group?: LarkGroupConfig,
): GroupSessionMode {
  if (group && group.sessionMode !== 'inherit') return group.sessionMode
  return bot.groupSessionMode
}

function resolveMentionTriggerMode(
  bot: LarkBotConfig,
  group?: LarkGroupConfig,
): MentionTriggerMode {
  if (group && group.mentionTriggerMode !== 'inherit') return group.mentionTriggerMode
  return bot.mentionTriggerMode
}

function resolveUseCard(bot: LarkBotConfig, group?: LarkGroupConfig): boolean {
  if (group?.replyFormat === 'card') return true
  if (group?.replyFormat === 'text') return false
  return bot.useInteractiveCard
}

function resolveSendIntermediateMessages(bot: LarkBotConfig, group?: LarkGroupConfig): boolean {
  if (group?.intermediateMessages === 'on') return true
  if (group?.intermediateMessages === 'off') return false
  return bot.sendIntermediateMessages
}

function resolveIdleCloseMs(bot: LarkBotConfig, group?: LarkGroupConfig): number | undefined {
  const minutes = group?.idleCloseMinutes ?? bot.idleCloseMinutes
  return minutes > 0 ? minutes * 60_000 : undefined
}

export function composeRoleReminder(
  bot: LarkBotConfig,
  group?: LarkGroupConfig,
): string | undefined {
  const botActive = bot.role.enabled && Boolean(bot.role.systemPrompt.trim() || bot.role.name.trim())
  const groupRole = group?.role

  if (groupRole?.mode === 'override') {
    const body = groupRole.systemPrompt.trim()
    const title = groupRole.name.trim()
    if (!body && !title) return undefined
    return [
      `<role${title ? ` name="${escapeXmlAttr(title)}"` : ''}>`,
      body || `你的角色是：${title}`,
      '</role>',
    ].join('\n')
  }

  const sections: string[] = []
  const roleTitle = groupRole?.name.trim() || (botActive ? bot.role.name.trim() : '')
  if (botActive) {
    sections.push(bot.role.systemPrompt.trim() || `你的角色是：${bot.role.name.trim()}`)
  }
  if (groupRole?.mode === 'append' && groupRole.systemPrompt.trim()) {
    sections.push(groupRole.systemPrompt.trim())
  }
  if (sections.length === 0) return undefined

  return [
    `<role${roleTitle ? ` name="${escapeXmlAttr(roleTitle)}"` : ''}>`,
    sections.join('\n\n'),
    '</role>',
  ].join('\n')
}

export interface PrefetchedQuotedMessageSummary {
  readonly messageId: string
  readonly senderName?: string
  readonly senderType?: 'user' | 'bot'
  readonly msgType: string
  readonly text?: string
  readonly imageCount: number
  readonly attachedImageCount: number
  readonly hasUnfetchedResources?: boolean
}

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Extracts Feishu message IDs whose full content has already been injected into a
 * session prompt (either as an inbound turn message, a coalesced batch item, or an
 * expanded `<quoted_message>` block). Fallback CLI-hint lines without expanded content
 * are intentionally ignored so a previously failed quote fetch can still be retried.
 */
export function extractInjectedLarkMessageIdsFromText(
  text: string,
  target: Set<string> = new Set(),
): Set<string> {
  if (!text) return target
  const tagAttrRe = /<(?:lark_context|quoted_message)\b[^>]*\bmessage_id="([^"]+)"/g
  for (const match of text.matchAll(tagAttrRe)) {
    const id = match[1] ? unescapeXmlAttr(match[1]).trim() : ''
    if (id) target.add(id)
  }
  const coalescedRe = /(?:^|\n)\[\d+\]\s+[^\n]*\(message_id="([^"]+)"\):/g
  for (const match of text.matchAll(coalescedRe)) {
    const id = match[1] ? unescapeXmlAttr(match[1]).trim() : ''
    if (id) target.add(id)
  }
  return target
}

export interface LarkConversationContextInput {
  readonly bot: Pick<LarkBotConfig, 'id' | 'name' | 'larkAppId'>
  readonly botOpenId?: string
  readonly sessionId?: string
  readonly msg: InboundLarkMessage
  readonly chatName?: string
  readonly senderName?: string
  readonly trigger?: 'p2p' | 'mention' | 'active-thread' | 'substitute' | 'listener'
  readonly allowSilentEmptyReply?: boolean
  readonly replyMode?: GroupReplyMode
  readonly useCard?: boolean
  readonly includeFullGuide?: boolean
  readonly prefetchedQuote?: PrefetchedQuotedMessageSummary
  /**
   * True when `msg.parentId` was already injected into an earlier turn (or an earlier
   * message in the same coalesced batch) of this session, so its full text and images
   * must not be repeated.
   */
  readonly quoteAlreadyInSession?: boolean
}

export function composeLarkContextReminder(input: LarkConversationContextInput): string {
  const { bot, msg } = input
  const attrs = [
    `bot_id="${escapeXmlAttr(bot.id)}"`,
    `bot_name="${escapeXmlAttr(bot.name)}"`,
    `app_id="${escapeXmlAttr(bot.larkAppId)}"`,
    ...(input.botOpenId ? [`bot_open_id="${escapeXmlAttr(input.botOpenId)}"`] : []),
    ...(input.sessionId ? [`session_id="${escapeXmlAttr(input.sessionId)}"`] : []),
    `chat_type="${escapeXmlAttr(msg.chatType)}"`,
    `chat_id="${escapeXmlAttr(msg.chatId)}"`,
    ...(input.chatName ? [`chat_name="${escapeXmlAttr(input.chatName)}"`] : []),
    ...(input.trigger ? [`trigger="${escapeXmlAttr(input.trigger)}"`] : []),
    `message_id="${escapeXmlAttr(msg.messageId)}"`,
    ...(msg.rootId || msg.threadId
      ? [`thread_id="${escapeXmlAttr((msg.rootId || msg.threadId)!)}"`]
      : []),
    ...(msg.parentId ? [`quoted_message_id="${escapeXmlAttr(msg.parentId)}"`] : []),
    ...(msg.senderOpenId ? [`sender_open_id="${escapeXmlAttr(msg.senderOpenId)}"`] : []),
    ...(msg.senderUnionId ? [`sender_union_id="${escapeXmlAttr(msg.senderUnionId)}"`] : []),
    ...(input.senderName ? [`sender_name="${escapeXmlAttr(input.senderName)}"`] : []),
    `sender_type="${msg.senderType}"`,
  ]

  const bodyLines: string[] = []
  const peerMentions = msg.mentions.filter(
    (m) => m.openId && m.openId !== input.botOpenId && m.openId !== msg.botOpenId,
  )
  if (peerMentions.length > 0) {
    const formatted = peerMentions
      .map((m) => `${m.name || m.key}(open_id="${m.openId}")`)
      .join('、')
    bodyLines.push(`提及成员：${formatted}`)
  }
  if (msg.parentId) {
    if (input.quoteAlreadyInSession) {
      // Pure thread continuation (`parentId === rootId`) carries the root id on every
      // reply in Feishu threads; omit the repeated quote body once the root is in context.
      // Explicit mid-thread quotes keep a minimal pointer without re-sending body/images.
      if (!msg.rootId || msg.parentId !== msg.rootId) {
        bodyLines.push(
          `引用消息：${msg.parentId}（内容已在本会话前文中，可直接结合上文回复；若前文已被压缩可运行 \`lark-bridge message ${msg.parentId}\` 查原文）`,
        )
      }
    } else {
      const q = input.prefetchedQuote
      if (q && q.messageId === msg.parentId) {
        const qAttrs = [
          `message_id="${escapeXmlAttr(q.messageId)}"`,
          `msg_type="${escapeXmlAttr(q.msgType)}"`,
          ...(q.senderName ? [`sender="${escapeXmlAttr(q.senderName)}"`] : []),
          ...(q.senderType ? [`sender_type="${q.senderType}"`] : []),
          ...(q.imageCount > 0 ? [`images="${q.imageCount}"`] : []),
        ]
        const rawText = q.text?.trim() ?? ''
        const maxQuoteChars = 4000
        const truncated = rawText.length > maxQuoteChars
        const displayText = truncated ? `${rawText.slice(0, maxQuoteChars)}…` : rawText
        const notes: string[] = []
        if (q.attachedImageCount > 0) {
          notes.push(`已自动附带 ${q.attachedImageCount} 张引用图片`)
        }
        if (q.imageCount > q.attachedImageCount) {
          notes.push(
            `另有 ${q.imageCount - q.attachedImageCount} 张引用图片未附带，可运行 \`lark-bridge message ${msg.parentId}\` 查看`,
          )
        }
        if (truncated || q.hasUnfetchedResources) {
          notes.push(`完整内容或附件可运行 \`lark-bridge message ${msg.parentId}\``)
        }
        const quoteContent =
          displayText || (q.imageCount > 0 ? `[图片消息，共 ${q.imageCount} 张]` : `[${q.msgType}]`)
        bodyLines.push(
          `<quoted_message ${qAttrs.join(' ')}>`,
          quoteContent,
          ...(notes.length > 0 ? [`（${notes.join('；')}）`] : []),
          '</quoted_message>',
        )
      } else {
        bodyLines.push(
          `引用消息：${msg.parentId}（查看全文或下载附件：\`lark-bridge message ${msg.parentId}\`）`,
        )
      }
    }
  }
  if (input.trigger === 'mention' && input.allowSilentEmptyReply !== true) {
    bodyLines.push(
      `回复约束：用户已显式 @ 提及你，本轮禁止静默、调用 \`lark-bridge silence\` 或输出 \`${SILENT_REPLY_SENTINEL}\`；若问题超出角色职责范围，请用一句话简短礼貌说明职责边界并拒答。`,
    )
  }
  if (input.includeFullGuide !== false) {
    bodyLines.push(
      '飞书工具：发送本地图片/文件/卡片、读取群或话题历史、查询本群成员 `open_id`（`<at id="ou_xxx">姓名</at>`）及管理提醒/定时任务，使用 `lark-bridge` CLI（见 `lark-bridge` 技能）。',
    )
  }

  if (bodyLines.length === 0) {
    return `<lark_context ${attrs.join(' ')} />`
  }
  return [`<lark_context ${attrs.join(' ')}>`, ...bodyLines, '</lark_context>'].join('\n')
}

export interface ScheduleTargetContextItem {
  readonly botId: string
  readonly botName: string
  readonly larkAppId: string
  readonly botOpenId?: string
  readonly chatId: string
  readonly chatName: string
  readonly replyToMessageId?: string
}

export interface ScheduleContextReminderInput {
  readonly scheduleId: string
  readonly title: string
  readonly enabled: boolean
  readonly deliveryMode: 'chat' | 'thread'
  readonly notifyOn: 'non_empty' | 'always' | 'error_only'
  readonly targets: readonly ScheduleTargetContextItem[]
}

export function composeScheduleContextReminder(input: ScheduleContextReminderInput): string {
  const attrs = [
    `schedule_id="${escapeXmlAttr(input.scheduleId)}"`,
    `title="${escapeXmlAttr(input.title)}"`,
    `delivery_mode="${input.deliveryMode}"`,
    `notify_on="${input.notifyOn}"`,
  ]
  const lines: string[] = [`<schedule ${attrs.join(' ')}>`]

  if (!input.enabled || input.targets.length === 0) {
    lines.push('通知目标：未配置默认群（如需主动推送飞书消息，使用 `lark-bridge send`）。')
    lines.push('</schedule>')
    return lines.join('\n')
  }

  for (const t of input.targets) {
    const botMeta = `bot_id="${t.botId}", app_id="${t.larkAppId}"${t.botOpenId ? `, bot_open_id="${t.botOpenId}"` : ''}`
    const threadMeta =
      input.deliveryMode === 'thread' && t.replyToMessageId
        ? `, reply_to="${t.replyToMessageId}"`
        : ''
    lines.push(
      `- 投递目标：智能体「${t.botName}」(${botMeta}) -> 群聊「${t.chatName}」(chat_id="${t.chatId}"${threadMeta})`,
    )
  }

  const outputRule =
    input.notifyOn === 'non_empty'
      ? `无需通知时仅输出 \`${SILENT_REPLY_SENTINEL}\`（或空文本）；`
      : input.notifyOn === 'error_only'
        ? `仅在存在异常时输出告警报告，正常时仅输出 \`${SILENT_REPLY_SENTINEL}\`（或空文本）；`
        : '每次执行均输出汇总结果；'

  lines.push(
    `- 输出规则：直接输出简体中文 Markdown 报告（${outputRule}勿用 \`lark-bridge send\` 重复发送正文；附带本地图片/文件时再用 \`lark-bridge send\`）。`,
    `- 提及规则：如需 @ 群成员，先运行 \`lark-bridge members --bot <botId> --chat <chatId> --query <姓名>\` 按需获取本群真实 \`open_id\`，再输出 \`<at id="ou_xxx">姓名</at>\`；不在群内人员写姓名并标注「（不在本群）」，禁止编造或跨应用混用 \`open_id\`。`,
  )
  lines.push('</schedule>')
  return lines.join('\n')
}

export function composeTurnPrompt(reminders: readonly string[], userText: string): string {
  const cleanUser = userText.trim()
  const userBlock = `<user_message>\n${cleanUser || '[空消息]'}\n</user_message>`
  const systemBlock = composeSystemReminder(reminders)
  return systemBlock ? `${systemBlock}\n\n${userBlock}` : userBlock
}

function isUserAllowedForP2p(bot: LarkBotConfig, senderOpenId?: string): boolean {
  if (!bot.p2pEnabled) return false
  if (bot.allowedUsers.length === 0) return true
  if (!senderOpenId) return false
  return bot.allowedUsers.includes(senderOpenId)
}

export function isGroupEnabled(bot: LarkBotConfig, group?: LarkGroupConfig): boolean {
  if (group) return group.enabled
  return bot.groupAccessMode === 'all_joined'
}

function mentionsOpenId(msg: InboundLarkMessage, targetOpenId: string): boolean {
  return msg.mentions.some((m) => m.openId === targetOpenId)
}

/**
 * Extracts mentioned peers in a group message, excluding the bot itself, `@all`,
 * and self-mentions (delegating to oneself).
 */
export function extractPeerUserMentions(
  msg: Pick<InboundLarkMessage, 'mentions' | 'botOpenId' | 'senderOpenId'>,
  overrideBotOpenId?: string,
): LarkMention[] {
  const effectiveBotOpenId = overrideBotOpenId || msg.botOpenId
  const seen = new Set<string>()
  const out: LarkMention[] = []
  for (const m of msg.mentions) {
    const openId = m.openId?.trim()
    if (!openId) continue
    if (openId === 'all' || m.key === '@_all') continue
    if (effectiveBotOpenId && openId === effectiveBotOpenId) continue
    if (msg.senderOpenId && openId === msg.senderOpenId) continue
    if (seen.has(openId)) continue
    seen.add(openId)
    out.push(m)
  }
  return out
}

function routeScopeForSessionMode(
  sessionMode: GroupSessionMode,
  msg: InboundLarkMessage,
): string {
  if (sessionMode === 'per_message') return `msg:${msg.messageId}`
  if (sessionMode === 'chat') return 'chat'
  return msg.rootId ?? msg.threadId ?? msg.messageId
}

export function isListenerSenderEnabled(
  listener: GroupListenerRule,
  senderOpenId: string | undefined,
  senderType: 'user' | 'bot',
): boolean {
  if (senderOpenId && Object.prototype.hasOwnProperty.call(listener.memberOverrides, senderOpenId)) {
    return Boolean(listener.memberOverrides[senderOpenId])
  }
  if (listener.senderTypes.length > 0 && !listener.senderTypes.includes(senderType)) {
    return false
  }
  if (listener.senderFilterMode === 'include_only') {
    return Boolean(senderOpenId && listener.senderOpenIds.includes(senderOpenId))
  }
  if (senderOpenId && listener.senderOpenIds.includes(senderOpenId)) {
    return false
  }
  return true
}

interface MessageMentionFlags {
  readonly hasAllMention: boolean
  readonly hasPeerMention: boolean
}

function collectPostAtUserIds(node: unknown, out: string[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const item of node) collectPostAtUserIds(item, out)
    return
  }
  if (typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  if (rec.tag === 'at' && typeof rec.user_id === 'string') {
    const uid = rec.user_id.trim()
    if (uid) out.push(uid)
    return
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === 'object') {
      collectPostAtUserIds(val, out)
    }
  }
}

function classifyListenerMentions(
  msg: Pick<InboundLarkMessage, 'mentions' | 'text' | 'rawContent' | 'botOpenId' | 'msgType'>,
): MessageMentionFlags {
  let hasAllMention = false
  let hasPeerMention = false

  for (const m of msg.mentions) {
    const id = m.openId?.trim()
    const key = m.key?.trim()
    if (key === '@_all' || id?.toLowerCase() === 'all') {
      hasAllMention = true
      continue
    }
    if (msg.botOpenId && id === msg.botOpenId) {
      continue
    }
    if (id || key) {
      hasPeerMention = true
    }
  }

  // Real Feishu `post` messages omit `@all` (and some bot-authored `at` nodes) from
  // `message.mentions`, keeping them only as `{ tag: "at", user_id: "..." }` in `rawContent`.
  if (msg.msgType === 'post' && msg.rawContent && (!hasAllMention || !hasPeerMention)) {
    try {
      const parsed: unknown = JSON.parse(msg.rawContent)
      const atIds: string[] = []
      collectPostAtUserIds(parsed, atIds)
      for (const uid of atIds) {
        if (uid === '@_all' || uid.toLowerCase() === 'all') {
          hasAllMention = true
          continue
        }
        const resolved = msg.mentions.find((m) => m.key === uid)?.openId?.trim() ?? uid
        if (msg.botOpenId && resolved === msg.botOpenId) {
          continue
        }
        hasPeerMention = true
      }
    } catch {
      // Ignore malformed rawContent; rely on structured `mentions`.
    }
  }

  // Fallback for interactive cards that embed `<at id="...">` tags without populating
  // `message.mentions`. Scoped to `interactive` so literal `<at ...>` code snippets in
  // plain `text`/`post` messages never false-positive as mentions.
  if (msg.msgType === 'interactive' && (!hasAllMention || !hasPeerMention)) {
    const atTagRe = /<at\s+(?:user_id|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi
    for (const match of msg.text.matchAll(atTagRe)) {
      const id = (match[1] ?? match[2] ?? match[3] ?? '').trim()
      if (!id) continue
      if (id.toLowerCase() === 'all') {
        hasAllMention = true
      } else if (!msg.botOpenId || id !== msg.botOpenId) {
        hasPeerMention = true
      }
    }
  }

  return { hasAllMention, hasPeerMention }
}

function matchesListenerRule(
  listener: GroupListenerRule,
  msg: InboundLarkMessage,
): { ok: boolean; reason?: string } {
  if (!listener.enabled) return { ok: false, reason: 'listener_disabled' }
  if (!listener.prompt.trim()) return { ok: false, reason: 'listener_empty_prompt' }

  if (listener.scope === 'top_level' && (msg.rootId || msg.parentId)) {
    return { ok: false, reason: 'listener_not_top_level' }
  }

  const mentionFilter = listener.mentionFilter ?? 'all'
  if (mentionFilter !== 'all') {
    const mentionFlags = classifyListenerMentions(msg)
    if (mentionFilter === 'exclude_all' && (mentionFlags.hasPeerMention || mentionFlags.hasAllMention)) {
      return { ok: false, reason: 'listener_mention_excluded' }
    }
    if (mentionFilter === 'exclude_peer' && mentionFlags.hasPeerMention) {
      return { ok: false, reason: 'listener_peer_mention_excluded' }
    }
  }

  if (
    listener.msgTypes.length > 0 &&
    !listener.msgTypes.includes(msg.msgType as GroupListenerRule['msgTypes'][number])
  ) {
    return { ok: false, reason: `listener_msg_type_excluded:${msg.msgType}` }
  }

  if (msg.botOpenId && msg.senderOpenId === msg.botOpenId) {
    return { ok: false, reason: 'listener_self_message' }
  }

  if (
    msg.senderOpenId &&
    Object.prototype.hasOwnProperty.call(listener.memberOverrides, msg.senderOpenId)
  ) {
    if (!listener.memberOverrides[msg.senderOpenId]) {
      return { ok: false, reason: 'listener_member_disabled' }
    }
  } else {
    if (listener.senderTypes.length > 0 && !listener.senderTypes.includes(msg.senderType)) {
      return { ok: false, reason: `listener_sender_type_excluded:${msg.senderType}` }
    }
    if (listener.senderFilterMode === 'include_only') {
      if (!msg.senderOpenId || !listener.senderOpenIds.includes(msg.senderOpenId)) {
        return { ok: false, reason: 'listener_sender_not_in_allowlist' }
      }
    } else if (msg.senderOpenId && listener.senderOpenIds.includes(msg.senderOpenId)) {
      return { ok: false, reason: 'listener_sender_excluded' }
    }
  }

  const normalized = replaceMentionKeysWithNames(msg.text, msg.mentions)
  if (
    listener.includeKeywords.length > 0 &&
    !listener.includeKeywords.some((kw) => kw && normalized.includes(kw))
  ) {
    return { ok: false, reason: 'listener_keyword_miss' }
  }
  if (listener.excludeKeywords.some((kw) => kw && normalized.includes(kw))) {
    return { ok: false, reason: 'listener_keyword_excluded' }
  }

  return { ok: true }
}

function buildListenerReminder(listener: GroupListenerRule, msg: InboundLarkMessage): string {
  const name = escapeXmlAttr(listener.name || '群消息监听')
  const lines = [
    `<listener name="${name}" chat_id="${escapeXmlAttr(msg.chatId)}" sender_type="${msg.senderType}" msg_type="${escapeXmlAttr(msg.msgType)}">`,
    listener.prompt.trim(),
  ]
  if (listener.allowSilentEmptyReply) {
    lines.push(
      `静默约定：判断无需回复时，仅输出 \`${SILENT_REPLY_SENTINEL}\` 或完全不输出正文（禁止输出空格、零宽字符或解释性拒答）。`,
    )
  }
  lines.push('</listener>')
  return lines.join('\n')
}

function buildDelegationFollowupReminder(
  msg: InboundLarkMessage,
  mode: 'silent_only' | 'assist',
): string {
  if (mode === 'silent_only') {
    return [
      `<delegation_followup mode="silent_only" chat_id="${escapeXmlAttr(msg.chatId)}">`,
      '仅判断当前消息是否构成成员间明确的行动委派（A @ B 排查、修复、发版、审批、CR 或交付具体事项）：',
      '1. 若属于需要后续核查的明确委派：先运行 `lark-bridge reminder list` 去重，再用 `lark-bridge reminder create --kind delegation` 登记跟进提醒（`--mention <B_open_id>:<B姓名>` 为主负责人，`--cc <A_open_id>:<A姓名>` 抄送发起人；有明确截止时间按截止时间，无明确时间则自适应：紧急故障 10 分钟、常规协作/CR/审批 1 小时，并在 `--prompt` 中要求核查话题与群主消息流、已回应但未给结果则顺延复查、已闭环则静默）。',
      '2. 若仅是寒暄、纯信息同步、纯问答或无行动项的 @ 他人：不建提醒。',
      '3. 本轮为后台静默观察，严禁向群聊回复文本，完成后直接调用 `lark-bridge silence --reason "<原因>"`。',
      '</delegation_followup>',
    ].join('\n')
  }
  return [
    `<delegation_followup mode="assist" chat_id="${escapeXmlAttr(msg.chatId)}">`,
    '已开启「委派事项跟进」：若当前消息属于 A @ B 的明确行动委派（排查/修复/发版/审批/CR/交付等），不要按“指派他人”直接忽略——可先运行 `lark-bridge reminder list` 去重，再在后台用 `lark-bridge reminder create --kind delegation --mention <B_open_id>:<B姓名> --cc <A_open_id>:<A姓名>` 登记跟进提醒（无明确时间则紧急故障 10 分钟、常规协作/CR/审批 1 小时）；如本身无需在群内插话，登记后调用 `lark-bridge silence` 静默退出。',
    '</delegation_followup>',
  ].join('\n')
}

function buildSubstituteReminder(
  targetName: string,
  disclosure: 'none' | 'subtle' | 'explicit',
  msg: InboundLarkMessage,
): string {
  const disclosureNote =
    disclosure === 'none'
      ? '以团队协作者口吻直接作答并给出依据，不提及“代答”或智能体身份。'
      : disclosure === 'subtle'
        ? `自然协助作答；涉及主观决策或拍板事项时，结尾简短说明待 ${targetName} 确认。`
        : `回复开头说明正协助 ${targetName} 先行检索作答，关键决策由其本人确认。`
  return [
    `<substitute target="${escapeXmlAttr(targetName)}" disclosure="${disclosure}" chat_id="${escapeXmlAttr(msg.chatId)}">`,
    disclosureNote,
    '</substitute>',
  ].join('\n')
}

interface ResolvedRoutingDefaults {
  readonly workingDir: string
  readonly workspaceName: string
  readonly chatName?: string
  readonly agentPreset: string
  readonly runtimeProfileId?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly useCard: boolean
  readonly cotEnabled: boolean
  readonly cotToolResultEnabled: boolean
  readonly sendIntermediateMessages: boolean
  readonly receivedReactionEmoji?: string
  readonly idleCloseMs?: number
  readonly roleReminder?: string
}

interface ResolvedGroupRoutingContext {
  readonly group?: LarkGroupConfig
  readonly groupReplyMode: GroupReplyMode
  readonly effectiveGroupReplyMode: GroupReplyMode
  readonly groupSessionMode: GroupSessionMode
  readonly mentionTriggerMode: MentionTriggerMode
  readonly threadRouteKey: string
  readonly chatRouteKey: string
}

interface ActiveThreadEvaluation {
  readonly hasWorkerSession: boolean
  readonly hasEphemeralThread: boolean
  readonly existingThreadTrigger?: string
  readonly allowThreadFollowup: boolean
  readonly isActiveThreadContext: boolean
  readonly allowSenderInActiveThread: boolean
  readonly isBarePeerMentionOnly: boolean
  readonly matchesSubstituteTarget: boolean
  readonly hasDelegationCandidate: boolean
}

type AgentDecisionOverrides = Omit<
  Extract<RoutingDecision, { action: 'agent' }>,
  | 'action'
  | 'workingDir'
  | 'workspaceName'
  | 'agentPreset'
  | 'runtimeProfileId'
  | 'model'
  | 'reasoningEffort'
  | 'useCard'
  | 'cotEnabled'
  | 'cotToolResultEnabled'
  | 'sendIntermediateMessages'
  | 'receivedReactionEmoji'
  | 'idleCloseMs'
  | 'roleReminder'
  | 'promptText'
> & {
  readonly useCard?: boolean
  readonly cotEnabled?: boolean
  readonly cotToolResultEnabled?: boolean
  readonly sendIntermediateMessages?: boolean
  readonly receivedReactionEmoji?: string | undefined
  readonly omitReceivedReactionEmoji?: boolean
  readonly includeChatName?: boolean
}

function resolveRoutingDefaults(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  group: LarkGroupConfig | undefined,
  runtime: RoutingRuntimeContext,
): ResolvedRoutingDefaults {
  const workingDir = resolveEffectiveWorkingDir(bot, group)
  const chatName = group?.chatName || runtime.chatName
  const workspaceName =
    msg.chatType === 'group'
      ? resolveEffectiveWorkspaceName(bot, group)
      : resolveEffectiveWorkspaceName(bot)
  const { agentPreset, runtimeProfileId, model, reasoningEffort } = resolveEffectiveAgentRuntime(
    bot,
    group,
  )
  const useCard = resolveUseCard(bot, group)
  const effectiveCot = resolveEffectiveCotConfig(bot, group)
  const sendIntermediateMessages = resolveSendIntermediateMessages(bot, group)
  const receivedReactionEmoji = resolveEffectiveReactionEmoji(bot, group)
  const idleCloseMs = resolveIdleCloseMs(bot, group)
  const roleReminder = composeRoleReminder(bot, group)
  return {
    workingDir,
    workspaceName,
    ...(chatName ? { chatName } : {}),
    agentPreset,
    ...(runtimeProfileId ? { runtimeProfileId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    useCard,
    cotEnabled: effectiveCot.enabled,
    cotToolResultEnabled: effectiveCot.toolResultEnabled,
    sendIntermediateMessages,
    ...(receivedReactionEmoji ? { receivedReactionEmoji } : {}),
    ...(idleCloseMs ? { idleCloseMs } : {}),
    ...(roleReminder ? { roleReminder } : {}),
  }
}

function buildAgentDecision(
  defaults: ResolvedRoutingDefaults,
  overrides: AgentDecisionOverrides,
): Extract<RoutingDecision, { action: 'agent' }> {
  const {
    useCard,
    cotEnabled,
    cotToolResultEnabled,
    sendIntermediateMessages,
    receivedReactionEmoji,
    omitReceivedReactionEmoji,
    includeChatName = true,
    ...rest
  } = overrides
  const effectiveReaction = omitReceivedReactionEmoji
    ? undefined
    : receivedReactionEmoji !== undefined
      ? receivedReactionEmoji
      : defaults.receivedReactionEmoji

  return {
    action: 'agent',
    workingDir: defaults.workingDir,
    workspaceName: defaults.workspaceName,
    ...(includeChatName && defaults.chatName ? { chatName: defaults.chatName } : {}),
    agentPreset: defaults.agentPreset,
    ...(defaults.runtimeProfileId ? { runtimeProfileId: defaults.runtimeProfileId } : {}),
    ...(defaults.model ? { model: defaults.model } : {}),
    ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    useCard: useCard ?? defaults.useCard,
    cotEnabled: cotEnabled ?? defaults.cotEnabled,
    cotToolResultEnabled: cotToolResultEnabled ?? defaults.cotToolResultEnabled,
    sendIntermediateMessages: sendIntermediateMessages ?? defaults.sendIntermediateMessages,
    ...(effectiveReaction ? { receivedReactionEmoji: effectiveReaction } : {}),
    ...(defaults.idleCloseMs ? { idleCloseMs: defaults.idleCloseMs } : {}),
    ...(defaults.roleReminder ? { roleReminder: defaults.roleReminder } : {}),
    ...rest,
    promptText: composeTurnPrompt(rest.turnReminders, rest.userText),
  }
}

function routeP2pMessage(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  defaults: ResolvedRoutingDefaults,
): RoutingDecision {
  if (!isUserAllowedForP2p(bot, msg.senderOpenId)) {
    return { action: 'ignore', reason: 'p2p_not_allowed' }
  }
  const clean = stripBotMentions(msg.text, msg.mentions, msg.botOpenId)
  const p2pScope = bot.p2pSessionMode === 'per_message' ? `msg:${msg.messageId}` : 'p2p'
  const routeKey = buildRouteKey(bot.larkAppId, msg.chatId, p2pScope)
  const cmd = parseSlashCommand(clean)
  if (cmd) {
    return {
      action: 'command',
      command: cmd,
      routeKey: buildRouteKey(bot.larkAppId, msg.chatId, 'p2p'),
      workingDir: defaults.workingDir,
      workspaceName: defaults.workspaceName,
      replyMode: 'chat',
    }
  }
  const p2pReaction = resolveEffectiveReactionEmoji(bot)
  const userText = clean || (msg.imageKeys.length > 0 ? '[图片消息]' : '')
  return buildAgentDecision(defaults, {
    trigger: 'p2p',
    routeKey,
    sessionMode: bot.p2pSessionMode,
    replyMode: 'chat',
    useCard: bot.useInteractiveCard,
    cotEnabled: Boolean(bot.cotEnabled),
    cotToolResultEnabled: bot.cotToolResultEnabled !== false,
    sendIntermediateMessages: bot.sendIntermediateMessages,
    ...(p2pReaction ? { receivedReactionEmoji: p2pReaction } : { omitReceivedReactionEmoji: true }),
    includeChatName: false,
    allowSilentEmptyReply: false,
    autoCloseAfterCompletion: bot.p2pSessionMode === 'per_message',
    turnReminders: [],
    userText,
  })
}

function resolveGroupRoutingContext(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  group: LarkGroupConfig | undefined,
  runtime: RoutingRuntimeContext,
): ResolvedGroupRoutingContext {
  const groupReplyMode = resolveGroupReplyMode(bot, group)
  return {
    ...(group ? { group } : {}),
    groupReplyMode,
    effectiveGroupReplyMode: resolveReplyModeInContext(groupReplyMode, msg),
    groupSessionMode: resolveGroupSessionMode(bot, group),
    mentionTriggerMode: resolveMentionTriggerMode(bot, group),
    threadRouteKey: resolveActiveThreadLookupKey(bot, msg, runtime),
    chatRouteKey: buildRouteKey(bot.larkAppId, msg.chatId, 'chat'),
  }
}

function routeDirectMention(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  defaults: ResolvedRoutingDefaults,
  groupCtx: ResolvedGroupRoutingContext,
  runtime: RoutingRuntimeContext,
): RoutingDecision | undefined {
  const mentionedBot = Boolean(msg.botOpenId && mentionsOpenId(msg, msg.botOpenId))
  if (!mentionedBot) return undefined

  const clean = stripBotMentions(msg.text, msg.mentions, msg.botOpenId)
  const resolvedRoute = resolveSessionRoute(
    bot,
    msg,
    groupCtx.groupSessionMode,
    groupCtx.effectiveGroupReplyMode,
    runtime,
  )
  const cmd = parseSlashCommand(clean)
  if (cmd) {
    const cmdRouteKey =
      groupCtx.groupSessionMode === 'chat' ? groupCtx.chatRouteKey : groupCtx.threadRouteKey
    return {
      action: 'command',
      command: cmd,
      routeKey: cmdRouteKey,
      workingDir: defaults.workingDir,
      workspaceName: defaults.workspaceName,
      replyMode: groupCtx.effectiveGroupReplyMode,
    }
  }
  const userText = clean || (msg.imageKeys.length > 0 ? '[图片消息]' : '')
  return buildAgentDecision(defaults, {
    trigger: 'mention',
    routeKey: resolvedRoute.routeKey,
    ...(resolvedRoute.ephemeralHandoffRouteKey
      ? { ephemeralHandoffRouteKey: resolvedRoute.ephemeralHandoffRouteKey }
      : {}),
    sessionMode: groupCtx.groupSessionMode,
    replyMode: groupCtx.effectiveGroupReplyMode,
    allowSilentEmptyReply: false,
    autoCloseAfterCompletion: groupCtx.groupSessionMode === 'per_message',
    turnReminders: [],
    userText,
  })
}

function evaluateActiveThreadState(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  groupCtx: ResolvedGroupRoutingContext,
  runtime: RoutingRuntimeContext,
): ActiveThreadEvaluation {
  const mainStreamRootAlreadyPromoted = Boolean(
    !msg.threadId &&
      msg.rootId &&
      runtime.isRouteBoundToNativeThread?.(buildRouteKey(bot.larkAppId, msg.chatId, msg.rootId)),
  )
  const hasWorkerSession =
    !mainStreamRootAlreadyPromoted && runtime.hasActiveSessionForRoute(groupCtx.threadRouteKey)
  const hasEphemeralThread =
    !mainStreamRootAlreadyPromoted &&
    !hasWorkerSession &&
    Boolean(runtime.hasEphemeralRouterThread?.(groupCtx.threadRouteKey))
  const existingThreadTrigger = runtime.getRouteTrigger?.(groupCtx.threadRouteKey)
  const hasThreadReplied = runtime.hasRouteReplied?.(groupCtx.threadRouteKey) ?? true
  const allowThreadFollowup =
    existingThreadTrigger === 'substitute'
      ? bot.substituteMode.activeThreadFollowup
      : existingThreadTrigger === 'listener'
        ? hasThreadReplied && groupCtx.mentionTriggerMode === 'mention_and_active_thread'
        : groupCtx.mentionTriggerMode === 'mention_and_active_thread'
  const isActiveThreadContext = Boolean(
    (msg.rootId || msg.threadId) &&
      !mainStreamRootAlreadyPromoted &&
      (hasWorkerSession || hasEphemeralThread),
  )
  const allowSenderInActiveThread =
    msg.senderType !== 'bot' ||
    (existingThreadTrigger === 'listener' &&
      Boolean(groupCtx.group?.listener?.enabled) &&
      isListenerSenderEnabled(groupCtx.group!.listener, msg.senderOpenId, 'bot'))
  const isBarePeerMentionOnly =
    msg.mentions.length > 0 &&
    msg.imageKeys.length === 0 &&
    stripBotMentions(msg.text, msg.mentions).length === 0
  const matchesSubstituteTarget =
    bot.substituteMode.enabled &&
    bot.substituteMode.targets.length > 0 &&
    (msg.msgType === 'text' || msg.msgType === 'post') &&
    bot.substituteMode.targets.some(
      (t) => mentionsOpenId(msg, t.openId) && msg.senderOpenId !== t.openId,
    )
  const delegationEnabled = Boolean(
    bot.experimental.proactive.remindersEnabled &&
      bot.experimental.proactive.delegationFollowupEnabled,
  )
  const peerMentions = extractPeerUserMentions(msg)
  const hasDelegationCandidate =
    delegationEnabled &&
    msg.senderType === 'user' &&
    (msg.msgType === 'text' || msg.msgType === 'post') &&
    peerMentions.length > 0 &&
    stripBotMentions(msg.text, msg.mentions).length > 0

  return {
    hasWorkerSession,
    hasEphemeralThread,
    ...(existingThreadTrigger ? { existingThreadTrigger } : {}),
    allowThreadFollowup,
    isActiveThreadContext,
    allowSenderInActiveThread,
    isBarePeerMentionOnly,
    matchesSubstituteTarget,
    hasDelegationCandidate,
  }
}

function routeActiveThreadFollowup(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  defaults: ResolvedRoutingDefaults,
  groupCtx: ResolvedGroupRoutingContext,
  state: ActiveThreadEvaluation,
): RoutingDecision | undefined {
  if (state.isActiveThreadContext && msg.msgType === 'sticker') {
    // Standalone Feishu stickers carry no text or @mention; ignore zero-cost in unmentioned threads.
    return { action: 'ignore', reason: 'no_matching_rule' }
  }
  if (state.isActiveThreadContext && !state.allowSenderInActiveThread) {
    // Never fall through to passive listeners when a peer bot posts in an active thread
    // (otherwise a bot-enabled `scope: 'all'` listener would re-trigger a multi-bot loop).
    return { action: 'ignore', reason: 'no_matching_rule' }
  }
  if (state.isActiveThreadContext && state.isBarePeerMentionOnly && !state.matchesSubstituteTarget) {
    return { action: 'ignore', reason: 'no_matching_rule' }
  }
  if (
    !state.allowThreadFollowup ||
    !state.allowSenderInActiveThread ||
    state.isBarePeerMentionOnly ||
    !state.isActiveThreadContext
  ) {
    return undefined
  }

  const clean = replaceMentionKeysWithNames(msg.text, msg.mentions)
  const cmd = parseSlashCommand(clean)
  const activeThreadReplyMode: GroupReplyMode = msg.threadId
    ? 'new-topic'
    : state.existingThreadTrigger === 'listener' && groupCtx.group?.listener
      ? groupCtx.group.listener.replyMode
      : groupCtx.groupReplyMode
  if (cmd) {
    return {
      action: 'command',
      command: cmd,
      routeKey: groupCtx.threadRouteKey,
      workingDir: defaults.workingDir,
      workspaceName: defaults.workspaceName,
      replyMode: activeThreadReplyMode,
    }
  }
  const userText = clean || (msg.imageKeys.length > 0 ? '[图片消息]' : '')
  const allowSilentEmptyReply =
    state.existingThreadTrigger === 'listener'
      ? (groupCtx.group?.listener?.allowSilentEmptyReply ?? true)
      : false
  const turnReminders = state.hasDelegationCandidate
    ? [buildDelegationFollowupReminder(msg, 'assist')]
    : []
  const forksEphemeralToNewTopic =
    !msg.threadId &&
    Boolean(msg.rootId) &&
    activeThreadReplyMode === 'new-topic' &&
    !state.hasWorkerSession &&
    state.hasEphemeralThread
  const activeRouteKey = forksEphemeralToNewTopic
    ? buildRouteKey(bot.larkAppId, msg.chatId, msg.messageId)
    : groupCtx.threadRouteKey
  return buildAgentDecision(defaults, {
    trigger: 'active-thread',
    routeKey: activeRouteKey,
    ...(forksEphemeralToNewTopic ? { ephemeralHandoffRouteKey: groupCtx.threadRouteKey } : {}),
    sessionMode: 'thread',
    replyMode: activeThreadReplyMode,
    cotEnabled: !allowSilentEmptyReply && defaults.cotEnabled,
    allowSilentEmptyReply,
    autoCloseAfterCompletion: false,
    ...(state.hasDelegationCandidate ? { delegationFollowup: true } : {}),
    turnReminders,
    userText,
  })
}

function routeSubstituteMode(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  defaults: ResolvedRoutingDefaults,
  groupCtx: ResolvedGroupRoutingContext,
  runtime: RoutingRuntimeContext,
): RoutingDecision | undefined {
  const sub = bot.substituteMode
  if (!sub.enabled || sub.targets.length === 0 || (msg.msgType !== 'text' && msg.msgType !== 'post')) {
    return undefined
  }
  const matchedTarget = sub.targets.find((t) => mentionsOpenId(msg, t.openId))
  if (!matchedTarget || msg.senderOpenId === matchedTarget.openId) {
    return undefined
  }
  const effectiveSubSessionMode: GroupSessionMode =
    sub.activeThreadFollowup && groupCtx.groupSessionMode === 'per_message'
      ? 'thread'
      : groupCtx.groupSessionMode
  const resolvedSubRoute = resolveSessionRoute(
    bot,
    msg,
    effectiveSubSessionMode,
    groupCtx.effectiveGroupReplyMode,
    runtime,
  )
  const userText = replaceMentionKeysWithNames(msg.text, msg.mentions) || `[${msg.msgType}]`
  const turnReminders = [buildSubstituteReminder(matchedTarget.name, sub.disclosure, msg)]
  return buildAgentDecision(defaults, {
    trigger: 'substitute',
    routeKey: resolvedSubRoute.routeKey,
    ...(resolvedSubRoute.ephemeralHandoffRouteKey
      ? { ephemeralHandoffRouteKey: resolvedSubRoute.ephemeralHandoffRouteKey }
      : {}),
    sessionMode: effectiveSubSessionMode,
    replyMode: groupCtx.effectiveGroupReplyMode,
    allowSilentEmptyReply: false,
    autoCloseAfterCompletion:
      !sub.activeThreadFollowup || effectiveSubSessionMode === 'per_message',
    turnReminders,
    userText,
  })
}

function routePassiveListener(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  defaults: ResolvedRoutingDefaults,
  groupCtx: ResolvedGroupRoutingContext,
  hasDelegationCandidate: boolean,
  runtime: RoutingRuntimeContext,
): { readonly decision?: RoutingDecision; readonly ignoreReason?: string } {
  const listener = groupCtx.group?.listener
  if (!listener?.enabled) return {}
  const check = matchesListenerRule(listener, msg)
  if (!check.ok) {
    return { ignoreReason: check.reason ?? 'listener_filtered' }
  }
  const effectiveListenerReplyMode = resolveReplyModeInContext(listener.replyMode, msg)
  const resolvedListenerRoute = resolveSessionRoute(
    bot,
    msg,
    listener.sessionMode,
    effectiveListenerReplyMode,
    runtime,
  )
  const userText = replaceMentionKeysWithNames(msg.text, msg.mentions) || `[${msg.msgType}]`
  const turnReminders = [
    buildListenerReminder(listener, msg),
    ...(hasDelegationCandidate ? [buildDelegationFollowupReminder(msg, 'assist')] : []),
  ]
  return {
    decision: buildAgentDecision(defaults, {
      trigger: 'listener',
      routeKey: resolvedListenerRoute.routeKey,
      ...(resolvedListenerRoute.ephemeralHandoffRouteKey
        ? { ephemeralHandoffRouteKey: resolvedListenerRoute.ephemeralHandoffRouteKey }
        : {}),
      sessionMode: listener.sessionMode,
      replyMode: effectiveListenerReplyMode,
      cotEnabled: !listener.allowSilentEmptyReply && defaults.cotEnabled,
      allowSilentEmptyReply: listener.allowSilentEmptyReply,
      autoCloseAfterCompletion:
        listener.autoCloseAfterCompletion || listener.sessionMode === 'per_message',
      ...(hasDelegationCandidate ? { delegationFollowup: true } : {}),
      turnReminders,
      userText,
      ...(listener.name ? { listenerName: listener.name } : {}),
      ...(!msg.threadId && listener.debounceSeconds > 0
        ? { listenerDebounceMs: listener.debounceSeconds * 1000 }
        : {}),
    }),
  }
}

function routeSilentDelegationObserver(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  defaults: ResolvedRoutingDefaults,
  runtime: RoutingRuntimeContext,
): RoutingDecision {
  const resolvedDelegationRoute = resolveSessionRoute(
    bot,
    msg,
    'per_message',
    'new-topic',
    runtime,
  )
  const userText = replaceMentionKeysWithNames(msg.text, msg.mentions) || `[${msg.msgType}]`
  const turnReminders = [buildDelegationFollowupReminder(msg, 'silent_only')]
  return buildAgentDecision(defaults, {
    trigger: 'listener',
    routeKey: resolvedDelegationRoute.routeKey,
    sessionMode: 'per_message',
    replyMode: 'new-topic',
    cotEnabled: false,
    cotToolResultEnabled: false,
    sendIntermediateMessages: false,
    omitReceivedReactionEmoji: true,
    allowSilentEmptyReply: true,
    autoCloseAfterCompletion: true,
    silentOnly: true,
    delegationFollowup: true,
    turnReminders,
    userText,
    listenerName: '委派事项跟进',
  })
}

export function decideLarkRouting(
  bot: LarkBotConfig,
  msg: InboundLarkMessage,
  runtime: RoutingRuntimeContext,
): RoutingDecision {
  if (!bot.enabled) {
    return { action: 'ignore', reason: 'bot_disabled' }
  }
  if (msg.botOpenId && msg.senderOpenId === msg.botOpenId) {
    return { action: 'ignore', reason: 'self_message' }
  }

  const group = msg.chatType === 'group' ? runtime.groupConfig : undefined
  const defaults = resolveRoutingDefaults(bot, msg, group, runtime)

  // 1. Direct P2P chat
  if (msg.chatType === 'p2p') {
    return routeP2pMessage(bot, msg, defaults)
  }

  // Group gate
  if (!isGroupEnabled(bot, group)) {
    return { action: 'ignore', reason: 'group_disabled' }
  }

  const groupCtx = resolveGroupRoutingContext(bot, msg, group, runtime)

  // 2. Group chat: direct @bot mention
  const mentionDecision = routeDirectMention(bot, msg, defaults, groupCtx, runtime)
  if (mentionDecision) return mentionDecision

  // 3. Group chat: active thread continuation (without re-mentioning agent)
  const activeThreadState = evaluateActiveThreadState(bot, msg, groupCtx, runtime)
  const activeThreadDecision = routeActiveThreadFollowup(
    bot,
    msg,
    defaults,
    groupCtx,
    activeThreadState,
  )
  if (activeThreadDecision) return activeThreadDecision

  // 4. Group chat: substituteMode (@target human)
  const substituteDecision = routeSubstituteMode(bot, msg, defaults, groupCtx, runtime)
  if (substituteDecision) return substituteDecision

  // 5. Group chat: passive listener rule configured on group
  const listenerResult = routePassiveListener(
    bot,
    msg,
    defaults,
    groupCtx,
    activeThreadState.hasDelegationCandidate,
    runtime,
  )
  if (listenerResult.decision) return listenerResult.decision

  // 6. Group chat: silent proactive delegation observer (`A @ B <task>`)
  if (activeThreadState.hasDelegationCandidate) {
    return routeSilentDelegationObserver(bot, msg, defaults, runtime)
  }

  return { action: 'ignore', reason: listenerResult.ignoreReason ?? 'no_matching_rule' }
}
