import { extname } from 'node:path'
import { Readable } from 'node:stream'
import * as lark from '@larksuiteoapi/node-sdk'
import { buildLarkPostPayload } from './markdown.js'
import { parseLarkMessageContent } from './message-parser.js'
import { hasVisibleText } from './reply-text.js'
import type {
  DiscoveredLarkChat,
  InboundLarkMessage,
  LarkBotConfig,
  LarkChatMember,
  LarkDirectoryUserHit,
  LarkDownloadedResource,
  LarkHistoryMessage,
  LarkMention,
  LarkMessageDetail,
  LarkResourceRef,
  LarkUserSearchHit,
} from './types.js'

export interface CardActionEvent {
  readonly botId: string
  readonly larkAppId: string
  readonly operatorOpenId?: string
  readonly actionValue: Record<string, unknown>
  readonly messageId?: string
}

export interface LarkBotProfile {
  readonly openId?: string
  readonly name?: string
  readonly avatarUrl?: string
  readonly description?: string
}

export interface ListChatMembersOptions {
  readonly userAccessToken?: string
  readonly userDirectoryLookup?: (
    queries: readonly string[],
  ) => Promise<readonly LarkDirectoryUserHit[]>
  readonly resolveBotAvatar?: (bot: {
    readonly openId: string
    readonly name: string
    readonly larkAppId?: string
  }) => Promise<string | undefined> | string | undefined
}

export interface LarkTransportCallbacks {
  readonly onMessage: (message: InboundLarkMessage) => Promise<void> | void
  readonly onCardAction?: (
    action: CardActionEvent,
  ) => Promise<{ toast?: string } | void> | { toast?: string } | void
  readonly onChatMembershipChange?: () => Promise<void> | void
  readonly onStatusChange?: () => void
  readonly onBotProfile?: (profile: LarkBotProfile) => void
  readonly logger?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface SendLarkReplyOptions {
  readonly chatId: string
  readonly replyToMessageId?: string
  readonly replyMode: 'new-topic' | 'reply' | 'chat'
  readonly text?: string
  readonly card?: Record<string, unknown>
}

export interface SendLarkProactiveOptions {
  readonly receiveIdType?: 'chat_id' | 'open_id'
  readonly receiveId?: string
  readonly replyToMessageId?: string
  readonly replyInThread?: boolean
  readonly msgType: 'text' | 'post' | 'interactive' | 'image' | 'file'
  readonly content: string
}

function inferLarkUploadFileType(
  fileName: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = extname(fileName).toLowerCase()
  if (ext === '.opus') return 'opus'
  if (ext === '.mp4') return 'mp4'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.doc' || ext === '.docx') return 'doc'
  if (ext === '.xls' || ext === '.xlsx' || ext === '.csv') return 'xls'
  if (ext === '.ppt' || ext === '.pptx') return 'ppt'
  return 'stream'
}

function extractMessageResources(msgType: string, rawContent: string): LarkResourceRef[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const rec = parsed as Record<string, unknown>
  const out: LarkResourceRef[] = []

  if (msgType === 'image' && typeof rec.image_key === 'string' && rec.image_key) {
    out.push({ type: 'image', key: rec.image_key, name: `${rec.image_key}.png` })
    return out
  }
  if (
    (msgType === 'file' || msgType === 'media' || msgType === 'audio') &&
    typeof rec.file_key === 'string' &&
    rec.file_key
  ) {
    const fileName =
      typeof rec.file_name === 'string' && rec.file_name.trim()
        ? rec.file_name.trim()
        : rec.file_key
    out.push({ type: 'file', key: rec.file_key, name: fileName })
    return out
  }

  const seen = new Set<string>()
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const obj = node as Record<string, unknown>
    for (const k of ['image_key', 'img_key']) {
      const val = obj[k]
      if (typeof val === 'string' && val && !seen.has(val)) {
        seen.add(val)
        out.push({ type: 'image', key: val, name: `${val}.png` })
      }
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v)
    }
  }
  walk(rec)
  return out
}

export interface SendLarkReplyResult {
  readonly messageId?: string
  readonly rootId?: string
  readonly threadId?: string
}

interface CachedUserDetail {
  readonly openId: string
  readonly name: string
  readonly enName?: string
  readonly email?: string
  readonly avatarUrl?: string
  readonly cachedAtMs: number
}

const USER_DETAIL_TTL_MS = 30 * 60_000
const CONTACT_DENIED_TTL_MS = 5 * 60_000

async function searchDirectoryWithUserToken(
  query: string,
  userAccessToken: string,
): Promise<LarkDirectoryUserHit[]> {
  const q = query.trim()
  if (!q || !userAccessToken) return []
  const url = new URL('https://open.feishu.cn/open-apis/search/v1/user')
  url.searchParams.set('query', q)
  url.searchParams.set('page_size', '20')
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${userAccessToken}`,
      accept: 'application/json',
    },
  })
  if (!res.ok) return []
  const body = (await res.json()) as {
    data?: {
      users?: Array<{
        open_id?: string
        user_id?: string
        name?: string
        en_name?: string
        email?: string
        avatar?: { avatar_72?: string; avatar_240?: string; avatar_origin?: string }
      }>
    }
  }
  const out: LarkDirectoryUserHit[] = []
  for (const u of body?.data?.users ?? []) {
    const openId = u.open_id?.trim()
    if (!openId) continue
    const userId = u.user_id?.trim() || undefined
    const avatarUrl = u.avatar?.avatar_72 || u.avatar?.avatar_240 || u.avatar?.avatar_origin
    out.push({
      openId,
      ...(userId ? { userId } : {}),
      name: u.name || u.en_name || openId,
      ...(u.en_name ? { enName: u.en_name } : {}),
      ...(u.email ? { email: u.email } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    })
  }
  return out
}

function pickDirectoryMatch(
  member: { readonly openId: string; readonly name: string; readonly userId?: string },
  candidates: readonly LarkDirectoryUserHit[],
): LarkDirectoryUserHit | undefined {
  const byOpenId = candidates.find((c) => c.openId === member.openId && c.avatarUrl)
  if (byOpenId) return byOpenId
  if (member.userId) {
    const byUserId = candidates.find((c) => c.userId === member.userId && c.avatarUrl)
    if (byUserId) return byUserId
  }
  const exactName = candidates.filter((c) => c.name === member.name && c.avatarUrl)
  if (exactName.length === 1) return exactName[0]
  return undefined
}

export class LarkBotTransport {
  private readonly client: lark.Client
  private wsClient?: lark.WSClient
  private startPromise?: Promise<void>
  private lifecycleEpoch = 0
  private botOpenId?: string
  private botAvatarUrl?: string
  private botDescription?: string
  private remoteBotName?: string
  private connected = false
  private startedAtMs?: number
  private lastEventAtMs?: number
  private lastError?: string
  private readonly userCache = new Map<string, CachedUserDetail>()
  private readonly contactDeniedUntilMs = new Map<string, number>()
  private readonly observedChatBots = new Map<string, Map<string, string>>()

  constructor(
    private readonly bot: LarkBotConfig,
    private readonly callbacks: LarkTransportCallbacks,
  ) {
    this.client = new lark.Client({
      appId: bot.larkAppId,
      appSecret: bot.larkAppSecret,
      disableTokenCache: false,
    })
    if (bot.avatarUrl) {
      this.botAvatarUrl = bot.avatarUrl
    }
    if (bot.description) {
      this.botDescription = bot.description
    }
  }

  get state() {
    return {
      botId: this.bot.id,
      larkAppId: this.bot.larkAppId,
      name: this.bot.name,
      ...(this.botAvatarUrl ? { avatarUrl: this.botAvatarUrl } : {}),
      ...(this.botDescription ? { description: this.botDescription } : {}),
      ...(this.remoteBotName ? { remoteBotName: this.remoteBotName } : {}),
      enabled: this.bot.enabled,
      connected: this.connected,
      botOpenId: this.botOpenId,
      startedAtMs: this.startedAtMs,
      lastEventAtMs: this.lastEventAtMs,
      lastError: this.lastError,
    }
  }

  async start(): Promise<void> {
    if (this.wsClient) return
    if (this.startPromise) return this.startPromise

    const epoch = ++this.lifecycleEpoch
    const startTask = this.startInternal(epoch)
    this.startPromise = startTask
    try {
      await startTask
    } finally {
      if (this.startPromise === startTask) {
        this.startPromise = undefined
      }
    }
  }

  private async startInternal(epoch: number): Promise<void> {
    this.startedAtMs = Date.now()
    this.lastError = undefined

    try {
      await this.fetchBotProfile()
    } catch (err) {
      this.log('warn', `fetch bot info failed for ${this.bot.name}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (epoch !== this.lifecycleEpoch) return

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => {
        if (epoch !== this.lifecycleEpoch) return
        this.lastEventAtMs = Date.now()
        try {
          const parsed = this.normalizeReceiveEvent(data)
          if (!parsed) return
          if (parsed.senderType === 'bot' && parsed.senderOpenId && parsed.senderOpenId !== this.botOpenId) {
            let botsInChat = this.observedChatBots.get(parsed.chatId)
            if (!botsInChat) {
              botsInChat = new Map()
              this.observedChatBots.set(parsed.chatId, botsInChat)
            }
            if (!botsInChat.has(parsed.senderOpenId)) {
              botsInChat.set(parsed.senderOpenId, parsed.senderOpenId)
            }
          }
          // Return immediately so WSClient ACKs Feishu well within the 3-second deadline
          // instead of triggering duplicate server retries during long-running agent turns.
          void Promise.resolve()
            .then(() => this.callbacks.onMessage(parsed))
            .catch((err) => {
              this.lastError = err instanceof Error ? err.message : String(err)
              this.log('error', `im.message.receive_v1 handler failed: ${this.lastError}`)
            })
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err)
          this.log('error', `im.message.receive_v1 normalize failed: ${this.lastError}`)
        }
      },
      'card.action.trigger': async (data: unknown) => {
        if (epoch !== this.lifecycleEpoch) return {}
        this.lastEventAtMs = Date.now()
        try {
          const event = this.normalizeCardAction(data)
          if (!event || !this.callbacks.onCardAction) return {}
          const result = await this.callbacks.onCardAction(event)
          if (result?.toast) {
            return { toast: { type: 'info', content: result.toast } }
          }
          return {}
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err)
          this.log('error', `card.action.trigger handler failed: ${this.lastError}`)
          return { toast: { type: 'error', content: '操作处理失败' } }
        }
      },
      'im.message.reaction.created_v1': () => {},
      'im.message.reaction.deleted_v1': () => {},
      'im.message.updated_v1': () => {},
      'im.chat.member.bot.added_v1': () => {
        if (epoch !== this.lifecycleEpoch) return
        this.lastEventAtMs = Date.now()
        void Promise.resolve(this.callbacks.onChatMembershipChange?.()).catch(() => {})
      },
      'im.chat.member.bot.deleted_v1': () => {
        if (epoch !== this.lifecycleEpoch) return
        this.lastEventAtMs = Date.now()
        void Promise.resolve(this.callbacks.onChatMembershipChange?.()).catch(() => {})
      },
    })

    const ws = new lark.WSClient({
      appId: this.bot.larkAppId,
      appSecret: this.bot.larkAppSecret,
      loggerLevel: lark.LoggerLevel.warn,
    })
    if (epoch !== this.lifecycleEpoch) {
      try {
        ws.close({ force: true })
      } catch {
        // Best-effort cleanup.
      }
      return
    }
    this.wsClient = ws

    try {
      await ws.start({ eventDispatcher: dispatcher })
    } catch (err) {
      if (this.wsClient === ws) {
        this.wsClient = undefined
        this.connected = false
      }
      try {
        ws.close({ force: true })
      } catch {
        // Best-effort cleanup.
      }
      throw err
    }

    if (epoch !== this.lifecycleEpoch || this.wsClient !== ws) {
      try {
        ws.close({ force: true })
      } catch {
        // Best-effort cleanup.
      }
      return
    }

    this.connected = true
    this.callbacks.onStatusChange?.()
    this.log('info', `Lark WSClient connected for bot "${this.bot.name}" (${this.bot.larkAppId})`)
  }

  async stop(): Promise<void> {
    this.lifecycleEpoch += 1
    this.startPromise = undefined
    const ws = this.wsClient
    this.wsClient = undefined
    this.connected = false
    if (ws) {
      try {
        ws.close({ force: true })
      } catch {
        // SDK close best-effort.
      }
    }
    this.callbacks.onStatusChange?.()
  }

  async fetchBotProfile(): Promise<LarkBotProfile> {
    const res = (await this.client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info/',
    })) as {
      bot?: { open_id?: string; app_name?: string; avatar_url?: string }
      data?: { bot?: { open_id?: string; app_name?: string; avatar_url?: string } }
    }
    const info = res?.bot ?? res?.data?.bot
    const openId = info?.open_id?.trim() || undefined
    let name = info?.app_name?.trim() || undefined
    let avatarUrl = info?.avatar_url?.trim() || undefined
    let description: string | undefined

    try {
      const appRes = (await this.client.request({
        method: 'GET',
        url: `/open-apis/application/v6/applications/${encodeURIComponent(this.bot.larkAppId)}`,
        params: { lang: 'zh_cn' },
      })) as {
        app?: {
          app_name?: string
          avatar_url?: string
          description?: string
          i18n?: Array<{ i18n_key?: string; name?: string; description?: string }>
        }
        data?: {
          app?: {
            app_name?: string
            avatar_url?: string
            description?: string
            i18n?: Array<{ i18n_key?: string; name?: string; description?: string }>
          }
        }
      }
      const app = appRes?.data?.app ?? appRes?.app
      if (app) {
        const i18nList = Array.isArray(app.i18n) ? app.i18n : []
        const zhEntry = i18nList.find((item) => item?.i18n_key === 'zh_cn')
        const descCandidate =
          zhEntry?.description?.trim() ??
          i18nList.find((item) => item?.description?.trim())?.description?.trim() ??
          app.description?.trim()
        if (descCandidate) {
          description = descCandidate
        }
        if (!avatarUrl && app.avatar_url?.trim()) {
          avatarUrl = app.avatar_url.trim()
        }
        if (!name) {
          name = zhEntry?.name?.trim() || app.app_name?.trim() || undefined
        }
      }
    } catch {
      // Optional scope (application:application:self_manage); degrade gracefully.
    }

    if (openId) this.botOpenId = openId
    if (name) this.remoteBotName = name
    if (avatarUrl) this.botAvatarUrl = avatarUrl
    if (description) this.botDescription = description
    const profile: LarkBotProfile = {
      ...(openId ? { openId } : {}),
      ...(name ? { name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(description ? { description } : {}),
    }
    if (openId || avatarUrl || name || description) {
      this.callbacks.onBotProfile?.(profile)
    }
    return profile
  }

  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      return (res as { data?: { reaction_id?: string } })?.data?.reaction_id
    } catch (err) {
      this.log('warn', `addReaction(${emojiType}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    } catch {
      // Best-effort cleanup.
    }
  }

  async downloadResourceBuffer(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<Buffer | undefined> {
    try {
      const res = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })
      const stream = (res as { getReadableStream?: () => NodeJS.ReadableStream })?.getReadableStream?.()
      if (!stream) return undefined
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      return Buffer.concat(chunks)
    } catch (err) {
      this.log(
        'warn',
        `downloadResource(${type}:${fileKey}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  async downloadImageAsBase64(messageId: string, imageKey: string): Promise<string | undefined> {
    const buf = await this.downloadResourceBuffer(messageId, imageKey, 'image')
    return buf?.toString('base64')
  }

  async uploadImageBuffer(buffer: Buffer): Promise<string> {
    const res = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: Readable.from([buffer]) as unknown as Buffer,
      },
    })
    const key = (res as { image_key?: string; data?: { image_key?: string } })?.image_key ??
      (res as { data?: { image_key?: string } })?.data?.image_key
    if (!key) throw new Error('Failed to upload image to Lark (missing image_key)')
    return key
  }

  async uploadFileBuffer(
    buffer: Buffer,
    fileName: string,
  ): Promise<{ fileKey: string; fileName: string }> {
    const safeName = fileName.trim() || 'attachment.bin'
    const res = await this.client.im.file.create({
      data: {
        file_type: inferLarkUploadFileType(safeName),
        file_name: safeName,
        file: Readable.from([buffer]) as unknown as Buffer,
      },
    })
    const key = (res as { file_key?: string; data?: { file_key?: string } })?.file_key ??
      (res as { data?: { file_key?: string } })?.data?.file_key
    if (!key) throw new Error('Failed to upload file to Lark (missing file_key)')
    return { fileKey: key, fileName: safeName }
  }

  async sendProactiveMessage(options: SendLarkProactiveOptions): Promise<SendLarkReplyResult> {
    if (options.replyToMessageId) {
      const res = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          msg_type: options.msgType,
          content: options.content,
          reply_in_thread: Boolean(options.replyInThread),
        },
      })
      const data = (res as { data?: { message_id?: string; root_id?: string; thread_id?: string } })?.data
      return {
        messageId: data?.message_id,
        rootId: data?.root_id,
        threadId: data?.thread_id,
      }
    }
    if (!options.receiveId) {
      throw new Error('receiveId or replyToMessageId is required')
    }
    const res = await this.client.im.message.create({
      params: { receive_id_type: options.receiveIdType ?? 'chat_id' },
      data: {
        receive_id: options.receiveId,
        msg_type: options.msgType,
        content: options.content,
      },
    })
    const data = (res as { data?: { message_id?: string; root_id?: string; thread_id?: string } })?.data
    return {
      messageId: data?.message_id,
      rootId: data?.root_id,
      threadId: data?.thread_id,
    }
  }

  async sendReply(options: SendLarkReplyOptions): Promise<SendLarkReplyResult> {
    if (!options.card && !hasVisibleText(options.text ?? '')) {
      this.log(
        'warn',
        `Refused to send blank reply to chat ${options.chatId} (replyTo=${options.replyToMessageId ?? '-'})`,
      )
      return {}
    }

    const msgType = options.card ? 'interactive' : 'post'
    const content = options.card
      ? JSON.stringify(options.card)
      : JSON.stringify(buildLarkPostPayload(options.text ?? ''))

    if (options.replyToMessageId && options.replyMode !== 'chat') {
      const res = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          msg_type: msgType,
          content,
          reply_in_thread: options.replyMode === 'new-topic',
        },
      })
      const data = (res as { data?: { message_id?: string; root_id?: string; thread_id?: string } })?.data
      return {
        messageId: data?.message_id,
        rootId: data?.root_id,
        threadId: data?.thread_id,
      }
    }

    const res = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: options.chatId,
        msg_type: msgType,
        content,
      },
    })
    const data = (res as { data?: { message_id?: string; root_id?: string; thread_id?: string } })?.data
    return {
      messageId: data?.message_id,
      rootId: data?.root_id,
      threadId: data?.thread_id,
    }
  }

  async patchMessageCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
    } catch (err) {
      this.log(
        'warn',
        `patchMessageCard(${messageId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async listJoinedChats(): Promise<DiscoveredLarkChat[]> {
    const out: DiscoveredLarkChat[] = []
    let pageToken: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const res = await this.client.im.chat.list({
        params: {
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })
      const items = res.data?.items ?? []
      for (const item of items) {
        if (!item.chat_id) continue
        out.push({
          botId: this.bot.id,
          botName: this.bot.name,
          larkAppId: this.bot.larkAppId,
          chatId: item.chat_id,
          name: item.name || item.chat_id,
          ...(item.description ? { description: item.description } : {}),
          ...(item.avatar ? { avatar: item.avatar } : {}),
          ...(item.owner_id ? { ownerId: item.owner_id } : {}),
        })
      }
      if (!res.data?.has_more || !res.data?.page_token) break
      pageToken = res.data.page_token
    }
    return out
  }

  /**
   * Lists both human members and bots/agents in a group chat (excluding this bot itself).
   */
  async listChatMembersAndBots(
    chatId: string,
    options: ListChatMembersOptions = {},
  ): Promise<LarkChatMember[]> {
    if (!this.botOpenId) {
      await this.fetchBotProfile().catch(() => {})
    }
    const members = new Map<string, LarkChatMember>()
    const botAppIds = new Map<string, string>()

    // 0. Query /members/list first to capture bot app_id (`cli_xxx`) mappings
    try {
      let pageToken: string | undefined
      for (let page = 0; page < 5; page += 1) {
        const res = (await this.client.request({
          method: 'GET',
          url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/list`,
          params: {
            member_id_type: 'open_id',
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        })) as {
          data?: {
            bots?: Array<{ app_id?: string; member_id?: string; name?: string; avatar?: string }>
            has_more?: boolean
            page_token?: string
          }
        }
        for (const b of res?.data?.bots ?? []) {
          const botOpenId = b.member_id?.trim()
          if (!botOpenId || botOpenId === this.botOpenId) continue
          const appId = b.app_id?.trim() || undefined
          if (appId) botAppIds.set(botOpenId, appId)
          members.set(botOpenId, {
            openId: botOpenId,
            name: b.name?.trim() || botOpenId,
            memberType: 'bot',
            ...(appId ? { larkAppId: appId } : {}),
            ...(b.avatar ? { avatarUrl: b.avatar } : {}),
          })
        }
        if (!res?.data?.has_more || !res?.data?.page_token) break
        pageToken = res.data.page_token
      }
    } catch {
      // Fallback to /members/bots below.
    }

    // 1. Members via im.chatMembers.get (separating human users from `is_agent: true` AI agents)
    try {
      let pageToken: string | undefined
      for (let page = 0; page < 5; page += 1) {
        const res = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: {
            member_id_type: 'open_id',
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        })
        for (const item of res.data?.items ?? []) {
          const openId = item.member_id?.trim()
          if (!openId || openId === this.botOpenId) continue
          const isAgent = Boolean((item as { is_agent?: boolean }).is_agent)
          if (isAgent) {
            const existingBot = members.get(openId)
            members.set(openId, {
              openId,
              name: item.name || existingBot?.name || openId,
              memberType: 'bot',
              ...(existingBot?.larkAppId ? { larkAppId: existingBot.larkAppId } : {}),
              ...(existingBot?.avatarUrl ? { avatarUrl: existingBot.avatarUrl } : {}),
            })
            continue
          }
          const detail = await this.lookupUserDetail(openId, item.name || openId)
          members.set(openId, {
            openId,
            name: detail?.name || item.name || openId,
            memberType: 'user',
            ...(detail?.avatarUrl ? { avatarUrl: detail.avatarUrl } : {}),
            ...(detail?.email ? { email: detail.email } : {}),
          })
        }
        if (!res.data?.has_more || !res.data?.page_token) break
        pageToken = res.data.page_token
      }
    } catch (err) {
      this.log('warn', `listChatMembers(${chatId}) human members failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 2. Bot members via /open-apis/im/v1/chats/:chatId/members/bots
    try {
      let pageToken: string | undefined
      for (let page = 0; page < 3; page += 1) {
        const res = (await this.client.request({
          method: 'GET',
          url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/bots`,
          params: {
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        })) as {
          data?: {
            bots?: Array<{ bot_id?: string; bot_name?: string; avatar?: string }>
            items?: Array<{ bot_id?: string; bot_name?: string; member_id?: string; name?: string; avatar?: string }>
            has_more?: boolean
            page_token?: string
          }
        }
        const list = res?.data?.bots ?? res?.data?.items ?? []
        for (const b of list) {
          const botOpenId = (b.bot_id ?? (b as { member_id?: string }).member_id ?? '').trim()
          if (!botOpenId || botOpenId === this.botOpenId) continue
          const botName = (b.bot_name ?? (b as { name?: string }).name ?? botOpenId).trim()
          const existing = members.get(botOpenId)
          const appId = existing?.larkAppId ?? botAppIds.get(botOpenId)
          const avatarUrl = b.avatar || existing?.avatarUrl
          members.set(botOpenId, {
            openId: botOpenId,
            name: botName || existing?.name || botOpenId,
            memberType: 'bot',
            ...(appId ? { larkAppId: appId } : {}),
            ...(avatarUrl ? { avatarUrl } : {}),
          })
        }
        if (!res?.data?.has_more || !res?.data?.page_token) break
        pageToken = res.data.page_token
      }
    } catch (err) {
      this.log('warn', `listChatMembers(${chatId}) bots failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 3. Merge any observed bot senders seen in live messages for this chat
    const observed = this.observedChatBots.get(chatId)
    if (observed) {
      for (const [openId, label] of observed) {
        if (openId !== this.botOpenId && !members.has(openId)) {
          members.set(openId, { openId, name: label, memberType: 'bot' })
        }
      }
    }

    // 4. Enrich human members missing avatars (e.g. outside app Contact Scope -> 41050)
    const missingUsers = [...members.values()].filter(
      (m) => m.memberType === 'user' && !m.avatarUrl && m.name && !m.name.startsWith('ou_'),
    )
    if (missingUsers.length > 0 && (options.userDirectoryLookup || options.userAccessToken)) {
      const userIdByName = new Map<string, string>()
      try {
        const uidRes = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'user_id', page_size: 100 },
        })
        const counts = new Map<string, number>()
        for (const it of uidRes.data?.items ?? []) {
          if (Boolean((it as { is_agent?: boolean }).is_agent) || !it.name) continue
          counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
        }
        for (const it of uidRes.data?.items ?? []) {
          if (
            !Boolean((it as { is_agent?: boolean }).is_agent) &&
            it.name &&
            it.member_id &&
            counts.get(it.name) === 1
          ) {
            userIdByName.set(it.name, it.member_id.trim())
          }
        }
      } catch {
        // Optional contact:user.employee_id:readonly scope; name/openId matching still works.
      }

      const uniqueQueries = [...new Set(missingUsers.map((m) => m.name.trim()).filter(Boolean))]
      let candidates: readonly LarkDirectoryUserHit[] = []
      try {
        if (options.userDirectoryLookup) {
          candidates = await options.userDirectoryLookup(uniqueQueries)
        } else if (options.userAccessToken) {
          const batches = await Promise.all(
            uniqueQueries.map((q) =>
              searchDirectoryWithUserToken(q, options.userAccessToken!).catch(() => []),
            ),
          )
          candidates = batches.flat()
        }
      } catch {
        candidates = []
      }

      if (candidates.length > 0) {
        for (const m of missingUsers) {
          const userId = m.userId ?? userIdByName.get(m.name)
          const matched = pickDirectoryMatch(
            { openId: m.openId, name: m.name, ...(userId ? { userId } : {}) },
            candidates,
          )
          if (!matched?.avatarUrl) continue
          const enriched: CachedUserDetail = {
            openId: m.openId,
            name: m.name,
            ...(matched.enName ? { enName: matched.enName } : {}),
            ...(matched.email || m.email ? { email: matched.email || m.email } : {}),
            avatarUrl: matched.avatarUrl,
            cachedAtMs: Date.now(),
          }
          this.userCache.set(m.openId, enriched)
          members.set(m.openId, {
            ...m,
            ...(userId ? { userId } : {}),
            ...(enriched.email ? { email: enriched.email } : {}),
            avatarUrl: matched.avatarUrl,
          })
        }
      }
    }

    // 5. Enrich bot avatars when resolver is available (e.g. peer bots in bridge or platform cache)
    if (options.resolveBotAvatar) {
      const missingBots = [...members.values()].filter((m) => m.memberType === 'bot' && !m.avatarUrl)
      await Promise.all(
        missingBots.map(async (b) => {
          try {
            const avatarUrl = await options.resolveBotAvatar!({
              openId: b.openId,
              name: b.name,
              ...(b.larkAppId ? { larkAppId: b.larkAppId } : {}),
            })
            if (avatarUrl) {
              members.set(b.openId, { ...b, avatarUrl })
            }
          } catch {
            // Best-effort bot avatar lookup.
          }
        }),
      )
    }

    return [...members.values()].sort((a, b) => {
      if (a.memberType !== b.memberType) return a.memberType === 'user' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  }

  /**
   * Searches users across:
   * 1. Enterprise directory (`/open-apis/search/v1/user`) when `userAccessToken` is available;
   * 2. Exact `ou_...` OpenID lookup via `contact.user.get`;
   * 3. Exact email lookup via `contact/v3/users/batch_get_id`;
   * 4. Members across joined groups of this bot (works immediately without user OAuth).
   */
  async searchUsers(
    query: string,
    userAccessToken?: string,
    userDirectoryLookup?: (queries: readonly string[]) => Promise<readonly LarkDirectoryUserHit[]>,
  ): Promise<LarkUserSearchHit[]> {
    const q = query.trim()
    const hits = new Map<string, LarkUserSearchHit>()

    // 1. Direct OpenID lookup
    if (q.startsWith('ou_')) {
      const detail = await this.lookupUserDetail(q)
      hits.set(q, {
        openId: q,
        name: detail?.name || q,
        ...(detail?.enName ? { enName: detail.enName } : {}),
        ...(detail?.email ? { email: detail.email } : {}),
        ...(detail?.avatarUrl ? { avatarUrl: detail.avatarUrl } : {}),
      })
    }

    // 2. Email lookup via contact.v3.users.batch_get_id
    if (q.includes('@')) {
      try {
        const res = (await this.client.request({
          method: 'POST',
          url: '/open-apis/contact/v3/users/batch_get_id',
          params: { user_id_type: 'open_id' },
          data: { emails: [q], include_resigned: false },
        })) as { data?: { user_list?: Array<{ user_id?: string; email?: string }> } }
        for (const item of res?.data?.user_list ?? []) {
          const openId = item.user_id?.trim()
          if (!openId) continue
          const detail = await this.lookupUserDetail(openId)
          hits.set(openId, {
            openId,
            name: detail?.name || q,
            email: detail?.email || item.email || q,
            ...(detail?.enName ? { enName: detail.enName } : {}),
            ...(detail?.avatarUrl ? { avatarUrl: detail.avatarUrl } : {}),
          })
        }
      } catch {
        // Optional scope; ignore if unavailable.
      }
    }

    // 3. Enterprise directory search via User Access Token (when authorized for this bot)
    if (userAccessToken && q) {
      try {
        const dirUsers = await searchDirectoryWithUserToken(q, userAccessToken)
        for (const u of dirUsers) {
          hits.set(u.openId, {
            openId: u.openId,
            name: u.name,
            ...(u.enName ? { enName: u.enName } : {}),
            ...(u.email ? { email: u.email } : {}),
            ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
          })
        }
      } catch {
        // Fallback to group members below.
      }
    }

    // 4. Joined group members fallback / enrichment (also lists known members when query is empty)
    try {
      const chats = await this.listJoinedChats()
      const qLower = q.toLowerCase()
      for (const chat of chats.slice(0, 8)) {
        const members = await this.listChatMembersAndBots(chat.chatId, {
          ...(userAccessToken ? { userAccessToken } : {}),
          ...(userDirectoryLookup ? { userDirectoryLookup } : {}),
        })
        for (const item of members) {
          if (item.memberType !== 'user' || item.openId === this.botOpenId || hits.has(item.openId)) {
            continue
          }
          const hay = [item.name, item.email ?? '', item.openId].join(' ').toLowerCase()
          if (!qLower || hay.includes(qLower)) {
            hits.set(item.openId, {
              openId: item.openId,
              name: item.name,
              ...(item.email ? { email: item.email } : {}),
              ...(item.avatarUrl ? { avatarUrl: item.avatarUrl } : {}),
            })
          }
          if (hits.size >= 25) break
        }
        if (hits.size >= 25) break
      }
    } catch {
      // Ignore if chat list fails.
    }

    return [...hits.values()].slice(0, 25)
  }

  async resolveUserSummary(
    openId: string,
    fallbackName?: string,
  ): Promise<{ openId: string; name: string; email?: string; avatarUrl?: string } | undefined> {
    if (!openId.trim()) return undefined
    const detail = await this.lookupUserDetail(openId.trim(), fallbackName)
    if (!detail) return undefined
    return {
      openId: detail.openId,
      name: detail.name,
      ...(detail.email ? { email: detail.email } : {}),
      ...(detail.avatarUrl ? { avatarUrl: detail.avatarUrl } : {}),
    }
  }

  async listMessages(options: {
    readonly chatId: string
    readonly threadId?: string
    readonly limit?: number
  }): Promise<LarkHistoryMessage[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100))
    let containerIdType: 'chat' | 'thread' = 'chat'
    let containerId = options.chatId
    let filterRootMessageId: string | undefined

    if (options.threadId) {
      const target = options.threadId.trim()
      if (target.startsWith('omt_')) {
        containerIdType = 'thread'
        containerId = target
      } else if (target.startsWith('om_')) {
        // Resolve omt_ thread id from root message if possible; otherwise filter chat history by root_id.
        try {
          const rootRes = await this.client.im.message.get({ path: { message_id: target } })
          const rootItem = rootRes.data?.items?.[0] as { thread_id?: string } | undefined
          if (rootItem?.thread_id) {
            containerIdType = 'thread'
            containerId = rootItem.thread_id
          } else {
            filterRootMessageId = target
          }
        } catch {
          filterRootMessageId = target
        }
      }
    }

    const fetchSize = filterRootMessageId ? Math.min(100, limit * 3) : Math.min(50, limit)
    const res = await this.client.im.message.list({
      params: {
        container_id_type: containerIdType,
        container_id: containerId,
        sort_type: 'ByCreateTimeDesc',
        page_size: fetchSize,
      },
    })

    const rawItems = [...(res.data?.items ?? [])]
    const mapped: LarkHistoryMessage[] = []
    for (const raw of rawItems) {
      const item = raw as Record<string, unknown>
      if (Boolean(item.deleted)) continue
      const messageId = typeof item.message_id === 'string' ? item.message_id : ''
      if (!messageId) continue
      const rootId = typeof item.root_id === 'string' && item.root_id ? item.root_id : undefined
      if (filterRootMessageId && messageId !== filterRootMessageId && rootId !== filterRootMessageId) {
        continue
      }
      mapped.push(await this.formatApiMessageItem(item))
      if (mapped.length >= limit) break
    }

    return mapped.reverse()
  }

  async getMessageDetail(
    messageId: string,
    options: { readonly downloadResources?: boolean; readonly includeRaw?: boolean } = {},
  ): Promise<LarkMessageDetail | undefined> {
    const res = await this.client.im.message.get({ path: { message_id: messageId } })
    const items = (res.data?.items ?? []) as Array<Record<string, unknown>>
    if (items.length === 0) return undefined

    const primary = items[0]!
    const base = await this.formatApiMessageItem(primary)
    let text = base.text
    if (base.msgType === 'merge_forward' && items.length > 1) {
      const lines: string[] = []
      for (const sub of items.slice(1)) {
        const subFmt = await this.formatApiMessageItem(sub)
        lines.push(`[${subFmt.senderName || subFmt.senderOpenId || subFmt.senderType}] ${subFmt.text}`)
      }
      text = lines.join('\n')
    }

    const body = (primary.body ?? {}) as Record<string, unknown>
    const rawContent = typeof body.content === 'string' ? body.content : ''
    let downloaded: LarkDownloadedResource[] | undefined

    if (options.downloadResources && base.resources.length > 0) {
      downloaded = []
      for (const r of base.resources.slice(0, 10)) {
        const buf = await this.downloadResourceBuffer(messageId, r.key, r.type)
        if (buf) {
          downloaded.push({
            type: r.type,
            key: r.key,
            fileName: r.name || (r.type === 'image' ? `${r.key}.png` : r.key),
            dataBase64: buf.toString('base64'),
          })
        }
      }
    }

    return {
      ...base,
      text,
      ...(options.includeRaw ? { rawContent } : {}),
      ...(downloaded && downloaded.length > 0 ? { downloaded } : {}),
    }
  }

  private async formatApiMessageItem(item: Record<string, unknown>): Promise<LarkHistoryMessage> {
    const messageId = typeof item.message_id === 'string' ? item.message_id : ''
    const chatId = typeof item.chat_id === 'string' && item.chat_id ? item.chat_id : undefined
    const rootId = typeof item.root_id === 'string' && item.root_id ? item.root_id : undefined
    const parentId = typeof item.parent_id === 'string' && item.parent_id ? item.parent_id : undefined
    const threadId = typeof item.thread_id === 'string' && item.thread_id ? item.thread_id : undefined
    const msgType = typeof item.msg_type === 'string' ? item.msg_type : 'text'
    const body = (item.body ?? {}) as Record<string, unknown>
    const rawContent = typeof body.content === 'string' ? body.content : ''
    const sender = (item.sender ?? {}) as Record<string, unknown>
    const senderId = typeof sender.id === 'string' && sender.id ? sender.id : undefined
    const senderTypeRaw = typeof sender.sender_type === 'string' ? sender.sender_type : 'user'
    const senderType: 'user' | 'bot' = senderTypeRaw === 'app' || senderTypeRaw === 'bot' ? 'bot' : 'user'
    const mentionsRaw = Array.isArray(item.mentions) ? item.mentions : []
    const mentions: LarkMention[] = mentionsRaw.map((m) => {
      const rec = (m ?? {}) as Record<string, unknown>
      return {
        key: typeof rec.key === 'string' ? rec.key : '',
        ...(typeof rec.id === 'string' ? { openId: rec.id } : {}),
        ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
      }
    })

    const parsed = parseLarkMessageContent(msgType, rawContent)
    let text = parsed.text
    for (const m of mentions) {
      if (m.key && m.name) {
        text = text.split(m.key).join(`@${m.name}`)
      }
    }

    let senderName: string | undefined
    if (senderId) {
      if (senderId === this.botOpenId) {
        senderName = this.bot.name
      } else if (senderType === 'user') {
        const detail = await this.lookupUserDetail(senderId)
        senderName = detail?.name
      } else {
        for (const botsInChat of this.observedChatBots.values()) {
          if (botsInChat.has(senderId)) {
            senderName = botsInChat.get(senderId)
            break
          }
        }
      }
    }

    const createTimeMs = Number(item.create_time)
    const resources = extractMessageResources(msgType, rawContent)

    return {
      messageId,
      ...(chatId ? { chatId } : {}),
      ...(rootId ? { rootId } : {}),
      ...(parentId ? { parentId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(senderId ? { senderOpenId: senderId } : {}),
      ...(senderName ? { senderName } : {}),
      senderType,
      msgType,
      text: text || (resources.length > 0 ? `[${msgType}]` : ''),
      createTimeMs: Number.isFinite(createTimeMs) && createTimeMs > 0 ? createTimeMs : 0,
      resources,
    }
  }

  private async lookupUserDetail(openId: string, fallbackName?: string): Promise<CachedUserDetail | undefined> {
    const now = Date.now()
    const cached = this.userCache.get(openId)
    if (cached && now - cached.cachedAtMs < USER_DETAIL_TTL_MS) {
      return cached
    }
    const deniedUntil = this.contactDeniedUntilMs.get(openId) ?? 0
    if (now >= deniedUntil) {
      try {
        const res = await this.client.contact.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        })
        const u = res.data?.user
        if (u) {
          const avatarUrl = u.avatar?.avatar_72 || u.avatar?.avatar_240 || u.avatar?.avatar_origin
          const detail: CachedUserDetail = {
            openId,
            name: u.name || fallbackName || openId,
            ...(u.en_name ? { enName: u.en_name } : {}),
            ...(u.email || u.enterprise_email ? { email: u.enterprise_email || u.email } : {}),
            ...(avatarUrl ? { avatarUrl } : {}),
            cachedAtMs: now,
          }
          this.userCache.set(openId, detail)
          this.contactDeniedUntilMs.delete(openId)
          return detail
        }
      } catch {
        // App may lack Contact Scope authority (41050) for this colleague; backoff direct get
        // without poisoning `userCache`, so directory search enrichment can still fill avatarUrl.
        this.contactDeniedUntilMs.set(openId, now + CONTACT_DENIED_TTL_MS)
      }
    }
    if (fallbackName) {
      return {
        openId,
        name: fallbackName,
        cachedAtMs: now,
      }
    }
    return undefined
  }

  private normalizeReceiveEvent(raw: unknown): InboundLarkMessage | undefined {
    const root = raw as Record<string, unknown>
    const message = (root?.message ?? {}) as Record<string, unknown>
    const sender = (root?.sender ?? {}) as Record<string, unknown>
    const senderId = (sender?.sender_id ?? {}) as Record<string, unknown>

    const messageId = typeof message.message_id === 'string' ? message.message_id : ''
    const chatId = typeof message.chat_id === 'string' ? message.chat_id : ''
    if (!messageId || !chatId) return undefined

    const msgType = typeof message.message_type === 'string' ? message.message_type : 'text'
    const rawContent = typeof message.content === 'string' ? message.content : ''
    const parsedContent = parseLarkMessageContent(msgType, rawContent)

    const rawMentions = Array.isArray(message.mentions) ? message.mentions : []
    const mentions: LarkMention[] = rawMentions.map((m) => {
      const rec = (m ?? {}) as Record<string, unknown>
      const idRec = (rec.id ?? {}) as Record<string, unknown>
      return {
        key: typeof rec.key === 'string' ? rec.key : '',
        ...(typeof idRec.open_id === 'string' ? { openId: idRec.open_id } : {}),
        ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
      }
    })

    const senderTypeRaw = typeof sender.sender_type === 'string' ? sender.sender_type : 'user'
    const senderType: 'user' | 'bot' = senderTypeRaw === 'app' || senderTypeRaw === 'bot' ? 'bot' : 'user'
    const createTimeRaw = Number(message.create_time)

    return {
      botId: this.bot.id,
      larkAppId: this.bot.larkAppId,
      ...(this.botOpenId ? { botOpenId: this.botOpenId } : {}),
      messageId,
      chatId,
      chatType: typeof message.chat_type === 'string' ? message.chat_type : 'group',
      ...(typeof message.root_id === 'string' && message.root_id ? { rootId: message.root_id } : {}),
      ...(typeof message.parent_id === 'string' && message.parent_id ? { parentId: message.parent_id } : {}),
      ...(typeof message.thread_id === 'string' && message.thread_id ? { threadId: message.thread_id } : {}),
      msgType,
      ...(typeof senderId.open_id === 'string' && senderId.open_id ? { senderOpenId: senderId.open_id } : {}),
      senderType,
      text: parsedContent.text,
      rawContent,
      mentions,
      imageKeys: parsedContent.imageKeys,
      createTimeMs: Number.isFinite(createTimeRaw) && createTimeRaw > 0 ? createTimeRaw : Date.now(),
    }
  }

  private normalizeCardAction(raw: unknown): CardActionEvent | undefined {
    const root = raw as Record<string, unknown>
    const operator = (root?.operator ?? {}) as Record<string, unknown>
    const action = (root?.action ?? {}) as Record<string, unknown>
    const context = (root?.context ?? {}) as Record<string, unknown>
    const value = action?.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return {
      botId: this.bot.id,
      larkAppId: this.bot.larkAppId,
      ...(typeof operator.open_id === 'string' ? { operatorOpenId: operator.open_id } : {}),
      actionValue: value as Record<string, unknown>,
      ...(typeof context.open_message_id === 'string' ? { messageId: context.open_message_id } : {}),
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.callbacks.logger?.(level, message)
  }
}
