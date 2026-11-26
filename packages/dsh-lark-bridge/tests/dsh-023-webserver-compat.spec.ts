import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LARK_CONSOLE_LOGIN_PATH,
  LARK_SESSION_OPEN_PATH,
  LarkBridgeManager,
  apply,
  createLarkHttpHandler,
  ensureCliAuthEndpoint,
  type ConnectionAdmitter,
} from '../src/index.js'
import { InstanceLock, InstanceLockConflictError } from '../src/instance-lock.js'
import { LarkBridgeStore } from '../src/store.js'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const LARK_BRIDGE_CLI = resolve(THIS_DIR, '../../dsh-bundle/bin/lark-bridge.mjs')

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-dsh023-compat-'))
  tempDirs.push(dir)
  return dir
}

type WebRequestListener = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void>,
) => Promise<void>

type EntryUrlListener = (
  baseUrl: string,
  entries: Array<{ label: string; url: string; open: boolean }>,
) => void

interface RegisteredRouteLike {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly auth?: 'anonymous' | 'required' | 'deny'
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/**
 * Simulates DSH 0.2.3-alpha.2 `dsh-host-webserver` + `dsh-client-connection` +
 * `dsh-host-authentication-token` request pipeline:
 * 1. `webserver/request` waterfall runs before route authorization.
 * 2. Route policy defaults to `'required'`.
 * 3. `webserver/authorize` always enforces Host/Origin/non-cross-site trust first;
 *    `'required'` additionally demands a DSH browser/API cookie (rejecting CLI Bearer tokens with 401).
 * 4. `connection.authenticatedUrl` is absent; entry URLs are resolved via `webserver/entry-url`.
 */
function createSimulatedDsh023Host(options: {
  readonly origin: string
  readonly launchToken?: string
  readonly emitBareEntryOnly?: boolean
}) {
  const routes: RegisteredRouteLike[] = []
  const requestListeners: WebRequestListener[] = []
  const entryUrlListeners: EntryUrlListener[] = []
  const disposers: Array<() => void | Promise<void>> = []
  let isOwnerCookieAuthed = false
  let admitRejection: 401 | 403 | 503 = 401

  if (options.launchToken || options.emitBareEntryOnly) {
    entryUrlListeners.push((baseUrl, entries) => {
      if (options.emitBareEntryOnly) {
        entries.push({ label: 'dsh web', url: baseUrl, open: true })
        return
      }
      const url = new URL(baseUrl)
      url.searchParams.set('token', options.launchToken!)
      entries.push({ label: 'dsh web', url: url.href, open: true })
    })
  }

  const parsedOrigin = new URL(options.origin)
  const isTrustedRequest = (req: IncomingMessage): boolean => {
    const host = typeof req.headers.host === 'string' ? req.headers.host : ''
    if (!host || host !== parsedOrigin.host) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (origin !== undefined) {
      try {
        if (new URL(origin).host !== host) return false
      } catch {
        return false
      }
    }
    return true
  }

  const webServer = {
    getOrigin: () => options.origin,
    register: vi.fn((route: RegisteredRouteLike) => {
      routes.push(route)
      return () => {
        const idx = routes.indexOf(route)
        if (idx >= 0) routes.splice(idx, 1)
      }
    }),
  }

  // Note: intentionally omits `authenticatedUrl` (removed in DSH 0.2.3-alpha.2).
  const connection: ConnectionAdmitter & { fetch: { register: ReturnType<typeof vi.fn> } } = {
    admit: (req) => {
      if (!isTrustedRequest(req)) return { rejection: 403 }
      if (isOwnerCookieAuthed) return { peer: { principal: { kind: 'owner' } } }
      return { rejection: admitRejection }
    },
    fetch: {
      register: vi.fn(() => () => {}),
    },
  }

  const on = vi.fn((event: string, listener: unknown) => {
    if (event === 'webserver/request') {
      requestListeners.push(listener as WebRequestListener)
    } else if (event === 'webserver/entry-url') {
      entryUrlListeners.push(listener as EntryUrlListener)
    }
    return () => {}
  })

  const emit = vi.fn((...args: unknown[]) => {
    const subject = typeof args[0] === 'object' ? args.shift() : undefined
    const event = args.shift()
    if (event === 'webserver/entry-url') {
      expect(subject === webServer || subject === undefined).toBe(true)
      const [baseUrl, entries] = args as [
        string,
        Array<{ label: string; url: string; open: boolean }>,
      ]
      for (const listener of entryUrlListeners) {
        listener(baseUrl, entries)
      }
    }
  })

  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    get: (key: string) => {
      if (key === 'webServer') return webServer
      if (key === 'connection') return connection
      return undefined
    },
    effect: (fn: () => void | (() => void | Promise<void>)) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return () => {}
    },
    inject: (_deps: readonly string[], cb: (subCtx: unknown) => void) => {
      cb({
        ...ctx,
        webServer,
        connection,
      })
    },
    on,
    emit,
    llm: { listProviders: () => [], listModels: async () => [] },
    agents: { get: () => undefined },
    sessions: { list: () => [] },
    webServer,
    connection,
  } as unknown as Context

  const dispatchHttp = (reqOpts: {
    readonly method?: string
    readonly url: string
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly remoteAddress?: string
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> =>
    new Promise((resolvePromise, reject) => {
      const req = Readable.from(
        reqOpts.body ? [Buffer.from(reqOpts.body, 'utf8')] : [],
      ) as unknown as IncomingMessage
      req.method = reqOpts.method ?? 'GET'
      req.url = reqOpts.url
      req.headers = { ...reqOpts.headers }
      ;(req as unknown as { socket?: { remoteAddress?: string; destroyed?: boolean } }).socket = {
        remoteAddress: reqOpts.remoteAddress ?? '127.0.0.1',
        destroyed: false,
      }

      let status = 200
      const headers: Record<string, string> = {}
      const chunks: Buffer[] = []
      const res = {
        destroyed: false,
        writeHead(code: number, hdrs?: Record<string, string>) {
          status = code
          if (hdrs) {
            for (const [k, v] of Object.entries(hdrs)) {
              headers[k.toLowerCase()] = v
            }
          }
          return res
        },
        end(chunk?: string | Buffer) {
          if (chunk !== undefined) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'))
          }
          resolvePromise({
            status,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        },
      } as unknown as ServerResponse

      const runRoute = async (): Promise<void> => {
        const pathname = new URL(req.url ?? '/', options.origin).pathname
        const matched = routes.find((r) =>
          r.kind === 'exact'
            ? pathname === r.path
            : pathname === r.path || pathname.startsWith(`${r.path}/`),
        )
        if (!matched) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        // DSH 0.2.3-alpha.2 outer `webserver/authorize`: policy defaults to `'required'`.
        const policy = matched.auth ?? 'required'
        if (!isTrustedRequest(req)) {
          res.writeHead(403, { 'cache-control': 'no-store' })
          res.end('forbidden')
          return
        }
        if (policy === 'required' && !isOwnerCookieAuthed) {
          res.writeHead(admitRejection, { 'cache-control': 'no-store' })
          res.end(admitRejection === 401 ? 'unauthorized' : 'authentication unavailable')
          return
        }
        await matched.handler(req, res)
      }

      let idx = 0
      const runWaterfall = async (): Promise<void> => {
        if (idx < requestListeners.length) {
          const listener = requestListeners[idx++]!
          await listener(req, res, runWaterfall)
          return
        }
        await runRoute()
      }

      runWaterfall().catch(reject)
    })

  return {
    ctx,
    webServer,
    connection,
    routes,
    requestListeners,
    dispatchHttp,
    setOwnerAuthed: (authed: boolean) => {
      isOwnerCookieAuthed = authed
    },
    setAdmitRejection: (code: 401 | 403 | 503) => {
      admitRejection = code
    },
    dispose: async () => {
      while (disposers.length > 0) {
        await disposers.pop()?.()
      }
    },
  }
}

describe('DSH 0.2.3-alpha.2 WebServer & Connection compatibility (backward compatible with 0.2.2-rc.5)', () => {
  it('registers /api/lark-bridge with auth: anonymous so CLI Bearer & Operator tokens pass outer webserver/authorize while keeping fail-closed auth', async () => {
    const dir = makeTempDir()
    const host = createSimulatedDsh023Host({
      origin: 'http://127.0.0.1:54321',
      launchToken: 'alpha2-launch-token-999',
    })

    await apply(host.ctx, {
      dataDir: dir,
      publicBaseUrl: '',
      idleSweepIntervalMs: 0,
      maxAuditEvents: 50,
      autoInstallCliAndSkill: false,
      syncGlobalCliAndSkill: false,
    })

    try {
      // 1. Route must explicitly declare auth: 'anonymous' for DSH 0.2.3-alpha.2+
      expect(host.webServer.register).toHaveBeenCalledTimes(1)
      expect(host.routes[0]?.path).toBe('/api/lark-bridge')
      expect(host.routes[0]?.auth).toBe('anonymous')

      const endpoint = JSON.parse(readFileSync(join(dir, 'cli-endpoint.json'), 'utf8')) as {
        apiBaseUrl: string
        token: string
      }
      expect(endpoint.apiBaseUrl).toBe('http://127.0.0.1:54321/api/lark-bridge')

      // 2. CLI Bearer token succeeds without a DSH browser cookie
      const cliHealth = await host.dispatchHttp({
        url: '/api/lark-bridge/health',
        headers: {
          host: '127.0.0.1:54321',
          authorization: `Bearer ${endpoint.token}`,
        },
      })
      expect(cliHealth.status).toBe(200)
      expect(JSON.parse(cliHealth.body).ok).toBe(true)

      // 3. Unauthenticated request still fails closed inside plugin handler (401 JSON)
      const unauth = await host.dispatchHttp({
        url: '/api/lark-bridge/health',
        headers: { host: '127.0.0.1:54321' },
      })
      expect(unauth.status).toBe(401)
      expect(JSON.parse(unauth.body)).toEqual({ ok: false, error: 'unauthorized' })

      // 4. 503 rejection from DSH 0.2.3-alpha.2 auth provider maps cleanly to authentication_unavailable
      host.setAdmitRejection(503)
      const authUnavailable = await host.dispatchHttp({
        url: '/api/lark-bridge/health',
        headers: { host: '127.0.0.1:54321' },
      })
      expect(authUnavailable.status).toBe(503)
      expect(JSON.parse(authUnavailable.body)).toEqual({
        ok: false,
        error: 'authentication_unavailable',
      })
      host.setAdmitRejection(401)

      // 5. Cross-site API calls remain blocked (403) by outer webserver/authorize
      const crossSiteApi = await host.dispatchHttp({
        url: '/api/lark-bridge/health',
        headers: {
          host: '127.0.0.1:54321',
          authorization: `Bearer ${endpoint.token}`,
          'sec-fetch-site': 'cross-site',
        },
      })
      expect(crossSiteApi.status).toBe(403)
    } finally {
      await host.dispose()
    }
  })

  it('resolves entry URL via webserver/entry-url and handles cross-site Feishu Web clicks on /open and /console-login in webserver/request', async () => {
    const dir = makeTempDir()
    const host = createSimulatedDsh023Host({
      origin: 'http://127.0.0.1:54321',
      launchToken: 'alpha2-secret-token',
    })

    await apply(host.ctx, {
      dataDir: dir,
      publicBaseUrl: '',
      idleSweepIntervalMs: 0,
      maxAuditEvents: 50,
      autoInstallCliAndSkill: false,
      syncGlobalCliAndSkill: false,
    })

    try {
      // Issue a /console one-time login link as Owner via HTTP API (without connection.authenticatedUrl!)
      host.setOwnerAuthed(true)
      const issueRes = await host.dispatchHttp({
        method: 'POST',
        url: '/api/lark-bridge/console-login/issue',
        headers: {
          host: '127.0.0.1:54321',
          origin: 'http://127.0.0.1:54321',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ botId: 'bot-alpha', botName: 'AlphaBot' }),
      })
      expect(issueRes.status).toBe(200)
      const issued = JSON.parse(issueRes.body) as { ok: boolean; url?: string }
      expect(issued.ok).toBe(true)
      expect(issued.url).toContain(LARK_CONSOLE_LOGIN_PATH)
      expect(issued.url).not.toContain('alpha2-secret-token')
      const code = new URL(issued.url!).searchParams.get('code')!

      // Simulate an unauthenticated user clicking the link from Feishu Web (`Sec-Fetch-Site: cross-site`)
      host.setOwnerAuthed(false)
      const crossSiteGet = await host.dispatchHttp({
        method: 'GET',
        url: `${LARK_CONSOLE_LOGIN_PATH}?code=${encodeURIComponent(code)}`,
        headers: {
          host: '127.0.0.1:54321',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      })
      expect(crossSiteGet.status).toBe(200)
      expect(crossSiteGet.body).toContain('确认并登录管理面')
      expect(crossSiteGet.body).not.toContain('alpha2-secret-token')

      // Cross-site POST to /console-login must NOT bypass outer authorization / CSRF fence
      const crossSitePost = await host.dispatchHttp({
        method: 'POST',
        url: LARK_CONSOLE_LOGIN_PATH,
        headers: {
          host: '127.0.0.1:54321',
          origin: 'https://evil.example.com',
          'sec-fetch-site': 'cross-site',
        },
        body: `code=${encodeURIComponent(code)}`,
      })
      expect(crossSitePost.status).toBe(403)

      // Same-origin POST submits form, consumes single-use code, and 303 redirects with launch token from webserver/entry-url
      const sameOriginPost = await host.dispatchHttp({
        method: 'POST',
        url: LARK_CONSOLE_LOGIN_PATH,
        headers: {
          host: '127.0.0.1:54321',
          origin: 'http://127.0.0.1:54321',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
        },
        body: `code=${encodeURIComponent(code)}`,
      })
      expect(sameOriginPost.status).toBe(303)
      expect(sameOriginPost.headers.location).toBe('/?token=alpha2-secret-token')
    } finally {
      await host.dispose()
    }
  })

  it('supports loopback session handoff (/api/lark-bridge/open) on DSH 0.2.3-alpha.2 and fails closed when no tokenized entry URL exists', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const host = createSimulatedDsh023Host({
      origin: 'http://127.0.0.1:52561',
      launchToken: 'desktop-alpha2-token',
    })
    const manager = new LarkBridgeManager(
      host.ctx,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store,
    )
    manager.bindLiveWebOrigin('http://127.0.0.1:52561', host.connection, host.webServer)

    const sid = 'session-alpha2-handoff'
    const url = manager.sessionWebUrl(sid)
    expect(url.startsWith(`http://127.0.0.1:52561${LARK_SESSION_OPEN_PATH}?`)).toBe(true)
    expect(url).not.toContain('desktop-alpha2-token')

    const parsed = new URL(url)
    const handler = createLarkHttpHandler(host.ctx, host.connection, manager)
    const res = await new Promise<{ status: number; body: string }>((resolvePromise, reject) => {
      const req = Readable.from([]) as unknown as IncomingMessage
      req.method = 'GET'
      req.url = `${parsed.pathname}${parsed.search}`
      req.headers = {
        host: '127.0.0.1:52561',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }
      ;(req as unknown as { socket?: { remoteAddress?: string } }).socket = {
        remoteAddress: '127.0.0.1',
      }
      let status = 200
      let body = ''
      const serverRes = {
        writeHead(code: number) {
          status = code
          return serverRes
        },
        end(chunk?: string | Buffer) {
          if (chunk) body += chunk.toString()
          resolvePromise({ status, body })
        },
      } as unknown as ServerResponse
      Promise.resolve(handler(req, serverRes)).catch(reject)
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain(
      `window.location.replace("/?token=desktop-alpha2-token#session=${encodeURIComponent(sid)}")`,
    )
    store.close()

    // Bare entry URL (no `?token=` / auth query) must fail closed
    const bareDir = makeTempDir()
    const bareStore = new LarkBridgeStore(bareDir)
    const bareHost = createSimulatedDsh023Host({
      origin: 'http://127.0.0.1:52562',
      emitBareEntryOnly: true,
    })
    const bareManager = new LarkBridgeManager(
      bareHost.ctx,
      {
        dataDir: bareDir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      bareStore,
    )
    bareManager.bindLiveWebOrigin('http://127.0.0.1:52562', bareHost.connection, bareHost.webServer)
    expect(bareManager.resolveAuthenticatedEntryUrl('http://127.0.0.1:52562/')).toBeUndefined()
    expect(
      bareManager.issueConsoleLoginLink({
        botId: 'b1',
        botName: 'B1',
        adminOpenId: 'ou_owner',
      }),
    ).toBeUndefined()
    expect(bareManager.sessionWebUrl('s1')).toBe('http://127.0.0.1:52562/#session=s1')
    bareStore.close()
  })

  it('does not overwrite active cli-endpoint.json or register routes when a secondary DSH instance hits InstanceLockConflictError', async () => {
    const dir = makeTempDir()
    const activeEndpoint = ensureCliAuthEndpoint(dir, 'http://127.0.0.1:3880')
    const lock = new InstanceLock(dir)
    lock.acquire()

    // Simulate an active lock held by another live PID (parent process) on the same host
    const lockContent = JSON.parse(readFileSync(lock.lockPath, 'utf8')) as Record<string, unknown>
    lockContent.pid = process.ppid
    writeFileSync(lock.lockPath, `${JSON.stringify(lockContent, null, 2)}\n`, 'utf8')

    const secondaryHost = createSimulatedDsh023Host({
      origin: 'http://127.0.0.1:59999',
      launchToken: 'secondary-token',
    })

    try {
      await expect(
        apply(secondaryHost.ctx, {
          dataDir: dir,
          publicBaseUrl: 'http://127.0.0.1:59999',
          idleSweepIntervalMs: 0,
          maxAuditEvents: 50,
          autoInstallCliAndSkill: false,
          syncGlobalCliAndSkill: false,
          instanceLockWaitMs: 30,
        }),
      ).rejects.toThrow(InstanceLockConflictError)

      // Active instance's cli-endpoint.json MUST remain untouched
      const after = JSON.parse(readFileSync(activeEndpoint.endpointFile, 'utf8')) as {
        apiBaseUrl: string
        token: string
      }
      expect(after.apiBaseUrl).toBe('http://127.0.0.1:3880/api/lark-bridge')
      expect(after.token).toBe(activeEndpoint.token)
      // Conflicting secondary instance never mounted routes or request hooks
      expect(secondaryHost.webServer.register).not.toHaveBeenCalled()
      expect(secondaryHost.requestListeners).toHaveLength(0)
    } finally {
      await secondaryHost.dispose()
      rmSync(lock.lockPath, { force: true })
    }
  })

  it('emits an actionable local-auth diagnostic (not Feishu user auth) when CLI receives HTTP 401', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
    })
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const addr = server.address() as { port: number }
    try {
      const stderr = await new Promise<string>((resolvePromise) => {
        execFile(
          process.execPath,
          [LARK_BRIDGE_CLI, 'context'],
          {
            env: {
              ...process.env,
              LARK_BRIDGE_API_URL: `http://127.0.0.1:${addr.port}/api/lark-bridge`,
              LARK_BRIDGE_CLI_TOKEN: 'dummy-token-0123456789abcdef0123456789abcdef',
            },
            encoding: 'utf8',
          },
          (_err, _stdout, errOut) => resolvePromise(String(errOut ?? '')),
        )
      })
      expect(stderr).toContain('HTTP 401')
      expect(stderr).toContain('并非飞书用户未授权')
      expect(stderr).toContain('cli-endpoint.json')
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
  })
})
