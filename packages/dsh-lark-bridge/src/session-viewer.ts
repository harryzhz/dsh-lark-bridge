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
const MAX_MUXES_PER_SESSION = 16
const MAX_STREAMS_PER_MUX = 64
const VIEWER_READ_ONLY_DENIED_REASON = 'lark-viewer/read-only'

interface ViewerStreamMux {
  readonly key: string
  readonly sessionId: string
  readonly abort: AbortController
  readonly streams: Map<string, AbortController>
  closed: boolean
  writeFrame(frame: unknown): Promise<boolean>
  close(): void
}

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

interface CarrierInbox {
  queue: unknown[]
  done: boolean
  error: Error | null
  wake: (() => void) | null
}

interface CarrierMux {
  readonly id: string
  readonly streams: Map<string, CarrierInbox>
  readonly ready: Promise<void>
  closed: boolean
  failAll(err: Error): void
}

type CarrierStreamErrorMaker = (
  message: string,
  failure: { readonly kind: 'carrier' } | { readonly kind: 'remote'; readonly code: string; readonly details: object },
) => Error

/**
 * Standalone browser-side NDJSON stream multiplexer factory.
 * Serialized into inline `<script>`; must not capture module bindings.
 */
function createViewerMuxDriver(
  pageFetch: typeof globalThis.fetch,
  streamUrl: () => string,
  authHeaders: Record<string, string>,
  makeStreamError: CarrierStreamErrorMaker,
): { ensureMux(): CarrierMux; closeActive(): void } {
  let activeMux: CarrierMux | null = null
  const wakeBox = (box: CarrierInbox) => {
    const w = box.wake
    box.wake = null
    w?.()
  }
  const makeId = (): string => {
    const bytes = new Uint8Array(8)
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    return `mux_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
  }
  const ensureMux = (): CarrierMux => {
    if (activeMux && !activeMux.closed) return activeMux
    const id = makeId()
    const streams = new Map<string, CarrierInbox>()
    const abort = new AbortController()
    let resolveReady!: () => void
    let rejectReady!: (err: Error) => void
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })
    ready.catch(() => {})
    const mux: CarrierMux = {
      id,
      streams,
      ready,
      closed: false,
      failAll(err) {
        if (mux.closed) return
        mux.closed = true
        if (activeMux === mux) activeMux = null
        abort.abort()
        rejectReady(err)
        for (const box of streams.values()) {
          if (!box.done && !box.error) {
            box.error = err
            wakeBox(box)
          }
        }
        streams.clear()
      },
    }
    activeMux = mux
    void (async () => {
      try {
        const res = await pageFetch(streamUrl(), {
          method: 'POST',
          credentials: 'same-origin',
          headers: authHeaders,
          body: JSON.stringify({ op: 'attach', muxId: id }),
          signal: abort.signal,
        })
        if (!res.ok) {
          mux.failAll(
            res.status === 401 || res.status === 403
              ? makeStreamError('Read-only stream channel refused', {
                  kind: 'remote',
                  code: 'lark-viewer/denied',
                  details: { status: res.status },
                })
              : makeStreamError(`Stream channel failed (HTTP ${String(res.status)})`, { kind: 'carrier' }),
          )
          return
        }
        if (!res.body) {
          mux.failAll(makeStreamError('Stream channel returned empty body', { kind: 'carrier' }))
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          while (!mux.closed) {
            const next = await reader.read()
            if (next.done || !next.value) break
            buffer += decoder.decode(next.value, { stream: true })
            for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
              const line = buffer.slice(0, nl).trim()
              buffer = buffer.slice(nl + 1)
              if (!line) continue
              const f = JSON.parse(line) as {
                type?: string
                streamId?: string
                value?: unknown
                error?: { code?: string; message?: string; details?: object }
              }
              if (f.type === 'ready') {
                resolveReady()
                continue
              }
              if (f.type === 'ping' || !f.streamId) continue
              const box = streams.get(f.streamId)
              if (!box) continue
              if (f.type === 'value') {
                box.queue.push(f.value)
                wakeBox(box)
              } else if (f.type === 'end') {
                streams.delete(f.streamId)
                box.done = true
                wakeBox(box)
              } else if (f.type === 'error') {
                streams.delete(f.streamId)
                const code = typeof f.error?.code === 'string' ? f.error.code : 'lark-viewer/stream-error'
                const msg = typeof f.error?.message === 'string' ? f.error.message : 'stream error'
                box.error =
                  code === 'gateway/cancelled'
                    ? makeStreamError(msg, { kind: 'carrier' })
                    : makeStreamError(msg, {
                        kind: 'remote',
                        code,
                        details: f.error?.details && typeof f.error.details === 'object' ? f.error.details : {},
                      })
                wakeBox(box)
              }
            }
          }
        } finally {
          void reader.cancel().catch(() => undefined)
        }
        mux.failAll(makeStreamError('Stream channel closed', { kind: 'carrier' }))
      } catch {
        mux.failAll(makeStreamError('Stream channel interrupted', { kind: 'carrier' }))
      }
    })()
    return mux
  }
  return {
    ensureMux,
    closeActive: () => activeMux?.failAll(makeStreamError('Page unloaded', { kind: 'carrier' })),
  }
}

/**
 * Browser-side transport shim injected before DSH's Web shell module scripts.
 * Multiplexes all Gateway streams over one NDJSON downlink per tab so plain
 * HTTP/1.1 origins never exhaust the browser's 6-connection pool.
 * Runs standalone from its serialized source text (must not capture module bindings).
 */
function installLarkViewerCarrier(
  options: ViewerCarrierScriptOptions,
  createMuxDriver: typeof createViewerMuxDriver,
): void {
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
  const streamUrl = () => new URL('api/lark-bridge/view/stream', baseUri()).href
  const makeStreamError: CarrierStreamErrorMaker = (message, failure) => {
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
    const res = await pageFetch(new URL('api/lark-bridge/view/rpc', baseUri()).href, {
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
    let code = 'lark-viewer/denied'
    let message = `Read-only session request refused (HTTP ${String(res.status)})`
    try {
      const parsed = (await res.json()) as { error?: unknown; message?: unknown }
      if (typeof parsed?.error === 'string' && parsed.error) code = parsed.error
      if (typeof parsed?.message === 'string' && parsed.message) message = parsed.message
    } catch {}
    return Response.json({
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code, message, details: { status: res.status } } },
    })
  }
  const muxDriver = createMuxDriver(pageFetch, streamUrl, authHeaders, makeStreamError)
  let streamSeq = 0
  const openStream = (endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      signal.throwIfAborted()
      const mux = muxDriver.ensureMux()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
        mux.ready.then(
          () => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          },
          (err) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          },
        )
      })
      signal.throwIfAborted()
      const streamId = `s${String(++streamSeq)}`
      const box: CarrierInbox = { queue: [], done: false, error: null, wake: null }
      mux.streams.set(streamId, box)
      const url = streamUrl()
      let opened = false
      try {
        let res: Response
        try {
          res = await pageFetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: authHeaders,
            body: JSON.stringify({ op: 'open', muxId: mux.id, streamId, endpoint, payload }),
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
          if (res.status === 410) mux.failAll(makeStreamError('Stream channel expired', { kind: 'carrier' }))
          throw makeStreamError(`Stream ${endpoint} failed (HTTP ${String(res.status)})`, { kind: 'carrier' })
        }
        opened = true
        while (true) {
          signal.throwIfAborted()
          if (box.queue.length > 0) {
            yield box.queue.shift()
            continue
          }
          if (box.error) throw box.error
          if (box.done) return
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              if (box.wake === done) box.wake = null
              resolve()
            }
            const done = () => {
              signal.removeEventListener('abort', onAbort)
              resolve()
            }
            box.wake = done
            signal.addEventListener('abort', onAbort, { once: true })
          })
        }
      } finally {
        mux.streams.delete(streamId)
        if (opened && !box.done && !box.error && !mux.closed) {
          void pageFetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: authHeaders,
            body: JSON.stringify({ op: 'cancel', muxId: mux.id, streamId }),
            keepalive: true,
          }).catch(() => undefined)
        }
      }
    },
  })
  const win = globalThis as { addEventListener?: (type: string, fn: () => void) => void }
  win.addEventListener?.('pagehide', () => muxDriver.closeActive())
  g.__DSH_LARK_VIEWER__ = { sessionId: options.sessionId, readOnly: true }
  g.__DSH_TRANSPORT__ = { fetch: viewerFetch, openStream }
}

/** Serialize the standalone inline carrier script safely for `<script>` embedding. */
export function renderViewerCarrierScript(options: ViewerCarrierScriptOptions): string {
  const arg = JSON.stringify(options).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  return `(${installLarkViewerCarrier.toString()})(${arg},${createViewerMuxDriver.toString()});`
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
  private readonly muxes = new Map<string, ViewerStreamMux>()
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
    const isDream =
      typeof this.store.hasDreamSession === 'function'
        ? this.store.hasDreamSession(sid)
        : Boolean(this.store.listDreamSessions?.().some((d) => d.sessionId === sid))
    if (isDream) {
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
        this.closeMuxesForSession(sid)
        void Promise.resolve(peer.dispose()).catch(() => undefined)
      }
    }
    if (disposeAllPeers) {
      for (const mux of [...this.muxes.values()]) {
        mux.close()
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
    try {
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
    } catch (err) {
      this.ctx.logger.warn(
        `[lark-bridge] failed to render read-only viewer page for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return { status: 503, error: 'viewer_render_failed' }
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
    let upstream: Response
    try {
      upstream = await handler.fetch(
        new Request(`http://lark-viewer.internal${normalizedPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rec?.envelope ?? {}),
          signal: abort.signal,
        }),
        auth.peer,
      )
    } catch (err) {
      if (abort.signal.aborted || res.destroyed || res.writableEnded) return
      sendViewerJson(res, 502, {
        ok: false,
        error: 'viewer_rpc_failed',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (abort.signal.aborted || res.destroyed || res.writableEnded) return
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
    const op = typeof rec?.op === 'string' ? rec.op.trim() : ''
    if (op === 'attach') {
      await this.handleMuxAttach(res, auth, rec)
      return
    }
    if (op === 'open') {
      this.handleMuxOpen(res, auth, wireStream, rec)
      return
    }
    if (op === 'cancel') {
      this.handleMuxCancel(res, auth, rec)
      return
    }

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
      'cache-control': 'no-store, no-transform',
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
    for (const mux of [...this.muxes.values()]) {
      mux.close()
    }
    this.muxes.clear()
    for (const peer of this.peers.values()) {
      void Promise.resolve(peer.dispose()).catch(() => undefined)
    }
    this.peers.clear()
  }

  private muxKey(sessionId: string, muxId: string): string {
    return `${sessionId}\u0000${muxId}`
  }

  private closeMuxesForSession(sessionId: string): void {
    for (const mux of [...this.muxes.values()]) {
      if (mux.sessionId === sessionId) {
        mux.close()
      }
    }
  }

  private async handleMuxAttach(
    res: ServerResponse,
    auth: { readonly sessionId: string; readonly peer: ViewerPeerLike },
    rec: Record<string, unknown> | null,
  ): Promise<void> {
    const muxId = typeof rec?.muxId === 'string' ? rec.muxId.trim() : ''
    if (!muxId || muxId.length > 128) {
      sendViewerJson(res, 400, { ok: false, error: 'mux_id_required' })
      return
    }
    const key = this.muxKey(auth.sessionId, muxId)
    this.muxes.get(key)?.close()
    const existingForSession = [...this.muxes.values()].filter((m) => m.sessionId === auth.sessionId)
    if (existingForSession.length >= MAX_MUXES_PER_SESSION) {
      existingForSession[0]?.close()
    }

    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, auth.peer.signal])
    let writeChain: Promise<void> = Promise.resolve()
    let finishWait: (() => void) | undefined

    const writeRawLine = (line: string): Promise<boolean> => {
      const next = writeChain.then(async (): Promise<boolean> => {
        if (mux.closed || signal.aborted || res.destroyed || res.writableEnded) return false
        const ok = res.write(line)
        if (!ok && !mux.closed && !signal.aborted && !res.destroyed) {
          await new Promise<void>((resolve) => {
            const done = () => {
              res.off('drain', done)
              res.off('close', done)
              signal.removeEventListener('abort', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
            signal.addEventListener('abort', done, { once: true })
          })
        }
        return !mux.closed && !signal.aborted && !res.destroyed
      })
      writeChain = next.then(() => undefined, () => undefined)
      return next
    }

    const mux: ViewerStreamMux = {
      key,
      sessionId: auth.sessionId,
      abort,
      streams: new Map(),
      closed: false,
      writeFrame: (frame) => writeRawLine(`${JSON.stringify(frame)}\n`),
      close: () => {
        if (mux.closed) return
        mux.closed = true
        if (this.muxes.get(key) === mux) this.muxes.delete(key)
        abort.abort()
        for (const streamAbort of mux.streams.values()) streamAbort.abort()
        mux.streams.clear()
        finishWait?.()
      },
    }
    this.muxes.set(key, mux)

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    })
    res.flushHeaders?.()

    const onClose = () => mux.close()
    res.on('close', onClose)
    auth.peer.signal.addEventListener('abort', onClose, { once: true })

    const heartbeat = setInterval(() => {
      void writeRawLine('{"type":"ping"}\n')
    }, STREAM_HEARTBEAT_MS)
    heartbeat.unref?.()

    try {
      if (await mux.writeFrame({ type: 'ready' })) {
        await new Promise<void>((resolve) => {
          if (mux.closed || signal.aborted) {
            resolve()
            return
          }
          finishWait = resolve
        })
      }
    } finally {
      clearInterval(heartbeat)
      res.off('close', onClose)
      auth.peer.signal.removeEventListener('abort', onClose)
      mux.close()
      if (!res.writableEnded && !res.destroyed) {
        res.end()
      }
    }
  }

  private handleMuxOpen(
    res: ServerResponse,
    auth: { readonly sessionId: string; readonly peer: ViewerPeerLike },
    wireStream: NonNullable<ViewerGatewayLike['wireStream']>,
    rec: Record<string, unknown> | null,
  ): void {
    const muxId = typeof rec?.muxId === 'string' ? rec.muxId.trim() : ''
    const streamId = typeof rec?.streamId === 'string' ? rec.streamId.trim() : ''
    const endpoint = typeof rec?.endpoint === 'string' ? rec.endpoint.trim() : ''
    if (!muxId || !streamId || !endpoint || streamId.length > 128 || endpoint.length > 256) {
      sendViewerJson(res, 400, { ok: false, error: 'invalid_stream_open' })
      return
    }
    const mux = this.muxes.get(this.muxKey(auth.sessionId, muxId))
    if (!mux || mux.closed || mux.abort.signal.aborted) {
      sendViewerJson(res, 410, { ok: false, error: 'mux_not_found' })
      return
    }
    if (mux.streams.size >= MAX_STREAMS_PER_MUX && !mux.streams.has(streamId)) {
      sendViewerJson(res, 429, { ok: false, error: 'too_many_streams' })
      return
    }
    mux.streams.get(streamId)?.abort()
    const streamAbort = new AbortController()
    mux.streams.set(streamId, streamAbort)
    const signal = AbortSignal.any([mux.abort.signal, streamAbort.signal, auth.peer.signal])

    sendViewerJson(res, 200, { ok: true })

    void (async () => {
      try {
        const iterable = await wireStream.open(endpoint, rec?.payload, emptyUplink(), auth.peer, signal)
        for await (const value of iterable) {
          if (!(await mux.writeFrame({ type: 'value', streamId, value }))) break
        }
        if (!signal.aborted && !mux.closed) {
          await mux.writeFrame({ type: 'end', streamId })
        }
      } catch (err) {
        if (!signal.aborted && !mux.closed) {
          await mux.writeFrame({ type: 'error', streamId, error: wireStream.failure(err) })
        }
      } finally {
        if (mux.streams.get(streamId) === streamAbort) {
          mux.streams.delete(streamId)
        }
      }
    })()
  }

  private handleMuxCancel(
    res: ServerResponse,
    auth: { readonly sessionId: string; readonly peer: ViewerPeerLike },
    rec: Record<string, unknown> | null,
  ): void {
    const muxId = typeof rec?.muxId === 'string' ? rec.muxId.trim() : ''
    const streamId = typeof rec?.streamId === 'string' ? rec.streamId.trim() : ''
    if (!muxId || !streamId) {
      sendViewerJson(res, 400, { ok: false, error: 'invalid_stream_cancel' })
      return
    }
    const mux = this.muxes.get(this.muxKey(auth.sessionId, muxId))
    const streamAbort = mux?.streams.get(streamId)
    if (streamAbort) {
      mux?.streams.delete(streamId)
      streamAbort.abort()
    }
    sendViewerJson(res, 200, { ok: true })
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
    const connection = this.connection()
    if (!connection || typeof connection.createPeer !== 'function') return undefined
    // Omit `interactions` so `$events` handshake is permitted; DSH Gateway still sets
    // `answers: false` and forbids waterfall responses for all non-owner principals.
    // Must invoke as a method on `connection` so HostConnectionService retains its `this` receiver.
    const peer = connection.createPeer({
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
    const binding =
      typeof this.store.getBindingBySessionId === 'function'
        ? this.store.getBindingBySessionId(sessionId)
        : this.store.listBindings().find((b) => b.sessionId === sessionId)
    if (binding) {
      return { botId: binding.botId, chatId: binding.chatId }
    }
    if (typeof this.store.findReminderOriginBySessionId === 'function') {
      return this.store.findReminderOriginBySessionId(sessionId)
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
