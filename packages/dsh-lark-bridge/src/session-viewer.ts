import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { resolveEffectiveGuestReadOnly } from '@dsh-lark/lark-core'
import { LARK_SESSION_OPEN_PATH } from './session-handoff.js'
import type { LarkBridgeStore } from './store.js'

export const LARK_VIEWER_PRINCIPAL_KIND = 'lark-viewer' as const
export const LARK_VIEW_RPC_PATH = '/api/lark-bridge/view/rpc'
export const LARK_VIEW_STREAM_PATH = '/api/lark-bridge/view/stream'

const VIEWER_TICKET_DOMAIN = 'lark-viewer:v1:'
const HEADER_SESSION = 'x-lark-view-session'
const HEADER_TICKET = 'x-lark-view-ticket'
const MAX_VIEWER_BODY_BYTES = 2 * 1024 * 1024
const STREAM_HEARTBEAT_MS = 25_000
const VIEWER_READ_ONLY_DENIED_REASON = 'lark-viewer/read-only'

export interface LarkViewerPrincipal {
  readonly kind: typeof LARK_VIEWER_PRINCIPAL_KIND
  readonly sessionId: string
}

interface ViewerPeerLike {
  readonly id?: string
  readonly principal: LarkViewerPrincipal
  readonly signal: AbortSignal
  dispose(): Promise<void> | void
}

interface ViewerRemoteAccessRole {
  readonly name: string
  readonly resource: 'global' | 'session' | 'workspace'
  readonly actions: readonly string[]
}

interface ViewerRemoteAccessBinding {
  readonly role: ViewerRemoteAccessRole
  readonly resource:
    | { readonly kind: 'global' }
    | { readonly kind: 'session'; readonly id: string }
    | { readonly kind: 'workspace'; readonly id: string }
}

interface ViewerRemoteAccessServiceLike {
  registerPolicy(
    kind: string,
    policy: {
      bindings(principal: LarkViewerPrincipal): readonly ViewerRemoteAccessBinding[]
      explain?(request: { readonly principal: LarkViewerPrincipal }): string | undefined
    },
  ): () => void
  invalidate(principal?: LarkViewerPrincipal): void
}

interface ViewerConnectionLike {
  createPeer?(options: {
    readonly principal: LarkViewerPrincipal
    readonly interactions?: 'answer' | 'none'
  }): ViewerPeerLike
  createSharedFetchHandler?(channel: '/api'): {
    fetch(request: Request, peer: ViewerPeerLike): Promise<Response>
  }
}

interface ViewerWebServerLike {
  readResource?(request: Request, peer: ViewerPeerLike): Promise<Response>
}

interface ViewerGatewayLike {
  readonly wireStream?: {
    open(
      endpoint: string,
      payload: unknown,
      uplink: AsyncIterable<unknown>,
      peer: ViewerPeerLike,
      signal: AbortSignal,
    ): Promise<AsyncIterable<unknown>>
    failure(error: unknown): {
      readonly code: string
      readonly message: string
      readonly details: object
    }
  }
}

interface ViewerWorkspaceRegistryLike {
  list?(): readonly { readonly id: string; readonly sessionIds?: readonly string[] }[]
}

/** Minimal global read actions required by DSH's Web shell to display one shared session. */
export const LARK_VIEWER_GLOBAL_ROLE: ViewerRemoteAccessRole = {
  name: 'lark-bridge:viewer-global',
  resource: 'global',
  actions: [
    'commands/list',
    'llm/listConfigurableProviders',
    'llm/listProviders',
    'session/control',
    'session/list',
    'session/modelCatalog',
    'workspace/follow',
  ],
}

/** Strictly read-only actions bound exclusively to the single shared session. */
export const LARK_VIEWER_SESSION_READ_ROLE: ViewerRemoteAccessRole = {
  name: 'lark-bridge:viewer-session-read',
  resource: 'session',
  actions: [
    'commands/list',
    'goals/get',
    'session/attachment',
    'session/control',
    'session/events',
    'session/follow',
    'session/list',
    'session/observeEvent',
    'session/observeProjections',
    'session/observeState',
    'session/page',
    'session/projections',
    'session/state',
    'session/wait',
    'skills/list',
    'toolResults/watch',
    'workspace/follow',
    'event:api-session/activity',
    'event:api-session/added',
    'event:api-session/error',
    'event:api-session/removed',
    'event:api-session/status',
  ],
}

/** Read-only workspace visibility limited to the workspace hosting the shared session. */
export const LARK_VIEWER_WORKSPACE_ROLE: ViewerRemoteAccessRole = {
  name: 'lark-bridge:viewer-workspace',
  resource: 'workspace',
  actions: ['workspace/follow'],
}

function encodeBase64Url(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function isSameOriginViewerPost(req: IncomingMessage, advertisedOrigin?: string): boolean {
  const secFetchSite = singleHeader(req.headers['sec-fetch-site'])?.toLowerCase()
  if (secFetchSite === 'cross-site') return false
  const origin = singleHeader(req.headers.origin)
  const host = singleHeader(req.headers.host)
  if (!origin || !host) return true
  try {
    const originHost = new URL(origin).host
    if (originHost === host) return true
    if (advertisedOrigin) {
      return originHost === new URL(advertisedOrigin).host
    }
    return false
  } catch {
    return false
  }
}

async function readBoundedJson(req: IncomingMessage, maxBytes = MAX_VIEWER_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new Error('Request payload too large')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

function sendViewerJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function emptyUplink(): AsyncIterable<unknown> {
  return (async function* () {})()
}

export interface ViewerCarrierScriptOptions {
  readonly sessionId: string
  readonly ticket: string
}

/**
 * Browser-side transport shim injected before DSH's Web shell module scripts.
 * Runs standalone from its serialized source text (must not capture module bindings).
 */
function installLarkViewerCarrier(options: ViewerCarrierScriptOptions): void {
  const g = globalThis as Record<string, unknown>
  const pageFetch = globalThis.fetch.bind(globalThis)
  const authHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-lark-view-session': options.sessionId,
    'x-lark-view-ticket': options.ticket,
  }
  const baseUri = (): string => {
    const doc = (globalThis as { document?: { baseURI?: string } }).document
    const loc = (globalThis as { location?: { href?: string } }).location
    return doc?.baseURI || loc?.href || '/'
  }
  const makeStreamError = (
    message: string,
    failure: { readonly kind: 'carrier' } | { readonly kind: 'remote'; readonly code: string; readonly details: object },
  ): Error => {
    const err = new Error(message) as Error & { dshRemoteStreamFailure?: object }
    if (failure.kind === 'remote') err.name = failure.code
    err.dshRemoteStreamFailure = failure
    return err
  }

  const viewerFetch = async (input: Request | URL | string, init: RequestInit): Promise<Response> => {
    const targetUrl = new URL(input instanceof Request ? input.url : String(input), baseUri())
    const marker = targetUrl.pathname.lastIndexOf('/api/')
    const apiPath = marker === -1 ? targetUrl.pathname : targetUrl.pathname.slice(marker)
    const rawBody = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined
    const rpcUrl = new URL('api/lark-bridge/view/rpc', baseUri()).href
    const res = await pageFetch(rpcUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: authHeaders,
      body: JSON.stringify({ path: apiPath, envelope: rawBody }),
      ...(init.signal ? { signal: init.signal } : {}),
    })
    if (res.ok) return res
    const rpcId =
      rawBody && typeof rawBody === 'object' && typeof (rawBody as { rpcId?: unknown }).rpcId === 'string'
        ? (rawBody as { rpcId: string }).rpcId
        : ''
    let errorCode = 'lark-viewer/denied'
    let errorMessage = `Read-only session request refused (HTTP ${String(res.status)})`
    try {
      const parsed = (await res.json()) as { error?: unknown; message?: unknown }
      if (typeof parsed?.error === 'string' && parsed.error) errorCode = parsed.error
      if (typeof parsed?.message === 'string' && parsed.message) errorMessage = parsed.message
    } catch {
      // Non-JSON refusal body.
    }
    return Response.json({
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: { code: errorCode, message: errorMessage, details: { status: res.status } },
      },
    })
  }

  const openStream = (endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      signal.throwIfAborted()
      const streamUrl = new URL('api/lark-bridge/view/stream', baseUri()).href
      let res: Response
      try {
        res = await pageFetch(streamUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers: authHeaders,
          body: JSON.stringify({ endpoint, payload }),
          signal,
        })
      } catch (err) {
        if (signal.aborted) throw err
        throw makeStreamError(`Stream ${endpoint} unreachable`, { kind: 'carrier' })
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw makeStreamError(`Read-only stream ${endpoint} refused`, {
            kind: 'remote',
            code: 'lark-viewer/denied',
            details: { status: res.status },
          })
        }
        throw makeStreamError(`Stream ${endpoint} failed (HTTP ${String(res.status)})`, {
          kind: 'carrier',
        })
      }
      if (!res.body) {
        throw makeStreamError(`Stream ${endpoint} returned empty body`, { kind: 'carrier' })
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          signal.throwIfAborted()
          let next: { readonly done: boolean; readonly value?: Uint8Array }
          try {
            next = await reader.read()
          } catch (err) {
            if (signal.aborted) throw err
            throw makeStreamError(`Stream ${endpoint} interrupted`, { kind: 'carrier' })
          }
          if (next.done || !next.value) break
          buffer += decoder.decode(next.value, { stream: true })
          let newlineAt = buffer.indexOf('\n')
          while (newlineAt !== -1) {
            const line = buffer.slice(0, newlineAt).trim()
            buffer = buffer.slice(newlineAt + 1)
            newlineAt = buffer.indexOf('\n')
            if (!line) continue
            const frame = JSON.parse(line) as {
              type?: string
              value?: unknown
              error?: { code?: string; message?: string; details?: object }
            }
            if (frame.type === 'ping') continue
            if (frame.type === 'end') return
            if (frame.type === 'error') {
              const code = typeof frame.error?.code === 'string' ? frame.error.code : 'lark-viewer/stream-error'
              const message = typeof frame.error?.message === 'string' ? frame.error.message : endpoint
              if (code === 'gateway/cancelled') {
                throw makeStreamError(message, { kind: 'carrier' })
              }
              throw makeStreamError(message, {
                kind: 'remote',
                code,
                details: frame.error?.details && typeof frame.error.details === 'object' ? frame.error.details : {},
              })
            }
            if (frame.type === 'value') {
              yield frame.value
            }
          }
        }
      } finally {
        void reader.cancel().catch(() => undefined)
      }
    },
  })

  g.__DSH_LARK_VIEWER__ = { sessionId: options.sessionId, readOnly: true }
  g.__DSH_TRANSPORT__ = { fetch: viewerFetch, openStream }
}

/** Serialize the standalone inline carrier script safely for `<script>` embedding. */
export function renderViewerCarrierScript(options: ViewerCarrierScriptOptions): string {
  const arg = JSON.stringify(options).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  return `(${installLarkViewerCarrier.toString()})(${arg});`
}

/**
 * Transform DSH's native rendered `index.html` so it runs cleanly under
 * `/api/lark-bridge/open?session=...&ticket=...` (2 segments below the app root)
 * with the read-only transport carrier installed before shell scripts load.
 */
export function transformViewerIndexHtml(
  rawHtml: string,
  options: ViewerCarrierScriptOptions,
): string {
  const strippedManifest = rawHtml
    .split('\n')
    .filter((line) => !line.includes('rel="manifest"') && !line.includes("rel='manifest'"))
    .join('\n')
  const carrierTag = `<script>${renderViewerCarrierScript(options)}</script>`
  if (/<base\s+href=(["'])\.\/?\1\s*\/?>/i.test(strippedManifest)) {
    return strippedManifest.replace(
      /<base\s+href=(["'])\.\/?\1\s*\/?>/i,
      `<base href="../../">${carrierTag}`,
    )
  }
  return strippedManifest.replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="../../">${carrierTag}`)
}

/**
 * Renders and serves strictly read-only, single-session DSH views for group
 * members who open Feishu session links without holding a DSH Owner cookie.
 * Enforcement is performed by DSH's native `RemoteAccessService` + `TypertGateway`.
 */
export class LarkSessionViewerService {
  private readonly peers = new Map<string, ViewerPeerLike>()
  private policyDisposer: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly store: LarkBridgeStore,
  ) {}

  attachToHost(): void {
    if (this.disposed || this.policyDisposer) return
    const registerOn = (remoteAccess: ViewerRemoteAccessServiceLike | undefined) => {
      if (!remoteAccess || typeof remoteAccess.registerPolicy !== 'function' || this.policyDisposer) return
      try {
        this.policyDisposer = remoteAccess.registerPolicy(LARK_VIEWER_PRINCIPAL_KIND, {
          bindings: (principal) => this.computeBindings(principal),
          explain: () => VIEWER_READ_ONLY_DENIED_REASON,
        })
      } catch (err) {
        this.ctx.logger.warn(
          `[lark-bridge] failed to register lark-viewer remoteAccess policy: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    registerOn(this.remoteAccess())
    if (!this.policyDisposer && typeof this.ctx.inject === 'function') {
      this.ctx.inject(['remoteAccess' as never], (accessCtx) => {
        registerOn((accessCtx as Context).get('remoteAccess' as never) as ViewerRemoteAccessServiceLike | undefined)
      })
    }
  }

  signTicket(sessionId: string): string {
    const secret = this.store.getViewerTicketSecret()
    return encodeBase64Url(
      createHmac('sha256', secret).update(`${VIEWER_TICKET_DOMAIN}${sessionId}`, 'utf8').digest(),
    )
  }

  verifyTicket(sessionId: string, ticket: string): boolean {
    if (!sessionId || !ticket) return false
    const expected = Buffer.from(this.signTicket(sessionId), 'utf8')
    const candidate = Buffer.from(ticket, 'utf8')
    return expected.byteLength === candidate.byteLength && timingSafeEqual(expected, candidate)
  }

  buildViewerUrl(baseOrigin: string, sessionId: string): string {
    const cleanBase = baseOrigin.trim().replace(/\/+$/, '')
    const ticket = this.signTicket(sessionId)
    return `${cleanBase}${LARK_SESSION_OPEN_PATH}?session=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`
  }

  /**
   * Returns true only when `sessionId` belongs to a Lark-managed conversation
   * (excluding internal Dreaming runs) whose effective Bot/Group policy enables
   * both session links and guest read-only viewing.
   */
  canViewSession(sessionId: string): boolean {
    const sid = sessionId.trim()
    if (!sid) return false
    if (this.store.listDreamSessions?.().some((d) => d.sessionId === sid)) {
      return false
    }
    const ownership = this.resolveSessionOwnership(sid)
    if (!ownership) return false
    const bot = this.store.getBot(ownership.botId)
    if (!bot) return false
    const group =
      ownership.chatId && !ownership.chatId.startsWith('p2p:')
        ? this.store.getGroup(bot.id, ownership.chatId)
        : undefined
    return resolveEffectiveGuestReadOnly(bot, group)
  }

  isAvailable(): boolean {
    const conn = this.connection()
    const ws = this.webServer()
    const gw = this.gateway()
    return Boolean(
      this.remoteAccess() &&
        conn?.createPeer &&
        conn?.createSharedFetchHandler &&
        ws?.readResource &&
        gw?.wireStream?.open,
    )
  }

  /**
   * Re-evaluate active viewer access snapshots immediately after bot/group config
   * changes or secret rotation, disposing any peers that are no longer allowed.
   */
  invalidateAccess(disposeAllPeers = false): void {
    this.remoteAccess()?.invalidate()
    for (const [sid, peer] of [...this.peers.entries()]) {
      if (disposeAllPeers || !this.canViewSession(sid)) {
        this.peers.delete(sid)
        void Promise.resolve(peer.dispose()).catch(() => undefined)
      }
    }
  }

  computeBindings(principal: LarkViewerPrincipal): readonly ViewerRemoteAccessBinding[] {
    const sid = principal.sessionId?.trim()
    if (!sid || !this.canViewSession(sid)) return []
    const bindings: ViewerRemoteAccessBinding[] = [
      { role: LARK_VIEWER_GLOBAL_ROLE, resource: { kind: 'global' } },
      { role: LARK_VIEWER_SESSION_READ_ROLE, resource: { kind: 'session', id: sid } },
    ]
    const workspaces = this.workspaceRegistry()?.list?.() ?? []
    for (const ws of workspaces) {
      if (ws.sessionIds?.includes(sid)) {
        bindings.push({
          role: LARK_VIEWER_WORKSPACE_ROLE,
          resource: { kind: 'workspace', id: ws.id },
        })
      }
    }
    return bindings
  }

  async renderViewerPage(
    sessionId: string,
    ticket: string,
  ): Promise<{ readonly status: number; readonly html?: string; readonly error?: string }> {
    if (!this.verifyTicket(sessionId, ticket) || !this.canViewSession(sessionId)) {
      return { status: 403, error: 'forbidden' }
    }
    const ws = this.webServer()
    const peer = this.getOrCreatePeer(sessionId)
    if (!ws?.readResource || !peer || !this.remoteAccess() || !this.gateway()?.wireStream) {
      return { status: 503, error: 'viewer_unavailable' }
    }
    const indexRes = await ws.readResource(new Request('http://lark-viewer.invalid/'), peer)
    if (!indexRes.ok) {
      return { status: 503, error: 'viewer_index_unavailable' }
    }
    const rawHtml = await indexRes.text()
    return {
      status: 200,
      html: transformViewerIndexHtml(rawHtml, { sessionId, ticket }),
    }
  }

  async handleViewerRpc(
    req: IncomingMessage,
    res: ServerResponse,
    options?: { readonly advertisedOrigin?: string },
  ): Promise<void> {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendViewerJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }
    if (!isSameOriginViewerPost(req, options?.advertisedOrigin)) {
      sendViewerJson(res, 403, { ok: false, error: 'cross_origin_forbidden' })
      return
    }
    const auth = this.authenticateViewerRequest(req)
    if (!auth) {
      sendViewerJson(res, 403, { ok: false, error: 'viewer_unauthorized' })
      return
    }
    const handler = this.connection()?.createSharedFetchHandler?.('/api')
    if (!handler) {
      sendViewerJson(res, 503, { ok: false, error: 'viewer_unavailable' })
      return
    }

    let body: unknown
    try {
      body = await readBoundedJson(req)
    } catch (err) {
      sendViewerJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_json' })
      return
    }
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
    const rawPath = typeof rec?.path === 'string' ? rec.path.trim() : ''
    let normalizedPath = ''
    try {
      normalizedPath = new URL(rawPath, 'http://lark-viewer.internal').pathname
    } catch {
      normalizedPath = ''
    }
    if (!normalizedPath.startsWith('/api/') || normalizedPath.startsWith('/api/lark-bridge')) {
      sendViewerJson(res, 403, { ok: false, error: 'route_not_allowed' })
      return
    }

    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    const upstream = await handler.fetch(
      new Request(`http://lark-viewer.internal${normalizedPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec?.envelope ?? {}),
        signal: abort.signal,
      }),
      auth.peer,
    )
    const bytes = Buffer.from(await upstream.arrayBuffer())
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
    res.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(bytes)
  }

  async handleViewerStream(
    req: IncomingMessage,
    res: ServerResponse,
    options?: { readonly advertisedOrigin?: string },
  ): Promise<void> {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendViewerJson(res, 405, { ok: false, error: 'method_not_allowed' })
      return
    }
    if (!isSameOriginViewerPost(req, options?.advertisedOrigin)) {
      sendViewerJson(res, 403, { ok: false, error: 'cross_origin_forbidden' })
      return
    }
    const auth = this.authenticateViewerRequest(req)
    if (!auth) {
      sendViewerJson(res, 403, { ok: false, error: 'viewer_unauthorized' })
      return
    }
    const wireStream = this.gateway()?.wireStream
    if (!wireStream) {
      sendViewerJson(res, 503, { ok: false, error: 'viewer_unavailable' })
      return
    }

    let body: unknown
    try {
      body = await readBoundedJson(req)
    } catch (err) {
      sendViewerJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_json' })
      return
    }
    const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
    const endpoint = typeof rec?.endpoint === 'string' ? rec.endpoint.trim() : ''
    if (!endpoint) {
      sendViewerJson(res, 400, { ok: false, error: 'endpoint_required' })
      return
    }

    const abort = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) abort.abort()
    }
    res.on('close', onClose)
    const signal = AbortSignal.any([abort.signal, auth.peer.signal])

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    })
    res.flushHeaders?.()

    const writeFrame = async (frame: unknown): Promise<boolean> => {
      if (signal.aborted || res.destroyed || res.writableEnded) return false
      const ok = res.write(`${JSON.stringify(frame)}\n`)
      if (!ok && !signal.aborted && !res.destroyed) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.once('drain', done)
          res.once('close', done)
        })
      }
      return !signal.aborted && !res.destroyed
    }

    const heartbeat = setInterval(() => {
      if (!signal.aborted && !res.destroyed && !res.writableEnded) {
        res.write('{"type":"ping"}\n')
      }
    }, STREAM_HEARTBEAT_MS)
    heartbeat.unref?.()

    try {
      const iterable = await wireStream.open(endpoint, rec?.payload, emptyUplink(), auth.peer, signal)
      for await (const value of iterable) {
        if (!(await writeFrame({ type: 'value', value }))) break
      }
      if (!signal.aborted && !res.destroyed && !res.writableEnded) {
        await writeFrame({ type: 'end' })
      }
    } catch (err) {
      if (!signal.aborted && !res.destroyed && !res.writableEnded) {
        await writeFrame({ type: 'error', error: wireStream.failure(err) })
      }
    } finally {
      clearInterval(heartbeat)
      res.off('close', onClose)
      if (!res.writableEnded && !res.destroyed) {
        res.end()
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.policyDisposer?.()
    this.policyDisposer = undefined
    for (const peer of this.peers.values()) {
      void Promise.resolve(peer.dispose()).catch(() => undefined)
    }
    this.peers.clear()
  }

  private authenticateViewerRequest(
    req: IncomingMessage,
  ): { readonly sessionId: string; readonly peer: ViewerPeerLike } | undefined {
    const sessionId = singleHeader(req.headers[HEADER_SESSION]) ?? ''
    const ticket = singleHeader(req.headers[HEADER_TICKET]) ?? ''
    if (!sessionId || !ticket) return undefined
    if (!this.verifyTicket(sessionId, ticket) || !this.canViewSession(sessionId)) return undefined
    const peer = this.getOrCreatePeer(sessionId)
    if (!peer) return undefined
    return { sessionId, peer }
  }

  private getOrCreatePeer(sessionId: string): ViewerPeerLike | undefined {
    if (this.disposed) return undefined
    const existing = this.peers.get(sessionId)
    if (existing && !existing.signal.aborted) return existing
    this.peers.delete(sessionId)
    const createPeer = this.connection()?.createPeer
    if (!createPeer) return undefined
    // Omit `interactions` so `$events` handshake is permitted; DSH Gateway still sets
    // `answers: false` and forbids waterfall responses for all non-owner principals.
    const peer = createPeer({
      principal: { kind: LARK_VIEWER_PRINCIPAL_KIND, sessionId },
    })
    this.peers.set(sessionId, peer)
    return peer
  }

  private resolveSessionOwnership(
    sessionId: string,
  ): { readonly botId: string; readonly chatId?: string } | undefined {
    const managed = this.store.getManagedSession?.(sessionId)
    if (managed) {
      return { botId: managed.botId, chatId: managed.chatId }
    }
    const binding = this.store.listBindings().find((b) => b.sessionId === sessionId)
    if (binding) {
      return { botId: binding.botId, chatId: binding.chatId }
    }
    const reminder = this.store.listReminders?.('all').find((r) => r.lastSessionId === sessionId)
    if (reminder) {
      return {
        botId: reminder.origin.botId,
        ...(reminder.origin.chatId ? { chatId: reminder.origin.chatId } : {}),
      }
    }
    return undefined
  }

  private remoteAccess(): ViewerRemoteAccessServiceLike | undefined {
    return this.ctx.get('remoteAccess' as never) as ViewerRemoteAccessServiceLike | undefined
  }

  private connection(): ViewerConnectionLike | undefined {
    return this.ctx.get('connection' as never) as ViewerConnectionLike | undefined
  }

  private webServer(): ViewerWebServerLike | undefined {
    return this.ctx.get('webServer' as never) as ViewerWebServerLike | undefined
  }

  private gateway(): ViewerGatewayLike | undefined {
    return this.ctx.get('typertGateway' as never) as ViewerGatewayLike | undefined
  }

  private workspaceRegistry(): ViewerWorkspaceRegistryLike | undefined {
    return this.ctx.get('workspaceRegistry' as never) as ViewerWorkspaceRegistryLike | undefined
  }
}
