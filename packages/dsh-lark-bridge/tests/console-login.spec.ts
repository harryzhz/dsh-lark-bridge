import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { parseSlashCommand } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import {
  ConsoleLoginHandoff,
  LARK_CONSOLE_LOGIN_PATH,
  handleConsoleLogin,
} from '../src/console-login.js'
import {
  createLarkHttpHandler,
  dispatchLarkApiRequest,
  type ConnectionAdmitter,
} from '../src/http-api.js'
import { handleSlashCommand, type SlashCommandHost } from '../src/slash-commands.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-console-login-test-'))
  tempDirs.push(dir)
  return dir
}

function createFakeReqRes(options: {
  readonly method?: string
  readonly url: string
  readonly headers?: Record<string, string>
  readonly body?: string
}) {
  const req = Readable.from(options.body ? [Buffer.from(options.body, 'utf8')] : []) as unknown as IncomingMessage
  req.method = options.method ?? 'GET'
  req.url = options.url
  req.headers = { ...options.headers }

  let statusCode = 200
  const headers: Record<string, string | string[]> = {}
  const chunks: Buffer[] = []
  const res = {
    writeHead(code: number, hdrs?: Record<string, string | string[]>) {
      statusCode = code
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
    },
  } as unknown as ServerResponse

  return {
    req,
    res,
    result: () => ({
      status: statusCode,
      headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }),
  }
}

describe('/console slash command and single-use console-login handoff', () => {
  it('parses /console slash command and enforces fail-closed admin + DM-only delivery rules', async () => {
    expect(parseSlashCommand('/console')).toEqual({ name: 'console', args: '' })

    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const unconfiguredBot = store.upsertBot({
      id: 'bot-no-admin',
      name: 'NoAdminBot',
      larkAppId: 'cli_test_no_admin',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: dir,
      adminUsers: [],
    })
    const adminBot = store.upsertBot({
      id: 'bot-admin',
      name: 'AdminBot',
      larkAppId: 'cli_test_admin',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: dir,
      adminUsers: ['ou_owner'],
    })

    const issueConsoleLoginLink = vi.fn(() => ({
      url: 'http://198.51.100.10:3890/api/lark-bridge/console-login?code=opaque-ticket-123',
      origin: 'http://198.51.100.10:3890',
      expiresInSec: 120,
      expiresAtMs: Date.now() + 120_000,
    }))

    const host: SlashCommandHost = {
      ctx: { agents: { get: () => undefined } } as unknown as Context,
      store,
      runtimes: { list: async () => [], providerFor: () => undefined, resolveDefaultModel: async () => '' } as never,
      unbindRoute: async () => false,
      sessionWebUrl: () => 'http://198.51.100.10:3890',
      issueConsoleLoginLink,
      runTurn: async () => '',
    }

    // 1. Fail-closed when bot has no adminUsers configured
    const replies1: string[] = []
    await handleSlashCommand(host, {
      bot: unconfiguredBot,
      chatType: 'p2p',
      senderOpenId: 'ou_owner',
      senderType: 'user',
      command: { name: 'console', args: '' },
      routeKey: 'r1',
      workingDir: dir,
      workspaceName: 'ws',
      reply: async (t) => {
        replies1.push(t)
      },
    })
    expect(replies1[0]).toContain('尚未为智能体')
    expect(issueConsoleLoginLink).not.toHaveBeenCalled()

    // 2. Fail-closed for non-admin user
    const replies2: string[] = []
    await handleSlashCommand(host, {
      bot: adminBot,
      chatType: 'p2p',
      senderOpenId: 'ou_other',
      senderType: 'user',
      command: { name: 'console', args: '' },
      routeKey: 'r2',
      workingDir: dir,
      workspaceName: 'ws',
      reply: async (t) => {
        replies2.push(t)
      },
    })
    expect(replies2[0]).toContain('仅智能体')
    expect(issueConsoleLoginLink).not.toHaveBeenCalled()

    // 3. Fail-closed for bot sender even if senderOpenId matches
    const replies3: string[] = []
    await handleSlashCommand(host, {
      bot: adminBot,
      chatType: 'group',
      senderOpenId: 'ou_owner',
      senderType: 'bot',
      command: { name: 'console', args: '' },
      routeKey: 'r3',
      workingDir: dir,
      workspaceName: 'ws',
      reply: async (t) => {
        replies3.push(t)
      },
    })
    expect(replies3[0]).toContain('仅支持管理员本人触发')
    expect(issueConsoleLoginLink).not.toHaveBeenCalled()

    // 4. P2P admin gets the one-time link directly (never contains master launchToken)
    const replies4: string[] = []
    await handleSlashCommand(host, {
      bot: adminBot,
      chatType: 'p2p',
      senderOpenId: 'ou_owner',
      senderType: 'user',
      command: { name: 'console', args: '' },
      routeKey: 'r4',
      workingDir: dir,
      workspaceName: 'ws',
      reply: async (t) => {
        replies4.push(t)
      },
    })
    expect(issueConsoleLoginLink).toHaveBeenCalledTimes(1)
    expect(replies4[0]).toContain('opaque-ticket-123')
    expect(replies4[0]).toContain('120 秒内有效')

    // 5. Group admin gets link ONLY via DM; group reply contains NO link/code
    const groupReplies: string[] = []
    const dmCalls: Array<{ openId: string; text: string }> = []
    await handleSlashCommand(host, {
      bot: adminBot,
      chatType: 'group',
      senderOpenId: 'ou_owner',
      senderType: 'user',
      command: { name: 'console', args: '' },
      routeKey: 'r5',
      workingDir: dir,
      workspaceName: 'ws',
      reply: async (t) => {
        groupReplies.push(t)
      },
      sendDirectMessage: async (openId, text) => {
        dmCalls.push({ openId, text })
      },
    })
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0]!.openId).toBe('ou_owner')
    expect(dmCalls[0]!.text).toContain('opaque-ticket-123')
    expect(groupReplies[0]).toContain('已通过私聊')
    expect(groupReplies[0]).not.toContain('opaque-ticket-123')
    expect(groupReplies[0]).not.toContain('http://')

    store.close()
  })

  it('keeps GET/HEAD non-consuming, enforces same-origin POST CSRF, consumes single-use ticket, and respects TTL', async () => {
    const handoff = new ConsoleLoginHandoff()
    let now = 1_700_000_000_000
    const ticket = handoff.issue(
      { botId: 'bot-1', botName: 'TestBot', adminOpenId: 'ou_owner', ttlMs: 120_000 },
      now,
    )
    const liveOrigin = 'http://198.51.100.10:3890'
    let isOwner = false
    const audits: string[] = []
    const connection: ConnectionAdmitter = {
      admit: () => (isOwner ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 }),
      authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=master-launch-token-xyz`,
    }

    // 1. HEAD preview request does NOT consume ticket or leak launchToken
    const headTx = createFakeReqRes({
      method: 'HEAD',
      url: `${LARK_CONSOLE_LOGIN_PATH}?code=${ticket.code}`,
      headers: { host: '198.51.100.10:3890' },
    })
    await handleConsoleLogin(headTx.req, headTx.res, {
      liveOrigin,
      connection,
      handoff,
      nowMs: () => now,
    })
    expect(headTx.result().status).toBe(200)
    expect(handoff.peek(ticket.code, now)).toBeDefined()

    // 2. GET top-level document renders confirmation form without exposing launchToken or consuming ticket
    const getTx = createFakeReqRes({
      method: 'GET',
      url: `${LARK_CONSOLE_LOGIN_PATH}?code=${ticket.code}`,
      headers: {
        host: '198.51.100.10:3890',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    })
    await handleConsoleLogin(getTx.req, getTx.res, {
      liveOrigin,
      connection,
      handoff,
      nowMs: () => now,
    })
    const getRes = getTx.result()
    expect(getRes.status).toBe(200)
    expect(getRes.headers['referrer-policy']).toBe('same-origin')
    expect(getRes.body).toContain('确认并登录管理面')
    expect(getRes.body).toContain(ticket.code)
    expect(getRes.body).not.toContain('master-launch-token-xyz')
    expect(handoff.peek(ticket.code, now)).toBeDefined()

    // 3. Cross-origin POST is blocked (403) and does NOT consume ticket
    const badOriginPost = createFakeReqRes({
      method: 'POST',
      url: LARK_CONSOLE_LOGIN_PATH,
      headers: {
        host: '198.51.100.10:3890',
        origin: 'https://evil.example.com',
        'sec-fetch-site': 'cross-site',
      },
      body: `code=${encodeURIComponent(ticket.code)}`,
    })
    await handleConsoleLogin(badOriginPost.req, badOriginPost.res, {
      liveOrigin,
      connection,
      handoff,
      nowMs: () => now,
    })
    expect(badOriginPost.result().status).toBe(403)
    expect(handoff.peek(ticket.code, now)).toBeDefined()

    // 4. Same-origin POST atomically consumes ticket and returns 303 to DSH auth root
    const validPost = createFakeReqRes({
      method: 'POST',
      url: LARK_CONSOLE_LOGIN_PATH,
      headers: {
        host: '198.51.100.10:3890',
        origin: 'http://198.51.100.10:3890',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
      },
      body: `code=${encodeURIComponent(ticket.code)}`,
    })
    await handleConsoleLogin(validPost.req, validPost.res, {
      liveOrigin,
      connection,
      handoff,
      nowMs: () => now,
      onAudit: (ev) => audits.push(`${ev.botId}:${ev.summary}`),
    })
    const postRes = validPost.result()
    expect(postRes.status).toBe(303)
    expect(postRes.headers.location).toBe('/?token=master-launch-token-xyz')
    expect(postRes.headers['cache-control']).toBe('no-store')
    expect(audits).toHaveLength(1)

    // 5. Replaying the same code fails closed (403)
    const replayPost = createFakeReqRes({
      method: 'POST',
      url: LARK_CONSOLE_LOGIN_PATH,
      headers: {
        host: '198.51.100.10:3890',
        origin: 'http://198.51.100.10:3890',
        'sec-fetch-site': 'same-origin',
      },
      body: `code=${encodeURIComponent(ticket.code)}`,
    })
    await handleConsoleLogin(replayPost.req, replayPost.res, {
      liveOrigin,
      connection,
      handoff,
      nowMs: () => now,
    })
    expect(replayPost.result().status).toBe(403)

    // 6. Expired ticket is rejected on both GET and POST
    const expiring = handoff.issue(
      { botId: 'bot-1', botName: 'TestBot', adminOpenId: 'ou_owner', ttlMs: 30_000 },
      now,
    )
    now += 31_000
    const expiredGet = createFakeReqRes({
      method: 'GET',
      url: `${LARK_CONSOLE_LOGIN_PATH}?code=${expiring.code}`,
      headers: { host: '198.51.100.10:3890' },
    })
    await handleConsoleLogin(expiredGet.req, expiredGet.res, {
      liveOrigin,
      connection,
      handoff,
      nowMs: () => now,
    })
    expect(expiredGet.result().status).toBe(403)

    // 7. Already-authenticated Owner skips straight to console root without minting launchToken
    isOwner = true
    const alreadyAuthedGet = createFakeReqRes({
      method: 'GET',
      url: `${LARK_CONSOLE_LOGIN_PATH}?code=anything`,
      headers: { host: '198.51.100.10:3890' },
    })
    await handleConsoleLogin(alreadyAuthedGet.req, alreadyAuthedGet.res, {
      liveOrigin,
      connection,
      handoff,
      nowMs: () => now,
    })
    expect(alreadyAuthedGet.result().status).toBe(200)
    expect(alreadyAuthedGet.result().body).toContain('window.location.replace("/")')
    expect(alreadyAuthedGet.result().body).not.toContain('master-launch-token-xyz')
  })

  it('wires /api/lark-bridge/console-login through createLarkHttpHandler and LarkBridgeManager.issueConsoleLoginLink', async () => {
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
        publicBaseUrl: 'http://198.51.100.10:3890',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    const connection: ConnectionAdmitter = {
      admit: () => ({ rejection: 401 }),
      authenticatedUrl: (base) => `${base.replace(/\/+$/, '')}/?token=secret-owner-token`,
    }
    manager.bindLiveWebOrigin('http://198.51.100.10:3890', connection)

    const issued = manager.issueConsoleLoginLink({
      botId: 'e2e-bot',
      botName: 'E2EBot',
      adminOpenId: 'ou_owner',
    })
    expect(issued).toBeDefined()
    expect(issued!.url).toContain(LARK_CONSOLE_LOGIN_PATH)
    expect(issued!.url).not.toContain('secret-owner-token')

    const code = new URL(issued!.url).searchParams.get('code')!
    const handler = createLarkHttpHandler(fakeCtx, connection, manager)

    const getTx = createFakeReqRes({
      method: 'GET',
      url: `${LARK_CONSOLE_LOGIN_PATH}?code=${encodeURIComponent(code)}`,
      headers: { host: '198.51.100.10:3890' },
    })
    await handler(getTx.req, getTx.res)
    expect(getTx.result().status).toBe(200)
    expect(getTx.result().body).toContain('E2EBot')

    const postTx = createFakeReqRes({
      method: 'POST',
      url: LARK_CONSOLE_LOGIN_PATH,
      headers: {
        host: '198.51.100.10:3890',
        origin: 'http://198.51.100.10:3890',
        'sec-fetch-site': 'same-origin',
      },
      body: `code=${encodeURIComponent(code)}`,
    })
    await handler(postTx.req, postTx.res)
    expect(postTx.result().status).toBe(303)
    expect(postTx.result().headers.location).toBe('/?token=secret-owner-token')

    // CLI bearer token must be blocked from POST /console-login/issue, while Owner web session succeeds
    const cliDenied = await dispatchLarkApiRequest(fakeCtx, manager, {
      method: 'POST',
      path: '/console-login/issue',
      body: { botId: 'e2e-bot' },
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliDenied.status).toBe(403)

    const ownerIssued = await dispatchLarkApiRequest(fakeCtx, manager, {
      method: 'POST',
      path: '/console-login/issue',
      body: { botId: 'e2e-bot', botName: 'E2EBot' },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(ownerIssued.status).toBe(200)
    expect((ownerIssued.payload as { url?: string }).url).toContain(LARK_CONSOLE_LOGIN_PATH)

    store.close()
  })
})
