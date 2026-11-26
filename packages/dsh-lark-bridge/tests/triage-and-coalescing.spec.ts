import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  assertContiguous,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import type { InboundLarkMessage, LarkBotTransport } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { LarkBridgeStore } from '../src/store.js'
import { TriageContextStore, classifyTriageError } from '../src/triage-service.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-triage-'): string {
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

type StreamHandler = (opts: GenerateOptions) => AsyncIterable<StreamChunk>

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

function createHarness(options: {
  readonly triageStream?: StreamHandler
  readonly manualTurnControl?: boolean
  readonly workerReply?: (prompt: string, turn: number) => string
  readonly enableSessionPersistence?: boolean
} = {}) {
  const dir = makeTempDir()
  const store = new LarkBridgeStore(dir)
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agents = new Map<string, { session: Session; followup: (msg: unknown) => void }>()
  const createdSessions: string[] = []
  const submittedWorkerPrompts: string[] = []
  const triageCalls: GenerateOptions[] = []
  const persistedSessions = new Map<
    string,
    { header: Record<string, unknown>; events: SessionEvent[]; flushed: boolean; closed: boolean }
  >()
  const workspaceAddSession = vi.fn()
  const workspaceArchiveSession = vi.fn().mockReturnValue(true)
  const pendingTurnResolvers: Array<(replyText: string) => void> = []
  let onWorkerTurnStart: ((turn: number, prompt: string) => void) | undefined
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
            attachSession: workspaceAddSession,
          }),
          archiveSession: workspaceArchiveSession,
        }
      }
      if (key === 'sessionPersistence' && options.enableSessionPersistence !== false) {
        return {
          create: async (rawHeader: SessionHeader) => {
            const header = materializeCreateHeader(rawHeader)
            const id = String(header.id)
            const rec = {
              header: header as unknown as Record<string, unknown>,
              events: [] as SessionEvent[],
              flushed: false,
              closed: false,
            }
            persistedSessions.set(id, rec)
            return {
              append: async (events: readonly SessionEvent[]) => {
                const batch = materializeAppendBatch(events)
                assertContiguous(header.id, batch, rec.events.length)
                validateStoredEvents(header, [...batch])
                rec.events.push(...batch)
              },
              flush: async () => {
                rec.flushed = true
                // Verify full DSH Session.fromRestore replayability on every flush
                const restored = Session.fromRestore(header.id, rec.events, header)
                if (restored.snapshotEvents().length < rec.events.length) {
                  throw new Error('restored session lost events')
                }
              },
              close: async () => {
                rec.closed = true
              },
            }
          },
        }
      }
      if (key === 'externalRuntimes') {
        return {
          list: () => [
            {
              id: 'codex',
              displayName: 'Codex',
              description: 'External Codex',
              providerId: 'codex-cli',
              defaultModel: 'gpt-5-codex',
            },
          ],
          get: (id: string) =>
            id === 'codex'
              ? {
                  id: 'codex',
                  displayName: 'Codex',
                  description: 'External Codex',
                  providerId: 'codex-cli',
                  defaultModel: 'gpt-5-codex',
                }
              : undefined,
          listModelsForProvider: async (providerId: string) =>
            providerId === 'codex-cli' ? [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }] : undefined,
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
      listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'custom-plan-cli', name: 'Agent Plan' },
        { id: 'codex-cli', name: 'Codex CLI' },
      ],
      listConfigurableProviders: () => [
        { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        {
          provider: 'custom-plan-cli',
          displayName: 'Agent Plan',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'custom-plan-cli'],
          declared: true,
        },
      ],
      listModels: async (provider: string) =>
        provider === 'deepseek'
          ? [
              { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
              { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
            ]
          : provider === 'custom-plan-cli'
            ? [{ provider: 'custom-plan-cli', id: 'plan-fast', name: 'Plan Fast' }]
            : [],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
        ...(model === 'deepseek-reasoner'
          ? {
              reasoning: {
                efforts: [
                  { id: 'low' as never, name: 'Low' },
                  { id: 'high' as never, name: 'High' },
                ],
              },
            }
          : {}),
      }),
      stream: (opts: GenerateOptions) => {
        triageCalls.push(opts)
        if (options.triageStream) return options.triageStream(opts)
        return makeToolCallStream({ action: 'handoff', reason: '默认移交' })
      },
    },
    sessions: {
      get: (id: string) => agents.get(id)?.session,
    },
    agents: {
      get: (id: string) => agents.get(id),
      create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) => {
        createdSessions.push(opts.sessionId)
        const session = {
          id: opts.sessionId,
          header: { cwd: opts.meta.cwd, agentPreset: opts.meta.agentPreset },
          snapshotEvents: () => [],
        } as unknown as Session
        const agent = {
          session,
          followup: (userMsg: { id?: string; content: Array<{ type: string; text?: string }> }) => {
            const turn = ++turnSeq
            const promptText = userMsg.content.map((b) => b.text ?? '').join('\n')
            submittedWorkerPrompts.push(promptText)
            emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
            emit(session, {
              type: 'user/message',
              data: { id: userMsg.id, turn },
            } as unknown as SessionEvent)
            onWorkerTurnStart?.(turn, promptText)

            const finish = (replyText: string) => {
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
              pendingTurnResolvers.push(finish)
            } else {
              const reply = options.workerReply?.(promptText, turn) ?? `Worker 完成第 ${turn} 轮`
              queueMicrotask(() => finish(reply))
            }
          },
        }
        agents.set(opts.sessionId, agent)
        return {
          agent,
          dispose: async () => {
            agents.delete(opts.sessionId)
          },
        }
      },
      resume: async () => {
        throw new Error('resume not expected')
      },
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
    },
    store,
  )

  return {
    dir,
    ctx,
    store,
    manager,
    createdSessions,
    submittedWorkerPrompts,
    triageCalls,
    persistedSessions,
    workspaceAddSession,
    workspaceArchiveSession,
    setOnWorkerTurnStart: (cb: (turn: number, prompt: string) => void) => {
      onWorkerTurnStart = cb
    },
    finishNextTurn: (replyText: string) => {
      const fn = pendingTurnResolvers.shift()
      if (!fn) throw new Error('no pending worker turn to finish')
      fn(replyText)
    },
  }
}

function makeFakeTransport() {
  let replySeq = 0
  let reactionSeq = 0
  const sentReplies: Array<Record<string, unknown>> = []
  const addedReactions: Array<{ messageId: string; emoji: string; reactionId: string }> = []
  const removedReactions: Array<{ messageId: string; reactionId: string }> = []

  const transport = {
    state: { botOpenId: 'ou_bot', connected: true },
    resolveUserSummary: vi.fn().mockImplementation(async (openId: string) => ({
      openId,
      name: openId === 'ou_alex' ? 'Alex' : 'Sam',
    })),
    addReaction: vi.fn().mockImplementation(async (messageId: string, emoji: string) => {
      const reactionId = `rx_${++reactionSeq}`
      addedReactions.push({ messageId, emoji, reactionId })
      return reactionId
    }),
    removeReaction: vi.fn().mockImplementation(async (messageId: string, reactionId: string) => {
      removedReactions.push({ messageId, reactionId })
    }),
    sendReply: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
      const id = `om_bot_reply_${++replySeq}`
      sentReplies.push({ ...opts, sentId: id })
      return {
        messageId: id,
        rootId: opts.replyToMessageId,
        ...(opts.replyMode === 'new-topic' ? { threadId: `omt_thread_${replySeq}` } : {}),
      }
    }),
    downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
  } as unknown as LarkBotTransport

  return { transport, sentReplies, addedReactions, removedReactions }
}

function makeGroupMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-1',
    larkAppId: 'cli_demo',
    botOpenId: 'ou_bot',
    messageId: 'om_1',
    chatId: 'oc_team',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_alex',
    senderType: 'user',
    text: 'hello',
    rawContent: '{"text":"hello"}',
    mentions: [],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

describe('Smart Triage Gate, Per-Group Overrides & Busy-Queue Coalescing', () => {
  it('silences listener chatter with zero main session and zero reaction flicker', async () => {
    const h = createHarness({
      triageStream: () => makeToolCallStream({ action: 'silent', reason: '日常确认语' }),
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'OnIt',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'passive_only',
      },
    })
    h.store.upsertGroup({
      botId: 'bot-1',
      chatId: 'oc_team',
      chatName: '研发群',
      enabled: true,
      listener: {
        enabled: true,
        name: '项目讨论',
        prompt: '仅响应技术问题',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
      },
    })

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({ messageId: 'om_chatter_1', text: '收到，辛苦了' }),
    )

    expect(h.triageCalls).toHaveLength(1)
    expect(h.createdSessions).toHaveLength(0)
    expect(fx.addedReactions).toHaveLength(0)
    expect(fx.sentReplies).toHaveLength(0)
    const ev = h.store.listEvents(10).find((e) => e.kind === 'silent_skip')
    expect(ev?.summary).toContain('智能分流静默：日常确认语')

    await h.manager.stop()
    h.store.close()
  })

  it('quick-replies in plain text with zero session, then hands off seamlessly with <router_handoff_context> when escalated', async () => {
    let callNum = 0
    const h = createHarness({
      triageStream: () => {
        callNum += 1
        if (callNum === 1) {
          return makeToolCallStream({
            action: 'quick_reply',
            reason: '简单问候',
            reply_text: '在的，有什么可以帮你？',
          })
        }
        return makeToolCallStream({
          action: 'handoff',
          reason: '需排查代码报错',
        })
      },
      workerReply: () => '已定位到登录超时根因，修复方案如下。',
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'OnIt',
      useInteractiveCard: true,
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'all_group',
      },
    })

    // Turn 1: explicit @Bot greeting -> Router quick_reply in plain text, zero Worker session, zero OnIt reaction
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_greet_1',
        text: '@DevBot 在吗',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )

    expect(h.createdSessions).toHaveLength(0)
    expect(fx.addedReactions).toHaveLength(0)
    expect(fx.sentReplies).toHaveLength(1)
    expect(fx.sentReplies[0]?.text).toBe('在的，有什么可以帮你？')
    expect(fx.sentReplies[0]?.card).toBeUndefined()

    // Turn 2: follow-up inside the quick-reply topic WITHOUT @Bot -> escalates to Worker with prior context!
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_task_2',
        rootId: 'om_greet_1',
        threadId: 'omt_thread_1',
        text: '帮我查下登录接口超时报错',
      }),
    )

    expect(h.createdSessions).toHaveLength(1)
    // Quiet handoff: only OnIt reaction added & removed, no extra placeholder bubble before Worker card
    expect(fx.addedReactions).toHaveLength(1)
    expect(fx.addedReactions[0]?.messageId).toBe('om_task_2')
    expect(fx.removedReactions).toHaveLength(1)
    expect(fx.sentReplies).toHaveLength(2)
    expect(fx.sentReplies[1]?.card).toBeDefined()
    expect(h.submittedWorkerPrompts[0]).toContain('<triage_handoff_context>')
    expect(h.submittedWorkerPrompts[0]).toContain('在吗')
    expect(h.submittedWorkerPrompts[0]).toContain('在的，有什么可以帮你？')

    await h.manager.stop()
    h.store.close()
  })

  it('feeds last reply into active-thread triage without truncation and fails open on timeout', async () => {
    const h = createHarness({
      triageStream: (opts) => {
        const userContent = opts.messages[0]?.content
        const promptText = Array.isArray(userContent)
          ? userContent.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
          : ''
        if (promptText.includes('好的，按 B 改')) {
          // Verify triage sees full last reply and formal metadata tag
          expect(promptText).toContain('你要按方案 A 还是方案 B 修改')
          expect(promptText).toContain('has_active_session=true')
          return makeToolCallStream({ action: 'handoff', reason: '回复主运行时确认选 B' })
        }
        // Simulate hang -> triggers timeout fail-open!
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((_, reject) => {
              opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true,
              })
            })
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
      workerReply: (_prompt, turn) =>
        turn === 1 ? '排查完毕，请问你要按方案 A 还是方案 B 修改？' : '已按方案 B 完成修改。',
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'OnIt',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'passive_only',
        timeoutMs: 1000,
      },
    })

    // Turn 1: explicit @Bot bypasses triage under passive_only and establishes Worker session
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_root_1',
        text: '@DevBot 帮我排查下配置冲突',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )
    expect(h.triageCalls).toHaveLength(0)
    expect(h.createdSessions).toHaveLength(1)

    // Turn 2: active-thread reply "好的，按 B 改" enters triage WITH Worker's last reply excerpt -> handoff
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_confirm_2',
        rootId: 'om_root_1',
        threadId: 'omt_thread_1',
        text: '好的，按 B 改',
      }),
    )
    expect(h.triageCalls).toHaveLength(1)
    expect(h.submittedWorkerPrompts).toHaveLength(2)

    // Turn 3: triage hangs past timeoutMs (1000ms) -> Fail-Open quietly to Worker!
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_timeout_3',
        rootId: 'om_root_1',
        threadId: 'omt_thread_1',
        text: '顺便跑下单测',
      }),
    )
    expect(h.triageCalls).toHaveLength(2)
    expect(h.submittedWorkerPrompts).toHaveLength(3)

    await h.manager.stop()
    h.store.close()
  })

  it('coalesces multiple messages queued while Worker is busy into a single follow-up turn and cleans up all reactions', async () => {
    const h = createHarness({
      manualTurnControl: true,
      triageStream: () => makeToolCallStream({ action: 'handoff', reason: '补充任务信息' }),
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'OnIt',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'passive_only',
        coalesceQueuedMessages: true,
      },
    })

    let resolveTurn1Started!: () => void
    const turn1Started = new Promise<void>((r) => {
      resolveTurn1Started = r
    })
    let resolveTurn2Started!: () => void
    const turn2Started = new Promise<void>((r) => {
      resolveTurn2Started = r
    })
    h.setOnWorkerTurnStart((turn) => {
      if (turn === 1) resolveTurn1Started()
      if (turn === 2) resolveTurn2Started()
    })

    // Turn 1 starts and stays busy
    const p1 = h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_burst_1',
        text: '@DevBot 开始排查线上慢查询',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )
    await turn1Started

    // While Turn 1 is still running, 3 follow-up messages arrive concurrently in the same thread
    const p2 = h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_burst_2',
        rootId: 'om_burst_1',
        text: '补充 1：接口是 /v1/orders',
      }),
    )
    const p3 = h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_burst_3',
        rootId: 'om_burst_1',
        senderOpenId: 'ou_sam',
        text: '补充 2：P99 飙到 3.2s',
      }),
    )
    const p4 = h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_burst_4',
        rootId: 'om_burst_1',
        text: '补充 3：刚发了索引变更',
      }),
    )

    // Wait until all 3 follow-ups have added their OnIt reaction and entered the waiting batch
    await vi.waitFor(() => {
      expect(fx.addedReactions).toHaveLength(4)
    })

    // Finish Turn 1 -> M2, M3, M4 should coalesce into ONE single Turn 2!
    h.finishNextTurn('第一轮初步分析完成')
    await p1
    await turn2Started

    expect(h.submittedWorkerPrompts).toHaveLength(2)
    expect(h.submittedWorkerPrompts[1]).toContain('以下 3 条消息')
    expect(h.submittedWorkerPrompts[1]).toContain('补充 1：接口是 /v1/orders')
    expect(h.submittedWorkerPrompts[1]).toContain('补充 2：P99 飙到 3.2s')
    expect(h.submittedWorkerPrompts[1]).toContain('补充 3：刚发了索引变更')

    // Finish combined Turn 2 -> all 3 follower promises resolve and ALL 4 reactions are removed
    h.finishNextTurn('已结合三条补充定位索引回归问题')
    await Promise.all([p2, p3, p4])

    expect(h.submittedWorkerPrompts).toHaveLength(2)
    expect(fx.sentReplies).toHaveLength(2)
    expect(fx.sentReplies[1]?.replyToMessageId).toBe('om_burst_4')
    expect(fx.removedReactions).toHaveLength(4)
    expect(h.store.listPendingTurns()).toHaveLength(0)

    await h.manager.stop()
    h.store.close()
  })

  it('tags native and custom configurable providers accurately on GET /api/lark-bridge/models and adapts call params for reasoning models', async () => {
    const h = createHarness({
      triageStream: () => makeToolCallStream({ action: 'silent', reason: '纯确认' }),
    })
    const fx = makeFakeTransport()

    const res = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'GET',
      path: '/api/lark-bridge/models',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(res.status).toBe(200)
    const groups = (res.payload as { groups: Array<{ provider: string; isExternal?: boolean }> })
      .groups
    expect(groups.find((g) => g.provider === 'deepseek')?.isExternal).toBe(false)
    // Custom configurable provider even with `-cli` suffix must stay native (not misclassified as external CLI)
    expect(groups.find((g) => g.provider === 'custom-plan-cli')?.isExternal).toBe(false)
    expect(groups.find((g) => g.provider === 'codex-cli')?.isExternal).toBe(true)

    // Reasoning-enabled triage model must omit `temperature` and raise `maxTokens` to 1024
    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        scope: 'all_group',
      },
    })

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_reason_1',
        text: '@DevBot 谢谢',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )

    expect(h.triageCalls).toHaveLength(1)
    expect(h.triageCalls[0]?.reasoningEffort).toBe('low')
    expect(h.triageCalls[0]?.temperature).toBeUndefined()
    expect(h.triageCalls[0]?.maxTokens).toBe(1024)

    await h.manager.stop()
    h.store.close()
  })

  it('supports per-group independent smart triage model, scope, and custom prompt overrides even when Bot default is off', async () => {
    const h = createHarness({
      triageStream: () =>
        makeToolCallStream({
          action: 'quick_reply',
          reason: '群独立规则快回',
          reply_text: '不客气，随时喊我。',
        }),
      workerReply: () => '主运行时直达回复',
    })
    const fx = makeFakeTransport()

    // Bot default smart triage is OFF
    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'OnIt',
      router: { enabled: false },
    })

    // Group A overrides with its own custom provider/model, all_group scope, and custom System Prompt
    h.store.upsertGroup({
      botId: 'bot-1',
      chatId: 'oc_group_a',
      chatName: '独立分流群 A',
      enabled: true,
      router: {
        mode: 'override',
        provider: 'custom-plan-cli',
        model: 'plan-fast',
        scope: 'all_group',
        timeoutMs: 3000,
        systemPrompt: '你是 {{bot_name}}，当前群 {{chat_name}}。群 A 专属分流规则：纯致谢快回。{{active_session_rule}}',
        coalesceQueuedMessages: true,
      },
    })

    // Group B inherits Bot default (OFF) -> goes straight to main runtime
    h.store.upsertGroup({
      botId: 'bot-1',
      chatId: 'oc_group_b',
      chatName: '普通群 B',
      enabled: true,
      router: { mode: 'inherit' },
    })

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_group_a',
        messageId: 'om_a_1',
        text: '@DevBot 辛苦啦',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )
    expect(h.triageCalls).toHaveLength(1)
    expect(h.triageCalls[0]?.provider).toBe('custom-plan-cli')
    expect(h.triageCalls[0]?.model).toBe('plan-fast')
    expect(h.triageCalls[0]?.system).toContain('你是 DevBot，当前群 独立分流群 A')
    expect(h.triageCalls[0]?.system).toContain('群 A 专属分流规则')
    expect(h.createdSessions).toHaveLength(0)
    expect(fx.sentReplies).toHaveLength(1)
    expect(fx.sentReplies[0]?.text).toBe('不客气，随时喊我。')

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_group_b',
        messageId: 'om_b_1',
        text: '@DevBot 辛苦啦',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )
    // Group B did NOT call triage and went straight to main runtime
    expect(h.triageCalls).toHaveLength(1)
    expect(h.createdSessions).toHaveLength(1)
    expect(fx.sentReplies).toHaveLength(2)

    await h.manager.stop()
    h.store.close()
  })

  it('persists inspectable DSH v4 triage sessions, links audit & handoff sessions, applies context params without truncation, and exposes HTTP delete/clear APIs', async () => {
    let callSeq = 0
    const h = createHarness({
      triageStream: () => {
        callSeq += 1
        if (callSeq === 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'block-start', index: 0, blockType: 'reasoning' }
              yield { type: 'block-delta', index: 0, delta: '这是一句纯确认语，直接静默。' }
              yield {
                type: 'block-end',
                index: 0,
                block: { type: 'reasoning', text: '这是一句纯确认语，直接静默。' },
              }
              yield {
                type: 'block-end',
                index: 1,
                block: {
                  type: 'tool-call',
                  id: 'tc_silent_1' as never,
                  name: 'route_message',
                  arguments: JSON.stringify({ action: 'silent', reason: '纯确认语' }),
                },
              }
              yield {
                type: 'usage',
                usage: { input: 120, output: 35, total: 155 } as never,
              }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
            },
          }
        }
        return makeToolCallStream({ action: 'handoff', reason: '完整长日志需主运行时排查' })
      },
      workerReply: () => '主运行时已收到完整长日志并定位问题。',
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'all_group',
        recentMessageCount: 1,
        contextTtlMinutes: 60,
        includeLastReply: false,
      },
    })
    h.store.upsertGroup({
      botId: 'bot-1',
      chatId: 'oc_team',
      chatName: '稳定性群',
      enabled: true,
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '仅回应有实质问题或告警的讨论，纯确认语静默',
        scope: 'all',
        replyMode: 'reply',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
        msgTypes: ['text'],
        senderTypes: ['user'],
      },
    })

    // Call 1: passive listener silent verdict -> persisted as archived DSH v4 triage session & linked to audit event
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_tr_1',
        text: '收到',
      }),
    )

    // Call 2: long untruncated message (3500 chars) -> handoff -> persisted + linked to main session
    const longPayload = `长报错日志开始-${'E'.repeat(3500)}-END_OF_STACK`
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_tr_2',
        text: `@DevBot ${longPayload}`,
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )

    expect(h.persistedSessions.size).toBe(2)
    const triageRows = h.store.listTriageSessions('bot-1')
    expect(triageRows).toHaveLength(2)

    const silentRow = triageRows.find((r) => r.action === 'silent')!
    const handoffRow = triageRows.find((r) => r.action === 'handoff')!
    expect(silentRow).toBeDefined()
    expect(handoffRow).toBeDefined()
    expect(handoffRow.handoffSessionId).toBe(h.createdSessions[0])

    // Every triage session was attached to workspace and immediately archived
    expect(h.workspaceAddSession).toHaveBeenCalledWith(silentRow.sessionId)
    expect(h.workspaceAddSession).toHaveBeenCalledWith(handoffRow.sessionId)
    expect(h.workspaceArchiveSession).toHaveBeenCalledWith(silentRow.sessionId, {
      stopActivity: true,
    })
    expect(h.workspaceArchiveSession).toHaveBeenCalledWith(handoffRow.sessionId, {
      stopActivity: true,
    })

    // Inspect persisted DSH v4 event sequence on silent session (strict lifecycle ordering & header contract)
    const silentLog = h.persistedSessions.get(silentRow.sessionId)!
    expect(silentLog.flushed).toBe(true)
    expect(silentLog.closed).toBe(true)
    expect(silentLog.header.delegationDepth).toBe(0)
    const types = silentLog.events.map((e) => e.type)
    expect(types).toEqual([
      'plugin:lark-bridge/origin',
      'session/title',
      'model/selection',
      'turn/start',
      'step/start',
      'system/message',
      'user/message',
      'request/header',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])

    // Final Step 2 assistant/message exposes the verdict conclusion directly in Conversation View (zero tool-call)
    const extractFinalText = (events: readonly SessionEvent[]): string => {
      const assistantEvents = events.filter((e) => e.type === 'assistant/message')
      const last = assistantEvents[assistantEvents.length - 1] as
        | { data?: { step?: number; usage?: unknown; message?: { content?: Array<{ type: string; text?: string }> } } }
        | undefined
      expect(last?.data?.step).toBe(2)
      expect(last?.data?.usage).toBeUndefined()
      const blocks = last?.data?.message?.content ?? []
      expect(blocks.some((b) => b.type === 'tool-call')).toBe(false)
      return blocks.map((b) => b.text ?? '').join('\n')
    }

    const silentConclusion = extractFinalText(silentLog.events)
    expect(silentConclusion).toContain('`silent`')
    expect(silentConclusion).toContain('纯确认语')

    const handoffLog = h.persistedSessions.get(handoffRow.sessionId)!
    const handoffConclusion = extractFinalText(handoffLog.events)
    expect(handoffConclusion).toContain('`handoff`')
    expect(handoffConclusion).toContain('完整长日志需主运行时排查')

    // Verify untruncated 3500-char payload & recentMessageCount=1 in Call 2
    const handoffUserContent = h.triageCalls[1]?.messages[0]?.content
    const handoffUserText = Array.isArray(handoffUserContent)
      ? handoffUserContent.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
      : ''
    expect(handoffUserText).toContain('END_OF_STACK')
    expect(handoffUserText).toContain('<recent_context>')

    // Audit events link to triageSessionId (both silent_skip and triage handoff)
    const events = h.store.listEvents(20)
    const silentEv = events.find((e) => e.kind === 'silent_skip')
    const triageEv = events.find((e) => e.kind === 'triage')
    expect(silentEv?.sessionId).toBe(silentRow.sessionId)
    expect(triageEv?.sessionId).toBe(handoffRow.sessionId)

    // HTTP endpoints: GET /cockpit returns triageDefaults, GET /bindings returns triageSessions
    const cockpitRes = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'GET',
      path: '/api/lark-bridge/cockpit',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(cockpitRes.status).toBe(200)
    const cockpitPayload = cockpitRes.payload as {
      triageDefaults?: {
        defaultSystemPrompt: string
        toolName: string
        toolSchema?: { name: string; parameters?: { properties?: Record<string, unknown> } }
        variables: Array<{ key: string }>
      }
    }
    expect(cockpitPayload.triageDefaults?.defaultSystemPrompt).toContain('{{bot_name}}')
    expect(cockpitPayload.triageDefaults?.toolName).toBe('route_message')
    expect(cockpitPayload.triageDefaults?.toolSchema?.name).toBe('route_message')
    expect(cockpitPayload.triageDefaults?.toolSchema?.parameters?.properties).toHaveProperty('action')
    expect(cockpitPayload.triageDefaults?.variables.length).toBeGreaterThanOrEqual(8)

    const bindingsRes = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'GET',
      path: '/api/lark-bridge/bindings',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(bindingsRes.status).toBe(200)
    const bindingsPayload = bindingsRes.payload as {
      triageSessions: Array<{ sessionId: string; sessionUrl?: string }>
    }
    expect(bindingsPayload.triageSessions).toHaveLength(2)
    expect(bindingsPayload.triageSessions[0]?.sessionUrl).toContain('#session=')

    // CLI bearer token must be rejected from destructive DELETE /triage-sessions
    const cliDelRes = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'DELETE',
      path: `/api/lark-bridge/triage-sessions/${silentRow.sessionId}`,
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliDelRes.status).toBe(403)

    // Owner delete single + clear all
    const delOne = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'DELETE',
      path: `/api/lark-bridge/triage-sessions/${silentRow.sessionId}`,
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(delOne.status).toBe(200)
    expect(h.store.listTriageSessions('bot-1')).toHaveLength(1)

    const delAll = await dispatchLarkApiRequest(h.ctx, h.manager, {
      method: 'DELETE',
      path: '/api/lark-bridge/triage-sessions',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(delAll.status).toBe(200)
    expect(h.store.listTriageSessions('bot-1')).toHaveLength(0)

    await h.manager.stop()
    h.store.close()
  })

  it('appends a clean Step 2 conclusion assistant/message for quick_reply and fail-open error sessions', async () => {
    let callSeq = 0
    const h = createHarness({
      triageStream: () => {
        callSeq += 1
        if (callSeq === 1) {
          return makeToolCallStream({
            action: 'quick_reply',
            reason: '简单打招呼',
            reply_text: '在的，请说。',
          })
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { code: 'NETWORK', message: 'upstream 502' } },
            } as unknown as StreamChunk
          },
        }
      },
      workerReply: () => '主运行时兜底已处理',
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-1',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'all_group',
      },
    })

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_qr_1',
        text: '@DevBot 在吗',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        messageId: 'om_err_1',
        text: '@DevBot 查一下报错日志',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )

    const rows = h.store.listTriageSessions('bot-1')
    const qrRow = rows.find((r) => r.action === 'quick_reply')!
    const errRow = rows.find((r) => r.fallback === true)!
    expect(qrRow).toBeDefined()
    expect(errRow).toBeDefined()

    const readStep2Text = (sessionId: string): string => {
      const rec = h.persistedSessions.get(sessionId)!
      const step2 = rec.events.find(
        (e) =>
          e.type === 'assistant/message' &&
          (e.data as { step?: number }).step === 2,
      ) as { data?: { message?: { content?: Array<{ type: string; text?: string }> } } } | undefined
      expect(step2).toBeDefined()
      return (step2?.data?.message?.content ?? []).map((b) => b.text ?? '').join('\n')
    }

    const qrText = readStep2Text(qrRow.sessionId)
    expect(qrText).toContain('`quick_reply`')
    expect(qrText).toContain('原因：简单打招呼')
    expect(qrText).toContain('回复：在的，请说。')

    const errText = readStep2Text(errRow.sessionId)
    expect(errText).toContain('`handoff`（回退直通）')
    expect(errText).toContain('原因：分流异常，自动直通主运行时')
    expect(errText).toContain('异常：upstream 502')

    // Structured fallback error classification & model info must be persisted on triage_sessions & audit_events.
    expect(errRow.errorCode).toBe('upstream_5xx')
    expect(errRow.errorMessage).toBe('upstream 502')
    const fallbackAudit = h.store
      .listEvents(50)
      .find((e) => e.kind === 'triage' && e.sessionId === errRow.sessionId)
    expect(fallbackAudit?.summary).toContain('分流回退直通')
    expect(fallbackAudit?.summary).toContain('upstream_5xx')
    expect(fallbackAudit?.summary).toContain('deepseek/deepseek-chat')
    expect(fallbackAudit?.summary).toContain('upstream 502')

    // Verify error classification and secret redaction across common upstream failure modes.
    expect(classifyTriageError('HTTP 429 Too Many Requests', false)).toMatchObject({
      errorCode: 'rate_limited',
    })
    expect(classifyTriageError('request aborted', true)).toMatchObject({
      errorCode: 'timeout',
    })
    const fakeKey = `${'sk'}-${'secretkeymaterial1234567890'}`
    const redacted = classifyTriageError(`401 Unauthorized Bearer ${fakeKey} api_key=${fakeKey}`, false)
    expect(redacted.errorCode).toBe('auth_error')
    expect(redacted.errorMessage).not.toContain(fakeKey)
    expect(redacted.errorMessage).toContain('[REDACTED')

    await h.manager.stop()
    h.store.close()
  })

  it('bypasses alert bot messages by default while triaging human follow-ups in the alert thread, and respects active_thread_only & group bypass overrides', async () => {
    const h = createHarness({
      triageStream: (opts) => {
        const userText = opts.messages[opts.messages.length - 1]?.content?.[0]?.text ?? ''
        if (userText.includes('收到')) {
          return makeToolCallStream({ action: 'silent', reason: '话题确认语' })
        }
        return makeToolCallStream({ action: 'handoff', reason: '需要处理' })
      },
      workerReply: () => '已定位告警根因，建议先回滚网关配置。',
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-1',
      name: 'OncallBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'passive_only',
      },
    })

    // Group 1: Alert group inherits default bypass (senderTypes=['bot'])
    h.store.upsertGroup({
      key: 'bot-1:oc_alert',
      botId: 'bot-1',
      chatId: 'oc_alert',
      chatName: '稳定性告警群',
      enabled: true,
      listener: {
        enabled: true,
        name: '告警排查',
        prompt: '排查线上告警',
        scope: 'top_level',
        replyMode: 'new-topic',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
        msgTypes: ['interactive', 'text'],
        senderTypes: ['bot', 'user'],
      },
    })

    // 1a. Alert bot card bypasses triage -> direct to Worker, audit event recorded
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_alert_1',
        msgType: 'interactive',
        senderType: 'bot',
        senderOpenId: 'cli_monitor_bot',
        text: '[P1] API 5xx 告警触发',
      }),
    )
    expect(h.triageCalls).toHaveLength(0)
    expect(h.submittedWorkerPrompts).toHaveLength(1)
    const bypassEvent = h.store
      .listEvents({ botId: 'bot-1', limit: 20 })
      .find((e) => e.kind === 'triage' && e.summary.includes('规则直通'))
    expect(bypassEvent?.summary).toContain('应用/机器人')

    // 1b. Human "收到" in the same alert thread enters triage (with alert context) and is silenced
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_alert',
        messageId: 'om_ack_2',
        rootId: 'om_alert_1',
        threadId: 'omt_alert_1',
        senderType: 'user',
        senderOpenId: 'ou_oncall',
        text: '收到，我看下',
      }),
    )
    expect(h.triageCalls).toHaveLength(1)
    const followUpTriageText = (h.triageCalls[0]?.messages[0]?.content ?? [])
      .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
      .join('\n')
    expect(followUpTriageText).toContain('[P1] API 5xx 告警触发')
    expect(h.submittedWorkerPrompts).toHaveLength(1)

    // Group 2: active_thread_only lets human listener first message bypass, while triaging active-thread follow-ups
    h.store.upsertGroup({
      key: 'bot-1:oc_active_only',
      botId: 'bot-1',
      chatId: 'oc_active_only',
      chatName: '人工值班群',
      enabled: true,
      router: {
        mode: 'override',
        scope: 'active_thread_only',
        bypass: { senderTypes: [], msgTypes: [], keywords: [] },
      },
      listener: {
        enabled: true,
        name: '人工报障',
        prompt: '排查人工报障',
        scope: 'top_level',
        replyMode: 'new-topic',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
        msgTypes: ['text'],
        senderTypes: ['user'],
      },
    })

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_active_only',
        messageId: 'om_manual_1',
        senderType: 'user',
        text: '订单接口超时了',
      }),
    )
    expect(h.triageCalls).toHaveLength(1)
    expect(h.submittedWorkerPrompts).toHaveLength(2)

    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_active_only',
        messageId: 'om_manual_ack_2',
        rootId: 'om_manual_1',
        threadId: 'omt_manual_1',
        senderType: 'user',
        text: '收到',
      }),
    )
    expect(h.triageCalls).toHaveLength(2)
    expect(h.submittedWorkerPrompts).toHaveLength(2)

    // Group 3: group override clears bot bypass and adds keyword bypass ("P0")
    h.store.upsertGroup({
      key: 'bot-1:oc_mixed',
      botId: 'bot-1',
      chatId: 'oc_mixed',
      chatName: '发布协同群',
      enabled: true,
      router: {
        mode: 'override',
        scope: 'passive_only',
        bypass: { senderTypes: [], msgTypes: [], keywords: ['P0'] },
      },
      listener: {
        enabled: true,
        name: '变更观察',
        prompt: '关注发布异常',
        scope: 'top_level',
        replyMode: 'reply',
        sessionMode: 'per_message',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: true,
        msgTypes: ['text'],
        senderTypes: ['bot', 'user'],
      },
    })

    // Non-keyword bot message now enters triage because senderTypes was cleared
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_mixed',
        messageId: 'om_release_ok_1',
        senderType: 'bot',
        senderOpenId: 'cli_ci_bot',
        text: '构建完成，收到请忽略',
      }),
    )
    expect(h.triageCalls).toHaveLength(3)
    expect(h.submittedWorkerPrompts).toHaveLength(2)

    // Human message matching keyword "p0" (case-insensitive) bypasses triage directly to Worker
    await h.manager.inbound.handleInbound(
      'bot-1',
      fx.transport,
      makeGroupMsg({
        chatId: 'oc_mixed',
        messageId: 'om_p0_2',
        senderType: 'user',
        text: '线上 p0 故障，支付失败',
      }),
    )
    expect(h.triageCalls).toHaveLength(3)
    expect(h.submittedWorkerPrompts).toHaveLength(3)

    await h.manager.stop()
    h.store.close()
  })

  it('bounds hydratedScopes with eviction, coalesces history SQLite writes, preserves append group role in triage prompt, and cancels silently when aborted pre-stream', async () => {
    // 1. TriageContextStore debounces burst history writes and evicts hydratedScopes cleanly
    const upsertSpy = vi.fn()
    const deleteSpy = vi.fn().mockReturnValue(1)
    const ctxStore = new TriageContextStore({
      historyPersistDebounceMs: 10_000,
      persistence: {
        loadTriageContextScopes: () => [],
        upsertTriageContextScope: upsertSpy,
        deleteTriageContextScope: deleteSpy,
        pruneTriageContextScopes: () => 0,
      },
    })

    const t0 = 1_760_000_000_000
    for (let i = 0; i < 10; i += 1) {
      ctxStore.recordChatMessage('chat:bot-1:oc_burst', {
        role: 'user',
        text: `msg-${i}`,
        timestampMs: t0 + i * 100,
        messageId: `om_burst_${i}`,
      })
    }
    // Debounced: 10 burst messages produce 0 immediate SQLite writes, then 1 coalesced write on flush
    expect(upsertSpy).toHaveBeenCalledTimes(0)
    ctxStore.flushPersisted()
    expect(upsertSpy).toHaveBeenCalledTimes(1)

    // Evicting/expiring a scope removes it from hydratedScopes so future cold backfill is allowed
    ctxStore.markScopeHydrated('chat:bot-1:oc_burst')
    expect(ctxStore.hasHydratedScope('chat:bot-1:oc_burst')).toBe(true)
    ctxStore.prunePersisted(t0 + 25 * 60 * 60_000)
    expect(ctxStore.hasHydratedScope('chat:bot-1:oc_burst')).toBe(false)

    // 2. Group role `append` mode preserves appended persona instructions in triage system prompt,
    //    and pre-stream signal.aborted returns `silent` cancel instead of fail-open handoff
    const h = createHarness({
      triageStream: () => makeToolCallStream({ action: 'silent', reason: '群追加设定命中' }),
    })
    const fx = makeFakeTransport()
    h.store.upsertBot({
      id: 'bot-role',
      name: 'RoleBot',
      larkAppId: 'cli_role',
      larkAppSecret: 'sec_role',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      role: {
        enabled: true,
        name: '平台助手',
        systemPrompt: '基础角色：负责全局研发支持。',
      },
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'all_group',
      },
    })
    h.store.upsertGroup({
      key: 'bot-role:oc_append',
      botId: 'bot-role',
      chatId: 'oc_append',
      chatName: '追加设定群',
      enabled: true,
      role: {
        mode: 'append',
        name: '',
        systemPrompt: '群追加规则：仅回应发布窗口变更，其余闲聊一律静默。',
      },
    })

    await h.manager.inbound.handleInbound(
      'bot-role',
      fx.transport,
      makeGroupMsg({
        botId: 'bot-role',
        larkAppId: 'cli_role',
        chatId: 'oc_append',
        messageId: 'om_append_1',
        text: '@RoleBot 今天天气不错',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'RoleBot' }],
      }),
    )
    expect(h.triageCalls[0]?.system).toContain('基础角色：负责全局研发支持。')
    expect(h.triageCalls[0]?.system).toContain('群追加规则：仅回应发布窗口变更，其余闲聊一律静默。')

    // Pre-aborted signal returns silent cancel (not fail-open handoff)
    const ac = new AbortController()
    ac.abort('recalled')
    const botCfg = h.store.getBot('bot-role')!
    const abortedResult = await h.manager.triage.evaluate({
      bot: botCfg,
      group: h.store.getGroup('bot-role', 'oc_append'),
      msg: makeGroupMsg({
        botId: 'bot-role',
        larkAppId: 'cli_role',
        chatId: 'oc_append',
        messageId: 'om_aborted_pre',
        text: '测试提前撤回',
      }),
      decision: {
        kind: 'agent',
        trigger: 'mention',
        routeKey: 'cli_role:oc_append:om_aborted_pre',
        chatId: 'oc_append',
        workingDir: h.dir,
        workspaceName: 'demo',
        agentPreset: 'standard',
        replyMode: 'reply',
        sessionMode: 'thread',
        useCard: false,
        userText: '测试提前撤回',
        allowSilentEmptyReply: false,
        autoCloseAfterCompletion: false,
        sendIntermediateMessages: false,
        idleCloseMinutes: 30,
      },
      routerConfig: {
        source: 'bot',
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'all_group',
        bypass: {
          senderTypes: ['bot'],
          triggerKeywords: [],
          allowSenderTypesOverride: false,
        },
        timeoutMs: 5_000,
        maxTriageImages: 0,
        systemPrompt: '',
        recentMessageCount: 5,
        contextTtlMinutes: 30,
        includeLastReply: true,
        coalesceQueuedMessages: false,
      },
      hasActiveWorker: false,
      workerBusy: false,
      traceId: 'tr_abort_pre',
      signal: ac.signal,
    })
    expect(abortedResult.verdict.action).toBe('silent')
    expect(abortedResult.verdict.fallback).toBeUndefined()

    await h.manager.stop()
    h.store.close()
  })

  it('never silently drops explicit @mentions under all_group and intercepts listener quick_reply hijacks on peer mentions', async () => {
    let callIdx = 0
    const h = createHarness({
      triageStream: (opts) => {
        callIdx += 1
        const userText = (opts.messages[0]?.content ?? [])
          .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
          .join('\n')
        const incomingIdx = userText.indexOf('<incoming_message>')
        const incomingSection = incomingIdx >= 0 ? userText.slice(incomingIdx) : userText
        // 1. Model mistakenly attempts `quick_reply` when listener sees `@OtherBot 重生了吗？`
        if (incomingSection.includes('重生了吗')) {
          return makeToolCallStream({
            action: 'quick_reply',
            reason: '@本智能体的轻松寒暄',
            reply_text: '重生了，记忆都在！',
          })
        }
        // 2. Model mistakenly attempts `silent` on explicit @DevBot snark under all_group
        if (incomingSection.includes('谁问你了')) {
          return makeToolCallStream({
            action: 'silent',
            reason: '群内吐槽式插话，无实质诉求',
          })
        }
        return makeToolCallStream({
          action: 'handoff',
          reason: '需主运行时处理',
        })
      },
      workerReply: (_prompt, turn) => `主运行时第 ${turn} 轮已响应`,
    })
    const fx = makeFakeTransport()

    h.store.upsertBot({
      id: 'bot-guard',
      name: 'DevBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: h.dir,
      agentPreset: 'standard',
      useInteractiveCard: false,
      receivedReactionEmoji: 'OnIt',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'all_group',
      },
    })
    h.store.upsertGroup({
      key: 'bot-guard:oc_team',
      botId: 'bot-guard',
      chatId: 'oc_team',
      chatName: '协作群',
      enabled: true,
      replyMode: 'reply',
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '参与团队讨论，无关闲聊静默',
        scope: 'all',
        replyMode: 'reply',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
        msgTypes: ['text'],
        senderTypes: ['user'],
      },
    })

    // Scenario 1: Listener sees `@OtherBot 重生了吗？` (not @DevBot) -> model tries quick_reply -> intercepted to silent!
    await h.manager.inbound.handleInbound(
      'bot-guard',
      fx.transport,
      makeGroupMsg({
        botId: 'bot-guard',
        messageId: 'om_peer_bot_1',
        text: '@_user_1 重生了吗？',
        mentions: [{ key: '@_user_1', openId: 'ou_other_bot', name: 'OtherBot' }],
      }),
    )
    expect(callIdx).toBe(1)
    expect(h.triageCalls[0]?.system).toContain('禁止使用 `quick_reply` 抢答')
    expect(fx.sentReplies).toHaveLength(0)
    expect(h.createdSessions).toHaveLength(0)
    expect(h.manager.triage.context.hasEphemeralThread('cli_demo:oc_team:om_peer_bot_1')).toBe(false)
    const peerTriageRow = h.store.listTriageSessions('bot-guard')[0]
    expect(peerTriageRow?.action).toBe('silent')
    expect(peerTriageRow?.reason).toContain('仅 @ OtherBot')

    // Scenario 2: Explicit @DevBot without active session -> model tries silent -> upgraded to handoff!
    await h.manager.inbound.handleInbound(
      'bot-guard',
      fx.transport,
      makeGroupMsg({
        botId: 'bot-guard',
        messageId: 'om_mention_root_1',
        text: '@_user_1 谁问你了',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )
    expect(callIdx).toBe(2)
    expect(h.createdSessions).toHaveLength(1)
    expect(h.submittedWorkerPrompts).toHaveLength(1)
    expect(fx.sentReplies).toHaveLength(1)
    expect(fx.sentReplies[0]?.text).toBe('主运行时第 1 轮已响应')
    const mentionTriageRow = h.store.listTriageSessions('bot-guard')[0]
    expect(mentionTriageRow?.action).toBe('handoff')
    expect(mentionTriageRow?.reason).toContain('显式 @ 智能体禁止静默')

    // Scenario 3: Explicit @DevBot in a thread that ALREADY has an active Worker session ->
    //             bypasses triage LLM directly (zero extra triage call, audited as fast bypass)
    await h.manager.inbound.handleInbound(
      'bot-guard',
      fx.transport,
      makeGroupMsg({
        botId: 'bot-guard',
        messageId: 'om_mention_follow_2',
        rootId: 'om_mention_root_1',
        parentId: 'om_mention_root_1',
        text: '@_user_1 再确认下刚才的结论',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DevBot' }],
      }),
    )
    expect(callIdx).toBe(2)
    expect(h.submittedWorkerPrompts).toHaveLength(2)
    expect(fx.sentReplies).toHaveLength(2)
    expect(fx.sentReplies[1]?.text).toBe('主运行时第 2 轮已响应')
    const bypassAudit = h.store
      .listEvents({ botId: 'bot-guard', limit: 20 })
      .find((e) => e.kind === 'triage' && e.summary.includes('话题已有活跃会话'))
    expect(bypassAudit).toBeDefined()

    // Scenario 4: Listener sees `@Alex 帮我排查一下超时问题` -> model returns handoff -> still allowed!
    await h.manager.inbound.handleInbound(
      'bot-guard',
      fx.transport,
      makeGroupMsg({
        botId: 'bot-guard',
        messageId: 'om_peer_handoff_3',
        text: '@_user_1 帮我排查一下超时问题',
        mentions: [{ key: '@_user_1', openId: 'ou_alex', name: 'Alex' }],
      }),
    )
    expect(callIdx).toBe(3)
    expect(h.createdSessions).toHaveLength(2)
    expect(h.submittedWorkerPrompts).toHaveLength(3)

    await h.manager.stop()
    h.store.close()
  })
})
