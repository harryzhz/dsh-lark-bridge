import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolFacade } from '../src/agent-tool-facade.js'
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

    // 3. agentSend embeds canonical sessionUrl (never ext:...)
    await facade.agentSend({ sessionId: 'ext:ext-conv-alpha', text: 'hello pooled' })
    expect(sendProactiveMessage).toHaveBeenCalledTimes(1)
    const sentPayload = sendProactiveMessage.mock.calls[0]?.[0] as { content?: string }
    expect(sentPayload.content).toContain('session-canonical-1')
    expect(sentPayload.content).not.toContain('ext:ext-conv-alpha')

    // 4. HTTP POST /reminders & POST /memory + supersede canonicalize sessionId and drop unresolved ext:*
    const createReminder = vi.fn(async (input: Record<string, unknown>) => ({
      id: 'rem-1',
      ...input,
    }))
    const mockManager = {
      store,
      memory,
      reminders: { create: createReminder },
      resolveCliSessionId: (sid?: string) => facade.canonicalizeSessionId(sid),
      resolveAgentContext: (sid?: string) => facade.resolveAgentContext(sid),
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
    expect(remMissingRes.status).toBe(201)
    expect((createReminder.mock.calls[1]?.[0] as { sessionId?: string }).sessionId).toBeUndefined()

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
  })

  it('falls back to ext:<ANTIGRAVITY_CONVERSATION_ID> in lark-bridge CLI and enforces pooled in-session guards', async () => {
    const dir = makeTempDir('lark-cli-ext-')
    const receivedUrls: string[] = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedUrls.push(req.url ?? '')
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

      // 1. Pooled agy subprocess (no DSH_SESSION_ID, has ANTIGRAVITY_CONVERSATION_ID) sends ext:<id>
      await execFileAsync(process.execPath, [cliEntryPath, 'context'], {
        env: { ...baseEnv, DSH_IN_AGENT_SESSION: '1', ANTIGRAVITY_CONVERSATION_ID: 'conv-uuid-123' },
      })
      expect(receivedUrls.at(-1)).toBe('/api/lark-bridge/agent/context?sessionId=ext%3Aconv-uuid-123')

      // 2. Explicit DSH_SESSION_ID takes precedence over ANTIGRAVITY_CONVERSATION_ID
      await execFileAsync(process.execPath, [cliEntryPath, 'context'], {
        env: {
          ...baseEnv,
          DSH_SESSION_ID: 'session-explicit-9',
          ANTIGRAVITY_CONVERSATION_ID: 'conv-uuid-123',
        },
      })
      expect(receivedUrls.at(-1)).toBe('/api/lark-bridge/agent/context?sessionId=session-explicit-9')

      // 3. In-session guard blocks plugin update and lifecycle drain under DSH_IN_AGENT_SESSION=1
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
