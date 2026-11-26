import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolFacade, SessionIdentityError } from '../src/agent-tool-facade.js'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { EXTERNAL_SESSION_ID_HEADER } from '../src/cli-support.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { MemoryService } from '../src/memory-service.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { LarkBridgeStore } from '../src/store.js'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const cliEntryPath = resolve(__dirname, '../../dsh-bundle/bin/lark-bridge.mjs')

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix = 'lark-ext-session-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('External session ID resolution (ext:<externalId>) & CLI in-session guards', () => {
  it('resolves ext:<externalId> across RuntimeCatalog, AgentToolFacade, reminders and memory HTTP APIs', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const memory = new MemoryService(dir, store)

    store.upsertBot({
      id: 'bot-pool',
      name: 'PoolBot',
      enabled: true,
      larkAppId: 'app_pool_demo',
      larkAppSecret: 'sec_pool_demo',
      defaultWorkingDir: dir,
    })
    store.upsertGroup({
      botId: 'bot-pool',
      chatId: 'chat_pool_demo',
      name: 'Pool Demo Group',
      enabled: true,
      workingDir: dir,
    })
    store.upsertBinding({
      routeKey: 'bot-pool:chat_pool_demo:msg_root_demo',
      botId: 'bot-pool',
      chatId: 'chat_pool_demo',
      chatType: 'group',
      threadId: 'thread_pool_demo',
      sessionId: 'session-canonical-1',
      workingDir: dir,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    })

    const externalToSession = new Map<string, string>([['ext-conv-alpha', 'session-canonical-1']])
    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      get: (key: string) =>
        key === 'externalRuntimes'
          ? {
              listRuntimes: () => [],
              resolveSessionIdByExternalId: (extId: string) => externalToSession.get(extId),
            }
          : undefined,
      llm: { listProviders: () => [], listModels: async () => [] },
      agents: { get: () => undefined },
    } as unknown as Context

    const runtimes = new RuntimeCatalog(fakeCtx)
    expect(runtimes.resolveSessionIdByExternalId('ext-conv-alpha')).toBe('session-canonical-1')
    expect(runtimes.resolveSessionIdByExternalId('ext-conv-missing')).toBeUndefined()

    const markSessionTurnSilent = vi.fn(() => ({
      matched: true,
      allowSilent: true,
      turnId: 'turn-demo-1',
    }))
    const sendProactiveMessage = vi.fn(async () => ({ messageId: 'msg_sent_1' }))
    const facade = new AgentToolFacade({
      ctx: fakeCtx,
      store,
      connections: {
        listBotStatuses: () => [
          {
            id: 'bot-pool',
            name: 'PoolBot',
            enabled: true,
            status: 'connected',
            appId: 'app_pool_demo',
            workingDir: dir,
          },
        ],
        transportFor: () => ({ sendProactiveMessage }) as never,
      } as never,
      inbound: {
        getActiveTurn: () => undefined,
        markSessionTurnSilent,
        listActiveTurns: () => [],
      } as never,
      getSchedules: () => ({}) as never,
      getReminders: () => ({ markSessionSilent: () => false }) as never,
      sessionWebUrl: (sid: string) => `http://127.0.0.1:3880/#session=${sid}`,
      resolveExternalSessionId: (extId: string) => runtimes.resolveSessionIdByExternalId(extId),
    })

    // 1. canonicalizeSessionId & resolveAgentContext
    expect(facade.canonicalizeSessionId('ext:ext-conv-alpha')).toBe('session-canonical-1')
    expect(facade.canonicalizeSessionId('ext:ext-conv-missing')).toBeUndefined()
    expect(facade.canonicalizeSessionId('session-direct-2')).toBe('session-direct-2')

    const resolvedCtx = facade.resolveAgentContext('ext:ext-conv-alpha')
    expect(resolvedCtx.bound).toBe(true)
    expect(resolvedCtx.sessionId).toBe('session-canonical-1')
    expect(resolvedCtx.botId).toBe('bot-pool')
    expect(resolvedCtx.chatId).toBe('chat_pool_demo')

    // 2. agentSilenceTurn resolves ext:<id> -> canonical sessionId
    const silenceOutcome = facade.agentSilenceTurn({
      sessionId: 'ext:ext-conv-alpha',
      reason: 'done',
    })
    expect(silenceOutcome.silenced).toBe(true)
    expect(markSessionTurnSilent).toHaveBeenCalledWith('session-canonical-1', 'done')
    expect(() => facade.agentSilenceTurn({ sessionId: 'ext:ext-conv-missing' })).toThrow(
      /sessionId is required/,
    )

    // 3. agentSend embeds canonical sessionUrl (never ext:...) and writes audit trail
    const sendOutcome = await facade.agentSend({ sessionId: 'ext:ext-conv-alpha', text: 'hello pooled' })
    expect(sendProactiveMessage).toHaveBeenCalledTimes(1)
    const sentPayload = sendProactiveMessage.mock.calls[0]?.[0] as { content?: string }
    expect(sentPayload.content).toContain('session-canonical-1')
    expect(sentPayload.content).not.toContain('ext:ext-conv-alpha')
    expect(sendOutcome.sessionId).toBe('session-canonical-1')
    expect(sendOutcome.routeKey).toBe('bot-pool:chat_pool_demo:msg_root_demo')
    const sendAudit = store.listEvents(10).find((e) => e.kind === 'reply' && e.sessionId === 'session-canonical-1')
    expect(sendAudit?.summary).toContain('CLI 主动发送')

    // 4. HTTP POST /reminders & POST /memory + supersede canonicalize sessionId and fail closed on unresolved ext:*
    const createReminder = vi.fn(async (input: Record<string, unknown>) => ({
      id: 'rem-1',
      ...input,
    }))
    const mockManager = {
      store,
      memory,
      reminders: { create: createReminder },
      resolveCliSessionId: (sid?: string) => facade.canonicalizeSessionId(sid),
      resolveCliSessionIdentity: (sid?: string, ext?: string) =>
        facade.resolveCliSessionIdentity(sid, ext),
      resolveAgentContext: (sid?: string, ext?: string) => facade.resolveAgentContext(sid, ext),
      agentSend: (input: Parameters<AgentToolFacade['agentSend']>[0]) => facade.agentSend(input),
      agentHistory: (input: Parameters<AgentToolFacade['agentHistory']>[0]) =>
        facade.agentHistory(input),
    } as never

    const remRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/reminders',
      body: {
        sessionId: 'ext:ext-conv-alpha',
        title: 'Follow up',
        prompt: 'Check status',
        triggerAt: '2026-12-01T00:00:00.000Z',
      },
      principalKind: 'owner',
      isCliAuthenticated: true,
    })
    expect(remRes.status).toBe(201)
    expect(createReminder).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-canonical-1' }),
    )

    // Unresolved ext:* WITHOUT explicit botId+chatId MUST fail closed (never fall back to default_bot)
    const remMissingRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/reminders',
      body: {
        sessionId: 'ext:ext-conv-missing',
        title: 'Follow up 2',
        prompt: 'Check status',
        triggerAt: '2026-12-01T00:00:00.000Z',
      },
      principalKind: 'owner',
      isCliAuthenticated: true,
    })
    expect(remMissingRes.status).toBe(400)
    expect((remMissingRes.payload as { code?: string }).code).toBe('unresolved_session_context')
    expect(createReminder).toHaveBeenCalledTimes(1)

    // Unresolved ext:* WITH explicit botId+chatId is allowed without leaking raw ext:* as sessionId
    const remExplicitTargetRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/reminders',
      body: {
        sessionId: 'ext:ext-conv-missing',
        botId: 'bot-pool',
        chatId: 'chat_pool_demo',
        title: 'Follow up explicit',
        prompt: 'Check status',
        triggerAt: '2026-12-01T00:00:00.000Z',
      },
      principalKind: 'owner',
      isCliAuthenticated: true,
    })
    expect(remExplicitTargetRes.status).toBe(201)
    expect((createReminder.mock.calls[1]?.[0] as { sessionId?: string }).sessionId).toBeUndefined()

    // Unresolved ext:* on resolveAgentContext, agentSend, POST /memory, GET /memory MUST fail closed (no default_bot)
    const unresolvedCtx = facade.resolveAgentContext('ext:ext-conv-missing')
    expect(unresolvedCtx.bound).toBe(false)
    expect(unresolvedCtx.botId).toBeUndefined()
    expect(unresolvedCtx.source).toBeUndefined()
    expect(unresolvedCtx.unresolvedSessionId).toBe('ext:ext-conv-missing')

    await expect(
      facade.agentSend({ sessionId: 'ext:ext-conv-missing', chatId: 'chat_pool_demo', text: 'must block' }),
    ).rejects.toThrow(SessionIdentityError)

    const memUnresolvedPost = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/memory',
      body: {
        sessionId: 'ext:ext-conv-missing',
        type: 'feedback',
        title: 'Must not fall back to default bot',
        content: 'Blocked',
      },
      principalKind: 'owner',
      isCliAuthenticated: true,
    })
    expect(memUnresolvedPost.status).toBe(400)
    expect((memUnresolvedPost.payload as { code?: string }).code).toBe('unresolved_session_context')

    const memUnresolvedGet = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'GET',
      path: '/memory?sessionId=ext%3Aext-conv-missing',
      principalKind: 'owner',
      isCliAuthenticated: true,
    })
    expect(memUnresolvedGet.status).toBe(400)

    const memCreateRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/memory',
      body: {
        sessionId: 'ext:ext-conv-alpha',
        type: 'feedback',
        title: 'Pooled memory test',
        content: 'Stored via pooled external conversation id',
      },
      principalKind: 'owner',
      isCliAuthenticated: true,
    })
    expect(memCreateRes.status).toBe(201)
    const createdEntry = (memCreateRes.payload as { entry: { id: string; sourceSessionId?: string; botId: string } }).entry
    expect(createdEntry.botId).toBe('bot-pool')
    expect(createdEntry.sourceSessionId).toBe('session-canonical-1')

    const memSuperRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: `/memory/${createdEntry.id}/supersede`,
      body: {
        sessionId: 'ext:ext-conv-alpha',
        reason: 'refined',
        title: 'Pooled memory test v2',
        content: 'Updated via pooled external conversation id',
      },
      principalKind: 'owner',
      isCliAuthenticated: true,
    })
    expect(memSuperRes.status).toBe(200)
    const replacement = (
      memSuperRes.payload as { replacementEntry?: { sourceSessionId?: string } }
    ).replacementEntry
    expect(replacement?.sourceSessionId).toBe('session-canonical-1')

    // 5. Cross-route identity mismatch guard (DSH_SESSION_ID != ANTIGRAVITY_CONVERSATION_ID owner) -> HTTP 409 + audit
    store.upsertBinding({
      routeKey: 'bot-pool:chat_pool_demo:msg_root_beta',
      botId: 'bot-pool',
      chatId: 'chat_pool_demo',
      chatType: 'group',
      threadId: 'thread_pool_beta',
      sessionId: 'session-canonical-2',
      workingDir: dir,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    })
    const mismatchSendRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/agent/send',
      body: { sessionId: 'session-canonical-2', text: 'HIJACKED_PROGRESS_UPDATE', textOnly: true },
      externalSessionId: 'ext-conv-alpha',
      principalKind: 'cli',
      isCliAuthenticated: true,
    })
    expect(mismatchSendRes.status).toBe(409)
    expect((mismatchSendRes.payload as { code?: string }).code).toBe('session_identity_mismatch')
    expect(sendProactiveMessage).toHaveBeenCalledTimes(1)
    const mismatchAudit = store
      .listEvents(10)
      .find((e) => e.kind === 'error' && e.summary.includes('会话身份冲突'))
    expect(mismatchAudit).toBeDefined()

    const mismatchRemRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/reminders',
      body: {
        sessionId: 'session-canonical-2',
        title: 'Hijacked reminder',
        prompt: 'Should fail',
        afterSeconds: 600,
      },
      externalSessionId: 'ext-conv-alpha',
      principalKind: 'cli',
      isCliAuthenticated: true,
    })
    expect(mismatchRemRes.status).toBe(409)

    const mismatchMemRes = await dispatchLarkApiRequest(fakeCtx, mockManager, {
      method: 'POST',
      path: '/memory',
      body: {
        sessionId: 'session-canonical-2',
        type: 'feedback',
        title: 'Hijacked memory',
        content: 'Should fail',
      },
      externalSessionId: 'ext-conv-alpha',
      principalKind: 'cli',
      isCliAuthenticated: true,
    })
    expect(mismatchMemRes.status).toBe(409)
  })

  it('persists external session links durably in SQLite across restarts and hot-reloads', async () => {
    const dir = makeTempDir('lark-durable-ext-')
    const store = new LarkBridgeStore(dir)
    const listeners: Array<(session: { id: string }, event: unknown) => void> = []
    let liveExternalMap = new Map<string, string>()

    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: (eventName: string, cb: (session: { id: string }, event: unknown) => void) => {
        if (eventName === 'session/event') listeners.push(cb)
        return () => {}
      },
      get: (key: string) => {
        if (key === 'externalRuntimes') {
          return {
            listRuntimes: () => [],
            resolveSessionIdByExternalId: (extId: string) => liveExternalMap.get(extId),
          }
        }
        return undefined
      },
      llm: { listProviders: () => [], listModels: async () => [] },
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: () => undefined },
    } as unknown as Context

    store.upsertBot({
      id: 'bot-durable',
      name: 'DurableBot',
      enabled: false,
      larkAppId: 'app_durable',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: dir,
    })
    store.upsertBinding({
      routeKey: 'app_durable_demo:chat_durable:om_root_durable',
      botId: 'bot-durable',
      larkAppId: 'app_durable_demo',
      chatId: 'chat_durable',
      chatType: 'group',
      workspaceName: 'Durable',
      sessionId: 'session-durable-1',
      agentPreset: 'agy',
      workingDir: dir,
      trigger: 'mention',
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
        syncGlobalCliAndSkill: false,
        enableInstanceLock: false,
      },
      store,
    )
    await manager.start()

    try {
      // Simulate external-agent plugin appending a durable binding event on session-durable-1
      for (const cb of listeners) {
        cb(
          { id: 'session-durable-1' },
          {
            type: 'plugin:external-agent/binding',
            ignorable: true,
            seq: 1,
            time: Date.now(),
            data: { driver: 'agy', externalId: 'ext-durable-uuid-1' },
          },
        )
      }

      // Live in-memory externalRuntimes map is completely empty (simulating restart / hot-reload)
      liveExternalMap = new Map()
      expect(manager.resolveCliSessionId('ext:ext-durable-uuid-1')).toBe('session-durable-1')
      const ctx = manager.resolveAgentContext('ext:ext-durable-uuid-1')
      expect(ctx.bound).toBe(true)
      expect(ctx.sessionId).toBe('session-durable-1')
      expect(ctx.botId).toBe('bot-durable')
    } finally {
      await manager.stop()
      store.close()
    }
  })

  it('falls back to ext:<ANTIGRAVITY_CONVERSATION_ID> in lark-bridge CLI, sends cross-check header, and enforces pooled in-session guards', async () => {
    const dir = makeTempDir('lark-cli-ext-')
    const receivedRequests: Array<{ url: string; extHeader?: string }> = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedRequests.push({
        url: req.url ?? '',
        extHeader:
          typeof req.headers[EXTERNAL_SESSION_ID_HEADER] === 'string'
            ? req.headers[EXTERNAL_SESSION_ID_HEADER]
            : undefined,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, bound: true, sessionId: 'session-canonical-1' }))
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const addr = server.address() as { port: number }
    const endpointFile = join(dir, 'cli-endpoint.json')
    writeFileSync(
      endpointFile,
      JSON.stringify({
        apiBaseUrl: `http://127.0.0.1:${addr.port}/api/lark-bridge`,
        publicBaseUrl: `http://127.0.0.1:${addr.port}`,
        token: 'tok_demo_test',
      }),
      'utf8',
    )

    try {
      const baseEnv: NodeJS.ProcessEnv = { ...process.env, LARK_BRIDGE_ENDPOINT_FILE: endpointFile }
      delete baseEnv.DSH_SESSION_ID
      delete baseEnv.DSH_IN_AGENT_SESSION
      delete baseEnv.ANTIGRAVITY_CONVERSATION_ID

      // 1. Pooled agy subprocess (no DSH_SESSION_ID, has ANTIGRAVITY_CONVERSATION_ID) sends ext:<id> + header
      await execFileAsync(process.execPath, [cliEntryPath, 'context'], {
        env: { ...baseEnv, DSH_IN_AGENT_SESSION: '1', ANTIGRAVITY_CONVERSATION_ID: 'conv-uuid-123' },
      })
      expect(receivedRequests.at(-1)).toEqual({
        url: '/api/lark-bridge/agent/context?sessionId=ext%3Aconv-uuid-123',
        extHeader: 'conv-uuid-123',
      })

      // 2. Ambient DSH_SESSION_ID + ANTIGRAVITY_CONVERSATION_ID sends BOTH so server can detect cross-route mismatch
      await execFileAsync(process.execPath, [cliEntryPath, 'context'], {
        env: {
          ...baseEnv,
          DSH_SESSION_ID: 'session-explicit-9',
          ANTIGRAVITY_CONVERSATION_ID: 'conv-uuid-123',
        },
      })
      expect(receivedRequests.at(-1)).toEqual({
        url: '/api/lark-bridge/agent/context?sessionId=session-explicit-9',
        extHeader: 'conv-uuid-123',
      })

      // 3. Explicit --session flag skips ambient external header override
      await execFileAsync(process.execPath, [cliEntryPath, 'context', '--session', 'session-manual-7'], {
        env: {
          ...baseEnv,
          DSH_SESSION_ID: 'session-explicit-9',
          ANTIGRAVITY_CONVERSATION_ID: 'conv-uuid-123',
        },
      })
      expect(receivedRequests.at(-1)).toEqual({
        url: '/api/lark-bridge/agent/context?sessionId=session-manual-7',
        extHeader: undefined,
      })

      // 4. In-session guard blocks plugin update and lifecycle drain under DSH_IN_AGENT_SESSION=1
      await expect(
        execFileAsync(process.execPath, [cliEntryPath, 'plugin', 'update'], {
          env: { ...baseEnv, DSH_IN_AGENT_SESSION: '1' },
        }),
      ).rejects.toThrow(/拒绝在活跃 Agent 会话内直接热更新插件/)

      await expect(
        execFileAsync(process.execPath, [cliEntryPath, 'lifecycle', 'drain'], {
          env: { ...baseEnv, ANTIGRAVITY_CONVERSATION_ID: 'conv-uuid-123' },
        }),
      ).rejects.toThrow(/拒绝在 Agent 会话内直接变更桥接排空状态/)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })
})
