import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return {
    ...actual,
    appendPluginRecord: vi.fn(),
  }
})

import type { LarkBridgeManager } from '../src/bridge-manager.js'
import { ensureCliAuthEndpoint } from '../src/cli-support.js'
import { DreamingService } from '../src/dreaming-service.js'
import { createLarkHttpHandler, type ConnectionAdmitter } from '../src/http-api.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { LarkBridgeStore } from '../src/store.js'
import type { WorkspaceGrouping } from '../src/workspace-grouping.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-dreaming-test-'))
  tempDirs.push(dir)
  return dir
}

function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  opts: { method?: string; url: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const rawBody = opts.body !== undefined ? JSON.stringify(opts.body) : ''
    const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as unknown as IncomingMessage
    req.method = opts.method ?? 'GET'
    req.url = opts.url
    req.headers = opts.headers ?? {}

    let status = 200
    let body = ''
    const res = {
      writeHead(code: number) {
        status = code
        return res
      },
      end(chunk?: string | Buffer) {
        if (chunk) body += chunk.toString()
        resolve({ status, json: body ? JSON.parse(body) : {} })
      },
    } as unknown as ServerResponse

    Promise.resolve(handler(req, res)).catch(reject)
  })
}

describe('DreamingService dual-gate scheduling, product dataDir isolation & native memory prompt', () => {
  it('skips below session threshold, writes transcript digests strictly under <dataDir>/dreaming/<botId>, never touches workDir/.local, and exposes POST /bots/:id/dream', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'dsh-agent',
      name: '研发智能体',
      enabled: true,
      larkAppId: 'cli_agent',
      larkAppSecret: 'sec_agent',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '02:00',
          minNewSessions: 2,
          scopes: ['个人偏好', '踩坑与排障经验', '核心发布约定'],
          cleanupAndCorrect: true,
        },
        proactive: {
          remindersEnabled: true,
          reminderCreationMode: 'silent',
          autoCodeEnabled: true,
          branchPrefix: 'agent/',
        },
      },
    })

    const sessionEventsMap = new Map<string, SessionEvent[]>()
    const archivedSessions: string[] = []
    const runTurnPrompts: string[] = []
    let nextDreamReply = ''

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: {
        get: (id: string) => {
          const evs = sessionEventsMap.get(id)
          return evs ? ({ id, snapshotEvents: () => evs } as unknown as Session) : undefined
        },
      },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = {
            session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } },
          }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const runtimes = new RuntimeCatalog(fakeCtx)
    const workspaces = {
      attachSession: vi.fn().mockResolvedValue(undefined),
      archiveSession: vi.fn(async (sid: string) => {
        archivedSessions.push(sid)
        return true
      }),
    } as unknown as WorkspaceGrouping

    const dreaming = new DreamingService({
      ctx: fakeCtx,
      dataDir,
      store,
      runtimes,
      workspaces,
      runTurn: vi.fn(async (_agent, content) => {
        runTurnPrompts.push(content.map((b) => ('text' in b ? b.text : '')).join('\n'))
        return nextDreamReply
      }),
    })

    // 1. Only 1 session recorded (< minNewSessions=2) -> at 02:05 it skips without spawning an agent!
    store.upsertManagedSession({
      sessionId: 'sess-1',
      botId: 'dsh-agent',
      chatId: 'oc_dev',
      trigger: 'mention',
      createdAtMs: 1000,
      lastActivityMs: 2000,
    })
    sessionEventsMap.set('sess-1', [
      {
        type: 'user/message',
        data: {
          content: [
            {
              type: 'text',
              text: '<system_reminder>\n<lark_context bot_id="dsh-agent">noisy</lark_context>\n</system_reminder>\n<user_message>\n以后架构评审请优先画表格对比\n</user_message>',
            },
          ],
        },
      } as unknown as SessionEvent,
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '好的，后续统一用表格对比。' }] } },
      } as unknown as SessionEvent,
    ])

    await dreaming.tick(new Date(2026, 10, 21, 2, 5, 0))
    expect(store.getDreamState('dsh-agent')?.status).toBe('skipped')
    expect(runTurnPrompts).toHaveLength(0)

    // 2. Next night (2026-11-22 02:10) after a 2nd session arrives -> runs Dreaming, writes clean digest to dataDir/dreaming/<botId>/
    store.upsertManagedSession({
      sessionId: 'sess-2',
      botId: 'dsh-agent',
      chatId: 'oc_dev',
      trigger: 'mention',
      createdAtMs: 3000,
      lastActivityMs: 4000,
    })
    sessionEventsMap.set('sess-2', [
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '<user_message>\n记得下周排查订单重试幂等漏洞\n</user_message>' }] },
      } as unknown as SessionEvent,
    ])

    nextDreamReply = '已更新 2 条记忆并清理 1 条过期配置说明'
    await dreaming.tick(new Date(2026, 10, 22, 2, 10, 0))

    expect(runTurnPrompts).toHaveLength(1)
    expect(runTurnPrompts[0]).toContain('核心发布约定')
    expect(runTurnPrompts[0]).not.toMatch(/Claude/i)
    expect(existsSync(join(workDir, '.local'))).toBe(false)

    const digestPath = join(dataDir, 'dreaming', 'dsh-agent', 'recent-transcripts.md')
    expect(existsSync(digestPath)).toBe(true)
    const digestContent = readFileSync(digestPath, 'utf8')
    expect(digestContent).toContain('以后架构评审请优先画表格对比')
    expect(digestContent).not.toContain('<lark_context')
    expect(archivedSessions).toHaveLength(1)

    // 3. Owner Web endpoint POST /api/lark-bridge/bots/dsh-agent/dream runs on demand; CLI token is rejected with 403.
    const cliAuth = ensureCliAuthEndpoint(dataDir, 'http://127.0.0.1:3880')
    const manager = {
      store,
      dreaming,
      cliAuth,
      listBotStatuses: () => [],
      listArchivedSessionIds: () => archivedSessions,
      sessionWebUrl: (sid: string) => `http://127.0.0.1:3880/#session=${sid}`,
    } as unknown as LarkBridgeManager
    const admitter: ConnectionAdmitter = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    const cliRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/dsh-agent/dream',
      headers: { authorization: `Bearer ${cliAuth.token}` },
    })
    expect(cliRes.status).toBe(403)

    nextDreamReply = '已核查当前代码库，无需新增记忆'
    const webRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/dsh-agent/dream',
      body: { force: true },
    })
    expect(webRes.status).toBe(200)
    expect((webRes.json.dreamState as { status: string; lastSummary: string }).status).toBe('succeeded')
    expect((webRes.json.dreamState as { lastSummary: string }).lastSummary).toContain('已核查当前代码库')
    expect(archivedSessions.length).toBeGreaterThanOrEqual(2)

    // 4. GET /api/lark-bridge/bindings exposes unified dreamSessions (both runs preserved), and DELETE removes finished entries.
    const bindingsRes = await invokeHandler(handler, { url: '/api/lark-bridge/bindings' })
    expect(bindingsRes.status).toBe(200)
    const dreamSessions = bindingsRes.json.dreamSessions as Array<Record<string, unknown>>
    expect(dreamSessions).toHaveLength(2)
    expect(dreamSessions[0]).toMatchObject({
      botId: 'dsh-agent',
      botName: '研发智能体',
      status: 'succeeded',
      summary: '已核查当前代码库，无需新增记忆',
    })
    expect(String(dreamSessions[0]?.sessionUrl)).toContain('#session=')
    expect(dreamSessions[1]).toMatchObject({
      botId: 'dsh-agent',
      status: 'succeeded',
      processedCount: 2,
      summary: '已更新 2 条记忆并清理 1 条过期配置说明',
    })

    const olderSessionId = String(dreamSessions[1]?.sessionId)
    const delRes = await invokeHandler(handler, {
      method: 'DELETE',
      url: `/api/lark-bridge/dream-sessions/${encodeURIComponent(olderSessionId)}`,
    })
    expect(delRes.status).toBe(200)
    expect(store.listDreamSessions()).toHaveLength(1)

    // Running Dreaming session cannot be deleted while active
    store.upsertDreamSession({
      sessionId: 'sess-dream-running',
      botId: 'dsh-agent',
      workspaceName: 'work',
      workingDir: workDir,
      agentPreset: 'standard',
      status: 'running',
      dateKey: '2026-11-23',
      processedCount: 1,
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })
    const delRunningRes = await invokeHandler(handler, {
      method: 'DELETE',
      url: '/api/lark-bridge/dream-sessions/sess-dream-running',
    })
    expect(delRunningRes.status).toBe(400)
  })

  it('backfills legacy dreamStates and auditEvents once, recovers interrupted running records, and never resurrects deleted entries', () => {
    const dataDir = makeTempDir()
    const legacyState = {
      version: 3,
      bots: [
        {
          id: 'bot-legacy',
          name: '老版本智能体',
          enabled: true,
          larkAppId: 'cli_legacy',
          larkAppSecret: 'sec_legacy',
          defaultWorkingDir: '~',
          agentPreset: 'standard',
        },
      ],
      groups: [],
      bindings: [],
      managedSessions: [],
      dreamStates: [
        {
          botId: 'bot-legacy',
          status: 'succeeded',
          lastDreamAtMs: 1_760_000_000_000,
          lastCheckedDateKey: '2026-11-23',
          lastSessionId: 'session-legacy-latest',
          lastProcessedCount: 9,
          lastSummary: '已整理 9 个会话 · 已完成只读核查',
          processedSessionIds: ['s1'],
        },
      ],
      listenerTemplates: [],
      scheduleBindings: [],
      hourlyBuckets: [],
      botMetrics: [],
      groupTraffic: [],
      auditEvents: [
        {
          id: 'ev-latest',
          timestampMs: 1_760_000_000_000,
          botId: 'bot-legacy',
          botName: '老版本智能体',
          sessionId: 'session-legacy-latest',
          durationMs: 4200,
          kind: 'lifecycle',
          summary: 'Dreaming 完成：已整理 9 个会话',
        },
        {
          id: 'ev-older',
          timestampMs: 1_759_900_000_000,
          botId: 'bot-legacy',
          botName: '老版本智能体',
          sessionId: 'session-legacy-older',
          durationMs: 3100,
          kind: 'lifecycle',
          summary: 'Dreaming 完成：已整理 3 个会话',
        },
      ],
    }
    writeFileSync(join(dataDir, 'lark-bridge-state.json'), JSON.stringify(legacyState, null, 2), 'utf8')

    // First load migrates both latest dreamState and older auditEvent without duplicating latest
    const store1 = new LarkBridgeStore(dataDir)
    const sessions1 = store1.listDreamSessions()
    expect(sessions1).toHaveLength(2)
    expect(sessions1[0]).toMatchObject({
      sessionId: 'session-legacy-latest',
      processedCount: 9,
      summary: '已完成只读核查',
      status: 'succeeded',
    })
    expect(sessions1[1]).toMatchObject({
      sessionId: 'session-legacy-older',
      processedCount: 3,
      durationMs: 3100,
      status: 'succeeded',
    })

    // Deleting a backfilled entry persists and must NOT resurrect on reload
    expect(store1.deleteDreamSession('session-legacy-older')).toBe(true)
    store1.upsertDreamSession({
      sessionId: 'session-interrupted',
      botId: 'bot-legacy',
      workspaceName: 'demo',
      workingDir: '~',
      agentPreset: 'standard',
      status: 'running',
      dateKey: '2026-11-23',
      processedCount: 1,
      createdAtMs: 1_760_100_000_000,
      lastActivityMs: 1_760_100_000_000,
    })

    const store2 = new LarkBridgeStore(dataDir)
    const sessions2 = store2.listDreamSessions()
    expect(sessions2.map((s) => s.sessionId)).toEqual(['session-interrupted', 'session-legacy-latest'])
    expect(sessions2[0]).toMatchObject({
      sessionId: 'session-interrupted',
      status: 'failed',
      summary: '执行因服务重启中断',
    })
  })
})
