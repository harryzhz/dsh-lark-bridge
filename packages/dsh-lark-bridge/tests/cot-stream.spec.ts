import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  type CotEventPayload,
  type CreateCotMessageOptions,
  type InboundLarkMessage,
  type LarkBotTransport,
  type SendLarkReplyInput,
} from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import {
  TurnCotController,
  closeOrphanCotBubble,
  type CotTransportLike,
  type TurnCotInputEvent,
} from '../src/cot-stream-controller.js'
import { handleSlashCommand } from '../src/slash-commands.js'
import { LarkBridgeStore } from '../src/store.js'
import { runTurnAndCollectReply } from '../src/turn-runner.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-cot-'): string {
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

function createMockCotTransport(overrides: Partial<CotTransportLike> = {}) {
  const created: CreateCotMessageOptions[] = []
  const appended: Array<{ cotId: string; messageId: string; events: readonly CotEventPayload[] }> =
    []
  const completed: Array<{ cotId: string; messageId: string; reason: 'done' | 'error' }> = []

  const transport: CotTransportLike = {
    createCotMessage:
      overrides.createCotMessage ??
      vi.fn(async (opts: CreateCotMessageOptions) => {
        created.push(opts)
        return { cotId: `cot_${created.length}`, messageId: `om_cot_${created.length}` }
      }),
    appendCotEvents:
      overrides.appendCotEvents ??
      vi.fn(async (cotId: string, messageId: string, events: readonly CotEventPayload[]) => {
        appended.push({ cotId, messageId, events })
        return { alreadyTerminal: false }
      }),
    completeCotMessage:
      overrides.completeCotMessage ??
      vi.fn(async (cotId: string, messageId: string, reason: 'done' | 'error') => {
        completed.push({ cotId, messageId, reason })
        return { alreadyTerminal: false }
      }),
  }

  const allEventTypes = () => appended.flatMap((b) => b.events.map((e) => e.event_type))

  return { transport, created, appended, completed, allEventTypes }
}

describe('TurnCotController & closeOrphanCotBubble', () => {
  it('stays lazy and creates no Feishu CoT bubble when a turn emits no reasoning or tool calls', async () => {
    const mock = createMockCotTransport()
    const onSettled = vi.fn()
    const controller = new TurnCotController({
      transport: mock.transport,
      chatId: 'oc_chat_1',
      chatType: 'group',
      replyMode: 'reply',
      messageId: 'om_msg_1',
      threadKey: 'sess-1',
      runId: 'run-1',
      toolResultEnabled: true,
      onSettled,
    })

    await controller.finish('done')
    expect(mock.created).toHaveLength(0)
    expect(mock.appended).toHaveLength(0)
    expect(mock.completed).toHaveLength(0)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('streams reasoning deltas, deduplicates committed reasoning of the same step, and emits tool calls & results', async () => {
    const mock = createMockCotTransport()
    const onCreated = vi.fn()
    const controller = new TurnCotController({
      transport: mock.transport,
      chatId: 'oc_chat_1',
      chatType: 'group',
      replyMode: 'new-topic',
      messageId: 'om_msg_1',
      threadKey: 'sess-1',
      runId: 'run-stream',
      toolResultEnabled: true,
      flushIntervalMs: 25,
      onCreated,
    })

    controller.push({
      type: 'reasoning-delta',
      blockKey: 'b1',
      stepKey: '1:1',
      text: '先读取配置文件',
    })
    controller.push({
      type: 'reasoning-delta',
      blockKey: 'b1',
      stepKey: '1:1',
      text: '确认端口设置',
    })
    controller.push({ type: 'reasoning-block-end', blockKey: 'b1' })
    // Committed reasoning for the same step must be skipped to prevent duplicate paragraphs
    controller.push({
      type: 'reasoning-message',
      stepKey: '1:1',
      text: '先读取配置文件确认端口设置',
    })
    controller.push({
      type: 'tool-call',
      callId: 'tc_1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/config.ts' }),
    })
    controller.push({
      type: 'tool-result',
      callId: 'tc_1',
      output: 'export const PORT = 3890',
      isError: false,
    })

    await controller.finish('done')

    expect(onCreated).toHaveBeenCalledWith({ cotId: 'cot_1', messageId: 'om_cot_1' })
    expect(mock.created).toEqual([
      { chatId: 'oc_chat_1', originMessageId: 'om_msg_1', replyInThread: true },
    ])
    const types = mock.allEventTypes()
    expect(types[0]).toBe('RUN_STARTED')
    expect(types[1]).toBe('REASONING_START')
    expect(types.filter((t) => t === 'REASONING_MESSAGE_START')).toHaveLength(1)
    expect(types).toContain('TOOL_CALL_START')
    expect(types).toContain('TOOL_CALL_RESULT')
    expect(types.slice(-2)).toEqual(['REASONING_END', 'RUN_FINISHED'])
    // Normal completion closes via RUN_FINISHED without needing explicit complete endpoint
    expect(mock.completed).toHaveLength(0)
  })

  it('inserts a placeholder reasoning node when a turn starts directly with a tool call and respects toolResultEnabled=false', async () => {
    const mock = createMockCotTransport()
    const controller = new TurnCotController({
      transport: mock.transport,
      chatId: 'oc_chat_1',
      chatType: 'p2p',
      replyMode: 'reply',
      messageId: 'om_msg_2',
      threadKey: 'sess-2',
      runId: 'run-direct-tool',
      toolResultEnabled: false,
    })

    controller.push({
      type: 'tool-call',
      callId: 'tc_direct',
      name: 'bash',
      arguments: JSON.stringify({ command: 'ls -la' }),
    })
    controller.push({
      type: 'tool-result',
      callId: 'tc_direct',
      output: 'README.md',
      isError: false,
    })

    await controller.finish('done')

    const types = mock.allEventTypes()
    const placeholderStartIdx = types.indexOf('REASONING_MESSAGE_START')
    const toolStartIdx = types.indexOf('TOOL_CALL_START')
    expect(placeholderStartIdx).toBeGreaterThan(-1)
    expect(toolStartIdx).toBeGreaterThan(placeholderStartIdx)
    const resultEvent = mock.appended
      .flatMap((b) => b.events)
      .find((e) => e.event_type === 'TOOL_CALL_RESULT')
    expect(resultEvent).toBeDefined()
    const outer = JSON.parse(resultEvent!.content) as { content: string }
    expect(JSON.parse(outer.content)).toEqual({ type: 'text', text: '已完成' })
  })

  it('isolates append failures and explicitly closes created bubbles on finish/interruption', async () => {
    let appendCount = 0
    const mock = createMockCotTransport({
      appendCotEvents: vi.fn(async () => {
        appendCount += 1
        if (appendCount === 1) throw new Error('network_blip')
        return { alreadyTerminal: false }
      }),
    })
    const logs: string[] = []
    const controller = new TurnCotController({
      transport: mock.transport,
      chatId: 'oc_chat_1',
      chatType: 'p2p',
      replyMode: 'reply',
      messageId: 'om_msg_3',
      threadKey: 'sess-3',
      runId: 'run-fault',
      toolResultEnabled: true,
      log: (_lvl, msg) => logs.push(msg),
    })

    controller.push({ type: 'reasoning-message', text: '正在排查日志' })
    await sleep(20)
    await controller.finish('interrupted', { notice: '执行中断' })

    expect(controller.isDisabled).toBe(true)
    expect(controller.isSettled).toBe(true)
    expect(mock.completed).toEqual([
      { cotId: 'cot_1', messageId: 'om_cot_1', reason: 'error' },
    ])
    expect(logs.length).toBeGreaterThan(0)
  })

  it('annotates before completing in closeOrphanCotBubble when reason is error', async () => {
    const mock = createMockCotTransport()
    await closeOrphanCotBubble(mock.transport, {
      cotId: 'cot_orphan',
      messageId: 'om_cot_orphan',
      reason: 'error',
      notice: '服务重启中断',
    })

    expect(mock.appended).toHaveLength(1)
    expect(mock.allEventTypes()).toEqual([
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
    ])
    expect(mock.completed).toEqual([
      { cotId: 'cot_orphan', messageId: 'om_cot_orphan', reason: 'error' },
    ])
  })
})

describe('/cot slash command, SQLite v12 migration, and turn-runner event forwarding', () => {
  it('handles /cot in P2P and enforces admin permission in groups', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    try {
      const bot = store.upsertBot({
        id: 'cot-bot',
        name: 'CoT-Bot',
        larkAppId: 'cli_cot_cmd',
        larkAppSecret: 'sec_demo',
        defaultWorkingDir: dir,
        adminUsers: ['ou_admin_1'],
      })

      const replies: string[] = []
      const deps = {
        ctx: {} as Context,
        store,
        runtimes: {} as never,
        unbindRoute: vi.fn(async () => false),
        sessionWebUrl: (sid: string) => `http://example.local/${sid}`,
        runTurn: vi.fn(async () => ''),
      }

      // P2P: turn on bot default
      await handleSlashCommand(deps, {
        bot,
        chatType: 'p2p',
        chatId: 'oc_p2p_1',
        senderOpenId: 'ou_member_1',
        senderType: 'user',
        command: { name: 'cot', args: 'on' },
        routeKey: 'cli_cot_cmd:oc_p2p_1',
        workingDir: dir,
        workspaceName: 'demo',
        reply: async (t) => {
          replies.push(t)
        },
      })
      expect(store.getBot('cot-bot')?.cotEnabled).toBe(true)
      expect(replies.at(-1)).toContain('已开启')

      // Group: non-admin cannot toggle
      const nonAdminReplies: string[] = []
      await handleSlashCommand(deps, {
        bot: store.getBot('cot-bot')!,
        chatType: 'group',
        chatId: 'oc_group_1',
        senderOpenId: 'ou_member_2',
        senderType: 'user',
        command: { name: 'cot', args: 'off' },
        routeKey: 'cli_cot_cmd:oc_group_1',
        workingDir: dir,
        workspaceName: 'demo',
        reply: async (t) => {
          nonAdminReplies.push(t)
        },
      })
      expect(nonAdminReplies[0]).toContain('管理员')
      expect(store.getGroup('cot-bot', 'oc_group_1')).toBeUndefined()

      // Group: admin can override to off and back to inherit
      const adminReplies: string[] = []
      await handleSlashCommand(deps, {
        bot: store.getBot('cot-bot')!,
        chatType: 'group',
        chatId: 'oc_group_1',
        senderOpenId: 'ou_admin_1',
        senderType: 'user',
        command: { name: 'cot', args: 'off' },
        routeKey: 'cli_cot_cmd:oc_group_1',
        workingDir: dir,
        workspaceName: 'demo',
        reply: async (t) => {
          adminReplies.push(t)
        },
      })
      expect(store.getGroup('cot-bot', 'oc_group_1')?.cotEnabled).toBe('off')
      expect(adminReplies.at(-1)).toContain('关闭')

      await handleSlashCommand(deps, {
        bot: store.getBot('cot-bot')!,
        group: store.getGroup('cot-bot', 'oc_group_1'),
        chatType: 'group',
        chatId: 'oc_group_1',
        senderOpenId: 'ou_admin_1',
        senderType: 'user',
        command: { name: 'cot', args: 'inherit' },
        routeKey: 'cli_cot_cmd:oc_group_1',
        workingDir: dir,
        workspaceName: 'demo',
        reply: async (t) => {
          adminReplies.push(t)
        },
      })
      expect(store.getGroup('cot-bot', 'oc_group_1')?.cotEnabled).toBe('inherit')
      expect(adminReplies.at(-1)).toContain('跟随智能体默认')
    } finally {
      store.close()
    }
  })

  it('persists and hydrates cotId and cotMessageId in pending_turns (SQLite migration v12)', () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    try {
      store.upsertPendingTurn({
        id: 'pt-cot-1',
        botId: 'cot-bot',
        chatId: 'oc_chat_1',
        messageId: 'om_msg_1',
        routeKey: 'cli_cot:oc_chat_1',
        replyMode: 'reply',
        trigger: 'mention',
        allowSilentEmptyReply: false,
        startedAtMs: 1_000,
        cotId: 'cot_persisted_1',
        cotMessageId: 'om_cot_persisted_1',
      })

      const loaded = store.listPendingTurns()
      expect(loaded).toHaveLength(1)
      expect(loaded[0]!.cotId).toBe('cot_persisted_1')
      expect(loaded[0]!.cotMessageId).toBe('om_cot_persisted_1')
    } finally {
      store.close()
    }
  })

  it('forwards live agent/assistant-stream reasoning deltas and session/event tool events to onCotEvent', async () => {
    const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const session = { id: 'sess-cot-runner' } as unknown as Session
    const ctx = {
      on(name: string, fn: (...args: unknown[]) => void) {
        let set = eventListeners.get(name)
        if (!set) {
          set = new Set()
          eventListeners.set(name, set)
        }
        set.add(fn)
        return () => {
          set!.delete(fn)
        }
      },
    } as unknown as Context

    const emitEvent = (name: string, ...args: unknown[]) => {
      for (const fn of eventListeners.get(name) ?? []) fn(...args)
    }

    const received: TurnCotInputEvent[] = []
    const agent = {
      session,
      followup(userMsg: { id?: string }) {
        emitEvent('session/event', session, { type: 'turn/start', data: { turn: 1 } })
        emitEvent('session/event', session, {
          type: 'user/message',
          data: { id: userMsg.id, turn: 1 },
        })
        emitEvent('agent/assistant-stream', {
          agent: { session },
          frame: { type: 'start', attemptId: 'att-1', turn: 1, step: 1 },
        })
        emitEvent('agent/assistant-stream', {
          agent: { session },
          frame: {
            type: 'chunk',
            attemptId: 'att-1',
            chunk: { type: 'reasoning-delta', index: 0, text: '流式思考中...' },
          },
        })
        emitEvent('agent/assistant-stream', {
          agent: { session },
          frame: {
            type: 'chunk',
            attemptId: 'att-1',
            chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '流式思考中...' } },
          },
        })
        emitEvent('agent/assistant-stream', {
          agent: { session },
          frame: { type: 'end', attemptId: 'att-1' },
        })
        emitEvent('session/event', session, {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 1,
            message: {
              content: [
                { type: 'reasoning', text: '流式思考中...' },
                { type: 'text', text: '先检查代码目录。' },
                { type: 'tool-call', id: 'tc-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
              ],
            },
          },
        })
        emitEvent('session/event', session, {
          type: 'tool/call',
          data: {
            turn: 1,
            step: 1,
            callId: 'tc-1',
            name: 'read_file',
            arguments: '{"path":"a.ts"}',
          },
        })
        emitEvent('session/event', session, {
          type: 'tool/result',
          data: {
            turn: 1,
            step: 1,
            message: {
              toolCallId: 'tc-1',
              isError: false,
              content: [{ type: 'text', text: 'export const x = 1' }],
            },
          },
        })
        emitEvent('session/event', session, {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 2,
            message: {
              content: [{ type: 'text', text: '最终答复：一切正常。' }],
            },
          },
        })
        emitEvent('session/event', session, {
          type: 'turn/end',
          data: { turn: 1, reason: { type: 'done' } },
        })
      },
    } as unknown as Agent

    const reply = await runTurnAndCollectReply(ctx, agent, '帮我查一下', {
      onCotEvent: (ev) => received.push(ev),
    })

    expect(reply).toBe('最终答复：一切正常。')
    expect(received.some((e) => e.type === 'reasoning-delta' && e.text === '流式思考中...')).toBe(
      true,
    )
    expect(received.some((e) => e.type === 'reasoning-block-end')).toBe(true)
    expect(received.some((e) => e.type === 'commentary-text' && e.text === '先检查代码目录。')).toBe(
      true,
    )
    expect(received.some((e) => e.type === 'tool-call' && e.callId === 'tc-1')).toBe(true)
    expect(
      received.some(
        (e) => e.type === 'tool-result' && e.callId === 'tc-1' && e.output === 'export const x = 1',
      ),
    ).toBe(true)
  })
})

describe('InboundPipeline native CoT end-to-end lifecycle & orphan recovery', () => {
  function createPipelineHarness(cotEnabled: boolean) {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const agents = new Map<string, { session: Session; followup: (msg: unknown) => void }>()
    let turnSeq = 0

    const emitEvent = (name: string, ...args: unknown[]) => {
      for (const fn of [...(eventListeners.get(name) ?? [])]) fn(...args)
    }

    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      get: (key: string) => {
        if (key === 'workspaceRegistry') {
          return {
            list: () => [],
            archivedSessionIds: [] as string[],
            create: async (_cwd: string, title?: string) => ({
              id: 'ws-cot',
              title: title ?? 'demo',
              cwd: dir,
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
      effect: () => () => {},
      on: (name: string, fn: (...args: unknown[]) => void) => {
        let set = eventListeners.get(name)
        if (!set) {
          set = new Set()
          eventListeners.set(name, set)
        }
        set.add(fn)
        return () => {
          set!.delete(fn)
        }
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
            followup: (userMsg: { id?: string }) => {
              const turn = ++turnSeq
              queueMicrotask(() => {
                emitEvent('session/event', session, { type: 'turn/start', data: { turn } })
                emitEvent('session/event', session, {
                  type: 'user/message',
                  data: { id: userMsg.id, turn },
                })
                emitEvent('agent/assistant-stream', {
                  agent: { session },
                  frame: { type: 'start', attemptId: 'att-e2e-1', turn, step: 1 },
                })
                emitEvent('agent/assistant-stream', {
                  agent: { session },
                  frame: {
                    type: 'chunk',
                    attemptId: 'att-e2e-1',
                    chunk: { type: 'reasoning-delta', index: 0, text: '分析日志中...' },
                  },
                })
                emitEvent('agent/assistant-stream', {
                  agent: { session },
                  frame: {
                    type: 'chunk',
                    attemptId: 'att-e2e-1',
                    chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '分析日志中...' } },
                  },
                })
                emitEvent('agent/assistant-stream', {
                  agent: { session },
                  frame: { type: 'end', attemptId: 'att-e2e-1' },
                })
                emitEvent('session/event', session, {
                  type: 'assistant/message',
                  data: {
                    turn,
                    step: 1,
                    message: {
                      role: 'assistant',
                      content: [
                        { type: 'reasoning', text: '分析日志中...' },
                        {
                          type: 'tool-call',
                          id: 'call_bash_1',
                          name: 'bash',
                          arguments: '{"command":"pnpm test"}',
                        },
                      ],
                    },
                  },
                })
                emitEvent('session/event', session, {
                  type: 'tool/call',
                  data: {
                    turn,
                    step: 1,
                    callId: 'call_bash_1',
                    name: 'bash',
                    arguments: '{"command":"pnpm test"}',
                  },
                })
                emitEvent('session/event', session, {
                  type: 'tool/result',
                  data: {
                    turn,
                    step: 1,
                    message: {
                      toolCallId: 'call_bash_1',
                      isError: false,
                      content: [{ type: 'text', text: 'PASS 10/10' }],
                    },
                  },
                })
                emitEvent('session/event', session, {
                  type: 'assistant/message',
                  data: {
                    turn,
                    step: 2,
                    message: {
                      role: 'assistant',
                      content: [{ type: 'text', text: '全部测试已通过。' }],
                    },
                  },
                })
                emitEvent('session/event', session, {
                  type: 'turn/end',
                  data: { turn, reason: { type: 'done' } },
                })
              })
            },
            abort: vi.fn(),
          }
          agents.set(opts.sessionId, agent)
          return {
            agent,
            dispose: vi.fn().mockResolvedValue(undefined),
          }
        },
        resume: vi.fn(),
        dispose: vi.fn(async () => {}),
      },
    } as unknown as Context

    const bot = store.upsertBot(
      LarkBotConfigSchema.parse({
        id: 'cot-e2e-bot',
        name: 'CoT-E2E',
        larkAppId: 'cli_cot_e2e',
        larkAppSecret: 'sec_demo',
        defaultWorkingDir: dir,
        agentPreset: 'standard',
        groupAccessMode: 'all_joined',
        useInteractiveCard: false,
        cotEnabled,
        cotToolResultEnabled: true,
      }),
    )

    const manager = new LarkBridgeManager(
      ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        longTurnAnchorMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
        syncGlobalCliAndSkill: false,
        enableInstanceLock: false,
      },
      store,
    )

    const sentReplies: SendLarkReplyInput[] = []
    const cotMock = createMockCotTransport()
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_e2e', connected: true },
      sendReply: vi.fn(async (input: SendLarkReplyInput) => {
        sentReplies.push(input)
        return { messageId: `om_reply_${sentReplies.length}` }
      }),
      addReaction: vi.fn(async () => 'react_1'),
      removeReaction: vi.fn(async () => {}),
      getUserName: vi.fn(async () => '测试同学'),
      getCachedUserName: vi.fn(() => '测试同学'),
      resolveUserSummary: vi.fn(async (openId: string) => ({ openId, name: '测试同学' })),
      createCotMessage: cotMock.transport.createCotMessage,
      appendCotEvents: cotMock.transport.appendCotEvents,
      completeCotMessage: cotMock.transport.completeCotMessage,
    } as unknown as LarkBotTransport

    // Inject active transport into connection pool
    const pool = (
      manager as unknown as {
        connections: {
          transports: Map<string, { config: typeof bot; transport: LarkBotTransport }>
        }
      }
    ).connections
    pool.transports.set(bot.id, { config: bot, transport: fakeTransport })

    return { dir, store, manager, bot, fakeTransport, sentReplies, cotMock }
  }

  it('creates, streams, and finishes native CoT bubble before delivering the final reply when enabled', async () => {
    const h = createPipelineHarness(true)
    try {
      const msg: InboundLarkMessage = {
        botId: h.bot.id,
        larkAppId: h.bot.larkAppId,
        botOpenId: 'ou_bot_e2e',
        messageId: 'om_in_1',
        chatId: 'oc_group_cot',
        chatType: 'group',
        msgType: 'text',
        senderOpenId: 'ou_sender_1',
        senderType: 'user',
        text: '@_user_1 跑一下单测',
        rawContent: '{"text":"@_user_1 跑一下单测"}',
        mentions: [{ key: '@_user_1', openId: 'ou_bot_e2e', name: 'CoT-E2E' }],
        imageKeys: [],
        createTimeMs: Date.now(),
      }

      await h.manager.handleInbound(h.bot.id, h.fakeTransport, msg)

      expect(h.cotMock.created).toHaveLength(1)
      expect(h.cotMock.allEventTypes()).toContain('TOOL_CALL_START')
      expect(h.cotMock.allEventTypes()).toContain('TOOL_CALL_RESULT')
      expect(h.cotMock.allEventTypes().slice(-2)).toEqual(['REASONING_END', 'RUN_FINISHED'])
      expect(h.sentReplies).toHaveLength(1)
      expect(h.sentReplies[0]!.text).toBe('全部测试已通过。')
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })

  it('does not call Feishu CoT API when cotEnabled is false', async () => {
    const h = createPipelineHarness(false)
    try {
      const msg: InboundLarkMessage = {
        botId: h.bot.id,
        larkAppId: h.bot.larkAppId,
        botOpenId: 'ou_bot_e2e',
        messageId: 'om_in_2',
        chatId: 'oc_group_cot',
        chatType: 'group',
        msgType: 'text',
        senderOpenId: 'ou_sender_1',
        senderType: 'user',
        text: '@_user_1 跑一下单测',
        rawContent: '{"text":"@_user_1 跑一下单测"}',
        mentions: [{ key: '@_user_1', openId: 'ou_bot_e2e', name: 'CoT-E2E' }],
        imageKeys: [],
        createTimeMs: Date.now(),
      }

      await h.manager.handleInbound(h.bot.id, h.fakeTransport, msg)

      expect(h.cotMock.created).toHaveLength(0)
      expect(h.sentReplies).toHaveLength(1)
      expect(h.sentReplies[0]!.text).toBe('全部测试已通过。')
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })

  it('closes persisted orphan CoT bubbles during startup recoverStalePendingTurns cleanup', async () => {
    const h = createPipelineHarness(true)
    try {
      h.store.upsertPendingTurn({
        id: 'orphan-turn-1',
        botId: h.bot.id,
        chatId: 'oc_group_cot',
        messageId: 'om_orphan_in',
        routeKey: `${h.bot.larkAppId}:oc_group_cot`,
        replyMode: 'reply',
        trigger: 'mention',
        allowSilentEmptyReply: false,
        startedAtMs: Date.now() - 60_000,
        cotId: 'cot_stale_99',
        cotMessageId: 'om_cot_stale_99',
      })

      const inbound = (
        h.manager as unknown as {
          inbound: { recoverStalePendingTurns: (botId?: string) => Promise<number> }
        }
      ).inbound

      const recovered = await inbound.recoverStalePendingTurns(h.bot.id)
      expect(recovered).toBe(1)
      expect(h.cotMock.completed).toEqual([
        { cotId: 'cot_stale_99', messageId: 'om_cot_stale_99', reason: 'error' },
      ])
      expect(h.store.listPendingTurns()).toHaveLength(0)
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })
})
