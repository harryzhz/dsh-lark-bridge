import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  InboundLarkMessage,
  LarkBotTransport,
  RecalledLarkMessageEvent,
} from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-recall-'): string {
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

interface ActiveMockTurn {
  readonly sessionId: string
  readonly turn: number
  readonly userText: string
  readonly finish: (replyText: string) => void
  readonly emitIntermediate: (text: string) => void
  readonly abort: () => void
}

function createRecallMockRuntimeCtx(options: {
  readonly llmStream?: (req: { signal?: AbortSignal }) => AsyncIterable<unknown>
} = {}) {
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agents = new Map<
    string,
    {
      session: Session
      followup: (msg: unknown) => void
      cancel: ReturnType<typeof vi.fn>
    }
  >()
  const disposedSessions: string[] = []
  const archivedSessions: string[] = []
  const cancelCalls: Array<{ sessionId: string; cause: unknown; options?: unknown }> = []
  const activeTurnsBySession = new Map<string, ActiveMockTurn>()
  const turnStartWaiters: Array<(turn: ActiveMockTurn) => void> = []
  const startedTurns: ActiveMockTurn[] = []

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  let turnSeq = 0
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaceRegistry') {
        return {
          list: () => [],
          create: async (_cwd: string, title?: string) => ({
            id: 'ws-recall',
            title: title ?? 'demo',
            cwd: '/tmp',
            sessionIds: [],
            attachSession: vi.fn().mockResolvedValue(undefined),
            setTitle: vi.fn().mockResolvedValue(undefined),
          }),
          archivedSessionIds: archivedSessions,
          archiveSession: async (sid: string) => {
            archivedSessions.push(sid)
            return true
          },
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
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'mock-model', name: 'Mock Model' }],
      ...(options.llmStream ? { stream: options.llmStream } : {}),
    },
    sessions: {
      get: (id: string) => agents.get(id)?.session,
    },
    agents: {
      listPresets: () => [{ id: 'standard', name: 'Standard', defaultModel: 'mock-model' }],
      get: (id: string) => agents.get(id),
      create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) => {
        const session = {
          id: opts.sessionId,
          header: { cwd: opts.meta.cwd, agentPreset: opts.meta.agentPreset },
          snapshotEvents: () => [],
        } as unknown as Session

        const cancel = vi.fn((cause: unknown, cancelOpts?: unknown) => {
          cancelCalls.push({ sessionId: opts.sessionId, cause, options: cancelOpts })
          const active = activeTurnsBySession.get(opts.sessionId)
          if (active) {
            active.abort()
          }
        })

        const agent = {
          session,
          cancel,
          followup: (userMsg: { id?: string; content?: Array<{ type: string; text?: string }> }) => {
            const turn = ++turnSeq
            const userText = (userMsg.content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
            emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
            emit(session, {
              type: 'user/message',
              data: { id: userMsg.id, turn },
            } as unknown as SessionEvent)

            let ended = false
            const record: ActiveMockTurn = {
              sessionId: opts.sessionId,
              turn,
              userText,
              emitIntermediate: (text: string) => {
                if (ended) return
                emit(session, {
                  type: 'assistant/message',
                  data: {
                    turn,
                    message: {
                      role: 'assistant',
                      content: [
                        { type: 'text', text },
                        { type: 'tool-call', id: `tc_${turn}`, name: 'noop', input: {} },
                      ],
                    },
                  },
                } as unknown as SessionEvent)
              },
              finish: (replyText: string) => {
                if (ended) return
                ended = true
                activeTurnsBySession.delete(opts.sessionId)
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
              },
              abort: () => {
                if (ended) return
                ended = true
                activeTurnsBySession.delete(opts.sessionId)
                emit(session, {
                  type: 'turn/end',
                  data: { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } },
                } as unknown as SessionEvent)
              },
            }
            activeTurnsBySession.set(opts.sessionId, record)
            startedTurns.push(record)
            const waiter = turnStartWaiters.shift()
            waiter?.(record)
          },
        }
        agents.set(opts.sessionId, agent)
        return {
          agent,
          dispose: async () => {
            disposedSessions.push(opts.sessionId)
            agents.delete(opts.sessionId)
          },
        }
      },
      resume: async () => {
        throw new Error('resume not expected')
      },
    },
  } as unknown as Context

  return {
    ctx,
    disposedSessions,
    archivedSessions,
    cancelCalls,
    startedTurns,
    waitForNextTurnStart: (): Promise<ActiveMockTurn> =>
      new Promise((resolve) => {
        turnStartWaiters.push(resolve)
      }),
  }
}

function makeMessage(overrides: Partial<InboundLarkMessage> & { messageId: string; text: string }): InboundLarkMessage {
  return {
    botId: 'bot-recall',
    larkAppId: 'cli_recall_1',
    botOpenId: 'ou_bot_recall',
    chatId: 'oc_recall_chat',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_user_1',
    senderType: 'user',
    rawContent: JSON.stringify({ text: overrides.text }),
    mentions: [{ key: '@_user_1', openId: 'ou_bot_recall', name: 'RecallBot' }],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

function makeRecallEvent(messageId: string, chatId = 'oc_recall_chat'): RecalledLarkMessageEvent {
  return {
    botId: 'bot-recall',
    larkAppId: 'cli_recall_1',
    messageId,
    chatId,
    recallTimeMs: Date.now(),
    recallType: 'message_owner',
  }
}

describe('Feishu message recall cancellation', () => {
  it('cancels an actively running turn via agent.cancel, suppresses replies, skips removeReaction, and preserves active multi-turn sessions', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createRecallMockRuntimeCtx()
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-recall',
      name: 'RecallBot',
      larkAppId: 'cli_recall_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupAccessMode: 'all_joined',
      receivedReactionEmoji: 'THUMBSUP',
      sendIntermediateMessages: true,
    })

    const sentReplies: unknown[] = []
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_recall', connected: true },
      addReaction: vi.fn().mockResolvedValue('react_1'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockImplementation(async (opts) => {
        sentReplies.push(opts)
        return { messageId: `om_reply_${sentReplies.length}`, rootId: 'om_root_1' }
      }),
    } as unknown as LarkBotTransport

    // Turn 1 completes normally to establish an active thread session.
    const t1Ready = runtime.waitForNextTurnStart()
    const p1 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({ messageId: 'om_root_1', text: '@RecallBot 你好' }),
    )
    const turn1 = await t1Ready
    turn1.finish('你好，请问有什么需要帮忙？')
    await p1
    expect(sentReplies).toHaveLength(1)
    expect(fakeTransport.removeReaction).toHaveBeenCalledTimes(1)

    // Turn 2 starts in the same thread and gets recalled mid-execution.
    ;(fakeTransport.removeReaction as ReturnType<typeof vi.fn>).mockClear()
    const t2Ready = runtime.waitForNextTurnStart()
    const p2 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_msg_2',
        rootId: 'om_root_1',
        parentId: 'om_root_1',
        text: '@RecallBot 帮我执行一个很慢的任务',
      }),
    )
    const turn2 = await t2Ready
    expect(manager.inbound.getActiveCount()).toBe(1)

    manager.inbound.handleMessageRecalled('bot-recall', fakeTransport, makeRecallEvent('om_msg_2'))
    // Intermediate commentary after recall must be suppressed.
    turn2.emitIntermediate('不应该被发出的过程消息')
    await p2

    expect(runtime.cancelCalls).toHaveLength(1)
    expect(runtime.cancelCalls[0]).toMatchObject({
      sessionId: turn2.sessionId,
      cause: { kind: 'user' },
      options: { keepInbox: true },
    })
    // No reply or error notice sent for the recalled turn.
    expect(sentReplies).toHaveLength(1)
    // Skip removeReaction on recalled message to avoid 230006 SDK errors.
    expect(fakeTransport.removeReaction).not.toHaveBeenCalled()
    expect(manager.inbound.getActiveCount()).toBe(0)
    expect(store.listPendingTurns()).toHaveLength(0)
    expect(manager.sessions.getActorState(turn2.sessionId)).toBe('idle')
    // Existing multi-turn session remains bound and reusable for subsequent messages.
    expect(store.listBindings()).toHaveLength(1)

    const recallAudit = store
      .listEvents(20)
      .find((e) => e.kind === 'lifecycle' && e.summary.includes('原消息已撤回'))
    expect(recallAudit).toBeDefined()

    // Turn 3 in the same thread still executes cleanly.
    const t3Ready = runtime.waitForNextTurnStart()
    const p3 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_msg_3',
        rootId: 'om_root_1',
        parentId: 'om_root_1',
        text: '@RecallBot 换个问题，当前状态如何？',
      }),
    )
    const turn3 = await t3Ready
    turn3.finish('一切正常')
    await p3
    expect(sentReplies).toHaveLength(2)

    await manager.stop()
    store.close()
  })

  it('disposes and archives a brand-new session when its very first message is recalled before any reply', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createRecallMockRuntimeCtx()
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-recall',
      name: 'RecallBot',
      larkAppId: 'cli_recall_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupAccessMode: 'all_joined',
      receivedReactionEmoji: 'NONE',
    })

    const fakeTransport = {
      state: { botOpenId: 'ou_bot_recall', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockResolvedValue({ messageId: 'om_r1' }),
    } as unknown as LarkBotTransport

    // Listener sessions start with hasReplied: false; recalling before any reply cleans up the empty session.
    store.upsertGroup({
      botId: 'bot-recall',
      chatId: 'oc_recall_chat',
      listener: {
        enabled: true,
        name: '巡检监听',
        prompt: '检查告警',
        replyMode: 'reply',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
      },
    })

    const t1Ready = runtime.waitForNextTurnStart()
    const p1 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_listener_1',
        text: '测试触发告警',
        mentions: [],
      }),
    )
    const turn1 = await t1Ready
    manager.inbound.handleMessageRecalled('bot-recall', fakeTransport, makeRecallEvent('om_listener_1'))
    await p1

    expect(fakeTransport.sendReply).not.toHaveBeenCalled()
    expect(runtime.disposedSessions).toContain(turn1.sessionId)
    expect(runtime.archivedSessions).toContain(turn1.sessionId)
    expect(store.listBindings()).toHaveLength(0)

    await manager.stop()
    store.close()
  })

  it('removes only the recalled item from a coalesced waiting queue without dropping healthy peers, and aborts the batch if all queued items are recalled', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createRecallMockRuntimeCtx()
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-recall',
      name: 'RecallBot',
      larkAppId: 'cli_recall_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupAccessMode: 'all_joined',
      receivedReactionEmoji: 'NONE',
      router: {
        enabled: false,
        coalesceQueuedMessages: true,
      },
    })

    const sentReplies: unknown[] = []
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_recall', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockImplementation(async (opts) => {
        sentReplies.push(opts)
        return { messageId: `om_reply_${sentReplies.length}` }
      }),
    } as unknown as LarkBotTransport

    // Start turn 1 so the session actor is busy.
    const t1Ready = runtime.waitForNextTurnStart()
    const p1 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({ messageId: 'om_q_root', text: '@RecallBot 任务1' }),
    )
    const turn1 = await t1Ready

    // Enqueue leader (om_q_2) and follower (om_q_3) into the coalesced waiting batch.
    const p2 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_q_2',
        rootId: 'om_q_root',
        parentId: 'om_q_root',
        text: '@RecallBot 需要被撤回的排队消息',
      }),
    )
    const p3 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_q_3',
        rootId: 'om_q_root',
        parentId: 'om_q_root',
        text: '@RecallBot 保留执行的排队消息',
      }),
    )
    await vi.waitFor(() => expect(manager.inbound.getActiveCount()).toBe(3))

    // Recall the leader (om_q_2); follower (om_q_3) must still execute once turn 1 finishes.
    manager.inbound.handleMessageRecalled('bot-recall', fakeTransport, makeRecallEvent('om_q_2'))

    const t2Ready = runtime.waitForNextTurnStart()
    turn1.finish('任务1完成')
    const turn2 = await t2Ready
    expect(turn2.userText).toContain('保留执行的排队消息')
    expect(turn2.userText).not.toContain('需要被撤回的排队消息')

    // Enqueue another message (om_q_4) while turn2 is running, then recall it before turn2 ends.
    const p4 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_q_4',
        rootId: 'om_q_root',
        parentId: 'om_q_root',
        text: '@RecallBot 单独排队后撤回',
      }),
    )
    await vi.waitFor(() => expect(manager.inbound.getActiveCount()).toBe(2))
    manager.inbound.handleMessageRecalled('bot-recall', fakeTransport, makeRecallEvent('om_q_4'))
    await p4

    turn2.finish('保留消息已完成')
    await Promise.all([p1, p2, p3])

    // Only 2 turns should have ever reached the agent (om_q_4 never started).
    expect(runtime.startedTurns).toHaveLength(2)
    expect(sentReplies).toHaveLength(2)
    expect(manager.inbound.getActiveCount()).toBe(0)
    expect(store.listPendingTurns()).toHaveLength(0)

    await manager.stop()
    store.close()
  })

  it('aborts in-flight triage evaluation, cleans triage context, and skips pending turn recovery when recalled', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)

    let triageAborted = false
    let releaseTriage!: () => void
    const triageStarted = new Promise<void>((resolve) => {
      releaseTriage = resolve
    })

    const runtime = createRecallMockRuntimeCtx({
      llmStream: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          releaseTriage()
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              triageAborted = true
              resolve()
              return
            }
            signal?.addEventListener(
              'abort',
              () => {
                triageAborted = true
                resolve()
              },
              { once: true },
            )
          })
          throw new Error('aborted')
        },
      }),
    })

    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-recall',
      name: 'RecallBot',
      larkAppId: 'cli_recall_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupAccessMode: 'all_joined',
      receivedReactionEmoji: 'NONE',
      router: {
        enabled: true,
        scope: 'all_group',
        provider: 'mock',
        model: 'mock-model',
      },
    })

    const fakeTransport = {
      state: { botOpenId: 'ou_bot_recall', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockResolvedValue({ messageId: 'om_r1' }),
      listMessages: vi.fn().mockResolvedValue([]),
    } as unknown as LarkBotTransport

    // Pre-seed triage context and a persisted pending turn to verify cleanup.
    manager.triage.context.recordChatMessage('chat:bot-recall:oc_recall_chat', {
      role: 'user',
      text: '已记录的历史消息',
      timestampMs: Date.now(),
      messageId: 'om_ctx_recalled',
    })
    store.upsertPendingTurn({
      id: 'pending-recalled-1',
      botId: 'bot-recall',
      chatId: 'oc_recall_chat',
      messageId: 'om_ctx_recalled',
      routeKey: 'cli_recall_1:oc_recall_chat:om_ctx_recalled',
      replyMode: 'reply',
      trigger: 'mention',
      allowSilentEmptyReply: false,
      startedAtMs: Date.now(),
      status: 'interrupted',
      updatedAtMs: Date.now(),
    })

    manager.inbound.handleMessageRecalled(
      'bot-recall',
      fakeTransport,
      makeRecallEvent('om_ctx_recalled'),
    )
    expect(
      manager.triage.context.getRecentMessages(
        'cli_recall_1:oc_recall_chat:om_ctx_recalled',
        'chat:bot-recall:oc_recall_chat',
      ),
    ).toHaveLength(0)
    expect(store.listPendingTurns()).toHaveLength(0)

    // Now test recall while triage LLM stream is actively running.
    const pTriage = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({ messageId: 'om_triage_1', text: '@RecallBot 帮我看下这个问题' }),
    )
    await triageStarted
    manager.inbound.handleMessageRecalled('bot-recall', fakeTransport, makeRecallEvent('om_triage_1'))
    await pTriage

    expect(triageAborted).toBe(true)
    expect(runtime.startedTurns).toHaveLength(0)
    expect(fakeTransport.sendReply).not.toHaveBeenCalled()
    expect(
      manager.triage.context.getRecentMessages(
        'cli_recall_1:oc_recall_chat:om_triage_1',
        'chat:bot-recall:oc_recall_chat',
      ),
    ).toHaveLength(0)

    // Out-of-order: recall arrives before inbound message.
    manager.inbound.handleMessageRecalled('bot-recall', fakeTransport, makeRecallEvent('om_early_1'))
    await manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({ messageId: 'om_early_1', text: '@RecallBot 乱序到达的消息' }),
    )
    expect(runtime.startedTurns).toHaveLength(0)

    await manager.stop()
    store.close()
  })

  it('records a clean lifecycle audit event when deliverReply hits Feishu 230006 (recalled message fallback)', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createRecallMockRuntimeCtx()
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-recall',
      name: 'RecallBot',
      larkAppId: 'cli_recall_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupAccessMode: 'all_joined',
      receivedReactionEmoji: 'NONE',
    })

    const err230006 = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { code: 230006, msg: 'message recalled' } },
    })
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_recall', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockRejectedValue(err230006),
    } as unknown as LarkBotTransport

    const t1Ready = runtime.waitForNextTurnStart()
    const p1 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({ messageId: 'om_230006_1', text: '@RecallBot 触发230006' }),
    )
    const turn1 = await t1Ready
    turn1.finish('回复内容')
    await p1

    expect(fakeTransport.sendReply).toHaveBeenCalledTimes(1)
    const events = store.listEvents(20)
    expect(events.some((e) => e.kind === 'lifecycle' && e.summary.includes('230006'))).toBe(true)
    expect(events.some((e) => e.kind === 'error')).toBe(false)

    await manager.stop()
    store.close()
  })

  it('does not abort an executing coalesced batch when only one peer message is recalled, and catches 230006 on triage quick_reply', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createRecallMockRuntimeCtx({
      llmStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: 'tc_qr',
              name: 'route_message',
              arguments: JSON.stringify({
                action: 'quick_reply',
                reason: '简单打招呼',
                replyText: '你好，我在！',
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        },
      }),
    })
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-recall',
      name: 'RecallBot',
      larkAppId: 'cli_recall_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupAccessMode: 'all_joined',
      receivedReactionEmoji: 'NONE',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'passive_only',
        coalesceQueuedMessages: true,
      },
    })

    const sentTargets: string[] = []
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_recall', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn(async (opts: { replyToMessageId?: string }) => {
        sentTargets.push(opts.replyToMessageId ?? '')
        return { messageId: `om_out_${sentTargets.length}` }
      }),
    } as unknown as LarkBotTransport

    // 1. Start turn 1 in a native thread so session is busy, then enqueue 2 coalesced items (om_peer_a, om_peer_b)
    const t1Ready = runtime.waitForNextTurnStart()
    const p1 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_batch_root',
        threadId: 'omt_batch_1',
        text: '@RecallBot 先做任务1',
      }),
    )
    const turn1 = await t1Ready

    const p2 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_peer_a',
        rootId: 'om_batch_root',
        parentId: 'om_batch_root',
        threadId: 'omt_batch_1',
        senderOpenId: 'ou_alice',
        text: '@RecallBot Alice 正常问题',
      }),
    )
    const p3 = manager.inbound.handleInbound(
      'bot-recall',
      fakeTransport,
      makeMessage({
        messageId: 'om_peer_b',
        rootId: 'om_batch_root',
        parentId: 'om_batch_root',
        threadId: 'omt_batch_1',
        senderOpenId: 'ou_bob',
        text: '@RecallBot Bob 稍后撤回的问题',
      }),
    )
    await vi.waitFor(() => expect(manager.inbound.getActiveCount()).toBe(3))
    await new Promise((r) => setTimeout(r, 30))

    const t2Ready = runtime.waitForNextTurnStart()
    turn1.finish('任务1完成')
    const turn2 = await t2Ready
    expect(turn2.userText).toContain('Alice 正常问题')
    expect(turn2.userText).toContain('Bob 稍后撤回的问题')

    // Recall ONLY om_peer_b (the latest item!) while the coalesced turn is running.
    manager.inbound.handleMessageRecalled('bot-recall', fakeTransport, makeRecallEvent('om_peer_b'))
    expect(runtime.cancelCalls).toHaveLength(0)

    turn2.finish('合并批次已完成')
    await Promise.all([p1, p2, p3])
    // Reply MUST still be delivered, anchored to surviving om_peer_a (NOT recalled om_peer_b)
    expect(sentTargets).toEqual(['om_batch_root', 'om_peer_a'])

    // 2. Triage quick_reply hitting Feishu 230006 settles cleanly without recording an error event
    store.upsertBot({
      id: 'bot-recall',
      name: 'RecallBot',
      larkAppId: 'cli_recall_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupAccessMode: 'all_joined',
      receivedReactionEmoji: 'NONE',
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'all_group',
      },
    })
    const err230006 = Object.assign(new Error('400'), {
      response: { data: { code: 230006, msg: 'message recalled' } },
    })
    const qrTransport = {
      state: { botOpenId: 'ou_bot_recall', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockRejectedValue(err230006),
    } as unknown as LarkBotTransport

    await manager.inbound.handleInbound(
      'bot-recall',
      qrTransport,
      makeMessage({ messageId: 'om_qr_recalled', text: '@RecallBot 在吗' }),
    )
    const events = store.listEvents(30)
    expect(events.some((e) => e.kind === 'lifecycle' && e.summary.includes('230006'))).toBe(true)
    expect(events.some((e) => e.kind === 'error')).toBe(false)

    await manager.stop()
    store.close()
  })
})
