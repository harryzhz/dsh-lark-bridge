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
import { MemoryService } from '../src/memory-service.js'
import { ProactiveReminderService } from '../src/reminder-service.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { RuntimeConcurrencyLimiter } from '../src/runtime-concurrency.js'
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

    // Stage 1 (ingest) + Stage 3 (proactive open-loop audit) run as separate turns
    expect(runTurnPrompts).toHaveLength(2)
    expect(runTurnPrompts[0]).toContain('核心发布约定')
    expect(runTurnPrompts[0]).not.toMatch(/Claude/i)
    expect(runTurnPrompts[1]).toContain('open-loops-snapshot.md')
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
    store1.upsertDreamState({
      botId: 'bot-legacy',
      status: 'running',
      lastSummary: '正在整理…',
      processedSessionIds: [],
    })
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
    expect(store2.getDreamState('bot-legacy')).toMatchObject({
      status: 'failed',
      lastSummary: '执行因服务重启中断',
    })
  })

  it('paginates persisted sessions past 120 events, filters silent listener noise, folds duplicate alerts, prioritizes mentions FIFO, and scopes activeWorkingDirs', async () => {
    const dataDir = makeTempDir()
    const parentDir = makeTempDir()
    const subRepoDir = join(parentDir, 'service-a')
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'ops-bot',
      name: 'OpsBot',
      enabled: true,
      larkAppId: 'cli_ops',
      larkAppSecret: 'sec_ops',
      defaultWorkingDir: parentDir,
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '02:00',
          minNewSessions: 2,
          scopes: ['踩坑与排障经验'],
          cleanupAndCorrect: true,
        },
      },
    })
    store.upsertGroup({
      botId: 'ops-bot',
      chatId: 'oc_alert',
      chatName: '服务告警群',
      enabled: true,
      workingDir: subRepoDir,
    })

    // Build a persisted 260-event session where the first 250 events are tool calls and the final reply is at event #259!
    const longEvents: SessionEvent[] = [
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '<user_message>\n检查超时根因\n</user_message>' }] },
      } as unknown as SessionEvent,
      ...Array.from({ length: 250 }, (_, idx) => ({
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'tool-call', id: `tc_${idx}`, name: 'bash', arguments: '{}' }],
          },
        },
      })) as unknown as SessionEvent[],
      {
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'text', text: '根因已定位：连接池耗尽导致尾部 P99 抖动。' }],
          },
        },
      } as unknown as SessionEvent,
    ]

    const persistedLogs = new Map<string, { cwd: string; events: SessionEvent[] }>([
      ['sess-long-mention', { cwd: subRepoDir, events: longEvents }],
      [
        'sess-silent-listener',
        {
          cwd: subRepoDir,
          events: [
            {
              type: 'user/message',
              data: { content: [{ type: 'text', text: '<user_message>\n收到辛苦了\n</user_message>' }] },
            } as unknown as SessionEvent,
            {
              type: 'tool/call',
              data: { name: 'bash', arguments: '{"command":"lark-bridge silence --reason \\"闲聊\\""}' },
            } as unknown as SessionEvent,
            {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: '<no_reply/>' }] } },
            } as unknown as SessionEvent,
          ],
        },
      ],
      [
        'sess-alert-1',
        {
          cwd: subRepoDir,
          events: [
            {
              type: 'user/message',
              data: { content: [{ type: 'text', text: '<user_message>\n[warning] CronJob failed 2026-11-23 17:40 val: 2\n</user_message>' }] },
            } as unknown as SessionEvent,
            {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: '已核查定时任务重试状态。' }] } },
            } as unknown as SessionEvent,
          ],
        },
      ],
      [
        'sess-alert-2',
        {
          cwd: subRepoDir,
          events: [
            {
              type: 'user/message',
              data: { content: [{ type: 'text', text: '<user_message>\n[warning] CronJob failed 2026-11-23 17:50 val: 3\n</user_message>' }] },
            } as unknown as SessionEvent,
            {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: '任务持续失败，建议值班介入。' }] } },
            } as unknown as SessionEvent,
          ],
        },
      ],
    ])

    // Insert sessions with newer listener noise and older high-value mention
    store.upsertManagedSession({
      sessionId: 'sess-long-mention',
      botId: 'ops-bot',
      chatId: 'oc_alert',
      trigger: 'mention',
      createdAtMs: 1000,
      lastActivityMs: 1000,
    })
    store.upsertManagedSession({
      sessionId: 'sess-alert-1',
      botId: 'ops-bot',
      chatId: 'oc_alert',
      trigger: 'listener',
      createdAtMs: 2000,
      lastActivityMs: 2000,
    })
    store.upsertManagedSession({
      sessionId: 'sess-alert-2',
      botId: 'ops-bot',
      chatId: 'oc_alert',
      trigger: 'listener',
      createdAtMs: 3000,
      lastActivityMs: 3000,
    })
    store.upsertManagedSession({
      sessionId: 'sess-silent-listener',
      botId: 'ops-bot',
      chatId: 'oc_alert',
      trigger: 'listener',
      createdAtMs: 4000,
      lastActivityMs: 4000,
    })

    const runPrompts: string[] = []
    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: { get: () => undefined },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = { session: { id: sessionId, header: { cwd: parentDir, agentPreset: 'codex' } } }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: (key: string) => {
        if (key === 'sessionPersistence') {
          return {
            open: async (sid: string) => {
              const rec = persistedLogs.get(String(sid))
              if (!rec) throw new Error('not found')
              return {
                header: { cwd: rec.cwd },
                read: async (offset = 0, limit = 200) => ({
                  events: rec.events.slice(offset, offset + limit),
                }),
                close: async () => {},
              }
            },
          }
        }
        return undefined
      },
    } as unknown as Context

    const dreaming = new DreamingService({
      ctx: fakeCtx,
      dataDir,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(async (_agent, content) => {
        runPrompts.push(content.map((b) => ('text' in b ? b.text : '')).join('\n'))
        return '已完成记忆整理'
      }),
    })

    const res = await dreaming.runForBot('ops-bot', { force: false, now: new Date(2026, 10, 24, 2, 5, 0) })
    expect(res.status).toBe('succeeded')
    // 1 mention + 1 folded alert group = 2 substantive digest entries (silent listener filtered out!)
    expect(res.lastProcessedCount).toBe(2)
    // All 4 sessions (including silent listener and folded duplicate) are retired in watermark
    expect(res.processedSessionIds).toEqual(
      expect.arrayContaining(['sess-long-mention', 'sess-alert-1', 'sess-alert-2', 'sess-silent-listener']),
    )

    const digest = readFileSync(join(dataDir, 'dreaming', 'ops-bot', 'recent-transcripts.md'), 'utf8')
    // Tail reply past event #120 MUST be preserved!
    expect(digest).toContain('根因已定位：连接池耗尽导致尾部 P99 抖动')
    // Silent listener chatter MUST be excluded from digest
    expect(digest).not.toContain('收到辛苦了')
    // Duplicate alert MUST be folded with count annotation, and mention comes first
    expect(digest).toContain('同主题重复 2 次已折叠')
    expect(digest.indexOf('sess-long-mention')).toBeLessThan(digest.indexOf('sess-alert-2'))

    // Prompt directs git inspection specifically to active subRepoDir instead of blindly scanning parentDir
    expect(runPrompts[0]).toContain(subRepoDir)
    expect(runPrompts[0]).toContain('勿盲目遍历无关仓库')
  })

  it('tracks real Memory mutations during Auto-Dream and rejects false-positive succeeded status when runtime reports memory write failure', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)
    const memory = new MemoryService(dataDir, store)

    store.upsertBot({
      id: 'dream-mem-bot',
      name: '记忆整理助手',
      enabled: true,
      larkAppId: 'cli_dream_mem',
      larkAppSecret: 'sec_dream_mem',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '02:00',
          minNewSessions: 1,
          scopes: ['踩坑与排障经验'],
          cleanupAndCorrect: true,
        },
      },
    })

    const oldEntry = memory.upsert({
      botId: 'dream-mem-bot',
      type: 'project',
      title: '旧限流阈值',
      content: '默认限流 100 QPS',
    }).entry

    store.upsertManagedSession({
      sessionId: 'sess-dream-src-1',
      botId: 'dream-mem-bot',
      chatId: 'oc_team',
      trigger: 'mention',
      createdAtMs: 1000,
      lastActivityMs: 2000,
    })

    const sessionEvents: SessionEvent[] = [
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '<user_message>\n接口限流已调整为 500 QPS\n</user_message>' }] },
      } as unknown as SessionEvent,
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '收到，已记录限流改为 500 QPS。' }] } },
      } as unknown as SessionEvent,
    ]

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: {
        get: (id: string) =>
          id === 'sess-dream-src-1'
            ? ({ id, snapshotEvents: () => sessionEvents } as unknown as Session)
            : undefined,
      },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = { session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } } }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    let runMode: 'fail_write' | 'real_write' = 'fail_write'
    const capturedPrompts: string[] = []
    const dreaming = new DreamingService({
      ctx: fakeCtx,
      dataDir,
      store,
      memory,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(async (_agent, content) => {
        const promptText = content.map((b) => ('text' in b ? b.text : '')).join('\n')
        capturedPrompts.push(promptText)
        if (runMode === 'fail_write') {
          return '当前运行时未暴露可写内置 Memory 接口，记忆写入与历史清理未完成。'
        }
        if (promptText.includes('stage="deep_consolidate"')) {
          return '全库核验健康，无需额外变更。'
        }
        memory.supersede(oldEntry.id, {
          reason: '2026-11-24 已调高至 500 QPS',
          replacement: {
            type: 'project',
            title: '新限流阈值 500 QPS',
            content: '2026-11-24 起核心接口默认限流提升至 500 QPS。',
          },
        })
        return '已完成 1 条记忆纠偏，将限流阈值更新为 500 QPS。'
      }),
    })

    // 1. When runtime reports inability to write memory with 0 real mutations -> MUST mark failed & NOT advance watermark!
    const failedState = await dreaming.runForBot('dream-mem-bot', {
      force: false,
      now: new Date(2026, 10, 24, 2, 5, 0),
    })
    expect(failedState.status).toBe('failed')
    expect(failedState.processedSessionIds).not.toContain('sess-dream-src-1')
    expect(capturedPrompts[0]).toContain('lark-bridge memory upsert')
    expect(capturedPrompts[0]).toContain(memory.memoryMarkdownPath('dream-mem-bot'))

    // 2. Retry with real Memory writes -> succeeds, records exact memoryStats & advances watermark!
    runMode = 'real_write'
    const okState = await dreaming.runForBot('dream-mem-bot', {
      force: true,
      now: new Date(2026, 10, 24, 2, 10, 0),
    })
    expect(okState.status).toBe('succeeded')
    expect(okState.processedSessionIds).toContain('sess-dream-src-1')
    expect(okState.lastSummary).toContain('新增 1')
    expect(okState.lastSummary).toContain('纠偏 1')

    const latestDream = store.listDreamSessions('dream-mem-bot')[0]
    expect(latestDream?.outcome).toBe('memory_updated')
    expect(latestDream?.memoryStats).toMatchObject({ created: 1, superseded: 1 })
  })

  it('preserves multi-turn listener sessions whose earlier turn gave a substantive reply even if a later turn used lark-bridge silence', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)
    store.upsertBot({
      id: 'dream-multi-bot',
      name: 'MultiBot',
      enabled: true,
      larkAppId: 'cli_multi',
      larkAppSecret: 'sec_multi',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '02:00',
          minNewSessions: 1,
          scopes: ['踩坑与排障经验'],
          cleanupAndCorrect: true,
        },
      },
    })
    store.upsertManagedSession({
      sessionId: 'sess-multi-silence',
      botId: 'dream-multi-bot',
      chatId: 'oc_multi',
      routeKey: 'cli_multi:oc_multi:om_1',
      trigger: 'listener',
      createdAtMs: Date.now() - 10_000,
      lastActivityMs: Date.now() - 5_000,
    })

    const eventsBySession = new Map<string, SessionEvent[]>([
      [
        'sess-multi-silence',
        [
          { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent,
          {
            type: 'user/message',
            data: { content: [{ type: 'text', text: '线上接口 P95 飙升了，帮忙查下' }] },
          } as unknown as SessionEvent,
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '已定位到数据库连接池耗尽，建议调大上限。' }] } },
          } as unknown as SessionEvent,
          { type: 'turn/start', data: { turn: 2 } } as unknown as SessionEvent,
          {
            type: 'user/message',
            data: { content: [{ type: 'text', text: '收到谢谢，我去改配置' }] },
          } as unknown as SessionEvent,
          {
            type: 'tool/call',
            data: { name: 'bash', arguments: '{"command":"lark-bridge silence --reason ack"}' },
          } as unknown as SessionEvent,
          {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: '已静默，无需打扰。' }] } },
          } as unknown as SessionEvent,
        ],
      ],
    ])

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: {
        get: (sid: string) =>
          eventsBySession.has(sid)
            ? { id: sid, header: { cwd: workDir }, snapshotEvents: () => eventsBySession.get(sid)! }
            : undefined,
      },
      agents: {
        listPresets: () => [{ id: 'standard', name: 'Standard', defaultModel: 'mock-model' }],
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => Promise<void> | void }) => {
          const agent = {
            session: {
              id: sessionId,
              header: { cwd: workDir },
              append: vi.fn(),
              snapshotEvents: () => [],
            },
          }
          await setup?.(fakeCtx, agent)
          return {
            agent,
            dispose: vi.fn().mockResolvedValue(undefined),
          }
        }),
      },
      llm: {
        listProviders: () => [{ id: 'mock', name: 'Mock' }],
        listModels: async () => [{ id: 'mock-model', name: 'Mock Model' }],
      },
      get: () => undefined,
    } as unknown as Context

    const dreaming = new DreamingService({
      ctx: fakeCtx,
      dataDir,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(async () => '已整理 1 条排障经验。'),
    })

    const state = await dreaming.runForBot('dream-multi-bot', {
      force: false,
      now: new Date(2026, 10, 25, 2, 5, 0),
    })
    expect(state.status).toBe('succeeded')
    expect(state.lastProcessedCount).toBe(1)
    expect(state.processedSessionIds).toContain('sess-multi-silence')
  })

  it('preserves speaker open_id/thread metadata with head+tail budgeting, enforces maxRemindersPerRun hard cap, defers overnight reminders to daytime, and writes DREAMS.md', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)
    const memory = new MemoryService(dataDir, store)

    store.upsertBot({
      id: 'night-bot',
      name: '夜间深度助手',
      enabled: true,
      larkAppId: 'cli_night',
      larkAppSecret: 'sec_night',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '03:00',
          minNewSessions: 1,
          maxSessionsPerRun: 0,
          maxCharsPerSession: 1200,
          maxRemindersPerRun: 2,
          deepConsolidation: true,
          scopes: ['踩坑与排障经验', '未完成待办'],
          cleanupAndCorrect: true,
        },
        proactive: {
          remindersEnabled: true,
          reminderCreationMode: 'silent',
          quietHoursEnabled: false,
          quietHoursStart: '00:00',
          quietHoursEnd: '08:00',
          autoCodeEnabled: false,
          branchPrefix: 'agent/',
        },
      },
    })

    // Seed an existing memory so Stage 2 deep audit runs too.
    memory.upsert({
      botId: 'night-bot',
      type: 'project',
      title: '缓存过期策略',
      content: '默认 10 分钟过期。',
      tags: ['cache'],
    })

    store.upsertManagedSession({
      sessionId: 'sess-unfinished',
      botId: 'night-bot',
      chatId: 'oc_dev_team',
      trigger: 'mention',
      createdAtMs: Date.UTC(2026, 10, 26, 10, 0, 0),
      lastActivityMs: Date.UTC(2026, 10, 26, 12, 0, 0),
    })

    const longSessionEvents: SessionEvent[] = [
      {
        type: 'user/message',
        data: {
          content: [
            {
              type: 'text',
              text: [
                '<system_reminder>',
                '<lark_context bot_id="night-bot" chat_type="group" chat_id="oc_dev_team" chat_name="核心研发群" trigger="mention" message_id="om_tail_1" thread_id="om_root_99" sender_open_id="ou_alex" sender_name="林晓" sender_type="user">',
                '提及成员：陈明(open_id="ou_chen")',
                '</lark_context>',
                '</system_reminder>',
                '<user_message>',
                '开头诉求：排查支付网关偶发 502',
                '</user_message>',
              ].join('\n'),
            },
          ],
        },
      } as unknown as SessionEvent,
      ...Array.from({ length: 8 }, (_, idx) => ({
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'text', text: `中间排查日志 ${idx + 1}：${'a'.repeat(300)}` }],
          },
        },
      })) as unknown as SessionEvent[],
      {
        type: 'assistant/message',
        data: { interrupted: true, message: { content: [] } },
      } as unknown as SessionEvent,
      {
        type: 'user/message',
        data: {
          content: [
            {
              type: 'text',
              text: '<user_message>\n收尾承诺：明天上午记得复测灰度超时配置\n</user_message>',
            },
          ],
        },
      } as unknown as SessionEvent,
    ]

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: {
        get: (id: string) =>
          id === 'sess-unfinished'
            ? ({ id, header: { cwd: workDir }, snapshotEvents: () => longSessionEvents } as unknown as Session)
            : undefined,
      },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => Promise<void> | void }) => {
          const agent = {
            session: { id: sessionId, header: { cwd: workDir, agentPreset: 'standard' } },
          }
          await setup?.(fakeCtx, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const runtimes = new RuntimeCatalog(fakeCtx)
    const workspaces = {
      attachSession: vi.fn().mockResolvedValue(undefined),
      archiveSession: vi.fn().mockResolvedValue(true),
    } as unknown as WorkspaceGrouping
    const runtimeLimiter = new RuntimeConcurrencyLimiter(2)

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes,
      workspaces,
      memory,
      runtimeLimiter,
      runTurn: vi.fn(async () => 'done'),
      sendOriginCard: vi.fn(async () => ({ messageId: 'om_card' })),
      patchOriginCard: vi.fn(async () => {}),
      deliverReminderOutput: vi.fn(async () => {}),
    })

    const runNow = new Date(2026, 10, 27, 3, 5, 0)
    const stagesSeen: string[] = []
    let capRejectionMessage = ''

    const dreaming = new DreamingService({
      ctx: fakeCtx,
      dataDir,
      store,
      memory,
      getReminders: () => reminders,
      runtimes,
      workspaces,
      runtimeLimiter,
      runTurn: vi.fn(async (agent, content) => {
        const text = content.map((b) => ('text' in b ? b.text : '')).join('\n')
        const sid = (agent as unknown as { session: { id: string } }).session.id
        if (text.includes('stage="ingest"')) {
          stagesSeen.push('ingest')
          return '增量记忆整理完成。未闭环线索：复测灰度超时配置。'
        }
        if (text.includes('stage="deep_consolidate"')) {
          stagesSeen.push('deep_consolidate')
          return '全库核验健康，无需额外变更。'
        }
        if (text.includes('stage="proactive_audit"')) {
          stagesSeen.push('proactive_audit')
          // Attempt 1: scheduled at 03:30 -> must be silently created AND auto-deferred to 08:00 despite bot quietHoursEnabled=false
          await reminders.create(
            {
              sessionId: sid,
              botId: 'night-bot',
              chatId: 'oc_dev_team',
              replyToMessageId: 'om_root_99',
              title: '复测灰度超时配置',
              prompt: '核查灰度超时配置是否已验证完成',
              at: '2026-11-27 03:30',
              mentions: [{ openId: 'ou_alex', name: '林晓' }],
            },
            runNow.getTime(),
          )
          // Attempt 2: second reminder (different thread) succeeds within cap=2
          await reminders.create(
            {
              sessionId: sid,
              botId: 'night-bot',
              chatId: 'oc_dev_team',
              title: '复核连接池指标',
              prompt: '确认连接池上限调整生效',
              at: '2026-11-27 10:00',
              mentions: [{ openId: 'ou_chen', name: '陈明' }],
            },
            runNow.getTime(),
          )
          // Attempt 3: exceeds maxRemindersPerRun=2 -> MUST throw hard cap error!
          try {
            await reminders.create(
              {
                sessionId: sid,
                botId: 'night-bot',
                chatId: 'oc_dev_team',
                title: '超限的第三条提醒',
                prompt: '不应被创建',
                at: '2026-11-27 10:30',
                mentions: [{ openId: 'ou_alex', name: '林晓' }],
              },
              runNow.getTime(),
            )
          } catch (err) {
            capRejectionMessage = err instanceof Error ? err.message : String(err)
          }
          return '已核查未闭环事项并创建 2 条白天跟进提醒。'
        }
        return 'ok'
      }),
    })

    const state = await dreaming.runForBot('night-bot', { force: false, now: runNow })
    expect(state.status).toBe('succeeded')
    expect(stagesSeen).toEqual(['ingest', 'deep_consolidate', 'proactive_audit'])
    expect(capRejectionMessage).toContain('单次提醒创建上限（2 条）')
    expect(state.proactiveStats).toMatchObject({
      batchesRun: 1,
      backlogRemaining: 0,
      remindersCreated: 2,
      deepConsolidated: true,
      openLoopsAudited: true,
    })

    // Check digest preserved speaker open_id, thread_reply_to, interrupted flag, and head+tail lines
    const digest = readFileSync(join(dataDir, 'dreaming', 'night-bot', 'recent-transcripts.md'), 'utf8')
    expect(digest).toContain('thread_reply_to=om_root_99')
    expect(digest).toContain('状态:曾中断')
    expect(digest).toContain('林晓(open_id="ou_alex")')
    expect(digest).toContain('开头诉求：排查支付网关偶发 502')
    expect(digest).toContain('收尾承诺：明天上午记得复测灰度超时配置')

    // Check open-loops snapshot, memory audit, and DREAMS.md journal were generated
    const snapshot = readFileSync(join(dataDir, 'dreaming', 'night-bot', 'open-loops-snapshot.md'), 'utf8')
    expect(snapshot).toContain('[曾中断会话]')
    expect(existsSync(join(dataDir, 'dreaming', 'night-bot', 'memory-audit.md'))).toBe(true)
    const journal = readFileSync(join(dataDir, 'dreaming', 'night-bot', 'DREAMS.md'), 'utf8')
    expect(journal).toContain('新建提醒 2 条')
    expect(journal).toContain('复测灰度超时配置')

    // Verify first reminder was silently scheduled and deferred from 03:30 to daytime 08:00
    const createdReminders = store.listReminders('active')
    expect(createdReminders).toHaveLength(2)
    const deferredOne = createdReminders.find((r) => r.title === '复测灰度超时配置')
    expect(deferredOne?.status).toBe('scheduled')
    expect(deferredOne?.deferredFromScheduledAt).toBeDefined()
    expect(new Date(deferredOne!.scheduledAt).getHours()).toBe(8)
    expect(deferredOne?.origin.replyToMessageId).toBe('om_root_99')
  })

  it('drains all unprocessed sessions across multiple batches by default (maxSessionsPerRun=0), respects explicit caps, and applies dedicated overnight Dreaming model', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'backlog-bot',
      name: '积压排空助手',
      enabled: true,
      larkAppId: 'cli_backlog',
      larkAppSecret: 'sec_backlog',
      defaultWorkingDir: workDir,
      model: 'fast-day-model',
      reasoningEffort: 'low',
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '03:00',
          minNewSessions: 1,
          maxSessionsPerRun: 5,
          maxCharsPerSession: 5000,
          maxRemindersPerRun: 0,
          deepConsolidation: false,
          model: 'deep-night-model',
          reasoningEffort: 'xhigh',
          scopes: ['项目领域知识'],
          cleanupAndCorrect: true,
        },
        proactive: {
          remindersEnabled: false,
          reminderCreationMode: 'silent',
          autoCodeEnabled: false,
          branchPrefix: 'agent/',
        },
      },
    })

    const eventsBySession = new Map<string, SessionEvent[]>()
    for (let i = 1; i <= 22; i += 1) {
      const sid = `sess-b-${String(i).padStart(2, '0')}`
      store.upsertManagedSession({
        sessionId: sid,
        botId: 'backlog-bot',
        chatId: 'oc_team',
        trigger: 'mention',
        createdAtMs: i * 1000,
        lastActivityMs: i * 1000 + 500,
      })
      eventsBySession.set(sid, [
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: `<user_message>\n待整理事项 #${i}\n</user_message>` }] },
        } as unknown as SessionEvent,
      ])
    }

    const createdModels: Array<{ model?: string; reasoningEffort?: string }> = []
    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: {
        get: (id: string) =>
          eventsBySession.has(id)
            ? ({ id, header: { cwd: workDir }, snapshotEvents: () => eventsBySession.get(id)! } as unknown as Session)
            : undefined,
      },
      agents: {
        listPresets: () => [{ id: 'standard', name: 'Standard', defaultModel: 'fast-day-model' }],
        create: vi.fn(async ({ sessionId, agentOptions, setup }: {
          sessionId: string
          agentOptions?: { model?: string; reasoningEffort?: string }
          setup?: (c: unknown, a: unknown) => Promise<void> | void
        }) => {
          createdModels.push({
            ...(agentOptions?.model ? { model: agentOptions.model } : {}),
            ...(agentOptions?.reasoningEffort ? { reasoningEffort: agentOptions.reasoningEffort } : {}),
          })
          const agent = { session: { id: sessionId, header: { cwd: workDir } } }
          await setup?.(fakeCtx, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      llm: {
        listProviders: () => [{ id: 'mock', name: 'Mock' }],
        listModels: async () => [
          { id: 'fast-day-model', name: 'Fast Day' },
          { id: 'deep-night-model', name: 'Deep Night' },
        ],
      },
      get: () => undefined,
    } as unknown as Context

    const dreaming = new DreamingService({
      ctx: fakeCtx,
      dataDir,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(async () => '批次整理完成'),
    })

    // 1. With maxSessionsPerRun=5 -> processes 5 sessions, reports 17 remaining, and uses dedicated night model
    const capped = await dreaming.runForBot('backlog-bot', {
      force: true,
      now: new Date(2026, 10, 27, 3, 5, 0),
    })
    expect(capped.status).toBe('succeeded')
    expect(capped.lastProcessedCount).toBe(5)
    expect(capped.proactiveStats).toMatchObject({ batchesRun: 1, backlogRemaining: 17 })
    expect(createdModels[0]).toEqual({ model: 'deep-night-model', reasoningEffort: 'xhigh' })

    // 2. Switch maxSessionsPerRun=0 (all unprocessed) -> drains remaining 17 sessions across 2 batches (15 + 2)
    const botCfg = store.getBot('backlog-bot')!
    store.upsertBot({
      ...botCfg,
      experimental: {
        ...botCfg.experimental,
        dreaming: { ...botCfg.experimental.dreaming, maxSessionsPerRun: 0 },
      },
    })
    const drained = await dreaming.runForBot('backlog-bot', {
      force: true,
      now: new Date(2026, 10, 28, 3, 5, 0),
    })
    expect(drained.status).toBe('succeeded')
    expect(drained.lastProcessedCount).toBe(17)
    expect(drained.proactiveStats).toMatchObject({ batchesRun: 2, backlogRemaining: 0 })
    expect(drained.processedSessionIds).toHaveLength(22)
  })
})
