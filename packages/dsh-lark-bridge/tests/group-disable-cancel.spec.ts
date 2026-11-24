import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InboundLarkMessage, LarkBotTransport } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-disable-cancel-'): string {
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
  readonly abort: () => void
}

function createDisableMockRuntimeCtx(options: {
  readonly persistedEventsBySession?: ReadonlyMap<string, readonly SessionEvent[]>
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
  const cancelCalls: Array<{ sessionId: string; cause: unknown }> = []
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
            id: 'ws-disable',
            title: title ?? 'demo',
            cwd: '/tmp',
            sessionIds: [],
            attachSession: vi.fn().mockResolvedValue(undefined),
            setTitle: vi.fn().mockResolvedValue(undefined),
          }),
          archivedSessionIds: [],
          archiveSession: async () => true,
        }
      }
      if (key === 'sessionPersistence' && options.persistedEventsBySession) {
        return {
          open: async (sid: string) => {
            const events = options.persistedEventsBySession?.get(String(sid)) ?? []
            return {
              read: async (offset: number, limit: number) => ({
                events: events.slice(offset, offset + limit),
              }),
              close: async () => {},
            }
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

        const cancel = vi.fn((cause: unknown) => {
          cancelCalls.push({ sessionId: opts.sessionId, cause })
          const active = activeTurnsBySession.get(opts.sessionId)
          if (active) active.abort()
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
            if (waiter) waiter(record)
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
      dispose: async (id: string) => {
        agents.delete(id)
      },
    },
  } as unknown as Context

  const waitForNextTurn = (): Promise<ActiveMockTurn> =>
    new Promise((resolve) => {
      turnStartWaiters.push(resolve)
    })

  return { ctx, cancelCalls, startedTurns, waitForNextTurn }
}

function makeFakeTransport(botOpenId = 'ou_bot_1') {
  let rxSeq = 0
  const sendReply = vi.fn().mockResolvedValue({ messageId: 'om_reply_1' })
  const addReaction = vi.fn().mockImplementation(async () => `rx_${++rxSeq}`)
  const removeReaction = vi.fn().mockResolvedValue(undefined)
  const transport = {
    state: { botOpenId, connected: true },
    addReaction,
    removeReaction,
    sendReply,
    downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as LarkBotTransport
  return { transport, sendReply, addReaction, removeReaction }
}

function makeGroupMsg(
  overrides: Partial<InboundLarkMessage> & { readonly messageId: string; readonly chatId: string },
): InboundLarkMessage {
  return {
    botId: 'bot-a',
    larkAppId: 'cli_bot_a',
    botOpenId: 'ou_bot_a',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_member_1',
    senderType: 'user',
    text: '@_user_1 排查接口延迟',
    rawContent: '{"text":"@_user_1 排查接口延迟"}',
    mentions: [{ key: '@_user_1', openId: 'ou_bot_a', name: 'BotA' }],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

describe('Group/bot disable immediate turn cancellation & recovery silence guards', () => {
  it('immediately cancels running and queued turns when a group is disabled via HTTP API without affecting other enabled groups', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createDisableMockRuntimeCtx()
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
      id: 'bot-a',
      name: 'BotA',
      larkAppId: 'cli_bot_a',
      larkAppSecret: 'mock-secret',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'OnIt',
    })
    store.upsertGroup({
      botId: 'bot-a',
      chatId: 'oc_target',
      chatName: '目标群',
      enabled: true,
    })
    store.upsertGroup({
      botId: 'bot-a',
      chatId: 'oc_other',
      chatName: '其他群',
      enabled: true,
    })

    const fake = makeFakeTransport('ou_bot_a')
    ;(
      manager as unknown as {
        connections: { transports: Map<string, { config: unknown; transport: LarkBotTransport }> }
      }
    ).connections.transports.set('bot-a', {
      config: store.getBot('bot-a')!,
      transport: fake.transport,
    })

    // 1. Start running turn in oc_target
    const targetFirstStarted = runtime.waitForNextTurn()
    const turn1 = manager.inbound.handleInbound(
      'bot-a',
      fake.transport,
      makeGroupMsg({
        chatId: 'oc_target',
        messageId: 'om_target_1',
        rootId: 'om_root_target',
        threadId: 'omt_target',
        text: '@_user_1 第一轮任务',
      }),
    )
    const activeTargetTurn = await targetFirstStarted

    // 2. Queue a second turn behind it in the same thread
    const turn2 = manager.inbound.handleInbound(
      'bot-a',
      fake.transport,
      makeGroupMsg({
        chatId: 'oc_target',
        messageId: 'om_target_2',
        rootId: 'om_root_target',
        threadId: 'omt_target',
        text: '@_user_1 排队中的第二轮任务',
      }),
    )

    // 3. Also start an independent turn in oc_other (must remain unaffected)
    const otherStarted = runtime.waitForNextTurn()
    const otherTurn = manager.inbound.handleInbound(
      'bot-a',
      fake.transport,
      makeGroupMsg({
        chatId: 'oc_other',
        messageId: 'om_other_1',
        text: '@_user_1 其他群正常任务',
      }),
    )
    const activeOtherTurn = await otherStarted

    // Allow turn2 to enter the waiting queue
    await new Promise((r) => setTimeout(r, 20))

    // 4. Disable oc_target through the exact same HTTP route the UI switch calls
    const res = await dispatchLarkApiRequest(runtime.ctx, manager, {
      method: 'PUT',
      path: '/api/lark-bridge/groups/bot-a/oc_target',
      body: { enabled: false },
    })
    expect(res.status).toBe(200)

    await Promise.all([turn1, turn2])

    // Running turn in oc_target was cancelled; queued turn2 never started
    expect(runtime.cancelCalls.some((c) => c.sessionId === activeTargetTurn.sessionId)).toBe(true)
    expect(runtime.startedTurns.filter((t) => t.sessionId === activeTargetTurn.sessionId)).toHaveLength(1)
    expect(fake.sendReply).not.toHaveBeenCalled()
    // Reactions on oc_target messages were cleaned up
    expect(fake.removeReaction).toHaveBeenCalledWith('om_target_1', expect.any(String))
    expect(fake.removeReaction).toHaveBeenCalledWith('om_target_2', expect.any(String))
    expect(store.listPendingTurns().filter((p) => p.chatId === 'oc_target')).toHaveLength(0)

    const lifecycleEvents = store
      .listEvents(20)
      .filter((e) => e.chatId === 'oc_target' && e.kind === 'lifecycle')
    expect(lifecycleEvents.some((e) => e.summary.includes('群聊响应开关已关闭'))).toBe(true)

    // 5. Independent turn in oc_other completes and replies normally
    activeOtherTurn.finish('其他群正常回复')
    await otherTurn
    expect(fake.sendReply).toHaveBeenCalledTimes(1)
    expect(fake.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'oc_other', replyToMessageId: 'om_other_1' }),
    )

    await manager.stop()
    store.close()
  })

  it('skips both completed redelivery and auto-resume during startup recovery when a group is disabled, and never silences recovered @mention turns via rejected silence tool calls', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const disabledSessionId = 'session-disabled-completed'
    const mentionSessionId = 'session-mention-rejected-silence'

    const persisted = new Map<string, readonly SessionEvent[]>([
      [
        disabledSessionId,
        [
          { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent,
          {
            type: 'user/message',
            data: { content: [{ type: 'text', text: 'message_id="om_disabled_done"' }] },
          } as unknown as SessionEvent,
          {
            type: 'assistant/message',
            data: {
              turn: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: '迟到的回复不应发出' }] },
            },
          } as unknown as SessionEvent,
          {
            type: 'turn/end',
            data: { turn: 1, reason: { kind: 'completed' } },
          } as unknown as SessionEvent,
        ],
      ],
      [
        mentionSessionId,
        [
          { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent,
          {
            type: 'user/message',
            data: { content: [{ type: 'text', text: 'message_id="om_mention_done"' }] },
          } as unknown as SessionEvent,
          {
            type: 'tool/call',
            data: {
              turn: 1,
              name: 'bash',
              arguments: '{"command":"lark-bridge silence --reason test"}',
            },
          } as unknown as SessionEvent,
          {
            type: 'assistant/message',
            data: {
              turn: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: '显式 @ 回复必须送达' }] },
            },
          } as unknown as SessionEvent,
          {
            type: 'turn/end',
            data: { turn: 1, reason: { kind: 'completed' } },
          } as unknown as SessionEvent,
        ],
      ],
    ])

    const runtime = createDisableMockRuntimeCtx({ persistedEventsBySession: persisted })
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
      id: 'bot-a',
      name: 'BotA',
      larkAppId: 'cli_bot_a',
      larkAppSecret: 'mock-secret',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      useInteractiveCard: false,
    })
    store.upsertGroup({
      botId: 'bot-a',
      chatId: 'oc_disabled_group',
      chatName: '已关闭群',
      enabled: false,
    })
    store.upsertGroup({
      botId: 'bot-a',
      chatId: 'oc_enabled_group',
      chatName: '已开启群',
      enabled: true,
    })

    const fake = makeFakeTransport('ou_bot_a')
    ;(
      manager as unknown as {
        connections: { transports: Map<string, { config: unknown; transport: LarkBotTransport }> }
      }
    ).connections.transports.set('bot-a', {
      config: store.getBot('bot-a')!,
      transport: fake.transport,
    })

    const nowMs = Date.now()
    store.upsertPendingTurn({
      id: 'pt-disabled-1',
      botId: 'bot-a',
      chatId: 'oc_disabled_group',
      chatName: '已关闭群',
      messageId: 'om_disabled_done',
      routeKey: 'cli_bot_a:oc_disabled_group:om_disabled_done',
      replyMode: 'reply',
      trigger: 'active-thread',
      allowSilentEmptyReply: false,
      reactionId: 'rx_disabled_1',
      sessionId: disabledSessionId,
      startedAtMs: nowMs - 10_000,
      status: 'interrupted',
      inboundMsg: makeGroupMsg({ chatId: 'oc_disabled_group', messageId: 'om_disabled_done' }),
      updatedAtMs: nowMs,
    })
    store.upsertPendingTurn({
      id: 'pt-mention-1',
      botId: 'bot-a',
      chatId: 'oc_enabled_group',
      chatName: '已开启群',
      messageId: 'om_mention_done',
      routeKey: 'cli_bot_a:oc_enabled_group:om_mention_done',
      replyMode: 'reply',
      trigger: 'mention',
      allowSilentEmptyReply: false,
      reactionId: 'rx_mention_1',
      sessionId: mentionSessionId,
      startedAtMs: nowMs - 10_000,
      status: 'interrupted',
      inboundMsg: makeGroupMsg({ chatId: 'oc_enabled_group', messageId: 'om_mention_done' }),
      updatedAtMs: nowMs,
    })

    const recovered = await manager.inbound.recoverStalePendingTurns('bot-a')
    expect(recovered).toBe(2)
    expect(store.listPendingTurns()).toHaveLength(0)

    // Disabled group pending turn was skipped (no sendReply, reaction removed)
    expect(fake.removeReaction).toHaveBeenCalledWith('om_disabled_done', 'rx_disabled_1')
    expect(fake.sendReply).toHaveBeenCalledTimes(1)
    expect(fake.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'oc_enabled_group',
        replyToMessageId: 'om_mention_done',
        text: '显式 @ 回复必须送达',
      }),
    )

    await manager.stop()
    store.close()
  })

  it('cancels in-flight turns when the owning bot is toggled off via HTTP API', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createDisableMockRuntimeCtx()
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
      id: 'bot-a',
      name: 'BotA',
      larkAppId: 'cli_bot_a',
      larkAppSecret: 'mock-secret',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'OnIt',
    })
    store.upsertGroup({
      botId: 'bot-a',
      chatId: 'oc_bot_toggle',
      chatName: '停用测试群',
      enabled: true,
    })

    const fake = makeFakeTransport('ou_bot_a')
    ;(
      manager as unknown as {
        connections: { transports: Map<string, { config: unknown; transport: LarkBotTransport }> }
      }
    ).connections.transports.set('bot-a', {
      config: store.getBot('bot-a')!,
      transport: fake.transport,
    })

    const started = runtime.waitForNextTurn()
    const turnPromise = manager.inbound.handleInbound(
      'bot-a',
      fake.transport,
      makeGroupMsg({ chatId: 'oc_bot_toggle', messageId: 'om_bot_toggle_1' }),
    )
    const activeTurn = await started

    const res = await dispatchLarkApiRequest(runtime.ctx, manager, {
      method: 'POST',
      path: '/api/lark-bridge/bots/bot-a/toggle',
      body: {},
    })
    expect(res.status).toBe(200)
    await turnPromise

    expect(runtime.cancelCalls.some((c) => c.sessionId === activeTurn.sessionId)).toBe(true)
    expect(fake.sendReply).not.toHaveBeenCalled()
    expect(fake.removeReaction).toHaveBeenCalledWith('om_bot_toggle_1', expect.any(String))
    expect(
      store
        .listEvents(20)
        .some((e) => e.kind === 'lifecycle' && e.summary.includes('智能体已停用')),
    ).toBe(true)

    await manager.stop()
    store.close()
  })
})
