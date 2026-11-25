import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type LoopbackConnectionAuth, renderSessionBounceHtml } from './session-handoff.js'

export const LARK_CONSOLE_LOGIN_PATH = '/api/lark-bridge/console-login'
export const DEFAULT_CONSOLE_LOGIN_TTL_MS = 120_000

const MAX_PENDING_TICKETS = 16
const MAX_TICKETS_PER_ADMIN = 3
const MAX_POST_BODY_BYTES = 4 * 1024

export interface ConsoleLoginTicket {
  readonly code: string
  readonly botId: string
  readonly botName: string
  readonly adminOpenId: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface IssuedConsoleLoginLink {
  readonly url: string
  readonly origin: string
  readonly expiresInSec: number
  readonly expiresAtMs: number
}

function encodeBase64Url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function matchesAuthority(hostHeader: string | undefined, origin: string): boolean {
  if (!hostHeader || !origin) return false
  try {
    const target = new URL(origin)
    const reqUrl = new URL(`${target.protocol}//${hostHeader}`)
    return reqUrl.host === target.host
  } catch {
    return false
  }
}

function matchesAnyAllowedAuthority(
  hostHeader: string | undefined,
  origins: readonly string[],
): boolean {
  if (!hostHeader) return false
  return origins.some((origin) => matchesAuthority(hostHeader, origin))
}

function isTopLevelDocumentNavigation(req: IncomingMessage): boolean {
  if (singleHeader(req.headers.origin)) return false
  const fetchMode = singleHeader(req.headers['sec-fetch-mode'])?.toLowerCase()
  if (fetchMode && fetchMode !== 'navigate') return false
  const fetchDest = singleHeader(req.headers['sec-fetch-dest'])?.toLowerCase()
  if (fetchDest && fetchDest !== 'document') return false
  return true
}

function isSameOriginPostForm(req: IncomingMessage): boolean {
  const host = singleHeader(req.headers.host)
  const origin = singleHeader(req.headers.origin)
  if (!host || !origin) return false
  try {
    if (new URL(origin).host !== host) return false
  } catch {
    return false
  }
  const fetchSite = singleHeader(req.headers['sec-fetch-site'])?.toLowerCase()
  if (fetchSite && fetchSite !== 'same-origin') return false
  const fetchMode = singleHeader(req.headers['sec-fetch-mode'])?.toLowerCase()
  if (fetchMode && fetchMode !== 'navigate' && fetchMode !== 'same-origin') return false
  return true
}

function extractBasePath(authorityBase: string): string {
  try {
    const pathname = new URL(authorityBase).pathname.replace(/\/+$/, '')
    return pathname && pathname !== '/' ? pathname : ''
  } catch {
    return ''
  }
}

async function readSmallTextBody(req: IncomingMessage, maxBytes = MAX_POST_BODY_BYTES): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > maxBytes) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
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
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
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
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  })
  res.end(method === 'HEAD' ? undefined : html)
}

/**
 * In-memory store for short-lived, single-use admin console login tickets issued via `/console`.
 * Keeps DSH's long-lived master `launchToken` strictly out of Feishu chat history.
 */
export class ConsoleLoginHandoff {
  private readonly tickets = new Map<string, ConsoleLoginTicket>()
  private disposed = false

  issue(
    input: {
      readonly botId: string
      readonly botName: string
      readonly adminOpenId: string
      readonly ttlMs?: number
    },
    nowMs = Date.now(),
  ): ConsoleLoginTicket {
    if (this.disposed) {
      throw new Error('console login handoff is disposed')
    }
    this.pruneExpired(nowMs)

    const ttlMs = Math.max(15_000, Math.min(300_000, input.ttlMs ?? DEFAULT_CONSOLE_LOGIN_TTL_MS))

    // Enforce per-admin active ticket cap by evicting oldest tickets for this bot+admin pair.
    const adminExisting = [...this.tickets.values()].filter(
      (t) => t.botId === input.botId && t.adminOpenId === input.adminOpenId,
    )
    while (adminExisting.length >= MAX_TICKETS_PER_ADMIN) {
      const oldest = adminExisting.shift()
      if (oldest) this.tickets.delete(oldest.code)
    }

    // Enforce global active ticket cap by evicting oldest entry.
    while (this.tickets.size >= MAX_PENDING_TICKETS) {
      const oldestKey = this.tickets.keys().next().value
      if (oldestKey === undefined) break
      this.tickets.delete(oldestKey)
    }

    const code = encodeBase64Url(randomBytes(32))
    const ticket: ConsoleLoginTicket = {
      code,
      botId: input.botId,
      botName: input.botName,
      adminOpenId: input.adminOpenId,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    }
    this.tickets.set(code, ticket)
    return ticket
  }

  buildUrl(baseOrigin: string, code: string): string {
    const cleanBase = baseOrigin.trim().replace(/\/+$/, '')
    return `${cleanBase}${LARK_CONSOLE_LOGIN_PATH}?code=${encodeURIComponent(code)}`
  }

  /** Validate without consuming so link-preview crawlers / HEAD requests cannot burn a ticket. */
  peek(code: string, nowMs = Date.now()): ConsoleLoginTicket | undefined {
    const trimmed = code.trim()
    if (!trimmed || trimmed.length > 128) return undefined
    const ticket = this.tickets.get(trimmed)
    if (!ticket) return undefined
    if (nowMs >= ticket.expiresAtMs) {
      this.tickets.delete(trimmed)
      return undefined
    }
    return ticket
  }

  /** Atomically validate and delete the one-time ticket. */
  consume(code: string, nowMs = Date.now()): ConsoleLoginTicket | undefined {
    const trimmed = code.trim()
    if (!trimmed || trimmed.length > 128) return undefined
    const ticket = this.tickets.get(trimmed)
    if (!ticket) return undefined
    this.tickets.delete(trimmed)
    if (nowMs >= ticket.expiresAtMs) return undefined
    return ticket
  }

  dispose(): void {
    this.disposed = true
    this.tickets.clear()
  }

  private pruneExpired(nowMs: number): void {
    for (const [code, ticket] of this.tickets) {
      if (nowMs >= ticket.expiresAtMs) {
        this.tickets.delete(code)
      }
    }
  }
}

export function renderConsoleLoginConfirmHtml(input: {
  readonly actionPath: string
  readonly code: string
  readonly botName: string
  readonly targetOrigin: string
  readonly remainingSec: number
}): string {
  const safeAction = escapeHtml(input.actionPath)
  const safeCode = escapeHtml(input.code)
  const safeBot = escapeHtml(input.botName)
  const safeOrigin = escapeHtml(input.targetOrigin)
  const safeSec = Math.max(1, Math.ceil(input.remainingSec))
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>登录 DeepSeek Harness 管理面</title>',
    '<style>',
    ':root{color-scheme:light dark;--bg:#f8f9fb;--card:#fff;--fg:#111827;--muted:#6b7280;--border:#e5e7eb;--accent:#111827;--accent-fg:#fff;--pill-bg:#f3f4f6}',
    '@media(prefers-color-scheme:dark){:root{--bg:#151517;--card:#1e1f23;--fg:#f3f4f6;--muted:#9ca3af;--border:#2d2f36;--accent:#f3f4f6;--accent-fg:#111827;--pill-bg:#2a2c33}}',
    '*{box-sizing:border-box}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.card{width:100%;max-width:420px;padding:28px;border-radius:14px;background:var(--card);border:1px solid var(--border);box-shadow:0 4px 20px rgba(0,0,0,.04)}',
    'h1{margin:0 0 8px;font-size:18px;font-weight:600}',
    'p{margin:0 0 16px;font-size:13px;color:var(--muted)}',
    '.meta{margin:0 0 20px;padding:12px 14px;border-radius:10px;background:var(--pill-bg);font-size:12px;color:var(--fg);word-break:break-all}',
    '.meta div+div{margin-top:4px;color:var(--muted)}',
    'button{width:100%;height:40px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600;cursor:pointer}',
    'button:hover{opacity:.92}',
    '.hint{margin-top:14px;margin-bottom:0;font-size:12px;color:var(--muted);text-align:center}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="card">',
    '<h1>登录 DeepSeek Harness 管理面</h1>',
    `<p>由智能体「${safeBot}」签发的一次性管理员登录凭据（约剩余 ${safeSec} 秒，点击后立即失效）。</p>`,
    '<div class="meta">',
    `<div>目标管理面：${safeOrigin}</div>`,
    '<div>登录成功后将在当前浏览器保存 30 天登录态，后续可直接访问。</div>',
    '</div>',
    `<form method="POST" action="${safeAction}">`,
    `<input type="hidden" name="code" value="${safeCode}">`,
    '<button type="submit">确认并登录管理面</button>',
    '</form>',
    '<p class="hint">请确认地址与预期一致后再点击，切勿向他人转发此链接。</p>',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}

export function renderConsoleLoginDeniedHtml(message: string): string {
  const safeMessage = escapeHtml(message)
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>登录链接已失效 · DeepSeek Harness</title>',
    '<style>',
    ':root{color-scheme:light dark;--bg:#f8f9fb;--card:#fff;--fg:#111827;--muted:#6b7280;--border:#e5e7eb}',
    '@media(prefers-color-scheme:dark){:root{--bg:#151517;--card:#1e1f23;--fg:#f3f4f6;--muted:#9ca3af;--border:#2d2f36}}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.card{max-width:400px;padding:24px 28px;border-radius:14px;background:var(--card);border:1px solid var(--border);text-align:center}',
    'h1{margin:0 0 8px;font-size:16px;font-weight:600}',
    'p{margin:0;font-size:13px;color:var(--muted)}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="card">',
    '<h1>管理面登录链接无效或已失效</h1>',
    `<p>${safeMessage}</p>`,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}

/**
 * Handles `/api/lark-bridge/console-login`:
 * - `GET` / `HEAD`: validates one-time ticket without consuming it and renders a
 *   same-origin confirmation form (immune to link-preview crawlers and prefetchers).
 *   Already-authenticated Owners skip straight to the console root.
 * - `POST`: enforces same-origin CSRF checks, atomically consumes the one-time ticket,
 *   and issues a `303 See Other` redirect to DSH's authenticated root path so DSH mints
 *   the 30-day `SameSite=Strict` Owner cookie and redirects to clean `./`.
 */
export async function handleConsoleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    readonly liveOrigin: string
    readonly advertisedOrigin?: string
    readonly connection: LoopbackConnectionAuth
    readonly handoff: ConsoleLoginHandoff
    readonly onAudit?: (ev: { readonly botId: string; readonly summary: string }) => void
    readonly nowMs?: () => number
  },
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    sendPlainText(res, 405, 'method not allowed\n', { allow: 'GET, HEAD, POST' })
    return
  }

  const { liveOrigin, advertisedOrigin = '', connection, handoff, onAudit } = options
  const nowMs = options.nowMs?.() ?? Date.now()
  const authorityBase = (advertisedOrigin || liveOrigin).trim().replace(/\/+$/, '')
  if (!authorityBase || !matchesAnyAllowedAuthority(singleHeader(req.headers.host), [liveOrigin, advertisedOrigin])) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }

  const basePath = extractBasePath(authorityBase)
  const consoleRoot = `${basePath}/`

  if (method === 'GET' || method === 'HEAD') {
    if (!isTopLevelDocumentNavigation(req)) {
      sendPlainText(res, 403, 'forbidden\n')
      return
    }
    const parsed = new URL(req.url ?? '/', `${authorityBase}/`)
    const code = parsed.searchParams.get('code')?.trim() ?? ''

    // Already authenticated as Owner -> clean bounce straight to console root.
    if (!('rejection' in connection.admit(req))) {
      if (method === 'GET' && code) {
        handoff.consume(code, nowMs)
      }
      sendHtml(res, method, renderSessionBounceHtml(consoleRoot), 200)
      return
    }

    const ticket = handoff.peek(code, nowMs)
    if (!ticket) {
      sendHtml(
        res,
        method,
        renderConsoleLoginDeniedHtml('该管理面登录链接无效、已过期或已被使用，请在飞书重新发送 /console 获取。'),
        403,
      )
      return
    }

    sendHtml(
      res,
      method,
      renderConsoleLoginConfirmHtml({
        actionPath: `${basePath}${LARK_CONSOLE_LOGIN_PATH}`,
        code: ticket.code,
        botName: ticket.botName,
        targetOrigin: authorityBase,
        remainingSec: (ticket.expiresAtMs - nowMs) / 1000,
      }),
      200,
    )
    return
  }

  // POST: strict same-origin CSRF fence before atomic single-use exchange.
  if (!isSameOriginPostForm(req)) {
    sendPlainText(res, 403, 'forbidden\n')
    return
  }

  const rawBody = await readSmallTextBody(req)
  if (rawBody === null) {
    sendPlainText(res, 413, 'payload too large\n')
    return
  }
  const code = new URLSearchParams(rawBody).get('code')?.trim() ?? ''

  if (!('rejection' in connection.admit(req))) {
    if (code) handoff.consume(code, nowMs)
    res.writeHead(303, {
      location: consoleRoot,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
    return
  }

  const ticket = handoff.consume(code, nowMs)
  if (!ticket) {
    sendHtml(
      res,
      'POST',
      renderConsoleLoginDeniedHtml('该管理面登录链接无效、已过期或已被使用，请在飞书重新发送 /console 获取。'),
      403,
    )
    return
  }

  if (typeof connection.authenticatedUrl !== 'function') {
    sendHtml(
      res,
      'POST',
      renderConsoleLoginDeniedHtml('当前 DSH Web 服务暂不支持一次性登录态换取，请在宿主机查看启动链接。'),
      503,
    )
    return
  }

  // Always pass a trailing-slash root URL so DSH's `authorizeIndex` (`pathname === '/'`) matches.
  const authed = new URL(connection.authenticatedUrl(`${authorityBase}/`))
  const targetPath = `${authed.pathname}${authed.search}`
  onAudit?.({
    botId: ticket.botId,
    summary: '管理员已通过 /console 一次性链接登录管理面',
  })
  res.writeHead(303, {
    location: targetPath,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end()
}
