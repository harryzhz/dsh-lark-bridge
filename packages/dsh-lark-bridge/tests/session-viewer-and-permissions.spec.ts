import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LARK_SESSION_OPEN_PATH,
  LARK_VIEWER_GLOBAL_ROLE,
  LARK_VIEWER_PRINCIPAL_KIND,
  LARK_VIEWER_SESSION_READ_ROLE,
  LARK_VIEWER_WORKSPACE_ROLE,
  LARK_VIEW_RPC_PATH,
  LARK_VIEW_STREAM_PATH,
  LarkBridgeManager,
  LarkBridgeStore,
  LarkSessionViewerService,
  createLarkHttpHandler,
  dispatchLarkApiRequest,
  transformViewerIndexHtml,
  type ConnectionAdmitter,
  type LarkViewerPrincipal,
} from '../src/index.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { handleSlashCommand } from '../src/slash-commands.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lark-viewer-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

interface CapturedHttpResponse {
  readonly status: number
  readonly headers: Record<string, string | string[]>
  readonly body: Buffer
  readonly text: string
}

async function invokeHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  options: {
    readonly method?: string
    readonly url: string
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly remoteAddress?: string
  },
): Promise<CapturedHttpResponse> {
  const req = Readable.from(options.body ? [Buffer.from(options.body, 'utf8')] : []) as IncomingMessage
  req.method = options.method ?? 'GET'
  req.url = options.url
  req.headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )
  ;(req as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: options.remoteAddress ?? '198.51.100.42',
  }

  let status = 200
  let headers: Record<string, string | string[]> = {}
  const chunks: Buffer[] = []
  const resEmitter = new EventEmitter()
  const res = Object.assign(resEmitter, {
    writableEnded: false,
    destroyed: false,
    writeHead(code: number, h?: Record<string, string | string[]>) {
      status = code
      headers = Object.fromEntries(
        Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      )
      return res
    },
    flushHeaders() {},
    write(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'))
      }
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'))
      }
      res.writableEnded = true
      resEmitter.emit('finish')
      resEmitter.emit('close')
      return res
    },
  }) as unknown as ServerResponse

  await handler(req, res)
  const body = Buffer.concat(chunks)
  return { status, headers, body, text: body.toString('utf8') }
}

function createViewerHarness(options: {
  readonly publicBaseUrl?: string
  readonly liveOrigin?: string
  readonly workspaces?: readonly { readonly id: string; readonly sessionIds: readonly string[] }[]
  readonly sharedFetch?: (request: Request, peer: { principal: LarkViewerPrincipal }) => Promise<Response>
  readonly streamOpen?: (
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: { principal: LarkViewerPrincipal },
    signal: AbortSignal,
  ) => Promise<AsyncIterable<unknown>>
} = {}) {
  const dir = makeTempDir()
  const store = new LarkBridgeStore(dir)
  const createdPeers: Array<{
    readonly principal: LarkViewerPrincipal
    readonly controller: AbortController
    readonly dispose: ReturnType<typeof vi.fn>
  }> = []
  const registeredPolicies = new Map<
    string,
    {
      bindings: (principal: LarkViewerPrincipal) => readonly unknown[]
      explain?: (req: { principal: LarkViewerPrincipal }) => string | undefined
    }
  >()
  const invalidateRemoteAccess = vi.fn()

  const remoteAccess = {
    registerPolicy: vi.fn((kind: string, policy: { bindings: (p: LarkViewerPrincipal) => readonly unknown[] }) => {
      registeredPolicies.set(kind, policy)
      return () => {
        registeredPolicies.delete(kind)
      }
    }),
    invalidate: invalidateRemoteAccess,
  }

  let isOwnerAuthed = false
  const authenticatedUrl = vi.fn((base: string) => `${base}/?token=SHOULD_NEVER_LEAK`)

  const connection = {
    _sentinel: 'host-connection-instance',
    admit: vi.fn((_req: IncomingMessage) =>
      isOwnerAuthed ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 as const },
    ),
    authenticatedUrl,
    createPeer: vi.fn(function (
      this: { _sentinel?: string } | undefined,
      { principal }: { principal: LarkViewerPrincipal },
    ) {
      // Mirrors HostConnectionService.createPeer accessing `this.ctx` — fails loudly if called detached!
      if (this?._sentinel !== 'host-connection-instance') {
        throw new TypeError("Cannot read properties of undefined (reading 'ctx')")
      }
      const controller = new AbortController()
      const dispose = vi.fn(() => {
        controller.abort()
      })
      const peer = {
        principal,
        signal: controller.signal,
        dispose,
      }
      createdPeers.push({ principal, controller, dispose })
      return peer
    }),
    createSharedFetchHandler: vi.fn(function (this: { _sentinel?: string } | undefined) {
      if (this?._sentinel !== 'host-connection-instance') {
        throw new TypeError("Cannot read properties of undefined (reading 'ctx')")
      }
      return {
        fetch:
          options.sharedFetch ??
          (async (request: Request, peer: { principal: LarkViewerPrincipal }) =>
            Response.json({
              type: 'server-response',
              rpcId: 'rpc-1',
              result: {
                ok: true,
                value: { path: new URL(request.url).pathname, viewerSession: peer.principal.sessionId },
              },
            })),
      }
    }),
  }

  const webServer = {
    readResource: vi.fn(async (_req: Request, peer: { principal: LarkViewerPrincipal }) => {
      const html = [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<base href="./">',
        '<link rel="manifest" href="manifest.webmanifest">',
        `<script>window.__DSH_REMOTE_ACCESS__={"owner":false,"sessionId":${JSON.stringify(peer.principal.sessionId)}};</script>`,
        '</head>',
        '<body><div id="root"></div></body>',
        '</html>',
      ].join('\n')
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }),
  }

  const typertGateway = {
    wireStream: {
      open:
        options.streamOpen ??
        (async (_endpoint: string, _payload: unknown, _uplink: AsyncIterable<unknown>, peer: { principal: LarkViewerPrincipal }) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'snapshot', sessionId: peer.principal.sessionId }
            yield { type: 'delta', text: 'hello' }
          },
        })),
      failure: (err: unknown) => ({
        code: 'remote-access/denied',
        message: err instanceof Error ? err.message : String(err),
        details: {},
      }),
    },
  }

  const workspaceRegistry = {
    list: () => options.workspaces ?? [{ id: 'ws-team', sessionIds: ['sess-group-1'] }],
  }

  const services: Record<string, unknown> = {
    remoteAccess,
    connection,
    webServer,
    typertGateway,
    workspaceRegistry,
  }

  const fakeCtx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: (name: string) => services[name],
    llm: { listProviders: () => [], listModels: async () => [] },
    agents: { get: () => undefined },
    sessions: { list: () => [] },
  } as unknown as Context

  const manager = new LarkBridgeManager(
    fakeCtx,
    {
      dataDir: dir,
      publicBaseUrl: options.publicBaseUrl ?? '',
      idleSweepIntervalMs: 0,
      maxAuditEvents: 50,
      autoInstallCliAndSkill: false,
    },
    store,
  )
  manager.sessionViewer.attachToHost()
  if (options.liveOrigin) {
    manager.bindLiveWebOrigin(options.liveOrigin, connection as unknown as ConnectionAdmitter)
  }

  const httpHandler = createLarkHttpHandler(fakeCtx, connection as unknown as ConnectionAdmitter, manager)

  return {
    dir,
    store,
    fakeCtx,
    manager,
    httpHandler,
    connection,
    webServer,
    remoteAccess,
    registeredPolicies,
    invalidateRemoteAccess,
    createdPeers,
    authenticatedUrl,
    setOwnerAuthed: (authed: boolean) => {
      isOwnerAuthed = authed
    },
  }
}

describe('Read-only guest session viewer & RBAC policy', () => {
  it('transforms DSH index.html with <base href="../../">, strips manifest, and injects standalone carrier script', () => {
    const html = transformViewerIndexHtml(
      '<!doctype html><html><head><base href="./">\n<link rel="manifest" href="manifest.webmanifest">\n</head><body></body></html>',
      { sessionId: 'sess-1', ticket: 'tkt-1' },
    )
    expect(html).toContain('<base href="../../">')
    expect(html).not.toContain('rel="manifest"')
    expect(html).toContain('__DSH_LARK_VIEWER__')
    expect(html).toContain('__DSH_TRANSPORT__')
    expect(html).toContain('"sessionId":"sess-1"')
  })

  it('grants strictly read-only single-session + workspace bindings and denies Dreaming/disabled sessions', () => {
    const h = createViewerHarness({
      liveOrigin: 'http://198.51.100.10:3880',
      workspaces: [
        { id: 'ws-team', sessionIds: ['sess-group-1'] },
        { id: 'ws-private', sessionIds: ['sess-other'] },
      ],
    })

    h.store.upsertBot({
      id: 'bot-1',
      name: 'Team Bot',
      larkAppId: 'cli_test',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: h.dir,
      dshSessionLinkInCard: true,
      sessionLinkGuestReadOnly: true,
    })
    h.store.upsertManagedSession({
      sessionId: 'sess-group-1',
      botId: 'bot-1',
      chatId: 'oc_team',
      routeKey: 'cli_test:oc_team:om_1',
      trigger: 'mention',
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })
    h.store.upsertDreamSession({
      sessionId: 'sess-dream-1',
      botId: 'bot-1',
      workspaceName: 'Team',
      workingDir: h.dir,
      agentPreset: 'standard',
      status: 'succeeded',
      dateKey: '2026-01-01',
      processedCount: 1,
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })

    const policy = h.registeredPolicies.get(LARK_VIEWER_PRINCIPAL_KIND)
    expect(policy).toBeDefined()

    const bindings = policy!.bindings({ kind: LARK_VIEWER_PRINCIPAL_KIND, sessionId: 'sess-group-1' })
    expect(bindings).toEqual([
      { role: LARK_VIEWER_GLOBAL_ROLE, resource: { kind: 'global' } },
      { role: LARK_VIEWER_SESSION_READ_ROLE, resource: { kind: 'session', id: 'sess-group-1' } },
      { role: LARK_VIEWER_WORKSPACE_ROLE, resource: { kind: 'workspace', id: 'ws-team' } },
    ])

    // Verify no mutating actions appear in any viewer role
    const allActions = [
      ...LARK_VIEWER_GLOBAL_ROLE.actions,
      ...LARK_VIEWER_SESSION_READ_ROLE.actions,
      ...LARK_VIEWER_WORKSPACE_ROLE.actions,
    ]
    for (const forbidden of [
      'session/send',
      'session/create',
      'session/cancel',
      'session/fork',
      'session/rename',
      'workspace/archive',
      'settings/update',
      'plugins/install',
    ]) {
      expect(allActions).not.toContain(forbidden)
    }

    // Dreaming & unmanaged sessions get zero bindings
    expect(policy!.bindings({ kind: LARK_VIEWER_PRINCIPAL_KIND, sessionId: 'sess-dream-1' })).toEqual([])
    expect(policy!.bindings({ kind: LARK_VIEWER_PRINCIPAL_KIND, sessionId: 'sess-other' })).toEqual([])

    // Group override `off` revokes visibility immediately
    h.store.upsertGroup({
      botId: 'bot-1',
      chatId: 'oc_team',
      sessionLinkGuestReadOnly: 'off',
    })
    expect(h.manager.sessionViewer.canViewSession('sess-group-1')).toBe(false)
    expect(policy!.bindings({ kind: LARK_VIEWER_PRINCIPAL_KIND, sessionId: 'sess-group-1' })).toEqual([])
  })

  it('serves read-only viewer for unauthenticated group members and full Owner bounce without launchToken on non-loopback & reverse-proxy deployments', async () => {
    const h = createViewerHarness({
      liveOrigin: 'http://127.0.0.1:3880',
      publicBaseUrl: 'https://dsh.example.com/app',
      workspaces: [{ id: 'ws-team', sessionIds: ['sess-group-1'] }],
    })
    h.store.upsertBot({
      id: 'bot-1',
      name: 'Team Bot',
      larkAppId: 'cli_test',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: h.dir,
      dshSessionLinkInCard: true,
      sessionLinkGuestReadOnly: true,
    })
    h.store.upsertManagedSession({
      sessionId: 'sess-group-1',
      botId: 'bot-1',
      chatId: 'oc_team',
      routeKey: 'cli_test:oc_team:om_1',
      trigger: 'mention',
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })

    const viewerUrl = h.manager.sessionWebUrl('sess-group-1')
    expect(viewerUrl.startsWith(`https://dsh.example.com/app${LARK_SESSION_OPEN_PATH}?`)).toBe(true)
    const parsed = new URL(viewerUrl)
    const ticket = parsed.searchParams.get('ticket')!
    const reqPath = `${LARK_SESSION_OPEN_PATH}${parsed.search}`

    // 1. Unauthenticated colleague receives native read-only DSH viewer HTML (never leaks launchToken)
    const guestRes = await invokeHttp(h.httpHandler, {
      url: reqPath,
      headers: {
        host: 'dsh.example.com',
        accept: 'text/html',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    })
    expect(guestRes.status).toBe(200)
    expect(guestRes.headers['content-type']).toContain('text/html')
    expect(guestRes.headers['x-frame-options']).toBe('DENY')
    expect(guestRes.text).toContain('<base href="../../">')
    expect(guestRes.text).toContain('__DSH_LARK_VIEWER__')
    expect(guestRes.text).not.toContain('SHOULD_NEVER_LEAK')
    expect(h.authenticatedUrl).not.toHaveBeenCalled()

    // 2. Authenticated Owner clicking the exact same link jumps directly into full Owner mode (preserving subpath)
    h.setOwnerAuthed(true)
    const ownerRes = await invokeHttp(h.httpHandler, {
      url: reqPath,
      headers: {
        host: 'dsh.example.com',
        accept: 'text/html',
      },
    })
    expect(ownerRes.status).toBe(200)
    expect(ownerRes.text).toContain('window.location.replace("/app/#session=sess-group-1")')
    expect(ownerRes.text).not.toContain('__DSH_LARK_VIEWER__')
    expect(h.authenticatedUrl).not.toHaveBeenCalled()

    // 3. Fail-closed checks for unauthenticated guests
    h.setOwnerAuthed(false)
    const wrongTicket = await invokeHttp(h.httpHandler, {
      url: `${LARK_SESSION_OPEN_PATH}?session=sess-group-1&ticket=invalid`,
      headers: { host: 'dsh.example.com', accept: 'text/html' },
    })
    expect(wrongTicket.status).toBe(403)
    expect(wrongTicket.text).toContain('无权查看该会话')

    const wrongHost = await invokeHttp(h.httpHandler, {
      url: reqPath,
      headers: { host: 'evil.example.com' },
    })
    expect(wrongHost.status).toBe(403)

    const crossSite = await invokeHttp(h.httpHandler, {
      url: reqPath,
      headers: {
        host: 'dsh.example.com',
        origin: 'https://evil.example.com',
        'sec-fetch-mode': 'cors',
      },
    })
    expect(crossSite.status).toBe(403)

    // 4. Reverse-proxy RPC + binary attachment + NDJSON streaming
    const rpcRes = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_RPC_PATH,
      headers: {
        host: '127.0.0.1:3880',
        origin: 'https://dsh.example.com',
        'sec-fetch-site': 'same-origin',
        'x-lark-view-session': 'sess-group-1',
        'x-lark-view-ticket': ticket,
      },
      body: JSON.stringify({
        path: '/api/session/state',
        envelope: { type: 'client-request', rpcId: 'rpc-1', method: 'session/state', payload: {} },
      }),
    })
    expect(rpcRes.status).toBe(200)
    expect(JSON.parse(rpcRes.text)).toMatchObject({
      result: { ok: true, value: { path: '/api/session/state', viewerSession: 'sess-group-1' } },
    })

    // Bridge control endpoints are hard-blocked on viewer RPC
    const blockedBridgeRpc = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_RPC_PATH,
      headers: {
        host: 'dsh.example.com',
        origin: 'https://dsh.example.com',
        'x-lark-view-session': 'sess-group-1',
        'x-lark-view-ticket': ticket,
      },
      body: JSON.stringify({ path: '/api/lark-bridge-rpc', envelope: {} }),
    })
    expect(blockedBridgeRpc.status).toBe(403)

    const crossOriginRpc = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_RPC_PATH,
      headers: {
        host: 'dsh.example.com',
        origin: 'https://evil.example.com',
        'x-lark-view-session': 'sess-group-1',
        'x-lark-view-ticket': ticket,
      },
      body: JSON.stringify({ path: '/api/session/state', envelope: {} }),
    })
    expect(crossOriginRpc.status).toBe(403)

    // Streaming NDJSON endpoint returns `value` frames + `end`
    const streamRes = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_STREAM_PATH,
      headers: {
        host: 'dsh.example.com',
        origin: 'https://dsh.example.com',
        'x-lark-view-session': 'sess-group-1',
        'x-lark-view-ticket': ticket,
      },
      body: JSON.stringify({ endpoint: 'session/follow', payload: { sessionId: 'sess-group-1' } }),
    })
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers['content-type']).toContain('application/x-ndjson')
    const frames = streamRes.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; value?: unknown })
    expect(frames).toEqual([
      { type: 'value', value: { type: 'snapshot', sessionId: 'sess-group-1' } },
      { type: 'value', value: { type: 'delta', text: 'hello' } },
      { type: 'end' },
    ])

    // 5. Rotating viewer secret requires Owner session, revokes old tickets, and disposes active peers
    const cliRotate = await dispatchLarkApiRequest(h.fakeCtx, h.manager, {
      method: 'POST',
      path: '/viewer/rotate-secret',
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliRotate.status).toBe(403)

    const ownerRotate = await dispatchLarkApiRequest(h.fakeCtx, h.manager, {
      method: 'POST',
      path: '/viewer/rotate-secret',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(ownerRotate.status).toBe(200)
    expect(h.invalidateRemoteAccess).toHaveBeenCalled()
    expect(h.createdPeers[0]?.dispose).toHaveBeenCalled()

    const revokedRes = await invokeHttp(h.httpHandler, {
      url: reqPath,
      headers: { host: 'dsh.example.com' },
    })
    expect(revokedRes.status).toBe(403)
  })

  it('preserves multipart/form-data binary responses on viewer RPC and emits error frames on denied streams', async () => {
    const h = createViewerHarness({
      liveOrigin: 'http://198.51.100.10:3880',
      sharedFetch: async () =>
        new Response(Buffer.from('binary-image-bytes', 'utf8'), {
          status: 200,
          headers: { 'content-type': 'multipart/form-data; boundary=test-boundary' },
        }),
      streamOpen: async () => {
        throw new Error('lark-viewer/read-only')
      },
    })
    h.store.upsertBot({
      id: 'bot-1',
      name: 'Team Bot',
      larkAppId: 'cli_test',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: h.dir,
    })
    h.store.upsertManagedSession({
      sessionId: 'sess-group-1',
      botId: 'bot-1',
      chatId: 'oc_team',
      routeKey: 'cli_test:oc_team:om_1',
      trigger: 'mention',
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })
    const ticket = h.manager.sessionViewer.signTicket('sess-group-1')

    const binRes = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_RPC_PATH,
      headers: {
        host: '198.51.100.10:3880',
        'x-lark-view-session': 'sess-group-1',
        'x-lark-view-ticket': ticket,
      },
      body: JSON.stringify({ path: '/api/session/attachment', envelope: {} }),
    })
    expect(binRes.status).toBe(200)
    expect(binRes.headers['content-type']).toBe('multipart/form-data; boundary=test-boundary')
    expect(binRes.text).toBe('binary-image-bytes')

    const errStream = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_STREAM_PATH,
      headers: {
        host: '198.51.100.10:3880',
        'x-lark-view-session': 'sess-group-1',
        'x-lark-view-ticket': ticket,
      },
      body: JSON.stringify({ endpoint: 'session/send', payload: {} }),
    })
    expect(errStream.status).toBe(200)
    expect(errStream.headers['cache-control']).toBe('no-store, no-transform')
    expect(JSON.parse(errStream.text.trim())).toMatchObject({
      type: 'error',
      error: { code: 'remote-access/denied', message: 'lark-viewer/read-only' },
    })
  })

  it('multiplexes concurrent viewer streams over one NDJSON downlink and isolates cancel / peer revocation', async () => {
    const abortedEndpoints: string[] = []
    const h = createViewerHarness({
      liveOrigin: 'http://198.51.100.10:3880',
      streamOpen: async (endpoint, _payload, _uplink, peer, signal) => {
        if (endpoint === 'account/watch') {
          throw new Error('lark-viewer/read-only')
        }
        if (endpoint === 'session/control') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { kind: 'control-ready', sessionId: peer.principal.sessionId }
              await new Promise<void>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    abortedEndpoints.push(endpoint)
                    resolve()
                  },
                  { once: true },
                )
              })
            },
          }
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { endpoint, step: 1 }
            yield { endpoint, step: 2 }
          },
        }
      },
    })
    h.store.upsertBot({
      id: 'bot-1',
      name: 'Team Bot',
      larkAppId: 'cli_test',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: h.dir,
    })
    h.store.upsertManagedSession({
      sessionId: 'sess-group-1',
      botId: 'bot-1',
      chatId: 'oc_team',
      routeKey: 'cli_test:oc_team:om_1',
      trigger: 'mention',
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })
    const ticket = h.manager.sessionViewer.signTicket('sess-group-1')
    const baseHeaders = {
      host: '198.51.100.10:3880',
      origin: 'http://198.51.100.10:3880',
      'x-lark-view-session': 'sess-group-1',
      'x-lark-view-ticket': ticket,
    }

    // Open a live attach downlink that stays open until we close it
    const attachReq = Readable.from([
      Buffer.from(JSON.stringify({ op: 'attach', muxId: 'mux-test-1' }), 'utf8'),
    ]) as IncomingMessage
    attachReq.method = 'POST'
    attachReq.url = LARK_VIEW_STREAM_PATH
    attachReq.headers = { ...baseHeaders }
    ;(attachReq as { socket: { remoteAddress: string } }).socket = { remoteAddress: '198.51.100.42' }

    const writtenFrames: Array<Record<string, unknown>> = []
    let attachHeaders: Record<string, string | string[]> = {}
    const resEmitter = new EventEmitter()
    let waitForFrames: (() => void) | undefined
    const attachRes = Object.assign(resEmitter, {
      writableEnded: false,
      destroyed: false,
      writeHead(_code: number, headers?: Record<string, string | string[]>) {
        attachHeaders = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
        return attachRes
      },
      flushHeaders() {},
      write(chunk?: string | Buffer) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : (chunk ?? '')
        for (const line of text.split('\n')) {
          if (line.trim()) writtenFrames.push(JSON.parse(line) as Record<string, unknown>)
        }
        waitForFrames?.()
        return true
      },
      end() {
        attachRes.writableEnded = true
        resEmitter.emit('close')
        return attachRes
      },
    }) as unknown as ServerResponse

    const attachDone = h.httpHandler(attachReq, attachRes)
    const waitUntil = (pred: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        if (pred()) {
          resolve()
          return
        }
        const timer = setTimeout(() => reject(new Error('timed out waiting for mux frames')), 2000)
        const check = () => {
          if (pred()) {
            clearTimeout(timer)
            waitForFrames = undefined
            resolve()
          }
        }
        waitForFrames = check
      })

    await waitUntil(() => writtenFrames.some((f) => f.type === 'ready'))
    expect(attachHeaders['cache-control']).toBe('no-store, no-transform')

    // Unknown mux returns 410 so the client cleanly reconnects
    const missingMux = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_STREAM_PATH,
      headers: baseHeaders,
      body: JSON.stringify({ op: 'open', muxId: 'mux-missing', streamId: 's0', endpoint: 'session/follow' }),
    })
    expect(missingMux.status).toBe(410)

    // Open 3 concurrent streams over the SAME single downlink
    const [open1, open2, open3] = await Promise.all([
      invokeHttp(h.httpHandler, {
        method: 'POST',
        url: LARK_VIEW_STREAM_PATH,
        headers: baseHeaders,
        body: JSON.stringify({ op: 'open', muxId: 'mux-test-1', streamId: 's1', endpoint: 'session/follow' }),
      }),
      invokeHttp(h.httpHandler, {
        method: 'POST',
        url: LARK_VIEW_STREAM_PATH,
        headers: baseHeaders,
        body: JSON.stringify({ op: 'open', muxId: 'mux-test-1', streamId: 's2', endpoint: 'account/watch' }),
      }),
      invokeHttp(h.httpHandler, {
        method: 'POST',
        url: LARK_VIEW_STREAM_PATH,
        headers: baseHeaders,
        body: JSON.stringify({ op: 'open', muxId: 'mux-test-1', streamId: 's3', endpoint: 'session/control' }),
      }),
    ])
    expect(open1.status).toBe(200)
    expect(open2.status).toBe(200)
    expect(open3.status).toBe(200)

    await waitUntil(
      () =>
        writtenFrames.some((f) => f.streamId === 's1' && f.type === 'end') &&
        writtenFrames.some((f) => f.streamId === 's2' && f.type === 'error') &&
        writtenFrames.some((f) => f.streamId === 's3' && f.type === 'value'),
    )
    expect(writtenFrames.filter((f) => f.streamId === 's1')).toEqual([
      { type: 'value', streamId: 's1', value: { endpoint: 'session/follow', step: 1 } },
      { type: 'value', streamId: 's1', value: { endpoint: 'session/follow', step: 2 } },
      { type: 'end', streamId: 's1' },
    ])
    expect(writtenFrames.find((f) => f.streamId === 's2')).toMatchObject({
      type: 'error',
      streamId: 's2',
      error: { code: 'remote-access/denied', message: 'lark-viewer/read-only' },
    })

    // Cancelling s3 aborts the upstream stream without closing the downlink
    const cancelRes = await invokeHttp(h.httpHandler, {
      method: 'POST',
      url: LARK_VIEW_STREAM_PATH,
      headers: baseHeaders,
      body: JSON.stringify({ op: 'cancel', muxId: 'mux-test-1', streamId: 's3' }),
    })
    expect(cancelRes.status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(abortedEndpoints).toContain('session/control')
    expect(attachRes.writableEnded).toBe(false)

    // Invalidating access / rotating secret closes the downlink cleanly
    h.manager.sessionViewer.invalidateAccess(true)
    await attachDone
    expect(attachRes.writableEnded).toBe(true)
  })

  it('returns 503 HTML instead of throwing when readResource fails unexpectedly', async () => {
    const h = createViewerHarness({ liveOrigin: 'http://198.51.100.10:3880' })
    h.store.upsertBot({
      id: 'bot-1',
      name: 'Team Bot',
      larkAppId: 'cli_test',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: h.dir,
    })
    h.store.upsertManagedSession({
      sessionId: 'sess-group-1',
      botId: 'bot-1',
      chatId: 'oc_team',
      routeKey: 'cli_test:oc_team:om_1',
      trigger: 'mention',
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })
    h.webServer.readResource.mockRejectedValueOnce(new Error('boom'))
    const url = new URL(h.manager.sessionWebUrl('sess-group-1'))
    const res = await invokeHttp(h.httpHandler, {
      url: `${url.pathname}${url.search}`,
      headers: { host: '198.51.100.10:3880', accept: 'text/html' },
    })
    expect(res.status).toBe(503)
    expect(res.text).toContain('只读会话视图服务暂不可用')
  })
})

describe('Group slash-command permission tightening', () => {
  it('blocks /agent and /model in group chats while keeping P2P /agent, /model and group /status, /help working', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const bot = store.upsertBot({
      id: 'bot-1',
      name: 'Team Bot',
      larkAppId: 'cli_test',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      model: 'provider/default',
    })
    const group = store.upsertGroup({
      botId: 'bot-1',
      chatId: 'oc_team',
      chatName: '研发群',
    })

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      get: () => undefined,
      llm: { listProviders: () => [], listModels: async () => [] },
      agents: { get: () => undefined },
      sessions: { list: () => [] },
    } as unknown as Context

    const runtimes = new RuntimeCatalog(fakeCtx)
    vi.spyOn(runtimes, 'list').mockResolvedValue([
      {
        id: 'standard',
        name: 'Standard',
        description: '',
        kind: 'native',
        supportsReasoningEffort: false,
        isDefault: true,
      },
      {
        id: 'codex',
        name: 'Codex',
        description: '',
        kind: 'external',
        supportsReasoningEffort: true,
        isDefault: false,
      },
    ])

    const replies: string[] = []
    const deps = {
      ctx: fakeCtx,
      store,
      runtimes,
      unbindRoute: vi.fn(async () => false),
      sessionWebUrl: (sid: string) => `https://dsh.example.com/#session=${sid}`,
      runTurn: vi.fn(async () => ''),
    }

    // Group /agent rejected without mutating bot or group config
    await handleSlashCommand(deps, {
      bot,
      group,
      chatType: 'group',
      senderOpenId: 'ou_member',
      command: { name: 'agent', args: 'codex' },
      routeKey: 'cli_test:oc_team:om_1',
      workingDir: dir,
      workspaceName: '研发群',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(replies.at(-1)).toContain('群聊中禁止通过 /agent 修改运行时配置')
    expect(store.getBot('bot-1')?.agentPreset).toBe('standard')
    expect(store.getGroup('bot-1', 'oc_team')?.agentPreset).toBe('')

    // Group /model without active session is rejected without mutating bot or group config
    await handleSlashCommand(deps, {
      bot,
      group,
      chatType: 'group',
      senderOpenId: 'ou_member',
      command: { name: 'model', args: 'provider/other' },
      routeKey: 'cli_test:oc_team:om_1',
      workingDir: dir,
      workspaceName: '研发群',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(replies.at(-1)).toContain('当前话题没有活跃会话')
    expect(store.getBot('bot-1')?.model).toBe('provider/default')

    // Group /help omits /agent command, documents session-only /model, and notes the restriction
    await handleSlashCommand(deps, {
      bot,
      group,
      chatType: 'group',
      senderOpenId: 'ou_member',
      command: { name: 'help', args: '' },
      routeKey: 'cli_test:oc_team:om_1',
      workingDir: dir,
      workspaceName: '研发群',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(replies.at(-1)).toContain('/status')
    expect(replies.at(-1)).toContain('/model [模型 ID] [思考强度]')
    expect(replies.at(-1)).toContain('仅允许在 DSH 控制台或私聊中修改')
    expect(replies.at(-1)).not.toContain('/agent <')

    // Group /status still works
    await handleSlashCommand(deps, {
      bot,
      group,
      chatType: 'group',
      senderOpenId: 'ou_member',
      command: { name: 'status', args: '' },
      routeKey: 'cli_test:oc_team:om_1',
      workingDir: dir,
      workspaceName: '研发群',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(replies.at(-1)).toContain('工作区：研发群')
    expect(replies.at(-1)).toContain('生效运行时：standard（provider/default）')

    // P2P /agent and /model continue to work
    await handleSlashCommand(deps, {
      bot,
      chatType: 'p2p',
      senderOpenId: 'ou_owner',
      command: { name: 'agent', args: 'codex' },
      routeKey: 'cli_test:p2p:ou_owner',
      workingDir: dir,
      workspaceName: 'Team Bot',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(replies.at(-1)).toContain('默认运行时已切换为 Codex')
    expect(store.getBot('bot-1')?.agentPreset).toBe('codex')
  })
})
