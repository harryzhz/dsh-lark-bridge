import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerApp } from '@larksuiteoapi/node-sdk'
import { generateDefaultBotIconPng, renderQrSvgDataUrl } from './qr-svg.js'

const ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn'
const ASK_ORIGIN = 'https://ask.feishu.cn'
const OPEN_ORIGIN = 'https://open.feishu.cn'
const QR_LOGIN_APP_ID = '12'
const LONG_CONNECTION_EVENT_MODE = 4
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
const QR_COMMON_HEADERS = {
  'x-api-version': '1.0.28',
  'x-device-info':
    'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false',
  'x-locale': 'zh-CN',
  'x-terminal-type': '2',
}

const DEFAULT_TENANT_SCOPES = [
  'application:application:self_manage',
  'im:chat:read',
  'im:chat.members:read',
  'im:chat.members:bot_access',
  'im:message',
  'im:message:send_as_bot',
  'im:message:readonly',
  'im:message:update',
  'im:message.group_at_msg:readonly',
  'im:message.group_at_msg.include_bot:readonly',
  'im:message.group_msg',
  'im:message.group_msg.include_bot:read',
  'im:message.p2p_msg:readonly',
  'im:message.reactions:read',
  'im:message.reactions:write_only',
  'im:resource',
  'cardkit:card:read',
  'cardkit:card:write',
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'contact:user.email:readonly',
  'contact:user.id:readonly',
  'docx:document:readonly',
  'docx:document:create',
  'docx:document:write_only',
  'drive:drive.metadata:readonly',
  'drive:drive.search:readonly',
  'wiki:wiki:readonly',
  'sheets:spreadsheet:read',
  'bitable:app',
]

const DEFAULT_USER_SCOPES = [
  'contact:contact.base:readonly',
  'contact:user:search',
  'offline_access',
]

const BASELINE_APP_EVENTS = [
  'im.message.receive_v1',
  'im.message.recalled_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'im.message.reaction.created_v1',
  'im.message.reaction.deleted_v1',
]

const BASELINE_CALLBACKS = ['card.action.trigger']

export interface StoredWebCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly hostOnly: boolean
  readonly expiresAt?: number
}

export interface LarkOpenPlatformIdentity {
  readonly userId: string
  readonly userName: string
  readonly email?: string
  readonly tenantId: string
  readonly tenantName: string
}

export interface LarkOpenPlatformStatus {
  readonly authenticated: boolean
  readonly source?: 'local_cache' | 'cli_cache'
  readonly identity?: LarkOpenPlatformIdentity
  readonly message?: string
}

export interface LarkQrJobView {
  readonly jobId: string
  readonly status: 'waiting_scan' | 'scanned' | 'working' | 'succeeded' | 'expired' | 'failed'
  readonly stepMessage: string
  readonly qrSvgDataUrl?: string
  readonly verificationUrl?: string
  readonly identity?: LarkOpenPlatformIdentity
  readonly createdBotId?: string
  readonly larkAppId?: string
  readonly error?: string
}

export interface LarkUserOAuthEntry {
  readonly botId: string
  readonly larkAppId: string
  readonly accessToken: string
  readonly refreshToken?: string
  readonly scope?: string
  readonly expiresAtMs: number
  readonly updatedAtMs: number
}

export interface LarkUserAuthView {
  readonly botId: string
  readonly authorized: boolean
  readonly expiresAtMs?: number
  readonly scope?: string
}

export interface AutoCreateBotRequest {
  readonly mode?: 'open_platform' | 'device_flow'
  readonly id?: string
  readonly name: string
  readonly description?: string
}

export interface AutoCreatedBotCredentials {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly larkAppId: string
  readonly larkAppSecret: string
}

export interface LarkOpenPlatformAppSummary {
  readonly appId: string
  readonly name: string
  readonly description: string
  readonly avatarUrl?: string
  readonly hasBotAbility: boolean
  readonly abilities: readonly string[]
  readonly appStatus: number
  readonly version?: string
  readonly role?: number
  readonly updateTime?: number
}

export interface LarkOpenPlatformAppCredentials {
  readonly appId: string
  readonly appSecret: string
  readonly name: string
  readonly description: string
  readonly avatarUrl?: string
  readonly hasBotAbility: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pickStr(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function writePrivateJson(filePath: string, payload: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best-effort POSIX permission.
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, filePath)
    chmodSync(filePath, 0o600)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Ignore cleanup error.
    }
    throw err
  }
}

function pruneCookies(cookies: readonly StoredWebCookie[]): StoredWebCookie[] {
  const now = Date.now()
  return cookies.filter((c) => c.name && (c.expiresAt === undefined || c.expiresAt > now))
}

function domainMatches(hostname: string, cookie: StoredWebCookie): boolean {
  const host = hostname.toLowerCase()
  const dom = cookie.domain.toLowerCase().replace(/^\.+/, '')
  if (cookie.hostOnly) return host === dom
  return host === dom || host.endsWith(`.${dom}`)
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  const norm = cookiePath || '/'
  if (reqPath === norm) return true
  if (!reqPath.startsWith(norm)) return false
  return norm.endsWith('/') || reqPath[norm.length] === '/'
}

function splitSetCookie(raw: string | null): string[] {
  if (!raw) return []
  return raw.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g).map((s) => s.trim()).filter(Boolean)
}

function parseSetCookie(urlStr: string, raw: string): StoredWebCookie | undefined {
  const parts = raw.split(';').map((p) => p.trim()).filter(Boolean)
  const first = parts.shift()
  if (!first) return undefined
  const eq = first.indexOf('=')
  if (eq <= 0) return undefined
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  const url = new URL(urlStr)

  let domain = url.hostname.toLowerCase()
  let hostOnly = true
  let path = '/'
  let secure = false
  let httpOnly = false
  let expiresAt: number | undefined

  for (const attr of parts) {
    const idx = attr.indexOf('=')
    const k = (idx >= 0 ? attr.slice(0, idx) : attr).trim().toLowerCase()
    const v = idx >= 0 ? attr.slice(idx + 1).trim() : ''
    if (k === 'domain' && v) {
      domain = v.toLowerCase().replace(/^\.+/, '')
      hostOnly = false
    } else if (k === 'path' && v.startsWith('/')) {
      path = v
    } else if (k === 'secure') {
      secure = true
    } else if (k === 'httponly') {
      httpOnly = true
    } else if (k === 'max-age') {
      const sec = Number(v)
      if (Number.isFinite(sec)) expiresAt = Date.now() + sec * 1000
    } else if (k === 'expires' && expiresAt === undefined) {
      const ms = Date.parse(v)
      if (Number.isFinite(ms)) expiresAt = ms
    }
  }

  return {
    name,
    value,
    domain,
    path,
    secure,
    httpOnly,
    hostOnly,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

class CookieJar {
  private list: StoredWebCookie[]

  constructor(initial: readonly StoredWebCookie[] = []) {
    this.list = pruneCookies(initial)
  }

  toJSON(): StoredWebCookie[] {
    this.list = pruneCookies(this.list)
    return [...this.list]
  }

  headerFor(urlStr: string): string {
    const url = new URL(urlStr)
    return pruneCookies(this.list)
      .filter((c) => {
        if (c.secure && url.protocol !== 'https:') return false
        if (!domainMatches(url.hostname, c)) return false
        return pathMatches(url.pathname || '/', c.path || '/')
      })
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
  }

  async fetch(
    urlStr: string,
    init: RequestInit = {},
    fetcher: typeof fetch = fetch,
    maxRedirects = 10,
  ): Promise<{ response: Response; finalUrl: string }> {
    let current = urlStr
    let referer: string | undefined
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const headers = new Headers(init.headers)
      const cookie = this.headerFor(current)
      if (cookie) headers.set('cookie', cookie)
      if (!headers.has('user-agent')) headers.set('user-agent', BROWSER_UA)
      if (referer && !headers.has('referer')) headers.set('referer', referer)

      const res = await fetcher(current, { ...init, headers, redirect: 'manual' })
      this.absorb(current, res.headers)
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return { response: res, finalUrl: current }
        referer = current
        current = new URL(loc, current).toString()
        continue
      }
      return { response: res, finalUrl: current }
    }
    throw new Error('Too many redirects')
  }

  private absorb(urlStr: string, headers: Headers): void {
    const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
    const rawList = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : splitSetCookie(headers.get('set-cookie'))
    for (const raw of rawList) {
      const parsed = parseSetCookie(urlStr, raw)
      if (!parsed) continue
      const idx = this.list.findIndex(
        (c) => c.name === parsed.name && c.domain === parsed.domain && c.path === parsed.path,
      )
      if (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now()) {
        if (idx >= 0) this.list.splice(idx, 1)
        continue
      }
      if (idx >= 0) this.list[idx] = parsed
      else this.list.push(parsed)
    }
  }
}

function extractBalancedJson(source: string, startIndex: number): string | undefined {
  let depth = 0
  let inStr = false
  let esc = false
  let began = false
  let beginIdx = startIndex
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i]!
    if (!began) {
      if (/\s/.test(ch)) continue
      if (ch !== '{') return undefined
      began = true
      beginIdx = i
      depth = 1
      continue
    }
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(beginIdx, i + 1)
    }
  }
  return undefined
}

function extractCsrfAndIdentity(html: string): {
  csrfToken?: string
  identity?: LarkOpenPlatformIdentity
} {
  const csrfMatch =
    /\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/.exec(html) ??
    /\bcsrfToken\s*:\s*(['"])([^'"]+)\1/.exec(html)
  const csrfToken = csrfMatch?.[2]

  let identity: LarkOpenPlatformIdentity | undefined
  const userMatch = /\bwindow\.user\s*=\s*/.exec(html)
  if (userMatch) {
    const rawJson = extractBalancedJson(html, userMatch.index + userMatch[0].length)
    if (rawJson) {
      try {
        const u = asRecord(JSON.parse(rawJson))
        const userId = pickStr(u, ['id', 'userId', 'user_id'])
        const userName =
          pickStr(u, ['name', 'userName', 'user_name']) ??
          pickStr(asRecord(u.displayName), ['value'])
        const tenantId = pickStr(u, ['tenantId', 'tenant_id'])
        const tenantName =
          pickStr(asRecord(u.tenantDisplayName), ['value']) ??
          pickStr(u, ['tenantName', 'tenant_name'])
        const email = pickStr(u, ['email'])
        if (userId && userName && tenantId && tenantName) {
          identity = {
            userId,
            userName,
            ...(email ? { email } : {}),
            tenantId,
            tenantName,
          }
        }
      } catch {
        // Ignore malformed window.user.
      }
    }
  }

  return {
    ...(csrfToken ? { csrfToken } : {}),
    ...(identity ? { identity } : {}),
  }
}

interface ConsoleClient {
  readonly apiOrigin: string
  readonly identity?: LarkOpenPlatformIdentity
  postJson(path: string, body?: unknown): Promise<Record<string, unknown>>
  postForm(path: string, form: FormData): Promise<Record<string, unknown>>
}

async function openConsoleClient(
  cookies: readonly StoredWebCookie[],
  fetcher: typeof fetch = fetch,
): Promise<ConsoleClient | undefined> {
  if (cookies.length === 0) return undefined
  const jar = new CookieJar(cookies)
  const { response, finalUrl } = await jar.fetch(`${OPEN_ORIGIN}/app`, { method: 'GET' }, fetcher)
  if (!response.ok) return undefined
  const html = await response.text()
  const { csrfToken, identity } = extractCsrfAndIdentity(html)
  if (!csrfToken) return undefined
  const apiOrigin = new URL(finalUrl).origin

  const call = async (
    path: string,
    body?: NonNullable<RequestInit['body']>,
    contentType?: string,
  ): Promise<Record<string, unknown>> => {
    const { response: r } = await jar.fetch(
      `${apiOrigin}${path}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          origin: apiOrigin,
          referer: finalUrl,
          'x-csrf-token': csrfToken,
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      },
      fetcher,
    )
    const json = asRecord(await r.json().catch(() => ({})))
    if (!r.ok || (typeof json.code === 'number' && json.code !== 0)) {
      const msg = pickStr(json, ['msg', 'message']) ?? `HTTP ${r.status}`
      throw new Error(`${path}: ${msg}`)
    }
    return json
  }

  return {
    apiOrigin,
    ...(identity ? { identity } : {}),
    postJson: (path, body) =>
      call(path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json'),
    postForm: (path, form) => call(path, form),
  }
}

function collectScopeEntries(
  node: unknown,
  bucket: 'tenant' | 'user' | undefined,
  out: Array<{ id: string; name: string; bucket?: 'tenant' | 'user' }>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectScopeEntries(item, bucket, out)
    return
  }
  if (!node || typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  const name = pickStr(rec, ['scope_name', 'scopeName', 'name', 'key', 'scopeKey'])
  const id = pickStr(rec, ['id', 'scope_id', 'scopeId', 'scopeID'])
  if (name && id) out.push({ id, name, ...(bucket ? { bucket } : {}) })
  for (const [k, v] of Object.entries(rec)) {
    if (!v || typeof v !== 'object') continue
    const nextBucket = /user/i.test(k) ? 'user' : /app|client|tenant/i.test(k) ? 'tenant' : bucket
    collectScopeEntries(v, nextBucket, out)
  }
}

export interface OpenPlatformVisibleSuggest {
  readonly departments: readonly string[]
  readonly members: readonly string[]
  readonly groups: readonly string[]
  readonly isAll: number
}

function extractVisibleIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    let id: string | undefined
    if (typeof entry === 'string') {
      id = entry.trim() || undefined
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      id = pickStr(entry as Record<string, unknown>, [
        'id',
        'memberId',
        'userId',
        'departmentId',
        'groupId',
      ])
    }
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/**
 * Normalizes a visibility scope block returned by `/developers/v1/visible/online/*`
 * (where `members`/`departments`/`groups` are rich objects `{ id, name, avatar, ... }`)
 * into the string-ID array shape required by `/developers/v1/app_version/create/*`.
 */
export function normalizeVisibleSuggest(raw: unknown): OpenPlatformVisibleSuggest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (!('departments' in rec || 'members' in rec || 'groups' in rec || 'isAll' in rec)) {
    return undefined
  }
  const isAll = typeof rec.isAll === 'number' ? rec.isAll : rec.isAll === true ? 1 : 0
  return {
    departments: extractVisibleIds(rec.departments),
    members: extractVisibleIds(rec.members),
    groups: extractVisibleIds(rec.groups),
    isAll,
  }
}

function nextSemanticVersion(versionListPayload: Record<string, unknown>): string {
  const data = asRecord(versionListPayload.data)
  const versions = Array.isArray(data.versions) ? data.versions : []
  const triples = versions
    .map((v) => pickStr(asRecord(v), ['appVersion']))
    .filter((v): v is string => Boolean(v))
    .map((v) => v.split('.').map((n) => Number.parseInt(n, 10)))
    .filter((parts) => parts.length === 3 && parts.every((n) => Number.isFinite(n)))
  if (triples.length === 0) return '1.0.0'
  const max = triples.reduce((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (b[i]! !== a[i]!) return b[i]! > a[i]! ? b : a
    }
    return a
  })
  return `${max[0]}.${max[1]}.${max[2]! + 1}`
}

export function slugifyBotId(name: string, fallbackSuffix?: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii) return ascii
  const cleanSuffix = (fallbackSuffix ?? '')
    .toLowerCase()
    .replace(/^cli_/, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 6)
  return `bot-${cleanSuffix || randomUUID().slice(0, 6)}`
}

function extractLocalizedAppFields(base: Record<string, unknown>): {
  readonly name?: string
  readonly description?: string
  readonly avatarUrl?: string
  readonly abilities: readonly string[]
} {
  const primaryLang = pickStr(base, ['primaryLang']) ?? 'zh_cn'
  const i18n = asRecord(base.i18n)
  const zhBlock = asRecord(i18n.zh_cn)
  const primaryBlock = asRecord(i18n[primaryLang])
  const name =
    pickStr(zhBlock, ['name']) ??
    pickStr(primaryBlock, ['name']) ??
    pickStr(base, ['name'])
  const description =
    pickStr(zhBlock, ['description', 'desc']) ??
    pickStr(primaryBlock, ['description', 'desc']) ??
    pickStr(base, ['desc', 'description'])
  const rawAvatar = pickStr(base, ['avatarUrl', 'avatar_url', 'iconUrl', 'icon_url', 'avatar'])
  const avatarUrl = rawAvatar && /^https?:\/\//i.test(rawAvatar) ? rawAvatar : undefined
  const abilities = Array.isArray(base.ability)
    ? base.ability.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    abilities,
  }
}

function parseOpenPlatformAppSummary(raw: unknown): LarkOpenPlatformAppSummary | undefined {
  const rec = asRecord(raw)
  const appId = pickStr(rec, ['appID', 'clientID', 'clientId', 'appId'])
  if (!appId) return undefined
  const fields = extractLocalizedAppFields(rec)
  const appStatus =
    typeof rec.appStatus === 'number'
      ? rec.appStatus
      : typeof rec.appListStatus === 'number'
        ? rec.appListStatus
        : 0
  const version = pickStr(rec, ['version'])
  const role = typeof rec.role === 'number' ? rec.role : undefined
  const updateTime = typeof rec.updateTime === 'number' ? rec.updateTime : undefined
  return {
    appId,
    name: fields.name || appId,
    description: fields.description ?? '',
    ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl } : {}),
    hasBotAbility: fields.abilities.includes('bot'),
    abilities: fields.abilities,
    appStatus,
    ...(version ? { version } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(updateTime !== undefined ? { updateTime } : {}),
  }
}

function appPriorityRank(app: LarkOpenPlatformAppSummary): number {
  if (app.hasBotAbility && app.appStatus !== 0 && app.appStatus !== 3) return 0
  if (app.hasBotAbility) return 1
  if (app.appStatus !== 0 && app.appStatus !== 3) return 2
  return 3
}

export class LarkPlatformManager {
  private readonly sessionPath: string
  private readonly cliFallbackSessionPath: string
  private readonly oauthPath: string
  private readonly jobs = new Map<string, LarkQrJobView>()
  private readonly oauthTokens = new Map<string, LarkUserOAuthEntry>()

  constructor(
    private readonly dataDir: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.sessionPath = join(dataDir, 'open-platform-session.json')
    this.cliFallbackSessionPath = process.env.LARK_OPEN_PLATFORM_SESSION_FILE?.trim() || ''
    this.oauthPath = join(dataDir, 'user-oauth-tokens.json')
    this.loadOAuthTokens()
  }

  getJob(jobId: string): LarkQrJobView | undefined {
    return this.jobs.get(jobId)
  }

  listUserAuthStatuses(botIds: readonly string[]): LarkUserAuthView[] {
    return botIds.map((botId) => {
      const token = this.oauthTokens.get(botId)
      if (!token) return { botId, authorized: false }
      const valid = Boolean(token.refreshToken || token.expiresAtMs > Date.now() + 30_000)
      return {
        botId,
        authorized: valid,
        expiresAtMs: token.expiresAtMs,
        ...(token.scope ? { scope: token.scope } : {}),
      }
    })
  }

  revokeUserOAuth(botId: string): boolean {
    const deleted = this.oauthTokens.delete(botId)
    if (deleted) this.persistOAuthTokens()
    return deleted
  }

  async inspectOpenPlatformSession(): Promise<LarkOpenPlatformStatus> {
    const loaded = await this.loadValidConsoleClient()
    if (!loaded) {
      return {
        authenticated: false,
        message: '尚未登录飞书开放平台，扫码登录后可一键创建智能体并同步签名信息',
      }
    }
    return {
      authenticated: true,
      source: loaded.source,
      ...(loaded.client.identity ? { identity: loaded.client.identity } : {}),
    }
  }

  logoutOpenPlatform(): void {
    try {
      if (existsSync(this.sessionPath)) unlinkSync(this.sessionPath)
    } catch {
      // Ignore unlink failure.
    }
  }

  startOpenPlatformQrLogin(): LarkQrJobView {
    const jobId = `qr-${randomUUID()}`
    const initial: LarkQrJobView = {
      jobId,
      status: 'waiting_scan',
      stepMessage: '正在生成飞书扫码二维码…',
    }
    this.jobs.set(jobId, initial)
    void this.runOpenPlatformQrFlow(jobId)
    return this.jobs.get(jobId)!
  }

  startUserOAuthLogin(botId: string, larkAppId: string, larkAppSecret: string): LarkQrJobView {
    const jobId = `oauth-${randomUUID()}`
    const initial: LarkQrJobView = {
      jobId,
      status: 'waiting_scan',
      stepMessage: '正在生成企业通讯录搜索授权码…',
    }
    this.jobs.set(jobId, initial)
    void this.runUserOAuthDeviceFlow(jobId, botId, larkAppId, larkAppSecret)
    return this.jobs.get(jobId)!
  }

  async getValidUserAccessToken(
    botId: string,
    larkAppId: string,
    larkAppSecret: string,
  ): Promise<string | undefined> {
    const entry = this.oauthTokens.get(botId)
    if (!entry) return undefined
    if (entry.expiresAtMs > Date.now() + 60_000) {
      return entry.accessToken
    }
    if (!entry.refreshToken) return undefined

    try {
      const res = await this.fetcher(`${OPEN_ORIGIN}/open-apis/authen/v2/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: larkAppId,
          client_secret: larkAppSecret,
          refresh_token: entry.refreshToken,
        }),
      })
      const data = asRecord(await res.json().catch(() => ({})))
      const accessToken = pickStr(data, ['access_token'])
      if (!res.ok || !accessToken) return undefined
      const refreshToken = pickStr(data, ['refresh_token']) ?? entry.refreshToken
      const expiresIn = Number(data.expires_in) || 7200
      const updated: LarkUserOAuthEntry = {
        ...entry,
        accessToken,
        refreshToken,
        expiresAtMs: Date.now() + expiresIn * 1000,
        updatedAtMs: Date.now(),
      }
      this.oauthTokens.set(botId, updated)
      this.persistOAuthTokens()
      return accessToken
    } catch {
      return undefined
    }
  }

  async getAnyValidUserAccessToken(
    bots: readonly { readonly id: string; readonly larkAppId: string; readonly larkAppSecret: string }[],
    preferredBotId?: string,
  ): Promise<{ readonly botId: string; readonly accessToken: string } | undefined> {
    const ordered = preferredBotId
      ? [
          ...bots.filter((b) => b.id === preferredBotId),
          ...bots.filter((b) => b.id !== preferredBotId),
        ]
      : [...bots]
    for (const bot of ordered) {
      const token = await this.getValidUserAccessToken(bot.id, bot.larkAppId, bot.larkAppSecret)
      if (token) return { botId: bot.id, accessToken: token }
    }
    return undefined
  }

  async fetchBotAppProfile(
    larkAppId: string,
  ): Promise<{ readonly name?: string; readonly description?: string; readonly avatarUrl?: string } | undefined> {
    const loaded = await this.loadValidConsoleClient()
    if (!loaded) return undefined
    try {
      const appPayload = await loaded.client.postJson(`/developers/v1/app/${larkAppId}`, {})
      const fields = extractLocalizedAppFields(asRecord(appPayload.data))
      if (!fields.name && !fields.description && !fields.avatarUrl) return undefined
      return {
        ...(fields.name ? { name: fields.name } : {}),
        ...(fields.description ? { description: fields.description } : {}),
        ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl } : {}),
      }
    } catch {
      return undefined
    }
  }

  async listOpenPlatformApps(): Promise<{
    readonly authenticated: boolean
    readonly identity?: LarkOpenPlatformIdentity
    readonly apps: readonly LarkOpenPlatformAppSummary[]
  }> {
    const loaded = await this.loadValidConsoleClient()
    if (!loaded) {
      return { authenticated: false, apps: [] }
    }
    const payload = await loaded.client.postJson('/developers/v1/app/list', {})
    const data = asRecord(payload.data)
    const rawList = Array.isArray(data.apps)
      ? data.apps
      : Array.isArray(data.list)
        ? data.list
        : Array.isArray(payload.apps)
          ? payload.apps
          : []
    const dedup = new Map<string, LarkOpenPlatformAppSummary>()
    for (const item of rawList) {
      const parsed = parseOpenPlatformAppSummary(item)
      if (parsed && !dedup.has(parsed.appId)) {
        dedup.set(parsed.appId, parsed)
      }
    }
    const apps = [...dedup.values()].sort((a, b) => {
      const rankDiff = appPriorityRank(a) - appPriorityRank(b)
      if (rankDiff !== 0) return rankDiff
      const timeDiff = (b.updateTime ?? 0) - (a.updateTime ?? 0)
      if (timeDiff !== 0) return timeDiff
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return {
      authenticated: true,
      ...(loaded.client.identity ? { identity: loaded.client.identity } : {}),
      apps,
    }
  }

  async fetchOpenPlatformAppCredentials(larkAppId: string): Promise<LarkOpenPlatformAppCredentials> {
    const appId = larkAppId.trim()
    if (!appId) {
      throw new Error('请选择要接入的飞书应用')
    }
    const loaded = await this.loadValidConsoleClient()
    if (!loaded) {
      throw new Error('尚未登录飞书开放平台，请先扫码登录')
    }
    const [appResult, secretResult] = await Promise.allSettled([
      loaded.client.postJson(`/developers/v1/app/${appId}`, {}),
      loaded.client.postJson(`/developers/v1/secret/${appId}`, {}),
    ])
    const base = appResult.status === 'fulfilled' ? asRecord(appResult.value.data) : {}
    const fields = extractLocalizedAppFields(base)
    const secretRestricted = base.secretRestricted === true
    let appSecret: string | undefined
    if (secretResult.status === 'fulfilled') {
      appSecret =
        pickStr(asRecord(secretResult.value.data), ['secret']) ??
        pickStr(secretResult.value, ['secret'])
    }
    if (!appSecret) {
      if (secretRestricted) {
        throw new Error(
          `该应用已开启密钥查看限制，无法自动读取 App Secret，请切换为「手动填写凭证」接入`,
        )
      }
      const reason =
        secretResult.status === 'rejected'
          ? secretResult.reason instanceof Error
            ? secretResult.reason.message
            : String(secretResult.reason)
          : ''
      throw new Error(
        `无法从开放平台读取应用 ${appId} 的 App Secret${reason ? `（${reason}）` : ''}，请确认应用权限或切换为「手动填写凭证」`,
      )
    }
    return {
      appId,
      appSecret,
      name: fields.name || appId,
      description: fields.description ?? '',
      ...(fields.avatarUrl ? { avatarUrl: fields.avatarUrl } : {}),
      hasBotAbility: fields.abilities.includes('bot'),
    }
  }

  startAutoCreateBot(
    input: AutoCreateBotRequest,
    onCreated: (created: AutoCreatedBotCredentials) => Promise<void>,
  ): LarkQrJobView {
    const jobId = `bot-${randomUUID()}`
    const initial: LarkQrJobView = {
      jobId,
      status: 'working',
      stepMessage: '正在检查飞书登录态…',
    }
    this.jobs.set(jobId, initial)
    if (input.mode === 'device_flow') {
      void this.runSdkDeviceFlowCreate(jobId, input, onCreated)
    } else {
      void this.runOpenPlatformCreate(jobId, input, onCreated)
    }
    return this.jobs.get(jobId)!
  }

  /**
   * Synchronizes bot display name and description (signature/intro) to Lark Open Platform
   * when a valid Open Platform Web session exists; degrades gracefully when unauthenticated.
   */
  async syncBotBaseInfo(
    larkAppId: string,
    desired: { readonly name: string; readonly description: string },
  ): Promise<{ readonly synced: boolean; readonly skipped?: boolean; readonly message?: string }> {
    const loaded = await this.loadValidConsoleClient()
    if (!loaded) {
      return { synced: false, message: '未登录飞书开放平台，名称与签名仅保存在本地配置' }
    }
    const { client } = loaded
    try {
      const appPayload = await client.postJson(`/developers/v1/app/${larkAppId}`, {})
      const base = asRecord(appPayload.data)
      const localized = extractLocalizedAppFields(base)
      const primaryLang = pickStr(base, ['primaryLang']) ?? 'zh_cn'
      const rawLangs = Array.isArray(base.langs) ? base.langs.filter((l): l is string => typeof l === 'string' && Boolean(l)) : [primaryLang]
      const langs = rawLangs.length > 0 ? rawLangs : [primaryLang]
      const currentName = pickStr(base, ['name']) ?? localized.name ?? ''
      const currentDesc = (typeof base.desc === 'string' && base.desc) ? base.desc : (localized.description ?? '')
      const nextName = desired.name.trim() || currentName
      const nextDesc = desired.description.trim()

      if (!nextName) {
        return { synced: false, message: '开放平台未返回当前应用信息' }
      }
      if (nextName === currentName && (nextDesc === currentDesc || (!nextDesc && !currentDesc))) {
        return { synced: true, skipped: true }
      }

      const visPayload = await client.postJson(`/developers/v1/visible/online/${larkAppId}`, {})
      const visData = asRecord(visPayload.data)
      const whiteList = normalizeVisibleSuggest(visData.whiteList ?? visData)
      const blackList = normalizeVisibleSuggest(visData.blackList) ?? {
        departments: [],
        members: [],
        groups: [],
        isAll: 0,
      }
      if (!whiteList) {
        return { synced: false, message: '无法读取线上应用可见范围，已跳过平台同步' }
      }

      const i18nCurrent = asRecord(base.i18n)
      const i18nNext: Record<string, unknown> = {}
      for (const lang of langs) {
        const block = asRecord(i18nCurrent[lang])
        i18nNext[lang] = {
          ...block,
          name: nextName,
          ...(nextDesc ? { description: nextDesc } : {}),
        }
      }
      const avatar = pickStr(base, ['avatar'])
      await client.postJson(`/developers/v1/base_info/${larkAppId}`, {
        clientId: larkAppId,
        name: nextName,
        desc: nextDesc || currentDesc,
        languages: langs,
        i18n: i18nNext,
        ...(avatar ? { avatar } : {}),
      })

      const versionsPayload = await client.postJson(`/developers/v1/app_version/list/${larkAppId}`, {})
      const versions = Array.isArray(asRecord(versionsPayload.data).versions)
        ? (asRecord(versionsPayload.data).versions as unknown[])
        : []
      const draftVersion = versions
        .map(asRecord)
        .find((v) => v.versionStatus === 0 && pickStr(v, ['versionId', 'version_id', 'id']))
      let versionId = draftVersion ? pickStr(draftVersion, ['versionId', 'version_id', 'id']) : undefined

      if (!versionId) {
        const created = await client.postJson(`/developers/v1/app_version/create/${larkAppId}`, {
          appVersion: nextSemanticVersion(versionsPayload),
          mobileDefaultAbility: 'bot',
          pcDefaultAbility: 'bot',
          changeLog: 'Sync bot profile from DSH Lark Bridge',
          remark: 'Sync bot profile from DSH Lark Bridge',
          visibleSuggest: whiteList,
          blackVisibleSuggest: blackList,
        })
        versionId = pickStr(asRecord(created.data), ['versionId', 'version_id', 'id']) ?? pickStr(created, ['versionId'])
      }
      if (versionId) {
        await client.postJson(`/developers/v1/publish/commit/${larkAppId}/${versionId}`, { clientId: larkAppId })
      }
      return { synced: true }
    } catch (err) {
      return {
        synced: false,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private updateJob(jobId: string, patch: Partial<LarkQrJobView>): void {
    const cur = this.jobs.get(jobId)
    if (!cur) return
    this.jobs.set(jobId, { ...cur, ...patch })
  }

  private readCookieFile(path: string): StoredWebCookie[] {
    if (!path || !existsSync(path)) return []
    try {
      const parsed = asRecord(JSON.parse(readFileSync(path, 'utf8')))
      if (!Array.isArray(parsed.cookies)) return []
      return pruneCookies(parsed.cookies as StoredWebCookie[])
    } catch {
      return []
    }
  }

  private async loadValidConsoleClient(): Promise<
    { client: ConsoleClient; cookies: StoredWebCookie[]; source: 'local_cache' | 'cli_cache' } | undefined
  > {
    const localCookies = this.readCookieFile(this.sessionPath)
    if (localCookies.length > 0) {
      const client = await openConsoleClient(localCookies, this.fetcher).catch(() => undefined)
      if (client) return { client, cookies: localCookies, source: 'local_cache' }
    }
    const cliCookies = this.readCookieFile(this.cliFallbackSessionPath)
    if (cliCookies.length > 0) {
      const client = await openConsoleClient(cliCookies, this.fetcher).catch(() => undefined)
      if (client) {
        writePrivateJson(this.sessionPath, { cookies: cliCookies })
        return { client, cookies: cliCookies, source: 'cli_cache' }
      }
    }
    return undefined
  }

  private async performInteractiveQrLogin(jobId: string): Promise<{
    cookies: StoredWebCookie[]
    client: ConsoleClient
  }> {
    const jar = new CookieJar()
    const redirectUri = `${ASK_ORIGIN}/`
    const initEndpoint = `${ACCOUNTS_ORIGIN}/accounts/qrlogin/init?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`
    const { response: initRes } = await jar.fetch(
      initEndpoint,
      {
        method: 'POST',
        headers: {
          ...QR_COMMON_HEADERS,
          'x-app-id': QR_LOGIN_APP_ID,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ biz_type: null, redirect_uri: redirectUri }),
      },
      this.fetcher,
    )
    const initData = asRecord(await initRes.json())
    if (initData.code !== 0) {
      throw new Error(pickStr(initData, ['message', 'msg']) ?? '初始化飞书扫码登录失败')
    }
    const token = pickStr(asRecord(asRecord(initData.data).step_info), ['token'])
    const flowKey = initRes.headers.get('x-flow-key') ?? ''
    if (!token || !flowKey) {
      throw new Error('飞书扫码初始化缺少 token 或 flowKey')
    }

    const qrPayload = JSON.stringify({ qrlogin: { token } })
    const qrSvgDataUrl = renderQrSvgDataUrl(qrPayload)
    this.updateJob(jobId, {
      status: 'waiting_scan',
      stepMessage: '请使用手机飞书 App 扫码登录开放平台',
      qrSvgDataUrl,
    })

    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const pollUrl = `${ACCOUNTS_ORIGIN}/accounts/qrlogin/polling?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`
      const { response: pollRes } = await jar.fetch(
        pollUrl,
        {
          method: 'POST',
          headers: {
            ...QR_COMMON_HEADERS,
            'x-app-id': QR_LOGIN_APP_ID,
            'x-flow-key': flowKey,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ biz_type: null }),
        },
        this.fetcher,
      )
      const pollData = asRecord(await pollRes.json())
      if (pollData.code !== 0) {
        throw new Error(pickStr(pollData, ['message', 'msg']) ?? '扫码状态轮询失败')
      }
      const inner = asRecord(pollData.data)
      const stepInfo = asRecord(inner.step_info)
      const nextStep = pickStr(inner, ['next_step'])
      const statusNum = typeof stepInfo.status === 'number' ? stepInfo.status : 0

      if (statusNum === 2) {
        this.updateJob(jobId, {
          status: 'scanned',
          stepMessage: '已扫码，请在手机飞书上点击确认登录…',
        })
      } else if (statusNum === 5) {
        throw Object.assign(new Error('二维码已过期，请重新获取'), { expired: true })
      }

      if (nextStep === 'enter_app') {
        const crossUri = pickStr(stepInfo, ['cross_login_uri'])
        if (crossUri) {
          await jar.fetch(crossUri, { method: 'GET' }, this.fetcher)
        }
        await jar.fetch(redirectUri, { method: 'GET' }, this.fetcher)
        const cookies = jar.toJSON()
        const client = await openConsoleClient(cookies, this.fetcher)
        if (!client) {
          throw new Error('扫码完成，但未能获取开放平台控制台凭证')
        }
        writePrivateJson(this.sessionPath, { cookies })
        return { cookies, client }
      }
    }
    throw Object.assign(new Error('等待扫码超时'), { expired: true })
  }

  private async runOpenPlatformQrFlow(jobId: string): Promise<void> {
    try {
      const { client } = await this.performInteractiveQrLogin(jobId)
      this.updateJob(jobId, {
        status: 'succeeded',
        stepMessage: client.identity
          ? `已登录：${client.identity.userName}（${client.identity.tenantName}）`
          : '飞书开放平台登录成功',
        ...(client.identity ? { identity: client.identity } : {}),
      })
    } catch (err) {
      const expired = Boolean((err as { expired?: boolean })?.expired)
      this.updateJob(jobId, {
        status: expired ? 'expired' : 'failed',
        stepMessage: err instanceof Error ? err.message : String(err),
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async runOpenPlatformCreate(
    jobId: string,
    input: AutoCreateBotRequest,
    onCreated: (created: AutoCreatedBotCredentials) => Promise<void>,
  ): Promise<void> {
    try {
      const name = input.name.trim()
      if (!name) throw new Error('智能体名称不能为空')
      const description = input.description?.trim() || `${name} · DeepSeekHarness 智能协作助手`
      const botId = input.id?.trim() || slugifyBotId(name)

      let loaded = await this.loadValidConsoleClient()
      if (!loaded) {
        const interactive = await this.performInteractiveQrLogin(jobId)
        loaded = { client: interactive.client, cookies: interactive.cookies, source: 'local_cache' }
      }
      const { client } = loaded
      if (!client.identity?.userId) {
        throw new Error('开放平台未返回当前登录用户身份，请重新扫码登录')
      }

      this.updateJob(jobId, {
        status: 'working',
        stepMessage: `正在以 ${client.identity.userName}（${client.identity.tenantName}）身份创建飞书智能体…`,
        identity: client.identity,
      })

      // 1. Upload generated 512x512 icon
      const iconBytes = generateDefaultBotIconPng()
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(iconBytes)], { type: 'image/png' }), 'bot-icon.png')
      form.append('uploadType', '4')
      form.append('isIsv', 'false')
      form.append('scale', JSON.stringify({ width: 512, height: 512 }))
      const uploaded = await client.postForm('/developers/v1/app/upload/image', form)
      const iconUrl = pickStr(uploaded, ['url']) ?? pickStr(asRecord(uploaded.data), ['url'])
      if (!iconUrl) throw new Error('上传默认智能体图标失败')

      // 2. Create app via developer_console template (fallback to /developers/v1/app/create)
      let appId: string | undefined
      try {
        const created = await client.postJson('/developers/v1/manifest/upsert_by_template', {
          appManifestTemplateID: 'developer_console',
          createAppUserCustomField: {
            i18n: { zh_cn: { name, description } },
            avatar: iconUrl,
            primaryLang: 'zh_cn',
          },
          cid: randomUUID(),
          HTTPHead: {},
        })
        appId =
          pickStr(created, ['ClientID', 'clientID', 'clientId', 'appId']) ??
          pickStr(asRecord(created.data), ['ClientID', 'clientID', 'clientId', 'appId'])
      } catch {
        appId = undefined
      }
      if (!appId) {
        const created = await client.postJson('/developers/v1/app/create', {
          appSceneType: 0,
          name,
          desc: description,
          avatar: iconUrl,
          i18n: { zh_cn: { name, description } },
          primaryLang: 'zh_cn',
        })
        appId =
          pickStr(created, ['ClientID', 'clientID', 'clientId', 'appId']) ??
          pickStr(asRecord(created.data), ['ClientID', 'clientID', 'clientId', 'appId'])
      }
      if (!appId?.startsWith('cli_')) {
        throw new Error('开放平台未返回有效的 App ID')
      }

      // 3. Enable bot ability, WebSocket event mode, scopes, events & callbacks
      this.updateJob(jobId, {
        status: 'working',
        larkAppId: appId,
        stepMessage: '正在开启飞书应用能力、长连接订阅与基础权限…',
      })
      await client.postJson(`/developers/v1/robot/switch/${appId}`, { clientId: appId, enable: true })
      await client.postJson(`/developers/v1/event/switch/${appId}`, {
        clientId: appId,
        eventMode: LONG_CONNECTION_EVENT_MODE,
      })
      await client
        .postJson(`/developers/v1/callback/switch/${appId}`, {
          clientId: appId,
          callbackMode: LONG_CONNECTION_EVENT_MODE,
        })
        .catch(() => {})

      // Import scopes best-effort
      try {
        const scopeCatalogPayload = await client.postJson(`/developers/v1/scope/all/${appId}`, {})
        const catalog: Array<{ id: string; name: string; bucket?: 'tenant' | 'user' }> = []
        collectScopeEntries(scopeCatalogPayload, undefined, catalog)
        const appScopeIDs = DEFAULT_TENANT_SCOPES.map(
          (n) => (catalog.find((c) => c.name === n && c.bucket === 'tenant') ?? catalog.find((c) => c.name === n))?.id,
        ).filter((v): v is string => Boolean(v))
        const userScopeIDs = DEFAULT_USER_SCOPES.map(
          (n) => (catalog.find((c) => c.name === n && c.bucket === 'user') ?? catalog.find((c) => c.name === n))?.id,
        ).filter((v): v is string => Boolean(v))
        if (appScopeIDs.length > 0 || userScopeIDs.length > 0) {
          await client.postJson(`/developers/v1/scope/update/${appId}`, {
            clientId: appId,
            appScopeIDs: [...new Set(appScopeIDs)],
            userScopeIDs: [...new Set(userScopeIDs)],
            scopeIds: [],
            operation: 'add',
            isDeveloperPanel: true,
          })
        }
      } catch {
        // Template app already carries baseline bot scopes.
      }

      // Subscribe baseline events & card callback
      await client
        .postJson(`/developers/v1/event/update/${appId}`, {
          clientId: appId,
          operation: 'add',
          events: [],
          appEvents: BASELINE_APP_EVENTS,
          userEvents: [],
          eventMode: LONG_CONNECTION_EVENT_MODE,
        })
        .catch(() => {})
      await client
        .postJson(`/developers/v1/callback/update/${appId}`, {
          clientId: appId,
          operation: 'add',
          callbacks: BASELINE_CALLBACKS,
          callbackMode: LONG_CONNECTION_EVENT_MODE,
        })
        .catch(() => {})

      // 4. Create & commit initial version 1.0.0 so the bot is immediately active in tenant
      this.updateJob(jobId, {
        status: 'working',
        stepMessage: '正在发布智能体版本并读取应用凭证…',
      })
      const versionCreated = await client.postJson(`/developers/v1/app_version/create/${appId}`, {
        appVersion: '1.0.0',
        mobileDefaultAbility: 'bot',
        pcDefaultAbility: 'bot',
        changeLog: 'Initial bot release.',
        visibleSuggest: {
          departments: [],
          members: [client.identity.userId],
          groups: [],
          isAll: 0,
        },
        blackVisibleSuggest: {
          departments: [],
          members: [],
          groups: [],
          isAll: 0,
        },
      })
      const versionId =
        pickStr(asRecord(versionCreated.data), ['versionId', 'version_id', 'id']) ??
        pickStr(versionCreated, ['versionId', 'version_id', 'id'])
      if (!versionId) {
        throw new Error(`应用 ${appId} 已创建，但未能生成可发布的初始版本`)
      }
      await client.postJson(`/developers/v1/publish/commit/${appId}/${versionId}`, { clientId: appId })

      const secretPayload = await client.postJson(`/developers/v1/secret/${appId}`, {})
      const appSecret =
        pickStr(asRecord(secretPayload.data), ['secret']) ?? pickStr(secretPayload, ['secret'])
      if (!appSecret) {
        throw new Error(`应用 ${appId} 已创建，但读取 App Secret 失败`)
      }

      await onCreated({
        id: botId,
        name,
        description,
        larkAppId: appId,
        larkAppSecret: appSecret,
      })

      this.updateJob(jobId, {
        status: 'succeeded',
        createdBotId: botId,
        larkAppId: appId,
        stepMessage: `智能体「${name}」（${appId}）已自动创建并接入长连接`,
      })
    } catch (err) {
      const expired = Boolean((err as { expired?: boolean })?.expired)
      const msg = err instanceof Error ? err.message : String(err)
      this.updateJob(jobId, {
        status: expired ? 'expired' : 'failed',
        stepMessage: msg,
        error: msg,
      })
    }
  }

  private async runSdkDeviceFlowCreate(
    jobId: string,
    input: AutoCreateBotRequest,
    onCreated: (created: AutoCreatedBotCredentials) => Promise<void>,
  ): Promise<void> {
    try {
      const name = input.name.trim()
      if (!name) throw new Error('智能体名称不能为空')
      const description = input.description?.trim() || ''
      const botId = input.id?.trim() || slugifyBotId(name)

      const result = await registerApp({
        source: 'dsh-lark-bridge',
        onQRCodeReady: (info: { url: string }) => {
          this.updateJob(jobId, {
            status: 'waiting_scan',
            stepMessage: '请使用手机飞书扫码创建个人智能体应用',
            qrSvgDataUrl: renderQrSvgDataUrl(info.url),
            verificationUrl: info.url,
          })
        },
      })
      if (!result.client_id || !result.client_secret) {
        throw new Error('扫码建应用未返回有效的凭证')
      }

      await onCreated({
        id: botId,
        name,
        description,
        larkAppId: result.client_id,
        larkAppSecret: result.client_secret,
      })

      this.updateJob(jobId, {
        status: 'succeeded',
        createdBotId: botId,
        larkAppId: result.client_id,
        stepMessage: `智能体「${name}」（${result.client_id}）已创建并接入`,
      })
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).replace(/[a-zA-Z0-9_-]{30,}/g, '***')
      this.updateJob(jobId, {
        status: /expired/i.test(msg) ? 'expired' : 'failed',
        stepMessage: msg,
        error: msg,
      })
    }
  }

  private async runUserOAuthDeviceFlow(
    jobId: string,
    botId: string,
    larkAppId: string,
    larkAppSecret: string,
  ): Promise<void> {
    try {
      const basic = Buffer.from(`${larkAppId}:${larkAppSecret}`).toString('base64')
      const scope = 'contact:user:search contact:contact.base:readonly offline_access'
      const body = new URLSearchParams({ client_id: larkAppId, scope })
      const res = await this.fetcher(`${ACCOUNTS_ORIGIN}/oauth/v1/device_authorization`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      })
      const data = asRecord(await res.json().catch(() => ({})))
      const deviceCode = pickStr(data, ['device_code'])
      const verifyUrl = pickStr(data, ['verification_uri_complete', 'verification_uri'])
      if (!res.ok || !deviceCode || !verifyUrl) {
        const desc = pickStr(data, ['error_description', 'error', 'msg']) ?? `HTTP ${res.status}`
        throw new Error(`发起用户授权失败：${desc}`)
      }

      const expiresIn = Number(data.expires_in) || 240
      let intervalSec = Math.max(2, Number(data.interval) || 3)
      this.updateJob(jobId, {
        status: 'waiting_scan',
        stepMessage: '请使用手机飞书扫码授权企业通讯录成员搜索',
        qrSvgDataUrl: renderQrSvgDataUrl(verifyUrl),
        verificationUrl: verifyUrl,
      })

      const deadline = Date.now() + expiresIn * 1000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000))
        const tokenBody = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: larkAppId,
          client_secret: larkAppSecret,
        })
        const pollRes = await this.fetcher(`${OPEN_ORIGIN}/open-apis/authen/v2/oauth/token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: tokenBody.toString(),
        })
        const pollData = asRecord(await pollRes.json().catch(() => ({})))
        const accessToken = pickStr(pollData, ['access_token'])
        if (accessToken) {
          const refreshToken = pickStr(pollData, ['refresh_token'])
          const tokenExpires = Number(pollData.expires_in) || 7200
          const grantedScope = pickStr(pollData, ['scope'])
          this.oauthTokens.set(botId, {
            botId,
            larkAppId,
            accessToken,
            ...(refreshToken ? { refreshToken } : {}),
            ...(grantedScope ? { scope: grantedScope } : {}),
            expiresAtMs: Date.now() + tokenExpires * 1000,
            updatedAtMs: Date.now(),
          })
          this.persistOAuthTokens()
          this.updateJob(jobId, {
            status: 'succeeded',
            stepMessage: '企业通讯录搜索授权成功',
          })
          return
        }
        const errCode = pickStr(pollData, ['error'])
        if (errCode === 'authorization_pending') continue
        if (errCode === 'slow_down') {
          intervalSec += 2
          continue
        }
        if (errCode === 'expired_token') {
          throw Object.assign(new Error('授权二维码已过期'), { expired: true })
        }
        if (errCode) {
          throw new Error(pickStr(pollData, ['error_description']) ?? errCode)
        }
      }
      throw Object.assign(new Error('等待用户扫码授权超时'), { expired: true })
    } catch (err) {
      const expired = Boolean((err as { expired?: boolean })?.expired)
      const msg = err instanceof Error ? err.message : String(err)
      this.updateJob(jobId, {
        status: expired ? 'expired' : 'failed',
        stepMessage: msg,
        error: msg,
      })
    }
  }

  private loadOAuthTokens(): void {
    if (!existsSync(this.oauthPath)) return
    try {
      const raw = asRecord(JSON.parse(readFileSync(this.oauthPath, 'utf8')))
      const list = Array.isArray(raw.tokens) ? raw.tokens : []
      for (const item of list) {
        const rec = asRecord(item)
        const botId = pickStr(rec, ['botId'])
        const larkAppId = pickStr(rec, ['larkAppId'])
        const accessToken = pickStr(rec, ['accessToken'])
        if (!botId || !larkAppId || !accessToken) continue
        this.oauthTokens.set(botId, {
          botId,
          larkAppId,
          accessToken,
          ...(pickStr(rec, ['refreshToken']) ? { refreshToken: pickStr(rec, ['refreshToken'])! } : {}),
          ...(pickStr(rec, ['scope']) ? { scope: pickStr(rec, ['scope'])! } : {}),
          expiresAtMs: Number(rec.expiresAtMs) || 0,
          updatedAtMs: Number(rec.updatedAtMs) || Date.now(),
        })
      }
    } catch {
      // Ignore unreadable oauth file.
    }
  }

  private persistOAuthTokens(): void {
    writePrivateJson(this.oauthPath, {
      tokens: [...this.oauthTokens.values()],
    })
  }
}
