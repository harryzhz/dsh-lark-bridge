import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SessionIdentityError, type LarkBridgeManager } from './bridge-manager.js'
import { EXTERNAL_SESSION_ID_HEADER, OPERATOR_TOKEN_HEADER } from './cli-support.js'
import { LARK_CONSOLE_LOGIN_PATH, handleConsoleLogin } from './console-login.js'
import {
  DEFAULT_MAX_BODY_BYTES,
  LARK_API_ROUTER,
  normalizeApiRouteLabel,
  ok,
  type HttpMethod,
} from './routes/index.js'
import {
  LARK_SESSION_OPEN_PATH,
  handleSessionOpen,
  type LoopbackConnectionAuth,
} from './session-handoff.js'
import { LARK_VIEW_RPC_PATH, LARK_VIEW_STREAM_PATH } from './session-viewer.js'

export interface ConnectionAdmitter extends LoopbackConnectionAuth {
  admit(req: IncomingMessage): { peer: unknown } | { rejection: 401 | 403 | 503 }
}

/** Shared `/api` exact Fetch route used by Web and Desktop UI clients via `ctx.connection.rpc`. */
export const LARK_BRIDGE_RPC_ENDPOINT = 'lark-bridge-rpc'
export const LARK_BRIDGE_RPC_PATH = `/api/${LARK_BRIDGE_RPC_ENDPOINT}`

export interface LarkApiRequest {
  readonly method: string
  /** Route relative to `/api/lark-bridge`, e.g. `/bots` or `/events?limit=120`. */
  readonly path: string
  readonly body?: unknown
  readonly externalSessionId?: string
  readonly isCliAuthenticated: boolean
  readonly isOperatorAuthenticated?: boolean
  readonly principalKind: string
  readonly signal?: AbortSignal
}

export interface LarkApiResponse {
  readonly status: number
  readonly payload: unknown
}

async function readJsonBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function isSameOriginMutationAllowed(req: IncomingMessage, isCliAuth: boolean): boolean {
  if (isCliAuth) return true
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Transport-agnostic Lark Bridge API dispatcher shared by:
 * 1) `ctx.connection.fetch.register('/api/lark-bridge-rpc')` (Web & Electron Desktop UI)
 * 2) `ctx.webServer.register('/api/lark-bridge')` (`lark-bridge` CLI Bearer auth & direct HTTP)
 *
 * Every registered route declares a mandatory fail-closed `RouteAuthPolicy` in `routes/*`.
 */
export async function dispatchLarkApiRequest(
  ctx: Context,
  manager: LarkBridgeManager,
  request: LarkApiRequest,
): Promise<LarkApiResponse> {
  const startedAt = performance.now()
  const method = request.method.toUpperCase() as HttpMethod
  let routeLabel = `${method} /invalid`

  try {
    const rawPath = request.path.startsWith('/') ? request.path : `/${request.path}`
    const url = new URL(rawPath, 'http://127.0.0.1')
    const pathname = url.pathname.replace(/^\/api\/lark-bridge\/?/, '').replace(/^\/+/, '')
    const segments = pathname ? pathname.split('/').map(decodeURIComponent) : []
    routeLabel = normalizeApiRouteLabel(method, segments)

    return await LARK_API_ROUTER.dispatch(ctx, manager, request, {
      method,
      url,
      pathname,
      segments,
    })
  } catch (err) {
    if (err instanceof SessionIdentityError) {
      return ok({ ok: false, code: err.code, error: err.message }, err.status)
    }
    const message = err instanceof Error ? err.message : String(err)
    return ok({ ok: false, error: message }, 400)
  } finally {
    manager.recordApiTiming?.(routeLabel, performance.now() - startedAt)
  }
}

async function handlePublicNavigationEndpoint(
  requestPath: string,
  req: IncomingMessage,
  res: ServerResponse,
  connection: ConnectionAdmitter,
  manager: LarkBridgeManager,
): Promise<boolean> {
  const advertisedOrigin = manager.getAdvertisedWebOrigin?.() ?? ''
  const resolveAuthenticatedUrl = (baseUrl: string): string | undefined =>
    manager.resolveAuthenticatedEntryUrl?.(baseUrl)
  if (requestPath === LARK_SESSION_OPEN_PATH) {
    await handleSessionOpen(req, res, {
      liveOrigin: manager.getLiveWebOrigin?.() ?? '',
      advertisedOrigin,
      connection,
      resolveAuthenticatedUrl,
      handoff: manager.sessionHandoff,
      ...(manager.sessionViewer ? { viewer: manager.sessionViewer } : {}),
    })
    return true
  }
  if (requestPath === LARK_CONSOLE_LOGIN_PATH) {
    await handleConsoleLogin(req, res, {
      liveOrigin: manager.getLiveWebOrigin?.() ?? '',
      advertisedOrigin,
      connection,
      resolveAuthenticatedUrl,
      handoff: manager.consoleLogin,
      onAudit: (ev) => {
        manager.store.recordEvent({
          botId: ev.botId,
          kind: 'lifecycle',
          summary: ev.summary,
        })
      },
    })
    return true
  }
  return false
}

/**
 * Pre-authorization `webserver/request` waterfall handler for DSH 0.2.3-alpha.2+.
 * Handles `GET`/`HEAD` top-level browser navigations to `/api/lark-bridge/open`
 * and `/api/lark-bridge/console-login` before outer `webserver/authorize` rejects
 * `Sec-Fetch-Site: cross-site` clicks coming from Feishu Web. Both endpoints
 * enforce their own strict Host allowlist, top-level document checks, and HMAC
 * ticket verification; all `POST` and API requests continue through `next()`.
 */
export function createLarkNavigationRequestHandler(
  connection: ConnectionAdmitter,
  manager: LarkBridgeManager,
): (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
) => Promise<void> {
  return async (req, res, next) => {
    if (req.socket?.destroyed || res.destroyed) return
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      await next()
      return
    }
    let requestPath = ''
    try {
      requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      await next()
      return
    }
    if (
      requestPath !== LARK_SESSION_OPEN_PATH &&
      requestPath !== LARK_CONSOLE_LOGIN_PATH
    ) {
      await next()
      return
    }
    await handlePublicNavigationEndpoint(requestPath, req, res, connection, manager)
  }
}

export function createLarkHttpHandler(
  ctx: Context,
  connection: ConnectionAdmitter,
  manager: LarkBridgeManager,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let requestPath: string
    try {
      requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_request_url' })
      return
    }
    const advertisedOrigin = manager.getAdvertisedWebOrigin?.() ?? ''
    if (await handlePublicNavigationEndpoint(requestPath, req, res, connection, manager)) {
      return
    }
    if (requestPath === LARK_VIEW_RPC_PATH) {
      if (!manager.sessionViewer) {
        sendJson(res, 503, { ok: false, error: 'viewer_unavailable' })
        return
      }
      await manager.sessionViewer.handleViewerRpc(req, res, { advertisedOrigin })
      return
    }
    if (requestPath === LARK_VIEW_STREAM_PATH) {
      if (!manager.sessionViewer) {
        sendJson(res, 503, { ok: false, error: 'viewer_unavailable' })
        return
      }
      await manager.sessionViewer.handleViewerStream(req, res, { advertisedOrigin })
      return
    }

    const authHeader =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    const operatorHeader =
      typeof req.headers[OPERATOR_TOKEN_HEADER] === 'string'
        ? req.headers[OPERATOR_TOKEN_HEADER]
        : undefined
    const isCliAuthenticated = Boolean(manager.cliAuth?.verify(authHeader))
    const isOperatorAuthenticated = Boolean(manager.operatorAuth?.verify(operatorHeader))

    let principalKind = 'owner'
    if (isCliAuthenticated || isOperatorAuthenticated) {
      principalKind = isOperatorAuthenticated ? 'operator' : 'cli'
    } else {
      const admission = connection.admit(req)
      if ('rejection' in admission) {
        sendJson(res, admission.rejection, {
          ok: false,
          error:
            admission.rejection === 401
              ? 'unauthorized'
              : admission.rejection === 503
                ? 'authentication_unavailable'
                : 'forbidden',
        })
        return
      }
      const admittedPeer = admission.peer as { principal?: { kind?: string } }
      principalKind = admittedPeer?.principal?.kind ?? 'owner'
    }

    if (!isSameOriginMutationAllowed(req, isCliAuthenticated || isOperatorAuthenticated)) {
      sendJson(res, 403, { ok: false, error: 'cross_origin_forbidden' })
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()
    const rawUrl = req.url ?? '/'
    const maxBodyBytes = LARK_API_ROUTER.resolveMaxBodyBytes(method, rawUrl)
    let body: unknown = undefined
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await readJsonBody(req, maxBodyBytes)
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }

    const externalSessionHeader =
      typeof req.headers[EXTERNAL_SESSION_ID_HEADER] === 'string'
        ? req.headers[EXTERNAL_SESSION_ID_HEADER].trim() || undefined
        : undefined
    const response = await dispatchLarkApiRequest(ctx, manager, {
      method,
      path: rawUrl,
      body,
      ...(externalSessionHeader ? { externalSessionId: externalSessionHeader } : {}),
      isCliAuthenticated,
      isOperatorAuthenticated,
      principalKind,
    })
    sendJson(res, response.status, response.payload)
  }
}

/**
 * Exact Fetch route handler for `ctx.connection.fetch.register({ path: LARK_BRIDGE_RPC_PATH, ... })`.
 * Speaks DSH Connection's standard `ClientRequest` / `ServerResponse` JSON envelope so the
 * browser UI works identically across DSH Web, Electron Desktop (`file://` + `__DSH_TRANSPORT__`),
 * and in-process carriers without custom auth headers or CORS workarounds.
 */
export function createLarkConnectionRpcHandler(
  ctx: Context,
  manager: LarkBridgeManager,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
    }
    let envelope: unknown
    try {
      envelope = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rec = envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : null
    const rpcId = typeof rec?.rpcId === 'string' ? rec.rpcId : 'invalid-request'
    if (
      !rec ||
      rec.type !== 'client-request' ||
      rec.method !== LARK_BRIDGE_RPC_ENDPOINT ||
      !rec.payload ||
      typeof rec.payload !== 'object'
    ) {
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: 'lark-bridge/bad-request',
              message: 'invalid lark-bridge RPC request envelope',
              details: {},
            },
          },
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    const payload = rec.payload as { method?: unknown; path?: unknown; body?: unknown }
    const method = typeof payload.method === 'string' ? payload.method : 'GET'
    const path = typeof payload.path === 'string' ? payload.path : '/'
    const dispatched = await dispatchLarkApiRequest(ctx, manager, {
      method,
      path,
      body: payload.body,
      isCliAuthenticated: false,
      principalKind: 'owner',
      signal: request.signal,
    })

    const data = dispatched.payload as { ok?: unknown; error?: unknown } | undefined
    if (dispatched.status >= 400 || data?.ok === false) {
      const errorMessage =
        typeof data?.error === 'string' && data.error.trim()
          ? data.error
          : `HTTP ${dispatched.status}`
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: 'lark-bridge/error',
              message: errorMessage,
              details: { status: dispatched.status },
            },
          },
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    return Response.json(
      {
        type: 'server-response',
        rpcId,
        result: {
          ok: true,
          value: dispatched.payload,
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
}
