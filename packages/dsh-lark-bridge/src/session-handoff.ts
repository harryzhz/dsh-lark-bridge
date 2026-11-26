import { execFile } from 'node:child_process'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const LARK_SESSION_OPEN_PATH = '/api/lark-bridge/open'

export interface LoopbackConnectionAuth {
  admit(req: IncomingMessage): { peer: unknown } | { rejection: 401 | 403 | 503 }
  authenticatedUrl?(baseUrl: string): string
}

export interface SessionViewerRenderer {
  verifyTicket(sessionId: string, ticket: string): boolean
  canViewSession(sessionId: string): boolean
  renderViewerPage(
    sessionId: string,
    ticket: string,
  ): Promise<{ readonly status: number; readonly html?: string; readonly error?: string }>
}

export interface DesktopOpenCommand {
  readonly requestId: string
  readonly sessionId: string
}

interface CommandWaiter {
  readonly resolve: (cmd: DesktopOpenCommand | null) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly cleanupAbort?: () => void
}

interface AckWaiter {
  readonly resolve: (opened: boolean) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const DEFAULT_WAIT_TIMEOUT_MS = 20_000
const MIN_WAIT_TIMEOUT_MS = 1_000
const MAX_WAIT_TIMEOUT_MS = 30_000
const ACTIVE_DESKTOP_ACK_TIMEOUT_MS = 1_500
const WAKE_DESKTOP_ACK_TIMEOUT_MS = 3_500
const PENDING_COMMAND_TTL_MS = 10_000

function encodeBase64Url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/**
 * Mirrors `@deepseek-ai/dsh-client-connection`'s loopback authority check:
 * `localhost`, IPv6 loopback (`[::1]`), or any IPv4 address in `127/8`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true
  const parts = normalized.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.trim().toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHostname(normalized.slice('::ffff:'.length))
  }
  return isLoopbackHostname(normalized)
}

/**
 * Bring the running DeepSeek Harness Desktop window to the foreground via its
 * official registered `dsh://open` URL scheme (macOS `open-url` / Windows `second-instance`).
 */
export function focusDesktopApp(platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === 'darwin') {
      execFile('open', ['dsh://open'], () => {})
      return
    }
    if (platform === 'win32') {
      execFile('cmd.exe', ['/d', '/c', 'start', '', 'dsh://open'], () => {})
      return
    }
    execFile('xdg-open', ['dsh://open'], () => {})
  } catch {
    // Non-fatal: the session has already been activated inside the Desktop renderer.
  }
}

/**
 * Per-process HMAC signer and Desktop navigation coordinator for loopback
 * session handoff links. Keeps DSH's master `launchToken` out of Feishu cards
 * and coordinates direct session switching with an attached Desktop renderer.
 */
export class LoopbackSessionHandoff {
  private readonly secret: Buffer
  private readonly commandWaiters = new Set<CommandWaiter>()
  private readonly ackWaiters = new Map<string, AckWaiter>()
  private pendingCommand: (DesktopOpenCommand & { readonly createdAtMs: number }) | null = null
  private desktopEverAttached = false
  private disposed = false

  constructor(secret: Buffer = randomBytes(32)) {
    this.secret = secret
  }

  get hasActiveDesktopClient(): boolean {
    return this.commandWaiters.size > 0
  }

  get hasSeenDesktopClient(): boolean {
    return this.desktopEverAttached
  }

  signTicket(sessionId: string): string {
    return encodeBase64Url(createHmac('sha256', this.secret).update(sessionId, 'utf8').digest())
  }

  verifyTicket(sessionId: string, ticket: string): boolean {
    if (!sessionId || !ticket) return false
    const expected = Buffer.from(this.signTicket(sessionId), 'utf8')
    const candidate = Buffer.from(ticket, 'utf8')
    return expected.byteLength === candidate.byteLength && timingSafeEqual(expected, candidate)
  }

  buildUrl(baseOrigin: string, sessionId: string): string {
    const cleanBase = baseOrigin.trim().replace(/\/+$/, '')
    const ticket = this.signTicket(sessionId)
    return `${cleanBase}${LARK_SESSION_OPEN_PATH}?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`
  }

  /**
   * Long-poll called exclusively by the DSH Desktop renderer (`dsh-app://app`)
   * to receive session-open commands triggered from Feishu cards.
   */
  waitForCommand(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, signal?: AbortSignal): Promise<DesktopOpenCommand | null> {
    if (this.disposed || signal?.aborted) {
      return Promise.resolve(null)
    }
    this.desktopEverAttached = true

    if (this.pendingCommand) {
      const pending = this.pendingCommand
      this.pendingCommand = null
      if (Date.now() - pending.createdAtMs <= PENDING_COMMAND_TTL_MS) {
        return Promise.resolve({ requestId: pending.requestId, sessionId: pending.sessionId })
      }
    }

    const boundedMs = Math.max(
      MIN_WAIT_TIMEOUT_MS,
      Math.min(MAX_WAIT_TIMEOUT_MS, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : DEFAULT_WAIT_TIMEOUT_MS),
    )

    return new Promise<DesktopOpenCommand | null>((resolve) => {
      const finish = (value: DesktopOpenCommand | null) => {
        if (!this.commandWaiters.delete(entry)) return
        clearTimeout(entry.timer)
        entry.cleanupAbort?.()
        resolve(value)
      }

      const timer = setTimeout(() => finish(null), boundedMs)
      timer.unref?.()

      let cleanupAbort: (() => void) | undefined
      if (signal) {
        const onAbort = () => finish(null)
        signal.addEventListener('abort', onAbort, { once: true })
        cleanupAbort = () => signal.removeEventListener('abort', onAbort)
      }

      const entry: CommandWaiter = {
        resolve: finish,
        timer,
        ...(cleanupAbort ? { cleanupAbort } : {}),
      }
      this.commandWaiters.add(entry)
    })
  }

  ackCommand(requestId: string, opened: boolean): boolean {
    const waiter = this.ackWaiters.get(requestId)
    if (!waiter) return false
    this.ackWaiters.delete(requestId)
    clearTimeout(waiter.timer)
    waiter.resolve(opened)
    return true
  }

  /**
   * Attempt to open `sessionId` directly inside the running DSH Desktop app.
   * Returns `true` only once the Desktop renderer confirms the session is open;
   * returns `false` immediately if no Desktop renderer has attached so Web mode
   * has zero added latency.
   */
  async requestOpenInDesktop(
    sessionId: string,
    options: {
      readonly focusApp?: () => void
      readonly activeAckTimeoutMs?: number
      readonly wakeAckTimeoutMs?: number
    } = {},
  ): Promise<boolean> {
    if (this.disposed) return false
    const focus = options.focusApp ?? focusDesktopApp
    const hadActiveWaiter = this.commandWaiters.size > 0
    if (!hadActiveWaiter && !this.desktopEverAttached) {
      return false
    }

    const requestId = randomUUID()
    const command: DesktopOpenCommand = { requestId, sessionId }
    const ackTimeoutMs = hadActiveWaiter
      ? (options.activeAckTimeoutMs ?? ACTIVE_DESKTOP_ACK_TIMEOUT_MS)
      : (options.wakeAckTimeoutMs ?? WAKE_DESKTOP_ACK_TIMEOUT_MS)

    const ackPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(requestId)
        if (this.pendingCommand?.requestId === requestId) {
          this.pendingCommand = null
        }
        resolve(false)
      }, ackTimeoutMs)
      timer.unref?.()
      this.ackWaiters.set(requestId, { resolve, timer })
    })

    if (hadActiveWaiter) {
      for (const waiter of [...this.commandWaiters]) {
        waiter.resolve(command)
      }
    } else {
      // macOS window was closed to Dock while the Desktop Host stayed alive:
      // wake the window first and hand off the queued command as soon as it attaches.
      this.pendingCommand = { ...command, createdAtMs: Date.now() }
      focus()
    }

    const opened = await ackPromise
    if (opened && hadActiveWaiter) {
      focus()
    }
    return opened
  }

  dispose(): void {
    this.disposed = true
    this.pendingCommand = null
    for (const waiter of [...this.commandWaiters]) {
      waiter.resolve(null)
    }
    this.commandWaiters.clear()
    for (const [id, waiter] of [...this.ackWaiters]) {
      this.ackWaiters.delete(id)
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function safeInlineJson(value: string): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

/**
 * Same-origin HTML bounce document. Navigating from a same-origin document
 * breaks out of cross-site redirect chains (e.g. clicks from Feishu Web),
 * ensuring DSH's `SameSite=Strict` auth cookie is sent on the follow-up `GET /`
 * while preserving the `#session=<id>` hash fragment.
 */
export function renderSessionBounceHtml(targetUrl: string): string {
  if (!targetUrl.startsWith('/')) {
    throw new Error('session bounce target must be a root-relative path')
  }
  const safeAttr = escapeHtmlAttribute(targetUrl)
  const safeScriptArg = safeInlineJson(targetUrl)
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<title>DeepSeek Harness</title>',
    `<noscript><meta http-equiv="refresh" content="0;url=${safeAttr}"></noscript>`,
    '</head>',
    '<body>',
    `<script>window.location.replace(${safeScriptArg});</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * Minimal confirmation page shown only if the browser does not allow
 * `window.close()` after the session was already opened in DSH Desktop.
 */
export function renderDesktopOpenedHtml(webFallbackUrl: string): string {
  if (!webFallbackUrl.startsWith('/')) {
    throw new Error('web fallback target must be a root-relative path')
  }
  const safeFallback = escapeHtmlAttribute(webFallbackUrl)
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>已在 DeepSeek Harness 打开</title>',
    '<style>',
    ':root{color-scheme:light dark;--bg:#f8f9fb;--card:#fff;--fg:#111827;--muted:#6b7280;--border:#e5e7eb;--accent:#111827;--accent-fg:#fff}',
    '@media(prefers-color-scheme:dark){:root{--bg:#151517;--card:#1e1f23;--fg:#f3f4f6;--muted:#9ca3af;--border:#2d2f36;--accent:#f3f4f6;--accent-fg:#111827}}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.card{max-width:360px;padding:24px 28px;border-radius:14px;background:var(--card);border:1px solid var(--border);text-align:center}',
    'h1{margin:0 0 8px;font-size:16px;font-weight:600}',
    'p{margin:0 0 18px;font-size:13px;color:var(--muted)}',
    '.actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}',
    'a{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 14px;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none}',
    '.primary{background:var(--accent);color:var(--accent-fg)}',
    '.secondary{border:1px solid var(--border);color:var(--fg)}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="card">',
    '<h1>已在 DeepSeek Harness 桌面端打开会话</h1>',
    '<p>可直接返回桌面应用继续对话，本标签页可安全关闭。</p>',
    '<div class="actions">',
    '<a class="primary" href="dsh://open">切换到桌面端</a>',
    `<a class="secondary" href="${safeFallback}">改为在浏览器打开</a>`,
    '</div>',
    '</div>',
    '<script>try{window.close();}catch{}</script>',
    '</body>',
    '</html>',
  ].join('\n')
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function matchesLiveOriginAuthority(hostHeader: string | undefined, liveOrigin: string): boolean {
  if (!hostHeader) return false
  try {
    const liveUrl = new URL(liveOrigin)
    const reqUrl = new URL(`${liveUrl.protocol}//${hostHeader}`)
    return reqUrl.host === liveUrl.host
  } catch {
    return false
  }
}

function sendPlainText(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(message)
}

function sendHtml(res: ServerResponse, method: string, html: string, status = 200): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
  })
  res.end(method === 'HEAD' ? undefined : html)
}

/**
 * Minimal error page for browser users when a read-only share link is invalid,
 * revoked, or disabled for the session's bot/group.
 */
export function renderViewerDeniedHtml(message: string): string {
  const safeMessage = escapeHtmlAttribute(message)
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>无权查看该会话 · DeepSeek Harness</title>',
    '<style>',
    ':root{color-scheme:light dark;--bg:#f8f9fb;--card:#fff;--fg:#111827;--muted:#6b7280;--border:#e5e7eb}',
    '@media(prefers-color-scheme:dark){:root{--bg:#151517;--card:#1e1f23;--fg:#f3f4f6;--muted:#9ca3af;--border:#2d2f36}}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.card{max-width:380px;padding:24px 28px;border-radius:14px;background:var(--card);border:1px solid var(--border);text-align:center}',
    'h1{margin:0 0 8px;font-size:16px;font-weight:600}',
    'p{margin:0;font-size:13px;color:var(--muted)}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="card">',
    '<h1>无权查看该会话</h1>',
    `<p>${safeMessage}</p>`,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}

function acceptsHtml(req: IncomingMessage): boolean {
  const accept = singleHeader(req.headers.accept)?.toLowerCase() ?? ''
  return accept.includes('text/html')
}

function sendViewerRefusal(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  const method = (req.method ?? 'GET').toUpperCase()
  if (acceptsHtml(req)) {
    sendHtml(res, method, renderViewerDeniedHtml(message), status)
    return
  }
  sendPlainText(res, status, `${message}\n`)
}

function isTopLevelDocumentNavigation(req: IncomingMessage): boolean {
  if (singleHeader(req.headers.origin)) return false
  const fetchMode = singleHeader(req.headers['sec-fetch-mode'])?.toLowerCase()
  if (fetchMode && fetchMode !== 'navigate') return false
  const fetchDest = singleHeader(req.headers['sec-fetch-dest'])?.toLowerCase()
  if (fetchDest && fetchDest !== 'document') return false
  return true
}

function matchesAnyAllowedAuthority(
  hostHeader: string | undefined,
  origins: readonly string[],
): boolean {
  if (!hostHeader) return false
  for (const origin of origins) {
    if (origin && matchesLiveOriginAuthority(hostHeader, origin)) return true
  }
  return false
}

/**
 * Unified session-open handler for `GET /api/lark-bridge/open`:
 * - Pure loopback deployments (Desktop / local `dsh web`): delegates strictly to
 *   `handleLoopbackSessionOpen` (Desktop handoff or local Owner bounce).
 * - Non-loopback deployments (LAN / server / reverse proxy): never mints `launchToken`;
 *   authenticated Owners bounce directly to `/#session=<id>`, while unauthenticated
 *   group members holding a valid HMAC ticket receive a native read-only DSH viewer page.
 */
export async function handleSessionOpen(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    readonly liveOrigin: string
    readonly advertisedOrigin?: string
    readonly connection: LoopbackConnectionAuth
    readonly resolveAuthenticatedUrl?: (baseUrl: string) => string | undefined
    readonly handoff?: LoopbackSessionHandoff
    readonly viewer?: SessionViewerRenderer
    readonly focusApp?: () => void
  },
): Promise<void> {
  const {
    liveOrigin,
    advertisedOrigin = '',
    connection,
    resolveAuthenticatedUrl,
    handoff,
    viewer,
    focusApp,
  } = options
  const pureLoopback =
    Boolean(liveOrigin) &&
    isLoopbackOrigin(liveOrigin) &&
    (!advertisedOrigin || isLoopbackOrigin(advertisedOrigin))

  if (pureLoopback) {
    await handleLoopbackSessionOpen(req, res, {
      liveOrigin,
      connection,
      ...(resolveAuthenticatedUrl ? { resolveAuthenticatedUrl } : {}),
      ...(handoff ? { handoff } : {}),
      ...(focusApp ? { focusApp } : {}),
    })
    return
  }

  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    sendPlainText(res, 405, 'method not allowed\n', { allow: 'GET, HEAD' })
    return
  }

  const authorityBase = advertisedOrigin || liveOrigin
  if (!authorityBase) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }

  const parsed = new URL(req.url ?? '/', authorityBase)
  const sessionId = parsed.searchParams.get('session')?.trim() ?? ''
  const ticket = parsed.searchParams.get('ticket')?.trim() ?? ''
  if (!sessionId || sessionId.length > 256 || /[\r\n]/.test(sessionId)) {
    sendViewerRefusal(req, res, 403, '无效的会话链接。')
    return
  }

  // 1. Authenticated DSH Owner -> seamless jump into full Owner session
  const alreadyOwner = !('rejection' in connection.admit(req))
  if (alreadyOwner) {
    if (!isTopLevelDocumentNavigation(req)) {
      sendPlainText(res, 403, 'forbidden\n')
      return
    }
    let basePath = ''
    try {
      const pathname = new URL(authorityBase).pathname.replace(/\/+$/, '')
      if (pathname && pathname !== '/') basePath = pathname
    } catch {
      basePath = ''
    }
    sendHtml(res, method, renderSessionBounceHtml(`${basePath}/#session=${encodeURIComponent(sessionId)}`))
    return
  }

  // 2. Unauthenticated colleague -> strictly read-only single-session viewer
  if (!matchesAnyAllowedAuthority(singleHeader(req.headers.host), [liveOrigin, advertisedOrigin])) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }
  if (!isTopLevelDocumentNavigation(req)) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }
  if (!viewer || !ticket || !viewer.verifyTicket(sessionId, ticket) || !viewer.canViewSession(sessionId)) {
    sendViewerRefusal(
      req,
      res,
      403,
      '该链接已失效、签名密钥已重置，或管理员未开启群成员只读查看权限。',
    )
    return
  }

  const rendered = await viewer.renderViewerPage(sessionId, ticket)
  if (rendered.status !== 200 || !rendered.html) {
    const status = rendered.status === 403 ? 403 : 503
    sendViewerRefusal(
      req,
      res,
      status,
      status === 403
        ? '无权查看该会话。'
        : '只读会话视图服务暂不可用，请确认 DSH Web 端服务已就绪。',
    )
    return
  }
  sendHtml(res, method, rendered.html, 200)
}

/**
 * Loopback-only session handoff endpoint (`GET /api/lark-bridge/open`).
 * In DSH Desktop, prefers switching directly to the session inside the Desktop
 * app and bringing its window to the front; falls back smoothly to an
 * authenticated same-origin Web bounce when Desktop is unavailable or `mode=web`.
 */
export async function handleLoopbackSessionOpen(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    readonly liveOrigin: string
    readonly connection: LoopbackConnectionAuth
    readonly resolveAuthenticatedUrl?: (baseUrl: string) => string | undefined
    readonly handoff?: LoopbackSessionHandoff
    readonly focusApp?: () => void
  },
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    sendPlainText(res, 405, 'method not allowed\n', { allow: 'GET, HEAD' })
    return
  }

  const { liveOrigin, connection, handoff, focusApp } = options
  if (!handoff || !liveOrigin || !isLoopbackOrigin(liveOrigin)) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }

  const remoteAddress = req.socket?.remoteAddress
  if (remoteAddress !== undefined && !isLoopbackRemoteAddress(remoteAddress)) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }

  if (!matchesLiveOriginAuthority(singleHeader(req.headers.host), liveOrigin)) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }

  // Only top-level browser document navigations may reach this endpoint;
  // block background fetch/XHR/subresource calls (which send Origin or non-navigate fetch metadata).
  if (singleHeader(req.headers.origin)) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }
  const fetchMode = singleHeader(req.headers['sec-fetch-mode'])?.toLowerCase()
  if (fetchMode && fetchMode !== 'navigate') {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }
  const fetchDest = singleHeader(req.headers['sec-fetch-dest'])?.toLowerCase()
  if (fetchDest && fetchDest !== 'document') {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }

  const parsed = new URL(req.url ?? '/', liveOrigin)
  const sessionId = parsed.searchParams.get('session')?.trim() ?? ''
  const ticket = parsed.searchParams.get('ticket')?.trim() ?? ''
  if (!sessionId || sessionId.length > 256 || /[\r\n]/.test(sessionId) || !handoff.verifyTicket(sessionId, ticket)) {
    sendPlainText(res, 403, 'invalid session handoff ticket\n')
    return
  }

  const forceWeb = parsed.searchParams.get('mode') === 'web'
  if (!forceWeb && method === 'GET') {
    const openedInDesktop = await handoff.requestOpenInDesktop(
      sessionId,
      focusApp ? { focusApp } : undefined,
    )
    if (openedInDesktop) {
      const webFallbackUrl = `${LARK_SESSION_OPEN_PATH}?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}&mode=web`
      sendHtml(res, method, renderDesktopOpenedHtml(webFallbackUrl))
      return
    }
  }

  const sessionHash = `#session=${encodeURIComponent(sessionId)}`
  const alreadyAuthed = !('rejection' in connection.admit(req))
  let targetUrl: string
  if (alreadyAuthed) {
    targetUrl = `/${sessionHash}`
  } else {
    const resolvedAuthUrl =
      options.resolveAuthenticatedUrl?.(liveOrigin) ??
      (typeof connection.authenticatedUrl === 'function'
        ? connection.authenticatedUrl(liveOrigin)
        : undefined)
    if (resolvedAuthUrl) {
      const authed = new URL(resolvedAuthUrl)
      authed.hash = sessionHash
      targetUrl = `${authed.pathname}${authed.search}${authed.hash}`
    } else {
      sendPlainText(res, 401, 'dsh web authentication required\n')
      return
    }
  }

  sendHtml(res, method, renderSessionBounceHtml(targetUrl))
}
