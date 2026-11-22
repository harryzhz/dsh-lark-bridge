import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { LarkPlatformManager } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import {
  buildCliWrapperContent,
  ensureCliAuthEndpoint,
  resolveBundledAssetPaths,
} from '../src/cli-support.js'
import {
  LARK_BRIDGE_RPC_ENDPOINT,
  LARK_BRIDGE_RPC_PATH,
  createLarkConnectionRpcHandler,
  createLarkHttpHandler,
  type ConnectionAdmitter,
} from '../src/http-api.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { LARK_SESSION_OPEN_PATH, handleLoopbackSessionOpen } from '../src/session-handoff.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-desktop-test-'))
  tempDirs.push(dir)
  return dir
}

describe('Desktop Connection RPC handler & cross-platform CLI support', () => {
  it('handles DSH Connection RPC envelopes cleanly across owner endpoints and errors', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const platform = new LarkPlatformManager(
      dir,
      vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    )
    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      get: () => undefined,
      llm: { listProviders: () => [], listModels: async () => [] },
      agents: { get: () => undefined },
    } as unknown as Context

    const manager = {
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      platform,
      cliAuth: ensureCliAuthEndpoint(dir, ''),
      listBotStatuses: () => [],
      listArchivedSessionIds: () => [],
      sessionWebUrl: (sid: string) => `http://127.0.0.1:43210/#session=${sid}`,
      schedules: { listViews: async () => ({ available: true, schedules: [] }) },
    } as never

    const rpcFetch = createLarkConnectionRpcHandler(fakeCtx, manager)

    // 1. Standard GET health via Connection RPC envelope
    const healthRes = await rpcFetch(
      new Request(`http://dsh.internal${LARK_BRIDGE_RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: LARK_BRIDGE_RPC_ENDPOINT,
          payload: { method: 'GET', path: '/health' },
        }),
      }),
    )
    expect(healthRes.status).toBe(200)
    const healthBody = (await healthRes.json()) as {
      type: string
      rpcId: string
      result: { ok: boolean; value?: { ok: boolean; principal: string } }
    }
    expect(healthBody.type).toBe('server-response')
    expect(healthBody.rpcId).toBe('rpc-1')
    expect(healthBody.result.ok).toBe(true)
    expect(healthBody.result.value?.principal).toBe('owner')

    // 2. Owner-only endpoint (/fs/dirs) succeeds over Desktop Connection RPC
    const fsRes = await rpcFetch(
      new Request(`http://dsh.internal${LARK_BRIDGE_RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-2',
          method: LARK_BRIDGE_RPC_ENDPOINT,
          payload: { method: 'GET', path: `/fs/dirs?path=${encodeURIComponent(dir)}` },
        }),
      }),
    )
    const fsBody = (await fsRes.json()) as {
      rpcId: string
      result: { ok: boolean; value?: { path: string } }
    }
    expect(fsBody.rpcId).toBe('rpc-2')
    expect(fsBody.result.ok).toBe(true)
    expect(fsBody.result.value?.path).toBeTruthy()

    // 3. Business 404 maps to structured RPC failure preserving rpcId
    const notFoundRes = await rpcFetch(
      new Request(`http://dsh.internal${LARK_BRIDGE_RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-3',
          method: LARK_BRIDGE_RPC_ENDPOINT,
          payload: { method: 'POST', path: '/bots/missing/toggle' },
        }),
      }),
    )
    expect(notFoundRes.status).toBe(200)
    const notFoundBody = (await notFoundRes.json()) as {
      rpcId: string
      result: { ok: boolean; error?: { code: string; message: string; details: { status: number } } }
    }
    expect(notFoundBody.rpcId).toBe('rpc-3')
    expect(notFoundBody.result.ok).toBe(false)
    expect(notFoundBody.result.error?.message).toBe('bot_not_found')
    expect(notFoundBody.result.error?.details.status).toBe(404)

    // 4. Non-POST is rejected with 405
    const getRes = await rpcFetch(
      new Request(`http://dsh.internal${LARK_BRIDGE_RPC_PATH}`, { method: 'GET' }),
    )
    expect(getRes.status).toBe(405)
  })

  it('defers writing cli-endpoint.json until live origin is bound, preserves token, and emits Electron-safe wrappers', () => {
    const dir = makeTempDir()
    const auth = ensureCliAuthEndpoint(dir, '')
    expect(auth.apiBaseUrl).toBe('')
    expect(existsSync(auth.endpointFile)).toBe(false)

    auth.updateBaseUrl('http://127.0.0.1:54321/')
    expect(auth.apiBaseUrl).toBe('http://127.0.0.1:54321/api/lark-bridge')
    const saved = JSON.parse(readFileSync(auth.endpointFile, 'utf8')) as {
      apiBaseUrl: string
      publicBaseUrl: string
      token: string
    }
    expect(saved.apiBaseUrl).toBe('http://127.0.0.1:54321/api/lark-bridge')
    expect(saved.publicBaseUrl).toBe('http://127.0.0.1:54321')
    expect(saved.token).toBe(auth.token)

    // Re-initializing preserves the same token across Desktop restarts on a new port
    const reloaded = ensureCliAuthEndpoint(dir, '')
    expect(reloaded.token).toBe(auth.token)
    reloaded.updateBaseUrl('http://127.0.0.1:59999')
    expect(reloaded.apiBaseUrl).toBe('http://127.0.0.1:59999/api/lark-bridge')

    // Electron wrapper sets ELECTRON_RUN_AS_NODE=1 on both POSIX and Windows
    const macElectron = buildCliWrapperContent({
      endpointFile: auth.endpointFile,
      cliEntry: '/pkg/dist/lark-bridge.mjs',
      execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      isElectron: true,
      platform: 'darwin',
    })
    expect(macElectron.fileName).toBe('lark-bridge')
    expect(macElectron.content).toContain('export ELECTRON_RUN_AS_NODE=1')

    const winElectron = buildCliWrapperContent({
      endpointFile: 'C:\\Users\\demo\\.dsh\\lark-bridge\\cli-endpoint.json',
      cliEntry: 'C:\\pkg\\dist\\lark-bridge.mjs',
      execPath: 'C:\\Program Files\\DSH\\DSH.exe',
      isElectron: true,
      platform: 'win32',
    })
    expect(winElectron.fileName).toBe('lark-bridge.cmd')
    expect(winElectron.content).toContain('set "ELECTRON_RUN_AS_NODE=1"')

    const standardNode = buildCliWrapperContent({
      endpointFile: auth.endpointFile,
      cliEntry: '/pkg/dist/lark-bridge.mjs',
      execPath: '/usr/local/bin/node',
      isElectron: false,
      platform: 'linux',
    })
    expect(standardNode.content).not.toContain('ELECTRON_RUN_AS_NODE')

    // Standalone packaged bundle asset resolution
    const pkgDir = makeTempDir()
    mkdirSync(join(pkgDir, 'dist'), { recursive: true })
    mkdirSync(join(pkgDir, 'skills', 'lark-bridge'), { recursive: true })
    writeFileSync(join(pkgDir, 'dist', 'lark-bridge.mjs'), '#!/usr/bin/env node\n', 'utf8')
    writeFileSync(join(pkgDir, 'skills', 'lark-bridge', 'SKILL.md'), '# skill\n', 'utf8')
    const located = resolveBundledAssetPaths(join(pkgDir, 'dist'))
    expect(located.cliEntry).toBe(join(pkgDir, 'dist', 'lark-bridge.mjs'))
    expect(located.skillSource).toBe(join(pkgDir, 'skills', 'lark-bridge', 'SKILL.md'))
  })

  it('issues loopback-only Desktop session handoff tickets without leaking launchToken and enforces strict defenses', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      get: () => undefined,
      llm: { listProviders: () => [], listModels: async () => [] },
      agents: { get: () => undefined },
      sessions: { list: () => [] },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    const authenticatedUrl = vi.fn(
      (baseUrl: string) => `${baseUrl.replace(/\/+$/, '')}/?token=secret-launch-token-123`,
    )
    let isAuthed = false
    const connection: ConnectionAdmitter = {
      admit: () => (isAuthed ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 }),
      authenticatedUrl,
    }

    const runHttp = (opts: {
      method?: string
      url: string
      headers?: Record<string, string>
      remoteAddress?: string
    }): Promise<{ status: number; headers: Record<string, string>; body: string }> =>
      new Promise((resolve, reject) => {
        const req = Readable.from([]) as unknown as IncomingMessage
        req.method = opts.method ?? 'GET'
        req.url = opts.url
        req.headers = opts.headers ?? {}
        ;(req as unknown as { socket?: { remoteAddress?: string } }).socket = {
          remoteAddress: opts.remoteAddress ?? '127.0.0.1',
        }
        let status = 200
        let headers: Record<string, string> = {}
        let body = ''
        const res = {
          writeHead(code: number, hdrs?: Record<string, string>) {
            status = code
            headers = hdrs ?? {}
            return res
          },
          end(chunk?: string | Buffer) {
            if (chunk) body += chunk.toString()
            resolve({ status, headers, body })
          },
        } as unknown as ServerResponse
        Promise.resolve(createLarkHttpHandler(fakeCtx, connection, manager)(req, res)).catch(reject)
      })

    // 1. Desktop ephemeral loopback origin generates a signed handoff URL (never leaking launchToken)
    manager.bindLiveWebOrigin('http://127.0.0.1:52561', connection)
    const sid = 'session-handoff-demo-1'
    const handoffUrl = manager.sessionWebUrl(sid)
    expect(handoffUrl.startsWith(`http://127.0.0.1:52561${LARK_SESSION_OPEN_PATH}?`)).toBe(true)
    expect(handoffUrl).not.toContain('secret-launch-token-123')
    const parsedHandoff = new URL(handoffUrl)
    const relativePath = `${parsedHandoff.pathname}${parsedHandoff.search}`

    // 2. Unauthenticated browser top-level navigation (including from Feishu Web cross-site tab)
    //    receives a same-origin HTML bounce carrying `/?token=<launchToken>#session=<sid>`
    const bounceRes = await runHttp({
      url: relativePath,
      headers: {
        host: '127.0.0.1:52561',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    })
    expect(bounceRes.status).toBe(200)
    expect(bounceRes.headers['cache-control']).toBe('no-store')
    expect(bounceRes.headers['referrer-policy']).toBe('no-referrer')
    expect(bounceRes.headers['x-frame-options']).toBe('DENY')
    expect(bounceRes.body).toContain(
      `window.location.replace("/?token=secret-launch-token-123#session=${encodeURIComponent(sid)}")`,
    )
    expect(authenticatedUrl).toHaveBeenCalledTimes(1)

    // 3. Once the browser holds a valid DSH cookie, bounce skips launchToken completely
    isAuthed = true
    const authedRes = await runHttp({
      url: relativePath,
      headers: { host: '127.0.0.1:52561' },
    })
    expect(authedRes.status).toBe(200)
    expect(authedRes.body).toContain(`window.location.replace("/#session=${encodeURIComponent(sid)}")`)
    expect(authedRes.body).not.toContain('secret-launch-token-123')
    expect(authenticatedUrl).toHaveBeenCalledTimes(1)

    // 4. Security defenses fail closed on tampering, DNS rebinding, remote peers, and JS fetches
    isAuthed = false
    const badTicket = await runHttp({
      url: `${LARK_SESSION_OPEN_PATH}?session=${encodeURIComponent(sid)}&ticket=tampered`,
      headers: { host: '127.0.0.1:52561' },
    })
    expect(badTicket.status).toBe(403)

    const wrongSession = await runHttp({
      url: `${LARK_SESSION_OPEN_PATH}?session=other-session&ticket=${encodeURIComponent(parsedHandoff.searchParams.get('ticket')!)}`,
      headers: { host: '127.0.0.1:52561' },
    })
    expect(wrongSession.status).toBe(403)

    const dnsRebind = await runHttp({
      url: relativePath,
      headers: { host: 'evil.example:52561' },
    })
    expect(dnsRebind.status).toBe(403)

    const remotePeer = await runHttp({
      url: relativePath,
      headers: { host: '127.0.0.1:52561' },
      remoteAddress: '198.51.100.99',
    })
    expect(remotePeer.status).toBe(403)

    const crossSiteFetch = await runHttp({
      url: relativePath,
      headers: {
        host: '127.0.0.1:52561',
        origin: 'https://evil.example',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
    })
    expect(crossSiteFetch.status).toBe(403)

    const wrongMethod = await runHttp({
      method: 'POST',
      url: relativePath,
      headers: { host: '127.0.0.1:52561' },
    })
    expect(wrongMethod.status).toBe(405)

    // 5. Non-loopback LAN/public listener NEVER emits handoff URLs and disables `/api/lark-bridge/open`
    manager.bindLiveWebOrigin('http://192.168.1.10:3880', connection)
    expect(manager.sessionWebUrl(sid)).toBe(`http://192.168.1.10:3880/#session=${encodeURIComponent(sid)}`)
    const lanOpenRes = await runHttp({
      url: relativePath,
      headers: { host: '192.168.1.10:3880' },
    })
    expect(lanOpenRes.status).toBe(403)
  })

  it('routes loopback handoff directly to an attached Desktop renderer with ACK + focus, and respects mode=web', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      get: () => undefined,
      llm: { listProviders: () => [], listModels: async () => [] },
      agents: { get: () => undefined },
      sessions: { list: () => [] },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    const authenticatedUrl = vi.fn(
      (baseUrl: string) => `${baseUrl.replace(/\/+$/, '')}/?token=desktop-launch-token`,
    )
    const connection: ConnectionAdmitter = {
      admit: () => ({ rejection: 401 }),
      authenticatedUrl,
    }
    manager.bindLiveWebOrigin('http://127.0.0.1:52561', connection)

    const rpcFetch = createLarkConnectionRpcHandler(fakeCtx, manager)
    const callRpc = async (method: string, path: string, body?: unknown) => {
      const res = await rpcFetch(
        new Request(`http://dsh.internal${LARK_BRIDGE_RPC_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: `rpc-${Math.random().toString(36).slice(2)}`,
            method: LARK_BRIDGE_RPC_ENDPOINT,
            payload: { method, path, ...(body !== undefined ? { body } : {}) },
          }),
        }),
      )
      return (await res.json()) as { result: { ok: boolean; value?: Record<string, unknown> } }
    }

    const sid = 'session-desktop-direct-1'
    const handoffUrl = new URL(manager.sessionWebUrl(sid))
    const relPath = `${handoffUrl.pathname}${handoffUrl.search}`
    const focusApp = vi.fn()

    const invokeOpen = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = Readable.from([]) as unknown as IncomingMessage
        req.method = 'GET'
        req.url = url
        req.headers = { host: '127.0.0.1:52561' }
        ;(req as unknown as { socket?: { remoteAddress?: string } }).socket = {
          remoteAddress: '127.0.0.1',
        }
        let status = 200
        let body = ''
        const res = {
          writeHead(code: number) {
            status = code
            return res
          },
          end(chunk?: string | Buffer) {
            if (chunk) body += chunk.toString()
            resolve({ status, body })
          },
        } as unknown as ServerResponse
        Promise.resolve(
          handleLoopbackSessionOpen(req, res, {
            liveOrigin: manager.getLiveWebOrigin(),
            connection,
            handoff: manager.sessionHandoff,
            focusApp,
          }),
        ).catch(reject)
      })

    // 1. Desktop renderer attaches long-poll waiter over Connection RPC
    const waitPromise = callRpc('GET', '/desktop/open-wait?timeoutMs=5000')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(manager.sessionHandoff.hasActiveDesktopClient).toBe(true)

    // 2. Browser clicks Feishu link -> Host wakes Desktop waiter -> Desktop ACKs -> Host focuses app
    const openPromise = invokeOpen(relPath)
    const waitResult = await waitPromise
    expect(waitResult.result.ok).toBe(true)
    const command = waitResult.result.value?.command as { requestId: string; sessionId: string } | null
    expect(command?.sessionId).toBe(sid)

    const ackResult = await callRpc('POST', '/desktop/open-ack', {
      requestId: command!.requestId,
      opened: true,
    })
    expect(ackResult.result.ok).toBe(true)
    expect(ackResult.result.value?.matched).toBe(true)

    const openRes = await openPromise
    expect(openRes.status).toBe(200)
    expect(openRes.body).toContain('已在 DeepSeek Harness 桌面端打开会话')
    expect(openRes.body).toContain('href="dsh://open"')
    expect(openRes.body).toContain('mode=web')
    expect(focusApp).toHaveBeenCalledTimes(1)
    expect(authenticatedUrl).not.toHaveBeenCalled()

    // 3. Explicit `?mode=web` bypasses Desktop and falls back directly to authenticated Web bounce
    const webRes = await invokeOpen(`${relPath}&mode=web`)
    expect(webRes.status).toBe(200)
    expect(webRes.body).toContain(
      `window.location.replace("/?token=desktop-launch-token#session=${encodeURIComponent(sid)}")`,
    )
    expect(authenticatedUrl).toHaveBeenCalledTimes(1)

    await manager.stop()
  })
})
