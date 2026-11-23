import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InboundLarkMessage, LarkBotTransport } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { LarkBridgeStore } from '../src/store.js'

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
} = {}) {
  const dir = makeTempDir()
  const store = new LarkBridgeStore(dir)
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agents = new Map<string, { session: Session; followup: (msg: unknown) => void }>()
  const createdSessions: string[] = []
  const submittedWorkerPrompts: string[] = []
  const triageCalls: GenerateOptions[] = []
  const pendingTurnResolvers: Array<(replyText: string) => void> = []
  let onWorkerTurnStart: ((turn: number, prompt: string) => void) | undefined
  let turnSeq = 0

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaces') {
        return {
          list: () => [],
          create: () => ({ id: 'ws-1', name: 'demo', cwd: dir, sessionIds: [] }),
          addSession: vi.fn(),
          archiveSession: vi.fn().mockReturnValue(true),
          getArchivedSessionIds: () => [],
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

describe('Experimental Router/Worker Triage Gate & Busy-Queue Coalescing', () => {
  it('silences listener chatter with zero Worker session and zero reaction flicker', async () => {
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
      experimental: {
        router: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          scope: 'passive_only',
        },
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
    expect(ev?.summary).toContain('Router 分流静默：日常确认语')

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
      experimental: {
        router: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          scope: 'all_group',
        },
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
    expect(h.submittedWorkerPrompts[0]).toContain('<router_handoff_context>')
    expect(h.submittedWorkerPrompts[0]).toContain('在吗')
    expect(h.submittedWorkerPrompts[0]).toContain('在的，有什么可以帮你？')

    await h.manager.stop()
    h.store.close()
  })

  it('feeds last Worker reply excerpt into active-thread triage and fails open on timeout', async () => {
    const h = createHarness({
      triageStream: (opts) => {
        const userContent = opts.messages[0]?.content
        const promptText = Array.isArray(userContent)
          ? userContent.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
          : ''
        if (promptText.includes('好的，按 B 改')) {
          // Verify triage sees Worker's last reply excerpt!
          expect(promptText).toContain('你要按方案 A 还是方案 B 修改')
          expect(promptText).toContain('has_active_worker=true')
          return makeToolCallStream({ action: 'handoff', reason: '回复 Worker 确认选 B' })
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
      experimental: {
        router: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          scope: 'passive_only',
          timeoutMs: 1000,
        },
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
      experimental: {
        router: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          scope: 'passive_only',
          coalesceQueuedMessages: true,
        },
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
      experimental: {
        router: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-reasoner',
          scope: 'all_group',
        },
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
})
