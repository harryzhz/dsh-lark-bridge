import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InboundLarkMessage, LarkBotTransport } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LarkBridgeManager,
  LarkBridgeStore,
  markBridgeHotReloadSwap,
  resetGlobalHotReloadHandoffForTest,
  resolveHostAgentPresets,
  resolveHostAgents,
  stashDetachedAgentHandle,
  sweepUnclaimedDetachedHandles,
} from '../src/index.js'

const execFileAsync = promisify(execFile)
const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY_PATH = resolve(THIS_DIR, '../../dsh-bundle/bin/lark-bridge.mjs')

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-reattach-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await resetGlobalHotReloadHandoffForTest()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-hot',
    larkAppId: 'cli_hot_1',
    botOpenId: 'ou_bot_hot',
    messageId: 'om_hot_1',
    chatId: 'oc_hot_group',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_alice',
    senderType: 'user',
    text: '@_bot 帮我跑个长任务',
    rawContent: '{}',
    mentions: [{ key: '@_bot', openId: 'ou_bot_hot', name: 'HotBot' }],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

interface ControllableLiveTurn {
  readonly sessionId: string
  readonly turn: number
  readonly userMessageId?: string
  readonly emitIntermediate: (text: string) => void
  readonly emitSilenceToolCall: () => void
  readonly complete: (finalText: string) => void
}

function createPersistentHostFixture() {
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const liveAgents = new Map<
    string,
    {
      agent: Agent & { status: string; followup: (msg: unknown) => void }
      events: SessionEvent[]
      disposeSpy: ReturnType<typeof vi.fn>
      cancelSpy: ReturnType<typeof vi.fn>
      followupCalls: number
      originalFollowup: (msg: unknown) => void
    }
  >()
  const submittedPrompts: Array<{ readonly sessionId: string; readonly turn: number; readonly text: string }> = []
  const liveTurns: ControllableLiveTurn[] = []
  let seqCounter = 0

  const emitEvent = (session: Session, event: SessionEvent) => {
    const entry = liveAgents.get(String(session.id))
    if (entry) entry.events.push(event)
    for (const fn of [...listeners]) {
      fn(session, event)
    }
  }

  const createAgentRecord = (sessionId: string, cwd: string, agentPreset: string): AgentHandle => {
    const events: SessionEvent[] = []
    let turnCounter = 0
    const session = {
      id: sessionId,
      header: { cwd, agentPreset },
      snapshotEvents: () => [...events],
    } as unknown as Session

    const cancelSpy = vi.fn()
    const disposeSpy = vi.fn(async () => {
      liveAgents.delete(sessionId)
    })

    const record: {
      agent: Agent & { status: string; followup: (msg: unknown) => void }
      events: SessionEvent[]
      disposeSpy: ReturnType<typeof vi.fn>
      cancelSpy: ReturnType<typeof vi.fn>
      followupCalls: number
      originalFollowup: (msg: unknown) => void
    } = {
      agent: undefined as unknown as Agent & { status: string; followup: (msg: unknown) => void },
      events,
      disposeSpy,
      cancelSpy,
      followupCalls: 0,
      originalFollowup: () => {},
    }

    const baseFollowup = (rawMsg: unknown) => {
      const userMsg = rawMsg as { id?: string; content?: Array<{ type: string; text?: string }> }
      record.followupCalls += 1
      record.agent.status = 'running'
      const turn = ++turnCounter
      const text = (userMsg.content ?? []).map((b) => b.text ?? '').join('\n')
      submittedPrompts.push({ sessionId, turn, text })

      emitEvent(session, {
        type: 'turn/start',
        seq: ++seqCounter,
        time: Date.now(),
        data: { turn },
      } as unknown as SessionEvent)
      emitEvent(session, {
        type: 'user/message',
        seq: ++seqCounter,
        time: Date.now(),
        data: {
          id: userMsg.id,
          turn,
          content: userMsg.content ?? [],
        },
      } as unknown as SessionEvent)

      liveTurns.push({
        sessionId,
        turn,
        ...(userMsg.id ? { userMessageId: userMsg.id } : {}),
        emitIntermediate: (stepText: string) => {
          emitEvent(session, {
            type: 'assistant/message',
            seq: ++seqCounter,
            time: Date.now(),
            data: {
              turn,
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: stepText },
                  { type: 'tool-call', id: `tc_${seqCounter}`, name: 'bash', arguments: '{}' },
                ],
              },
            },
          } as unknown as SessionEvent)
        },
        emitSilenceToolCall: () => {
          emitEvent(session, {
            type: 'tool/call',
            seq: ++seqCounter,
            time: Date.now(),
            data: {
              turn,
              name: 'bash',
              arguments: JSON.stringify({ command: 'lark-bridge silence --reason "背景已闭环"' }),
            },
          } as unknown as SessionEvent)
        },
        complete: (finalText: string) => {
          if (finalText) {
            emitEvent(session, {
              type: 'assistant/message',
              seq: ++seqCounter,
              time: Date.now(),
              data: {
                turn,
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: finalText }],
                },
              },
            } as unknown as SessionEvent)
          }
          record.agent.status = 'idle'
          emitEvent(session, {
            type: 'turn/end',
            seq: ++seqCounter,
            time: Date.now(),
            data: { turn, reason: { kind: 'completed' } },
          } as unknown as SessionEvent)
        },
      })
    }

    record.originalFollowup = baseFollowup
    record.agent = {
      id: sessionId,
      session,
      status: 'idle',
      inbox: { hasPending: false },
      followup: baseFollowup,
      cancel: cancelSpy,
      whenIdle: async () => {},
    } as unknown as Agent & { status: string; followup: (msg: unknown) => void }

    liveAgents.set(sessionId, record)
    return {
      agent: record.agent,
      dispose: disposeSpy,
    }
  }

  const agentsApi = {
    get: (id: string) => liveAgents.get(String(id))?.agent,
    list: () => [...liveAgents.values()].map((e) => e.agent),
    create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) =>
      createAgentRecord(String(opts.sessionId), opts.meta.cwd, opts.meta.agentPreset),
    resume: async (opts: { resumeSessionId: string }) => {
      const existing = liveAgents.get(String(opts.resumeSessionId))
      if (existing) {
        return { agent: existing.agent, dispose: existing.disposeSpy }
      }
      return createAgentRecord(String(opts.resumeSessionId), '/Users/demo/project', 'standard')
    },
  }

  const makePluginCtx = () => {
    const localListeners = new Set<(session: Session, event: SessionEvent) => void>()
    const localDisposers: Array<() => void> = []
    const ctx = {
      root: {
        get: (key: string) => (key === 'agents' ? agentsApi : undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      get: (key: string) => {
        if (key === 'workspaceRegistry') {
          return {
            list: () => [],
            archivedSessionIds: [] as string[],
            create: async (cwd: string, title?: string) => ({
              id: 'ws-hot',
              title: title ?? 'demo',
              cwd,
              sessionIds: [] as string[],
              setTitle: vi.fn(),
              attachSession: vi.fn(),
            }),
            archiveSession: vi.fn().mockReturnValue(true),
          }
        }
        return undefined
      },
      inject: vi.fn(),
      effect: (fn: () => void | (() => void)) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') localDisposers.push(cleanup)
        return () => {
          if (typeof cleanup === 'function') {
            const idx = localDisposers.indexOf(cleanup)
            if (idx >= 0) localDisposers.splice(idx, 1)
          }
        }
      },
      on: (name: string, fn: (session: Session, event: SessionEvent) => void) => {
        if (name === 'session/event') {
          listeners.add(fn)
          localListeners.add(fn)
        }
        return () => {
          listeners.delete(fn)
          localListeners.delete(fn)
        }
      },
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        listConfigurableProviders: () => [
          { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        ],
        listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
      },
      sessions: {
        get: (id: string) => liveAgents.get(String(id))?.agent.session,
      },
      agents: agentsApi,
      disposePluginFiber: () => {
        for (const fn of [...localListeners]) listeners.delete(fn)
        localListeners.clear()
        while (localDisposers.length > 0) {
          localDisposers.pop()?.()
        }
      },
    }
    return ctx as unknown as Context & { disposePluginFiber: () => void }
  }

  return {
    makePluginCtx,
    liveAgents,
    liveTurns,
    submittedPrompts,
  }
}

function makeMockTransport() {
  const sentReplies: Array<{ chatId: string; replyToMessageId?: string; text?: string; card?: unknown }> = []
  const removedReactions: Array<{ messageId: string; reactionId: string }> = []
  const transport = {
    state: { connected: true, botOpenId: 'ou_bot_hot', botName: 'HotBot' },
    addReaction: vi.fn(async () => 'rx_hot_1'),
    removeReaction: vi.fn(async (messageId: string, reactionId: string) => {
      removedReactions.push({ messageId, reactionId })
    }),
    sendReply: vi.fn(async (input: { chatId: string; replyToMessageId?: string; text?: string; card?: unknown }) => {
      sentReplies.push(input)
      return { messageId: `om_reply_${sentReplies.length}`, rootId: input.replyToMessageId }
    }),
    getCachedUserProfile: vi.fn(() => undefined),
    resolveUserSummary: vi.fn(async (openId: string) => ({ openId, name: 'Alice' })),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    pauseInbound: vi.fn(async () => {}),
    resumeInbound: vi.fn(async () => {}),
  } as unknown as LarkBotTransport
  return { transport, sentReplies, removedReactions }
}

function seedBot(store: LarkBridgeStore, workDir: string) {
  store.upsertBot({
    id: 'bot-hot',
    name: 'HotBot',
    enabled: true,
    larkAppId: 'cli_hot_1',
    larkAppSecret: 'sec_hot_value',
    defaultWorkingDir: workDir,
    agentPreset: 'standard',
    provider: 'deepseek',
    model: 'deepseek-chat',
    useInteractiveCard: false,
    sendIntermediateMessages: true,
    router: {
      enabled: false,
      provider: 'deepseek',
      model: 'deepseek-chat',
      scope: 'passive_only',
      timeoutMs: 5000,
      recentMessageCount: 6,
      contextTtlMinutes: 30,
      includeLastReply: true,
      coalesceQueuedMessages: true,
    },
  })
  store.upsertGroup({
    botId: 'bot-hot',
    chatId: 'oc_hot_group',
    chatName: '热更新测试群',
    enabled: true,
    replyMode: 'reply',
    sessionMode: 'thread',
    intermediateMessages: 'on',
  })
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('Timed out waiting for condition')
}

describe('Seamless hot-reload agent preservation & live turn reattach', () => {
  it('binds agents resolved via resolveHostAgents() to Cordis root fiber so plugin HMR disposal never tears down live agents', async () => {
    class MockAgentsService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'agents')
      }
      create() {
        let disposed = false
        const unfollow = this.ctx.effect(() => () => {
          disposed = true
        })
        return {
          isDisposed: () => disposed,
          dispose: async () => {
            await unfollow()
          },
        }
      }
    }

    const root = new Context()
    await root.plugin(MockAgentsService).await()

    let childOwnedHandle!: { isDisposed: () => boolean; dispose: () => Promise<void> }
    let rootOwnedHandle!: { isDisposed: () => boolean; dispose: () => Promise<void> }

    const pluginFork = root.plugin({
      name: 'bridge-hmr-sim',
      inject: ['agents'],
      apply(ctx) {
        childOwnedHandle = (ctx.agents as unknown as MockAgentsService).create()
        rootOwnedHandle = (resolveHostAgents(ctx) as unknown as MockAgentsService).create()
      },
    })
    await pluginFork.await()

    // Unloading the bridge plugin tears down child-owned handles, but preserves root-owned handles.
    await pluginFork.dispose()
    expect(childOwnedHandle.isDisposed()).toBe(true)
    expect(rootOwnedHandle.isDisposed()).toBe(false)

    // Host process shutdown still cleans up root-owned handles automatically.
    await root.fiber.dispose()
    expect(rootOwnedHandle.isDisposed()).toBe(true)
  })

  it('binds agentPresets resolved via resolveHostAgentPresets() to Cordis root fiber across plugin disposal', async () => {
    class MockAgentPresetsService extends Service {
      constructor(ctx: Context) {
        super(ctx, 'agentPresets')
      }
      mount() {
        let disposed = false
        this.ctx.effect(() => () => {
          disposed = true
        })
        return { isDisposed: () => disposed }
      }
    }

    const root = new Context()
    await root.plugin(MockAgentPresetsService).await()

    let rootMountedPreset!: { isDisposed: () => boolean }
    const pluginFork = root.plugin({
      name: 'bridge-presets-hmr-sim',
      apply(ctx) {
        const presets = resolveHostAgentPresets<MockAgentPresetsService>(ctx)
        expect(presets).toBeDefined()
        rootMountedPreset = presets!.mount()
      },
    })
    await pluginFork.await()

    await pluginFork.dispose()
    expect(rootMountedPreset.isDisposed()).toBe(false)

    await root.fiber.dispose()
    expect(rootMountedPreset.isDisposed()).toBe(true)
  })

  it('resolves root context via Symbol.for("cordis.root") on Cordis 4.2 without touching strict-injected ctx.root', () => {
    const CORDIS_ROOT_SYMBOL = Symbol.for('cordis.root')
    const rootAgents = { create: vi.fn(), get: vi.fn() }
    const childAgents = { create: vi.fn(), get: vi.fn() }
    const rootPresets = { mount: vi.fn() }
    const childPresets = { mount: vi.fn() }

    const rootCtx = {
      get: vi.fn((name: string) => {
        if (name === 'agents') return rootAgents
        if (name === 'agentPresets') return rootPresets
        return undefined
      }),
    }

    // Simulate Cordis 4.2.0-alpha.1 strict inject proxy:
    // - `ctx[Context.root]` (Symbol.for('cordis.root')) returns the root context
    // - `'root' in ctx` is false, and reading `ctx.root` throws without inject
    const cordis42Target: Record<PropertyKey, unknown> = {
      [CORDIS_ROOT_SYMBOL]: rootCtx,
      agents: childAgents,
      get: (name: string) => (name === 'agentPresets' ? childPresets : undefined),
    }
    const cordis42Ctx = new Proxy(cordis42Target, {
      has(target, prop) {
        return Reflect.has(target, prop)
      },
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || Reflect.has(target, prop)) {
          return Reflect.get(target, prop, receiver)
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    }) as unknown as Context

    expect(resolveHostAgents(cordis42Ctx)).toBe(rootAgents)
    expect(resolveHostAgentPresets(cordis42Ctx)).toBe(rootPresets)

    // When a strict proxy omits `Symbol.for('cordis.root')` as well as `'root'`,
    // both helpers must fall back cleanly instead of throwing `without inject`.
    const strictNoRootTarget: Record<PropertyKey, unknown> = {
      agents: childAgents,
      get: (name: string) => (name === 'agentPresets' ? childPresets : undefined),
    }
    const strictNoRootCtx = new Proxy(strictNoRootTarget, {
      has(target, prop) {
        return Reflect.has(target, prop)
      },
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || Reflect.has(target, prop)) {
          return Reflect.get(target, prop, receiver)
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    }) as unknown as Context

    expect(resolveHostAgents(strictNoRootCtx)).toBe(childAgents)
    expect(resolveHostAgentPresets(strictNoRootCtx)).toBe(childPresets)
  })

  it('keeps running agent alive across bridge hot-reload, skips already-sent progress, flushes gap progress, and finishes with zero prompt replay', async () => {
    const dir = makeTempDir('dsh-hot-live-')
    const fixture = createPersistentHostFixture()

    // === Generation 1 ===
    const storeV1 = new LarkBridgeStore(dir)
    seedBot(storeV1, dir)
    const ctxV1 = fixture.makePluginCtx()
    const tV1 = makeMockTransport()
    const mgrV1 = new LarkBridgeManager(
      ctxV1,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV1,
    )
    mgrV1.connections.transports.set('bot-hot', {
      config: storeV1.getBot('bot-hot')!,
      transport: tV1.transport,
    })

    const turnPromiseV1 = mgrV1.inbound.handleInbound('bot-hot', tV1.transport, makeMsg())
    await waitUntil(() => fixture.liveTurns.length === 1)
    const liveTurn = fixture.liveTurns[0]!

    // Emit progress #1 BEFORE hot-reload
    liveTurn.emitIntermediate('进度 1：开始分析代码')
    await waitUntil(() => tV1.sentReplies.length === 1)
    expect(tV1.sentReplies[0]?.text).toBe('进度 1：开始分析代码')

    // Trigger bridge hot-reload swap & stop v1
    markBridgeHotReloadSwap(dir, 'upd_seamless_1')
    await mgrV1.stop()
    ctxV1.disposePluginFiber()
    await turnPromiseV1
    storeV1.close()

    // Verify agent stayed 100% alive, was NEVER cancelled or disposed, reaction stayed intact,
    // and ScheduleNotifier restored original agent.followup without retaining v1 closure.
    const liveEntry = fixture.liveAgents.get(liveTurn.sessionId)!
    expect(liveEntry).toBeDefined()
    expect(liveEntry.cancelSpy).not.toHaveBeenCalled()
    expect(liveEntry.disposeSpy).not.toHaveBeenCalled()
    expect(liveEntry.agent.followup).toBe(liveEntry.originalFollowup)
    expect(tV1.removedReactions).toHaveLength(0)

    // === Reload gap (v1 stopped, v2 not yet started) ===
    // Agent keeps executing in the background and emits progress #2 during the gap!
    liveTurn.emitIntermediate('进度 2：热更空窗期已完成编译')

    // === Generation 2 ===
    const storeV2 = new LarkBridgeStore(dir)
    const ctxV2 = fixture.makePluginCtx()
    const tV2 = makeMockTransport()
    const mgrV2 = new LarkBridgeManager(
      ctxV2,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV2,
    )
    mgrV2.connections.transports.set('bot-hot', {
      config: storeV2.getBot('bot-hot')!,
      transport: tV2.transport,
    })

    // Check persisted cursor in SQLite before recovery
    const persisted = storeV2.listPendingTurns()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.interruptKind).toBe('hot_reload')
    expect(persisted[0]?.targetTurn).toBe(1)
    expect(persisted[0]?.intermediateSentCount).toBe(1)

    await mgrV2.inbound.recoverStalePendingTurns()

    // Gap progress #2 is flushed immediately, while progress #1 is NOT duplicated!
    await waitUntil(() => tV2.sentReplies.length === 1)
    expect(tV2.sentReplies[0]?.text).toBe('进度 2：热更空窗期已完成编译')
    // Zero prompt replay: agent.followup was only ever called once!
    expect(liveEntry.followupCalls).toBe(1)
    expect(fixture.submittedPrompts).toHaveLength(1)

    // Meanwhile, a new inbound Feishu message arrives in the same thread while reattached turn 1 is still running.
    // SessionActor must serialize it behind turn 1 rather than preempting!
    const secondInbound = mgrV2.inbound.handleInbound(
      'bot-hot',
      tV2.transport,
      makeMsg({ messageId: 'om_hot_2', rootId: 'om_hot_1', text: '@HotBot 顺便看下第二项' }),
    )
    await new Promise((r) => setTimeout(r, 40))
    expect(liveEntry.followupCalls).toBe(1)

    // Agent emits live progress #3 and finishes turn 1
    liveTurn.emitIntermediate('进度 3：单测全部通过')
    liveTurn.complete('全部改造完成，结果正常！')

    await waitUntil(() => tV2.sentReplies.length === 3)
    expect(tV2.sentReplies.map((r) => r.text)).toEqual([
      '进度 2：热更空窗期已完成编译',
      '进度 3：单测全部通过',
      '全部改造完成，结果正常！',
    ])
    expect(tV2.removedReactions).toEqual([{ messageId: 'om_hot_1', reactionId: 'rx_hot_1' }])

    // Now the queued second message executes cleanly as turn 2
    await waitUntil(() => fixture.liveTurns.length === 2)
    expect(liveEntry.followupCalls).toBe(2)
    fixture.liveTurns[1]!.complete('第二项也看完了')
    await secondInbound
    expect(tV2.sentReplies.at(-1)?.text).toBe('第二项也看完了')
    expect(storeV2.listPendingTurns()).toHaveLength(0)

    await mgrV2.stop()
    storeV2.close()
  })

  it('flushes gap progress and final reply when the live agent finishes completely during the hot-reload window', async () => {
    const dir = makeTempDir('dsh-hot-done-in-gap-')
    const fixture = createPersistentHostFixture()

    const storeV1 = new LarkBridgeStore(dir)
    seedBot(storeV1, dir)
    const ctxV1 = fixture.makePluginCtx()
    const tV1 = makeMockTransport()
    const mgrV1 = new LarkBridgeManager(
      ctxV1,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV1,
    )
    mgrV1.connections.transports.set('bot-hot', {
      config: storeV1.getBot('bot-hot')!,
      transport: tV1.transport,
    })

    const p1 = mgrV1.inbound.handleInbound('bot-hot', tV1.transport, makeMsg())
    await waitUntil(() => fixture.liveTurns.length === 1)
    const liveTurn = fixture.liveTurns[0]!
    liveTurn.emitIntermediate('进度 A（热更前已发）')
    await waitUntil(() => tV1.sentReplies.length === 1)

    markBridgeHotReloadSwap(dir, 'upd_gap_done')
    await mgrV1.stop()
    ctxV1.disposePluginFiber()
    await p1
    storeV1.close()

    // Turn emits progress B and finishes completely while bridge is unloaded
    liveTurn.emitIntermediate('进度 B（热更空窗产出）')
    liveTurn.complete('后台在热更新期间已顺利完成')

    const storeV2 = new LarkBridgeStore(dir)
    const ctxV2 = fixture.makePluginCtx()
    const tV2 = makeMockTransport()
    const mgrV2 = new LarkBridgeManager(
      ctxV2,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV2,
    )
    mgrV2.connections.transports.set('bot-hot', {
      config: storeV2.getBot('bot-hot')!,
      transport: tV2.transport,
    })

    await mgrV2.inbound.recoverStalePendingTurns()
    await mgrV2.inbound.waitForRecoveries()

    // Progress A is skipped, progress B + final reply are delivered, zero prompt replay!
    expect(tV2.sentReplies.map((r) => r.text)).toEqual([
      '进度 B（热更空窗产出）',
      '后台在热更新期间已顺利完成',
    ])
    expect(fixture.liveAgents.get(liveTurn.sessionId)?.followupCalls).toBe(1)
    expect(tV2.removedReactions).toEqual([{ messageId: 'om_hot_1', reactionId: 'rx_hot_1' }])
    expect(storeV2.listPendingTurns()).toHaveLength(0)

    await mgrV2.stop()
    storeV2.close()
  })

  it('respects lark-bridge silence tool calls executed during the hot-reload gap and suppresses reply delivery', async () => {
    const dir = makeTempDir('dsh-hot-silence-')
    const fixture = createPersistentHostFixture()

    const storeV1 = new LarkBridgeStore(dir)
    seedBot(storeV1, dir)
    storeV1.upsertGroup({
      botId: 'bot-hot',
      chatId: 'oc_hot_group',
      chatName: '热更新测试群',
      enabled: true,
      replyMode: 'reply',
      sessionMode: 'thread',
      listener: {
        enabled: true,
        name: '观察监听',
        prompt: '必要时静默',
        allowSilentEmptyReply: true,
        sessionMode: 'thread',
      },
    })
    const ctxV1 = fixture.makePluginCtx()
    const tV1 = makeMockTransport()
    const mgrV1 = new LarkBridgeManager(
      ctxV1,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV1,
    )
    mgrV1.connections.transports.set('bot-hot', {
      config: storeV1.getBot('bot-hot')!,
      transport: tV1.transport,
    })

    const p1 = mgrV1.inbound.handleInbound(
      'bot-hot',
      tV1.transport,
      makeMsg({ text: '普通巡检消息', mentions: [] }),
    )
    await waitUntil(() => fixture.liveTurns.length === 1)
    const liveTurn = fixture.liveTurns[0]!

    markBridgeHotReloadSwap(dir, 'upd_silence')
    await mgrV1.stop()
    ctxV1.disposePluginFiber()
    await p1
    storeV1.close()

    // During reload gap, agent invokes `lark-bridge silence` and emits explanatory text
    liveTurn.emitSilenceToolCall()
    liveTurn.complete('已静默，无需打扰群聊。')

    const storeV2 = new LarkBridgeStore(dir)
    const ctxV2 = fixture.makePluginCtx()
    const tV2 = makeMockTransport()
    const mgrV2 = new LarkBridgeManager(
      ctxV2,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV2,
    )
    mgrV2.connections.transports.set('bot-hot', {
      config: storeV2.getBot('bot-hot')!,
      transport: tV2.transport,
    })

    await mgrV2.inbound.recoverStalePendingTurns()
    await mgrV2.inbound.waitForRecoveries()

    expect(tV2.sentReplies).toHaveLength(0)
    expect(storeV2.listPendingTurns()).toHaveLength(0)

    await mgrV2.stop()
    storeV2.close()
  })

  it('survives back-to-back hot-reloads (v1 -> v2 -> v3) without interrupting or replaying the running turn', async () => {
    const dir = makeTempDir('dsh-hot-twice-')
    const fixture = createPersistentHostFixture()

    const bootManager = () => {
      const store = new LarkBridgeStore(dir)
      const ctx = fixture.makePluginCtx()
      const mockT = makeMockTransport()
      const mgr = new LarkBridgeManager(
        ctx,
        {
          dataDir: dir,
          publicBaseUrl: '',
          idleSweepIntervalMs: 0,
          maxAuditEvents: 100,
          autoInstallCliAndSkill: false,
          enableInstanceLock: false,
        },
        store,
      )
      mgr.connections.transports.set('bot-hot', {
        config: store.getBot('bot-hot')!,
        transport: mockT.transport,
      })
      return { store, ctx, mockT, mgr }
    }

    const v1 = bootManager()
    seedBot(v1.store, dir)
    v1.mgr.connections.transports.set('bot-hot', {
      config: v1.store.getBot('bot-hot')!,
      transport: v1.mockT.transport,
    })
    const p1 = v1.mgr.inbound.handleInbound('bot-hot', v1.mockT.transport, makeMsg())
    await waitUntil(() => fixture.liveTurns.length === 1)
    const liveTurn = fixture.liveTurns[0]!
    liveTurn.emitIntermediate('步骤 1')
    await waitUntil(() => v1.mockT.sentReplies.length === 1)

    // Hot-reload #1: v1 -> v2
    markBridgeHotReloadSwap(dir, 'upd_1')
    await v1.mgr.stop()
    v1.ctx.disposePluginFiber()
    await p1
    v1.store.close()

    const v2 = bootManager()
    await v2.mgr.inbound.recoverStalePendingTurns()
    liveTurn.emitIntermediate('步骤 2')
    await waitUntil(() => v2.mockT.sentReplies.length === 1)

    // Hot-reload #2: v2 -> v3
    markBridgeHotReloadSwap(dir, 'upd_2')
    await v2.mgr.stop()
    v2.ctx.disposePluginFiber()
    await v2.mgr.inbound.waitForRecoveries()
    v2.store.close()

    const v3 = bootManager()
    await v3.mgr.inbound.recoverStalePendingTurns()
    liveTurn.complete('跨两次热更新后的最终结论')
    await waitUntil(() => v3.mockT.sentReplies.length === 1)

    expect(v3.mockT.sentReplies[0]?.text).toBe('跨两次热更新后的最终结论')
    expect(fixture.liveAgents.get(liveTurn.sessionId)?.followupCalls).toBe(1)
    expect(v3.store.listPendingTurns()).toHaveLength(0)

    await v3.mgr.stop()
    v3.store.close()
  })

  it('falls back to prompt replay when the host process restarted and the live agent no longer exists', async () => {
    const dir = makeTempDir('dsh-hot-fallback-')
    const fixture = createPersistentHostFixture()

    const storeV1 = new LarkBridgeStore(dir)
    seedBot(storeV1, dir)
    const ctxV1 = fixture.makePluginCtx()
    const tV1 = makeMockTransport()
    const mgrV1 = new LarkBridgeManager(
      ctxV1,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV1,
    )
    mgrV1.connections.transports.set('bot-hot', {
      config: storeV1.getBot('bot-hot')!,
      transport: tV1.transport,
    })

    const p1 = mgrV1.inbound.handleInbound('bot-hot', tV1.transport, makeMsg())
    await waitUntil(() => fixture.liveTurns.length === 1)

    markBridgeHotReloadSwap(dir, 'upd_crash')
    await mgrV1.stop()
    ctxV1.disposePluginFiber()
    await p1
    storeV1.close()

    // Simulate full host restart: all in-memory host agents & detached handles are gone!
    fixture.liveAgents.clear()
    await resetGlobalHotReloadHandoffForTest(dir)

    const storeV2 = new LarkBridgeStore(dir)
    const ctxV2 = fixture.makePluginCtx()
    const tV2 = makeMockTransport()
    const mgrV2 = new LarkBridgeManager(
      ctxV2,
      {
        dataDir: dir,
        publicBaseUrl: '',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      storeV2,
    )
    mgrV2.connections.transports.set('bot-hot', {
      config: storeV2.getBot('bot-hot')!,
      transport: tV2.transport,
    })

    await mgrV2.inbound.recoverStalePendingTurns()
    await waitUntil(() => fixture.liveTurns.length === 2)
    expect(fixture.submittedPrompts).toHaveLength(2)
    expect(fixture.submittedPrompts[1]?.text).toContain('<restart_recovery')
    fixture.liveTurns[1]!.complete('重放兜底完成')
    await mgrV2.inbound.waitForRecoveries()

    expect(tV2.sentReplies.map((r) => r.text)).toEqual(['重放兜底完成'])
    await mgrV2.stop()
    storeV2.close()
  })

  it('auto-disposes orphaned detached handles when no reloaded bridge reclaims them', async () => {
    const dir = makeTempDir('dsh-hot-orphan-')
    const disposeSpy = vi.fn(async () => {})
    const fakeHandle = {
      agent: {
        status: 'idle',
        whenIdle: async () => {},
      },
      dispose: disposeSpy,
    } as unknown as AgentHandle

    stashDetachedAgentHandle(dir, 'session-orphan-1', fakeHandle, 40)
    await waitUntil(() => disposeSpy.mock.calls.length === 1, 1000)
    expect(disposeSpy).toHaveBeenCalledTimes(1)

    // Sweep helper disposes idle handles immediately while skipping still-running ones unless forced
    const runningDispose = vi.fn(async () => {})
    stashDetachedAgentHandle(
      dir,
      'session-still-running',
      { agent: { status: 'running' }, dispose: runningDispose } as unknown as AgentHandle,
      60_000,
    )
    expect(await sweepUnclaimedDetachedHandles(dir)).toBe(0)
    expect(runningDispose).not.toHaveBeenCalled()
    expect(await sweepUnclaimedDetachedHandles(dir, { forceAll: true })).toBe(1)
    expect(runningDispose).toHaveBeenCalledTimes(1)
  })

  it('retries CLI requests across transient plain-text 401/404 reload windows, never retries JSON auth/app errors, and permits in-session `plugin update bridge`', async () => {
    let contextHits = 0
    let failJsonHits = 0
    let unauthHits = 0
    let bridgeUpdateHits = 0

    const server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/api/lark-bridge/agent/context')) {
        contextHits += 1
        if (contextHits === 1) {
          // DSH 0.2.3+ outer webserver/authorize returns plain-text 401 when `/api/lark-bridge` is briefly unregistered.
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('unauthorized')
          return
        }
        if (contextHits === 2) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sessionId: 'session-live-cli', attempts: contextHits }))
        return
      }
      if (url.startsWith('/api/lark-bridge/memory/')) {
        unauthHits += 1
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
        return
      }
      if (url.startsWith('/api/lark-bridge/groups')) {
        failJsonHits += 1
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'route_not_found' }))
        return
      }
      if (url === '/api/lark-bridge/plugins/update') {
        bridgeUpdateHits += 1
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            operation: { operationId: 'upd_bridge_in_session', status: 'verifying', items: [] },
          }),
        )
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const addr = server.address() as { port: number }
    const dataDir = makeTempDir('dsh-cli-retry-')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dataDir, 'operator-token'), 'a'.repeat(48), 'utf8')
    // Simulate an active bridge HMR swap recorded in `plugin-update-status.json` so DSH 0.2.3
    // plain-text 401 from unregistered `/api/lark-bridge` is treated as a transient reload window.
    writeFileSync(
      join(dataDir, 'plugin-update-status.json'),
      JSON.stringify({
        operationId: 'upd_cli_retry',
        status: 'removing',
        currentTarget: 'bridge',
        updatedAtMs: Date.now(),
      }),
      'utf8',
    )

    const baseEnv = {
      ...process.env,
      LARK_BRIDGE_API_URL: `http://127.0.0.1:${addr.port}/api/lark-bridge`,
      LARK_BRIDGE_CLI_TOKEN: 'cli_token_retry_test',
      LARK_BRIDGE_DATA_DIR: dataDir,
      LARK_BRIDGE_CLI_RETRY_MAX_MS: '5000',
    }

    try {
      // 1. Plain-text 401 (DSH 0.2.3) & 404 (DSH 0.2.2) during reload window are retried and succeed on hit #3
      const okRes = await execFileAsync(process.execPath, [CLI_ENTRY_PATH, 'context'], { env: baseEnv })
      expect(JSON.parse(okRes.stdout)).toEqual({
        ok: true,
        sessionId: 'session-live-cli',
        attempts: 3,
      })

      // 2. Structured JSON 404 application error is NOT retried
      await expect(
        execFileAsync(process.execPath, [CLI_ENTRY_PATH, 'chats'], { env: baseEnv }),
      ).rejects.toThrow(/route_not_found/)
      expect(failJsonHits).toBe(1)

      // 3. Structured JSON HTTP 401 from mounted bridge is NEVER retried
      await expect(
        execFileAsync(process.execPath, [CLI_ENTRY_PATH, 'memory', 'get', 'mem-401-check'], {
          env: baseEnv,
        }),
      ).rejects.toThrow(/HTTP 401/)
      expect(unauthHits).toBe(1)

      // 4. Inside an active Agent session, `plugin update bridge --no-wait` is allowed (seamless!),
      //    while `plugin update external-agents` and `plugin update all` stay blocked without --detached.
      const bridgeRes = await execFileAsync(
        process.execPath,
        [CLI_ENTRY_PATH, 'plugin', 'update', 'bridge', '--no-wait', '--data-dir', dataDir],
        { env: { ...baseEnv, DSH_IN_AGENT_SESSION: '1' } },
      )
      expect(JSON.parse(bridgeRes.stdout).operation?.operationId).toBe('upd_bridge_in_session')
      expect(bridgeUpdateHits).toBe(1)

      await expect(
        execFileAsync(
          process.execPath,
          [CLI_ENTRY_PATH, 'plugin', 'update', 'external-agents', '--data-dir', dataDir],
          { env: { ...baseEnv, DSH_IN_AGENT_SESSION: '1' } },
        ),
      ).rejects.toThrow(/拒绝在活跃 Agent 会话内直接热更新插件/)
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })
})
