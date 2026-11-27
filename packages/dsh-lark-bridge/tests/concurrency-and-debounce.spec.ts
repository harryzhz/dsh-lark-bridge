import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  type InboundLarkMessage,
  type LarkBotTransport,
} from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { ListenerDebounceBuffer } from '../src/listener-debounce.js'
import {
  RuntimeConcurrencyLimiter,
  buildRuntimeConcurrencyKey,
} from '../src/runtime-concurrency.js'
import { CONFIG_SNAPSHOT_FILENAME } from '../src/storage/database.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-p0-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeToolCallStream(args: Record<string, unknown>): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc_1' as never,
          name: 'route_message',
          arguments: JSON.stringify(args),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
}

describe('RuntimeConcurrencyLimiter', () => {
  it('bounds concurrency per runtime independently and prioritizes interactive over background turns', async () => {
    const limiter = new RuntimeConcurrencyLimiter(1)

    const lease1 = await limiter.acquire({ runtimeKey: 'codex', priority: 'background' })
    expect(lease1).toBeDefined()
    expect(lease1!.waitMs).toBe(0)

    // A separate runtime preset does not block on codex
    const otherLease = await limiter.acquire({ runtimeKey: 'agy', priority: 'background' })
    expect(otherLease).toBeDefined()
    expect(otherLease!.waitMs).toBe(0)

    const order: string[] = []
    const bgWaiter = limiter
      .acquire({ runtimeKey: 'codex', priority: 'background' })
      .then((lease) => {
        order.push('background-1')
        return lease
      })
    const bgWaiter2 = limiter
      .acquire({ runtimeKey: 'codex', priority: 'background' })
      .then((lease) => {
        order.push('background-2')
        return lease
      })
    const interactiveWaiter = limiter
      .acquire({ runtimeKey: 'codex', priority: 'interactive' })
      .then((lease) => {
        order.push('interactive-1')
        return lease
      })

    expect(limiter.getStats()).toEqual({
      maxPerRuntime: 1,
      active: 2,
      queued: 3,
      byRuntime: {
        codex: { active: 1, queued: 3 },
        agy: { active: 1, queued: 0 },
      },
    })

    // Release codex slot -> interactive waiter jumps ahead of queued background turns
    lease1!.release()
    const iLease = await interactiveWaiter
    expect(iLease).toBeDefined()
    expect(order).toEqual(['interactive-1'])

    // Release again -> FIFO within background tier
    iLease!.release()
    const b1Lease = await bgWaiter
    expect(b1Lease).toBeDefined()
    expect(order).toEqual(['interactive-1', 'background-1'])

    b1Lease!.release()
    const b2Lease = await bgWaiter2
    expect(b2Lease).toBeDefined()
    expect(order).toEqual(['interactive-1', 'background-1', 'background-2'])

    b2Lease!.release()
    otherLease!.release()
    expect(limiter.getStats().active).toBe(0)
    expect(limiter.getStats().queued).toBe(0)
  })

  it('cancels aborted waiters without leaking permits and supports unlimited mode (0)', async () => {
    const limiter = new RuntimeConcurrencyLimiter(1)
    const first = await limiter.acquire({ runtimeKey: 'codex', priority: 'background' })
    const abortCtrl = new AbortController()
    const cancelledWait = limiter.acquire({
      runtimeKey: 'codex',
      priority: 'background',
      signal: abortCtrl.signal,
    })
    const liveWait = limiter.acquire({ runtimeKey: 'codex', priority: 'background' })

    abortCtrl.abort()
    expect(await cancelledWait).toBeUndefined()
    expect(limiter.getStats().queued).toBe(1)

    first!.release()
    const liveLease = await liveWait
    expect(liveLease).toBeDefined()
    liveLease!.release()
    expect(limiter.getStats().active).toBe(0)

    const unlimited = new RuntimeConcurrencyLimiter(0)
    const [a, b, c] = await Promise.all([
      unlimited.acquire({ runtimeKey: 'codex', priority: 'background' }),
      unlimited.acquire({ runtimeKey: 'codex', priority: 'background' }),
      unlimited.acquire({ runtimeKey: 'codex', priority: 'background' }),
    ])
    expect(a && b && c).toBeTruthy()
    a!.release()
    b!.release()
    c!.release()
  })

  it('supports per-runtime and per-profile overrides, inheritance, and hot limit updates', async () => {
    const limiter = new RuntimeConcurrencyLimiter(1, { codex: 2 })
    const proxyKey = buildRuntimeConcurrencyKey('codex', 'proxy-a')

    // Profile inherits base runtime override (2) until explicitly overridden
    expect(limiter.getLimit('standard')).toBe(1)
    expect(limiter.getLimit('codex')).toBe(2)
    expect(limiter.getLimit(proxyKey)).toBe(2)

    // Profile pool is independent from base runtime pool
    const base1 = await limiter.acquire({ runtimeKey: 'codex', priority: 'interactive' })
    const base2 = await limiter.acquire({ runtimeKey: 'codex', priority: 'interactive' })
    const proxy1 = await limiter.acquire({ runtimeKey: proxyKey, priority: 'interactive' })
    expect(base1 && base2 && proxy1).toBeTruthy()

    // Third turn on base codex queues
    let base3Acquired = false
    const base3Promise = limiter
      .acquire({ runtimeKey: 'codex', priority: 'interactive' })
      .then((lease) => {
        base3Acquired = true
        return lease
      })
    await Promise.resolve()
    expect(base3Acquired).toBe(false)

    // Raising codex limit hot-wakes queued base waiter without releasing active turns
    limiter.setOverride('codex', 3)
    const base3 = await base3Promise
    expect(base3Acquired).toBe(true)
    expect(base3).toBeDefined()

    // Narrow profile override to 1 -> second proxy turn queues until limit raised or switched to unlimited (0)
    limiter.setOverride(proxyKey, 1)
    expect(limiter.getLimit(proxyKey)).toBe(1)
    let proxy2Acquired = false
    const proxy2Promise = limiter
      .acquire({ runtimeKey: proxyKey, priority: 'interactive' })
      .then((lease) => {
        proxy2Acquired = true
        return lease
      })
    await Promise.resolve()
    expect(proxy2Acquired).toBe(false)

    // Switching profile override to unlimited (0) wakes waiter immediately AND still tracks active count
    limiter.setOverride(proxyKey, 0)
    const proxy2 = await proxy2Promise
    expect(proxy2Acquired).toBe(true)
    expect(limiter.getStats().byRuntime[proxyKey]?.active).toBe(2)

    // Tightening from unlimited (0) back to 1 blocks a third turn while 2 remain active
    limiter.setOverride(proxyKey, 1)
    let proxy3Acquired = false
    const proxy3Promise = limiter
      .acquire({ runtimeKey: proxyKey, priority: 'interactive' })
      .then((lease) => {
        proxy3Acquired = true
        return lease
      })
    await Promise.resolve()
    expect(proxy3Acquired).toBe(false)

    // Removing profile override restores inheritance from codex (3) -> immediately wakes proxy3!
    limiter.setOverride(proxyKey, null)
    expect(limiter.getLimit(proxyKey)).toBe(3)
    const proxy3 = await proxy3Promise
    expect(proxy3Acquired).toBe(true)

    base1!.release()
    base2!.release()
    base3!.release()
    proxy1!.release()
    proxy2!.release()
    proxy3!.release()
    expect(limiter.getStats().active).toBe(0)
    expect(limiter.getStats().queued).toBe(0)
  })

  it('persists concurrency overrides in SQLite, reloads on restart, and enforces Owner-only HTTP API', async () => {
    const dataDir = makeTempDir('dsh-lark-concurrency-api-')
    const h = createBridgeHarness({
      dataDir,
      maxConcurrentTurnsPerRuntime: 3,
    })

    // Non-owner CLI / operator requests must be rejected with 403
    const cliDenied = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'PUT',
      path: '/runtimes/concurrency',
      body: { runtimeId: 'codex', maxConcurrent: 5 },
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliDenied.status).toBe(403)

    const operatorDenied = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'PUT',
      path: '/runtimes/concurrency',
      body: { runtimeId: 'codex', maxConcurrent: 5 },
      isCliAuthenticated: false,
      isOperatorAuthenticated: true,
      principalKind: 'operator',
    })
    expect(operatorDenied.status).toBe(403)

    // Bounds & input validation
    const invalidOutOfRange = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'PUT',
      path: '/runtimes/concurrency',
      body: { runtimeId: 'codex', maxConcurrent: 64 },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(invalidOutOfRange.status).toBe(400)

    const invalidFloat = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'PUT',
      path: '/runtimes/concurrency',
      body: { runtimeId: 'codex', maxConcurrent: 2.5 },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(invalidFloat.status).toBe(400)

    // Owner updates base runtime & profile limits
    const setBase = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'PUT',
      path: '/runtimes/concurrency',
      body: { runtimeId: 'codex', maxConcurrent: 6 },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(setBase.status).toBe(200)
    expect(h.manager.runtimeLimiter.getLimit('codex')).toBe(6)

    const setProfile = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'PUT',
      path: '/runtimes/concurrency',
      body: { runtimeId: 'codex', profileId: 'proxy-a', maxConcurrent: 0 },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(setProfile.status).toBe(200)
    expect(h.manager.runtimeLimiter.getLimit('codex::proxy-a')).toBe(0)

    // GET /runtimes returns concurrency snapshot
    const listRes = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'GET',
      path: '/runtimes',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(listRes.status).toBe(200)
    const listPayload = listRes.payload as {
      concurrency: { defaultLimit: number; maxLimit: number; limits: Record<string, number> }
    }
    expect(listPayload.concurrency.defaultLimit).toBe(3)
    expect(listPayload.concurrency.maxLimit).toBe(32)
    expect(listPayload.concurrency.limits).toEqual({
      codex: 6,
      'codex::proxy-a': 0,
    })

    // Snapshot & SQLite reload preserve persisted overrides across restart
    h.store.flushConfigSnapshot()
    const snapshot = JSON.parse(readFileSync(join(dataDir, CONFIG_SNAPSHOT_FILENAME), 'utf8')) as {
      runtimeConcurrencyLimits?: Record<string, number>
    }
    expect(snapshot.runtimeConcurrencyLimits).toEqual({
      codex: 6,
      'codex::proxy-a': 0,
    })
    await h.manager.stop()
    h.store.close()

    const reloadedStore = new LarkBridgeStore(dataDir)
    const reloadedManager = new LarkBridgeManager(
      h.ctx,
      {
        dataDir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
        maxConcurrentTurnsPerRuntime: 3,
      },
      reloadedStore,
    )
    expect(reloadedManager.runtimeLimiter.getLimit('codex')).toBe(6)
    expect(reloadedManager.runtimeLimiter.getLimit('codex::proxy-a')).toBe(0)

    // Resetting base override via null restores default limit (3)
    const resetRes = await dispatchLarkApiRequest(h.ctx, reloadedManager, {
      method: 'PUT',
      path: '/runtimes/concurrency',
      body: { runtimeId: 'codex', maxConcurrent: null },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(resetRes.status).toBe(200)
    expect(reloadedManager.runtimeLimiter.getLimit('codex')).toBe(3)
    expect(reloadedStore.getRuntimeConcurrencyLimits()).toEqual({ 'codex::proxy-a': 0 })

    await reloadedManager.stop()
    reloadedStore.close()
  })
})

describe('ListenerDebounceBuffer', () => {
  it('coalesces rapid consecutive messages per bucket and isolates different buckets', async () => {
    const batches: Array<readonly string[]> = []
    const buffer = new ListenerDebounceBuffer<string>(async (entries) => {
      batches.push(entries.map((e) => e.payload))
    })

    const p1 = buffer.enqueue({
      bucketKey: 'bot:oc_team:bot:listener',
      botId: 'bot',
      chatId: 'oc_team',
      messageId: 'om_1',
      debounceMs: 40,
      payload: 'alert-1',
    })
    const p2 = buffer.enqueue({
      bucketKey: 'bot:oc_team:bot:listener',
      botId: 'bot',
      chatId: 'oc_team',
      messageId: 'om_2',
      debounceMs: 40,
      payload: 'alert-2',
    })
    const p3 = buffer.enqueue({
      bucketKey: 'bot:oc_team:user:listener',
      botId: 'bot',
      chatId: 'oc_team',
      messageId: 'om_3',
      debounceMs: 40,
      payload: 'user-msg',
    })

    await Promise.all([p1, p2, p3])
    expect(batches).toHaveLength(2)
    expect(batches).toContainEqual(['alert-1', 'alert-2'])
    expect(batches).toContainEqual(['user-msg'])
  })

  it('drops recalled messages or disabled scopes cleanly before flushing', async () => {
    const flushed: string[][] = []
    const buffer = new ListenerDebounceBuffer<string>(async (entries) => {
      flushed.push(entries.map((e) => e.payload))
    })

    const p1 = buffer.enqueue({
      bucketKey: 'bot:oc_a:user:listener',
      botId: 'bot',
      chatId: 'oc_a',
      messageId: 'om_drop',
      debounceMs: 80,
      payload: 'drop-me',
    })
    const p2 = buffer.enqueue({
      bucketKey: 'bot:oc_a:user:listener',
      botId: 'bot',
      chatId: 'oc_a',
      messageId: 'om_keep',
      debounceMs: 80,
      payload: 'keep-me',
    })
    expect(buffer.cancelMessage('bot', 'om_drop')).toBe(true)

    const p3 = buffer.enqueue({
      bucketKey: 'bot:oc_b:user:listener',
      botId: 'bot',
      chatId: 'oc_b',
      messageId: 'om_b1',
      debounceMs: 80,
      payload: 'disabled-chat',
    })
    expect(buffer.cancelScope('bot', 'oc_b')).toBe(1)

    await Promise.all([p1, p2, p3])
    expect(flushed).toEqual([['keep-me']])
    expect(buffer.pendingCount).toBe(0)
  })
})

function createBridgeHarness(options: {
  readonly dataDir?: string
  readonly maxConcurrentTurnsPerRuntime?: number
  readonly listenerDebounceOverrideMs?: number
  readonly reminderDispatchStaggerMs?: number
  readonly triageStream?: (opts: GenerateOptions) => AsyncIterable<StreamChunk>
  readonly manualTurnControl?: boolean
}) {
  const dir = options.dataDir ?? makeTempDir()
  const store = new LarkBridgeStore(dir)
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agents = new Map<string, { session: Session; followup: (msg: unknown) => void }>()
  const submittedPrompts: Array<{ sessionId: string; text: string; imageCount: number }> = []
  const triageCalls: GenerateOptions[] = []
  const pendingResolvers: Array<{ sessionId: string; resolve: (reply: string) => void }> = []
  const startedOrder: string[] = []
  let activeTurnsNow = 0
  let maxObservedActive = 0
  let turnSeq = 0

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaceRegistry') {
        return {
          list: () => [],
          archivedSessionIds: [] as string[],
          create: async (_cwd: string, title?: string) => ({
            id: 'ws-1',
            title: title ?? 'demo',
            cwd: dir,
            sessionIds: [] as string[],
            setTitle: vi.fn(),
            attachSession: vi.fn(),
          }),
          archiveSession: vi.fn().mockReturnValue(true),
        }
      }
      if (key === 'externalRuntimes') {
        return {
          list: () => [
            {
              id: 'codex',
              displayName: 'Codex',
              description: 'Codex',
              providerId: 'codex-cli',
              defaultModel: 'gpt-5-codex',
            },
          ],
          get: (id: string) =>
            id === 'codex'
              ? {
                  id: 'codex',
                  displayName: 'Codex',
                  description: 'Codex',
                  providerId: 'codex-cli',
                  defaultModel: 'gpt-5-codex',
                }
              : undefined,
          listModelsForProvider: async () => [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }],
        }
      }
      return undefined
    },
    inject: vi.fn(),
    effect: () => () => {},
    on: (name: string, fn: (session: Session, event: SessionEvent) => void) => {
      if (name === 'session/event') listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listConfigurableProviders: () => [
        { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
        inputModalities: ['text', 'image'],
      }),
      stream: (opts: GenerateOptions) => {
        triageCalls.push(opts)
        if (options.triageStream) return options.triageStream(opts)
        return makeToolCallStream({ action: 'handoff', reason: '移交核查' })
      },
    },
    sessions: { get: (id: string) => agents.get(id)?.session },
    agents: {
      get: (id: string) => agents.get(id),
      create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) => {
        const session = {
          id: opts.sessionId,
          header: { cwd: opts.meta.cwd, agentPreset: opts.meta.agentPreset },
          snapshotEvents: () => [],
        } as unknown as Session
        const agent = {
          session,
          followup: (userMsg: { id?: string; content: Array<{ type: string; text?: string }> }) => {
            const turn = ++turnSeq
            const text = userMsg.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
            const imageCount = userMsg.content.filter((b) => b.type === 'image').length
            submittedPrompts.push({ sessionId: opts.sessionId, text, imageCount })
            startedOrder.push(text)
            activeTurnsNow += 1
            if (activeTurnsNow > maxObservedActive) maxObservedActive = activeTurnsNow

            emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
            emit(session, {
              type: 'user/message',
              data: { id: userMsg.id, turn },
            } as unknown as SessionEvent)

            const finish = (replyText: string) => {
              activeTurnsNow = Math.max(0, activeTurnsNow - 1)
              emit(session, {
                type: 'assistant/message',
                data: {
                  turn,
                  message: { role: 'assistant', content: [{ type: 'text', text: replyText }] },
                },
              } as unknown as SessionEvent)
              emit(session, {
                type: 'turn/end',
                data: { turn, reason: { kind: 'completed' } },
              } as unknown as SessionEvent)
            }

            if (options.manualTurnControl) {
              pendingResolvers.push({ sessionId: opts.sessionId, resolve: finish })
            } else {
              queueMicrotask(() => finish('已排查完成'))
            }
          },
        }
        agents.set(opts.sessionId, agent)
        return {
          agent,
          dispose: vi.fn().mockResolvedValue(undefined),
        }
      },
      resume: vi.fn(),
    },
  } as unknown as Context

  const manager = new LarkBridgeManager(
    ctx,
    {
      dataDir: dir,
      publicBaseUrl: 'http://127.0.0.1:3880',
      idleSweepIntervalMs: 0,
      maxAuditEvents: 200,
      autoInstallCliAndSkill: false,
      enableInstanceLock: false,
      ...(options.maxConcurrentTurnsPerRuntime !== undefined
        ? { maxConcurrentTurnsPerRuntime: options.maxConcurrentTurnsPerRuntime }
        : {}),
      ...(options.listenerDebounceOverrideMs !== undefined
        ? { listenerDebounceOverrideMs: options.listenerDebounceOverrideMs }
        : {}),
      ...(options.reminderDispatchStaggerMs !== undefined
        ? { reminderDispatchStaggerMs: options.reminderDispatchStaggerMs }
        : {}),
    },
    store,
  )

  const sentReplies: Array<{ replyToMessageId?: string; text?: string; card?: unknown }> = []
  const downloadedResources: Array<{ messageId: string; imageKey: string }> = []
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=',
    'base64',
  )
  const fakeTransport = {
    state: { botOpenId: 'ou_bot', connected: true },
    addReaction: vi.fn().mockResolvedValue('rx_1'),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    sendReply: vi.fn(async (req: { replyToMessageId?: string; text?: string; card?: unknown }) => {
      sentReplies.push(req)
      return { messageId: `om_reply_${sentReplies.length}` }
    }),
    getCachedUserName: () => undefined,
    resolveUserSummary: vi.fn().mockResolvedValue({ name: 'Alex' }),
    downloadResourceBuffer: vi.fn(async (messageId: string, imageKey: string) => {
      downloadedResources.push({ messageId, imageKey })
      return pngBytes
    }),
  } as unknown as LarkBotTransport

  const bot = LarkBotConfigSchema.parse({
    id: 'bot-1',
    name: 'TestBot',
    larkAppId: 'cli_test',
    larkAppSecret: 'sec_test',
    defaultWorkingDir: dir,
    agentPreset: 'codex',
    useInteractiveCard: false,
    router: {
      enabled: true,
      provider: 'deepseek',
      model: 'deepseek-chat',
      scope: 'all_group',
      bypass: { senderTypes: ['bot'], msgTypes: [], keywords: [] },
      timeoutMs: 4000,
      maxTriageImages: 5,
    },
  })
  store.upsertBot(bot)
  ;(manager.connections.transports as Map<string, unknown>).set(bot.id, { transport: fakeTransport })

  return {
    dir,
    ctx,
    store,
    manager,
    bot,
    transport: fakeTransport,
    submittedPrompts,
    triageCalls,
    pendingResolvers,
    startedOrder,
    sentReplies,
    downloadedResources,
    getMaxObservedActive: () => maxObservedActive,
  }
}

function makeGroupMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-1',
    larkAppId: 'cli_test',
    botOpenId: 'ou_bot',
    messageId: 'om_msg_1',
    chatId: 'oc_team',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_alex',
    senderType: 'user',
    text: '排查一下异常',
    rawContent: '{"text":"排查一下异常"}',
    mentions: [],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

describe('InboundPipeline & ReminderService P0 integration', () => {
  it('debounces rapid alert bursts into a single worker turn and preserves per-message image references', async () => {
    const h = createBridgeHarness({ listenerDebounceOverrideMs: 45 })
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-1:oc_alert',
        botId: 'bot-1',
        chatId: 'oc_alert',
        chatName: '告警群',
        listener: {
          enabled: true,
          name: '告警排查',
          prompt: '排查告警',
          sessionMode: 'thread',
          senderTypes: ['bot'],
          msgTypes: ['interactive', 'text', 'image'],
          debounceSeconds: 5,
        },
      }),
    )

    const p1 = h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_alert_1',
        senderType: 'bot',
        senderOpenId: 'ou_alert_bot',
        msgType: 'interactive',
        text: '告警1: CPU 飙高',
        imageKeys: ['img_from_msg_1'],
      }),
    )
    const p2 = h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_alert_2',
        senderType: 'bot',
        senderOpenId: 'ou_alert_bot',
        msgType: 'interactive',
        text: '告警2: 延迟飙升',
      }),
    )
    const p3 = h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_alert_3',
        senderType: 'bot',
        senderOpenId: 'ou_alert_bot',
        msgType: 'interactive',
        text: '告警3: 错误率上升',
      }),
    )

    await Promise.all([p1, p2, p3])
    expect(h.submittedPrompts).toHaveLength(1)
    expect(h.submittedPrompts[0]!.text).toContain('告警1: CPU 飙高')
    expect(h.submittedPrompts[0]!.text).toContain('告警2: 延迟飙升')
    expect(h.submittedPrompts[0]!.text).toContain('告警3: 错误率上升')
    // Image from earlier debounced message is downloaded with its own original messageId
    expect(h.downloadedResources).toEqual([
      { messageId: 'om_alert_1', imageKey: 'img_from_msg_1' },
    ])
    expect(h.submittedPrompts[0]!.imageCount).toBe(1)

    await h.manager.stop()
  })

  it('passes active_chat_listeners to triage so concurrent follow-up chatter can be silenced before spawning a duplicate session', async () => {
    const h = createBridgeHarness({
      manualTurnControl: true,
      triageStream: (opts) => {
        const userBlocks = opts.messages[0]?.content
        const promptText = Array.isArray(userBlocks)
          ? userBlocks
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : ''
        if (promptText.includes('active_chat_listeners=')) {
          return makeToolCallStream({ action: 'silent', reason: '同群已有旁听会话处理中' })
        }
        return makeToolCallStream({ action: 'handoff', reason: '首个故障讨论，移交主运行时' })
      },
    })
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-1:oc_team',
        botId: 'bot-1',
        chatId: 'oc_team',
        chatName: '团队群',
        listener: {
          enabled: true,
          name: '工作日常',
          prompt: '关注故障排查',
          sessionMode: 'thread',
          senderTypes: ['user'],
          debounceSeconds: 0,
        },
      }),
    )

    const turn1 = h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({ messageId: 'om_first', text: 'CN 节点启动报路径缺失' }),
    )
    await vi.waitFor(() => expect(h.pendingResolvers).toHaveLength(1))

    // Second concurrent listener message arrives while first is still running
    await h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({ messageId: 'om_second', text: '我刚看了一下确实还没同步过去' }),
    )

    expect(h.triageCalls).toHaveLength(2)
    const secondPromptBlocks = h.triageCalls[1]!.messages[0]!.content as Array<{
      type: string
      text?: string
    }>
    const secondUserText = secondPromptBlocks.find((b) => b.type === 'text')?.text ?? ''
    expect(secondUserText).toContain('active_chat_listeners=1')
    expect(secondUserText).toContain('<active_chat_listeners>')
    expect(secondUserText).toContain('CN 节点启动报路径缺失')
    // Silenced by triage without creating a second worker session
    expect(h.submittedPrompts).toHaveLength(1)

    h.pendingResolvers[0]!.resolve('已完成定位')
    await turn1
    await h.manager.stop()
  })

  it('enforces per-runtime concurrency limit and lets interactive mentions jump ahead of queued alerts', async () => {
    const h = createBridgeHarness({
      maxConcurrentTurnsPerRuntime: 1,
      manualTurnControl: true,
    })
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-1:oc_alert',
        botId: 'bot-1',
        chatId: 'oc_alert',
        chatName: '告警群',
        listener: {
          enabled: true,
          name: '告警排查',
          prompt: '排查告警',
          sessionMode: 'thread',
          senderTypes: ['bot'],
          msgTypes: ['interactive', 'text'],
          debounceSeconds: 0,
        },
      }),
    )

    const pAlert1 = h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_a1',
        senderType: 'bot',
        text: 'ALERT_ONE',
      }),
    )
    await vi.waitFor(() => expect(h.pendingResolvers).toHaveLength(1))

    // Queue a second background alert, then an interactive @mention
    const pAlert2 = h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_a2',
        senderType: 'bot',
        text: 'ALERT_TWO',
      }),
    )
    await sleep(20)

    const pMention = h.manager.inbound.handleInbound(
      'bot-1',
      h.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_m1',
        senderType: 'user',
        text: '@_user_1 URGENT_MENTION',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'TestBot' }],
      }),
    )
    await vi.waitFor(() => expect(h.manager.runtimeLimiter.getStats().queued).toBe(2))
    expect(h.getMaxObservedActive()).toBe(1)

    // Finish first alert -> interactive mention must run BEFORE queued ALERT_TWO
    h.pendingResolvers.shift()!.resolve('alert 1 done')
    await vi.waitFor(() => expect(h.pendingResolvers).toHaveLength(1))
    expect(h.startedOrder[1]).toContain('URGENT_MENTION')

    h.pendingResolvers.shift()!.resolve('mention done')
    await vi.waitFor(() => expect(h.pendingResolvers).toHaveLength(1))
    expect(h.startedOrder[2]).toContain('ALERT_TWO')

    h.pendingResolvers.shift()!.resolve('alert 2 done')
    await Promise.all([pAlert1, pAlert2, pMention])
    expect(h.getMaxObservedActive()).toBe(1)
    await h.manager.stop()
  })

  it('staggers simultaneously due reminders and enforces shared runtimeLimiter concurrency', async () => {
    const h = createBridgeHarness({
      maxConcurrentTurnsPerRuntime: 1,
      reminderDispatchStaggerMs: 40,
      manualTurnControl: true,
    })

    const pastIso = new Date(Date.now() - 1000).toISOString()
    for (const idx of [1, 2]) {
      h.store.upsertReminder({
        id: `rem-burst-${idx}`,
        title: `复查任务 ${idx}`,
        prompt: `REMINDER_TASK_${idx}`,
        scheduledAt: pastIso,
        status: 'scheduled',
        origin: {
          botId: 'bot-1',
          botName: 'TestBot',
          larkAppId: 'cli_test',
          chatType: 'p2p',
          userOpenId: 'ou_alex',
          deliveryMode: 'p2p',
        },
        mentions: [],
        ccMentions: [],
        createdAtMs: Date.now() - 5000,
        updatedAtMs: Date.now() - 5000,
      })
    }

    await h.manager.reminders.tick()
    // First reminder started immediately; second is staggered
    await vi.waitFor(() => expect(h.pendingResolvers).toHaveLength(1))
    expect(h.startedOrder[0]).toContain('REMINDER_TASK_1')

    // Wait past stagger delay: second reminder acquires session but waits on runtimeLimiter (max=1)
    await sleep(70)
    expect(h.pendingResolvers).toHaveLength(1)
    expect(h.getMaxObservedActive()).toBe(1)

    // Complete first reminder -> second reminder immediately starts
    h.pendingResolvers.shift()!.resolve('<no_reminder_needed/>')
    await vi.waitFor(() => expect(h.pendingResolvers).toHaveLength(1))
    expect(h.startedOrder[1]).toContain('REMINDER_TASK_2')

    h.pendingResolvers.shift()!.resolve('<no_reminder_needed/>')
    await vi.waitFor(() => expect(h.manager.reminders.getActiveCount()).toBe(0))
    expect(h.getMaxObservedActive()).toBe(1)
    await h.manager.stop()
  })
})
