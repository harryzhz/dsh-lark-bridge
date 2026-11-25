import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  type InboundLarkMessage,
  type LarkBotTransport,
  type SendLarkProactiveOptions,
  type SendLarkReplyOptions,
} from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lark-thread-fork-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeGroupMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-fork',
    larkAppId: 'cli_fork_app',
    botOpenId: 'ou_bot_fork',
    messageId: 'om_msg_default',
    chatId: 'oc_fork_group',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_alice',
    senderType: 'user',
    text: '@_bot_1 你好',
    rawContent: '{}',
    mentions: [{ key: '@_bot_1', openId: 'ou_bot_fork', name: 'ForkBot' }],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

interface TurnGate {
  readonly sessionId: string
  readonly prompt: string
  readonly resolve: (replyText: string) => void
}

function createControllableRuntime() {
  const createdSessionIds: string[] = []
  const submittedBySession = new Map<string, string[]>()
  const activeGates: TurnGate[] = []
  const gateWaiters: Array<(gate: TurnGate) => void> = []
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agentsMap = new Map<string, Agent>()
  let autoReply: ((sessionId: string, prompt: string) => string) | undefined
  let turnSeq = 0

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  const notifyGate = (gate: TurnGate) => {
    const waiter = gateWaiters.shift()
    if (waiter) {
      waiter(gate)
    } else {
      activeGates.push(gate)
    }
  }

  const waitForNextTurn = (): Promise<TurnGate> => {
    const existing = activeGates.shift()
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve) => {
      gateWaiters.push(resolve)
    })
  }

  const makeAgent = (sessionId: string, cwd: string): Agent => {
    const session = {
      id: sessionId,
      header: { cwd, agentPreset: 'standard' },
      snapshotEvents: () => [],
      append: vi.fn(),
    } as unknown as Session

    const agent = {
      session,
      followup: vi.fn(
        (userMsg: { id?: string; content?: Array<{ type: string; text?: string }> }) => {
          const turn = ++turnSeq
          const prompt = (userMsg.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n')
          const list = submittedBySession.get(sessionId) ?? []
          list.push(prompt)
          submittedBySession.set(sessionId, list)

          emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
          emit(session, {
            type: 'user/message',
            data: { id: userMsg.id, turn },
          } as unknown as SessionEvent)

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

          if (autoReply) {
            const replyText = autoReply(sessionId, prompt)
            queueMicrotask(() => finish(replyText))
            return
          }
          notifyGate({ sessionId, prompt, resolve: finish })
        },
      ),
      cancel: vi.fn(),
      model: {
        current: () => ({ provider: 'mock', model: 'mock-model' }),
        select: vi.fn(),
      },
    } as unknown as Agent
    agentsMap.set(sessionId, agent)
    return agent
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaceRegistry') {
        return {
          list: () => [],
          create: async (_cwd: string, title?: string) => ({
            id: 'ws-fork',
            title: title ?? 'ws',
            cwd: '/tmp',
            sessionIds: [],
            attachSession: vi.fn().mockResolvedValue(undefined),
            setTitle: vi.fn().mockResolvedValue(undefined),
          }),
          archiveSession: vi.fn().mockResolvedValue(true),
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
    agents: {
      listPresets: () => [{ id: 'standard', name: 'Standard', defaultModel: 'mock-model' }],
      create: vi.fn(
        async (opts: {
          sessionId: string
          meta: { cwd: string }
        }): Promise<AgentHandle> => {
          createdSessionIds.push(opts.sessionId)
          const agent = makeAgent(opts.sessionId, opts.meta.cwd)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) } as unknown as AgentHandle
        },
      ),
      resume: vi.fn(
        async (opts: { resumeSessionId: string }): Promise<AgentHandle> => {
          const existing = agentsMap.get(opts.resumeSessionId) ?? makeAgent(opts.resumeSessionId, '/tmp')
          return { agent: existing, dispose: vi.fn().mockResolvedValue(undefined) } as unknown as AgentHandle
        },
      ),
      get: vi.fn((sid: string) => agentsMap.get(sid)),
    },
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'mock-model', name: 'Mock Model' }],
      resolveModelInfo: async () => ({ id: 'mock-model', name: 'Mock Model' }),
    },
    sessions: {
      get: (sid: string) => agentsMap.get(sid)?.session,
    },
  } as unknown as Context

  return {
    ctx,
    createdSessionIds,
    submittedBySession,
    waitForNextTurn,
    setAutoReply(fn?: (sessionId: string, prompt: string) => string) {
      autoReply = fn
    },
  }
}

describe('Thread fork isolation & executing-turn reply anchor', () => {
  it('isolates concurrent sibling quote replies off a quick-replied main-stream root and anchors lark-bridge send to the active thread', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createControllableRuntime()
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
    await manager.start()

    store.upsertBot({
      id: 'bot-fork',
      name: 'ForkBot',
      enabled: true,
      larkAppId: 'cli_fork_app',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupReplyMode: 'new-topic',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
      receivedReactionEmoji: 'NONE',
      useInteractiveCard: false,
      router: { enabled: false },
    })
    store.upsertGroup({
      botId: 'bot-fork',
      chatId: 'oc_fork_group',
      chatName: '协作群',
      enabled: true,
      replyMode: 'new-topic',
      sessionMode: 'thread',
      replyFormat: 'text',
    })

    // Seed ephemeral quick-reply context on M0 (simulating listener quick_reply M1 in main chat).
    const m0RouteKey = 'cli_fork_app:oc_fork_group:om_m0_img'
    manager.triage.context.recordEphemeralQuickReply({
      routeKey: m0RouteKey,
      chatScopeKey: 'chat:bot-fork:oc_fork_group',
      trigger: 'listener',
      senderName: 'Alice',
      userText: '[图片消息]',
      routerReply: '这张老记录很有意思，只是终端形态换了。',
    })

    const sentReplies: SendLarkReplyOptions[] = []
    const sentProactive: SendLarkProactiveOptions[] = []
    const threadByReplyTarget = new Map<string, string>([
      ['om_fork_a', 'omt_topic_a'],
      ['om_fork_b', 'omt_topic_b'],
      ['om_fork_c', 'omt_topic_c'],
      ['om_b_followup', 'omt_topic_b'],
    ])
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_fork', connected: true },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_alice', name: 'Alice' }),
      getMessageDetail: vi.fn().mockResolvedValue({
        messageId: 'om_m1_quick',
        msgType: 'post',
        senderName: 'ForkBot',
        senderType: 'bot',
        text: '这张老记录很有意思，只是终端形态换了。',
        resources: [],
      }),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      uploadImageBuffer: vi.fn().mockResolvedValue('img_mock_key_1'),
      sendReply: vi.fn(async (opts: SendLarkReplyOptions) => {
        sentReplies.push(opts)
        const target = opts.replyToMessageId ?? 'om_unknown'
        const threadId = threadByReplyTarget.get(target) ?? 'omt_other'
        const rootId = target === 'om_b_followup' ? 'om_fork_b' : target
        return { messageId: `om_out_${sentReplies.length}`, rootId, threadId }
      }),
      sendProactiveMessage: vi.fn(async (opts: SendLarkProactiveOptions) => {
        sentProactive.push(opts)
        return {
          messageId: `om_proactive_${sentProactive.length}`,
          rootId: opts.replyToMessageId,
          threadId: opts.replyToMessageId === 'om_fork_b' ? 'omt_topic_b' : 'omt_other',
        }
      }),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    } as unknown as LarkBotTransport
    manager.connections.transports.set('bot-fork', {
      transport: fakeTransport,
      appId: 'cli_fork_app',
      appSecret: 'mock-secret-value',
    } as never)

    // 1. M_A, M_B, and M_C all quote M1 in the main chat stream (same rootId=om_m0_img, no threadId).
    //    M_B and M_C arrive concurrently!
    runtime.setAutoReply((_sid, prompt) => {
      if (prompt.includes('作者')) return '作者回复'
      if (prompt.includes('改成什么')) return '2026 翻拍版回复'
      return '终端形态回复'
    })

    await manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({
        messageId: 'om_fork_a',
        rootId: 'om_m0_img',
        parentId: 'om_m1_quick',
        text: '@_bot_1 你应该叫这个作者什么',
      }),
    )

    await Promise.all([
      manager.inbound.handleInbound(
        'bot-fork',
        fakeTransport,
        makeGroupMsg({
          messageId: 'om_fork_b',
          rootId: 'om_m0_img',
          parentId: 'om_m1_quick',
          senderOpenId: 'ou_bob',
          text: '@_bot_1 类比到现在，上面的话应该改成什么？',
        }),
      ),
      manager.inbound.handleInbound(
        'bot-fork',
        fakeTransport,
        makeGroupMsg({
          messageId: 'om_fork_c',
          rootId: 'om_m0_img',
          parentId: 'om_m1_quick',
          senderOpenId: 'ou_alice',
          text: '@_bot_1 现在的终端形态换成什么了？',
        }),
      ),
    ])

    // All three sibling forks MUST own three isolated sessions & three isolated Feishu thread bindings.
    expect(runtime.createdSessionIds).toHaveLength(3)
    const bindingA = store.getBinding('cli_fork_app:oc_fork_group:om_fork_a')
    const bindingB = store.getBinding('cli_fork_app:oc_fork_group:om_fork_b')
    const bindingC = store.getBinding('cli_fork_app:oc_fork_group:om_fork_c')
    expect(bindingA?.sessionId).toBeDefined()
    expect(bindingB?.sessionId).toBeDefined()
    expect(bindingC?.sessionId).toBeDefined()
    expect(new Set([bindingA!.sessionId, bindingB!.sessionId, bindingC!.sessionId]).size).toBe(3)
    expect(bindingA?.aliasRouteKeys).toEqual(['cli_fork_app:oc_fork_group:omt_topic_a'])
    expect(bindingB?.aliasRouteKeys).toEqual(['cli_fork_app:oc_fork_group:omt_topic_b'])
    expect(bindingC?.aliasRouteKeys).toEqual(['cli_fork_app:oc_fork_group:omt_topic_c'])

    // All three isolated threads inherited the non-destructively peeked quick-reply context.
    for (const sid of [bindingA!.sessionId, bindingB!.sessionId, bindingC!.sessionId]) {
      expect(runtime.submittedBySession.get(sid)?.[0]).toContain('这张老记录很有意思')
    }

    // 2. Follow up inside Topic B (`omt_topic_b`) and send an image via `lark-bridge send` mid-turn.
    runtime.setAutoReply(undefined)
    const turnPromise = manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({
        messageId: 'om_b_followup',
        rootId: 'om_fork_b',
        parentId: 'om_fork_b',
        threadId: 'omt_topic_b',
        senderOpenId: 'ou_bob',
        text: '@_bot_1 你试试生成图片',
      }),
    )
    const gate = await runtime.waitForNextTurn()
    expect(gate.sessionId).toBe(bindingB!.sessionId)

    const sendRes = await manager.agentSend({
      sessionId: gate.sessionId,
      textOnly: true,
      images: [{ fileName: 'card.png', dataBase64: Buffer.from('fake-png').toString('base64') }],
    })
    expect(sendRes.messageIds).toHaveLength(1)
    expect(sentProactive).toHaveLength(1)
    expect(sentProactive[0]).toMatchObject({
      replyToMessageId: 'om_fork_b',
      replyInThread: true,
      msgType: 'image',
    })

    gate.resolve('语录卡已经发在上面啦')
    await turnPromise

    await manager.stop()
    store.close()
  })

  it('detaches old main-stream root upon promotion so later sibling quotes never hijack an existing promoted thread', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createControllableRuntime()
    runtime.setAutoReply(() => 'ok')

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
    await manager.start()

    store.upsertBot({
      id: 'bot-fork',
      name: 'ForkBot',
      enabled: true,
      larkAppId: 'cli_fork_app',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupReplyMode: 'reply',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
      receivedReactionEmoji: 'NONE',
      useInteractiveCard: false,
      router: { enabled: false },
    })
    store.upsertGroup({
      botId: 'bot-fork',
      chatId: 'oc_fork_group',
      chatName: '协作群',
      enabled: true,
      replyMode: 'reply',
      sessionMode: 'thread',
      replyFormat: 'text',
    })

    let nextReplyResult: { messageId: string; rootId?: string; threadId?: string } = {
      messageId: 'om_reply_main',
      rootId: 'om_root_1',
    }
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_fork', connected: true },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_alice', name: 'Alice' }),
      getMessageDetail: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn(async () => nextReplyResult),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    } as unknown as LarkBotTransport
    manager.connections.transports.set('bot-fork', {
      transport: fakeTransport,
      appId: 'cli_fork_app',
      appSecret: 'mock-secret-value',
    } as never)

    // 1. Main-stream replyMode='reply' creates S1 bound to om_root_1.
    await manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({ messageId: 'om_root_1', text: '@_bot_1 初始提问' }),
    )
    const s1 = store.getBinding('cli_fork_app:oc_fork_group:om_root_1')?.sessionId
    expect(s1).toBeDefined()

    // 2. Switch group to new-topic; M_branch1 quotes M_reply -> continues S1 and promotes S1 to omt_1.
    store.upsertGroup({
      ...store.getGroup('bot-fork', 'oc_fork_group')!,
      replyMode: 'new-topic',
    })
    nextReplyResult = { messageId: 'om_t1_r1', rootId: 'om_branch_1', threadId: 'omt_1' }
    await manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({
        messageId: 'om_branch_1',
        rootId: 'om_root_1',
        parentId: 'om_reply_main',
        text: '@_bot_1 沿着这个继续聊',
      }),
    )
    expect(store.getBinding('cli_fork_app:oc_fork_group:om_root_1')).toBeUndefined()
    expect(store.getBinding('cli_fork_app:oc_fork_group:om_branch_1')?.sessionId).toBe(s1)
    expect(store.getBinding('cli_fork_app:oc_fork_group:omt_1')?.sessionId).toBe(s1)

    // 3. Unmentioned main-stream sibling quote off om_root_1 MUST NOT hijack S1.
    await manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({
        messageId: 'om_unmentioned_sibling',
        rootId: 'om_root_1',
        parentId: 'om_reply_main',
        mentions: [],
        text: '路过点评一句',
      }),
    )
    expect(runtime.submittedBySession.get(s1!)).toHaveLength(2)

    // 4. Mentioned main-stream sibling quote off om_root_1 MUST create an isolated session S2.
    nextReplyResult = { messageId: 'om_t2_r1', rootId: 'om_branch_2', threadId: 'omt_2' }
    await manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({
        messageId: 'om_branch_2',
        rootId: 'om_root_1',
        parentId: 'om_reply_main',
        senderOpenId: 'ou_bob',
        text: '@_bot_1 换个角度问一下',
      }),
    )
    const s2 = store.getBinding('cli_fork_app:oc_fork_group:om_branch_2')?.sessionId
    expect(s2).toBeDefined()
    expect(s2).not.toBe(s1)
    expect(store.getBinding('cli_fork_app:oc_fork_group:omt_2')?.sessionId).toBe(s2)
    expect(store.listBindings()).toHaveLength(2)

    await manager.stop()
    store.close()
  })

  it('uses active executing turn context over legacy multi-alias bindings, chat/per_message modes, and refuses binding a second native thread', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createControllableRuntime()
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
    await manager.start()

    store.upsertBot({
      id: 'bot-fork',
      name: 'ForkBot',
      enabled: true,
      larkAppId: 'cli_fork_app',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      groupReplyMode: 'new-topic',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
      receivedReactionEmoji: 'NONE',
      useInteractiveCard: false,
      router: { enabled: false },
    })
    store.upsertGroup({
      botId: 'bot-fork',
      chatId: 'oc_fork_group',
      chatName: '协作群',
      enabled: true,
      replyMode: 'new-topic',
      sessionMode: 'thread',
      replyFormat: 'text',
    })

    // Seed a legacy pre-upgrade tangled binding that has both Topic B and Topic C aliased on one session.
    const legacySessionId = 'session-legacy-tangled'
    store.upsertBinding({
      routeKey: 'cli_fork_app:oc_fork_group:om_m0_legacy',
      aliasRouteKeys: [
        'cli_fork_app:oc_fork_group:om_topic_b_root',
        'cli_fork_app:oc_fork_group:omt_legacy_b',
        'cli_fork_app:oc_fork_group:om_topic_c_root',
        'cli_fork_app:oc_fork_group:omt_legacy_c',
      ],
      botId: 'bot-fork',
      botName: 'ForkBot',
      larkAppId: 'cli_fork_app',
      chatType: 'group',
      chatId: 'oc_fork_group',
      chatName: '协作群',
      workspaceName: 'ws',
      sessionId: legacySessionId,
      agentPreset: 'standard',
      workingDir: dir,
      trigger: 'mention',
      hasReplied: true,
      createdAtMs: Date.now() - 10_000,
      lastActivityMs: Date.now() - 1_000,
    })

    // Store invariant: bindRouteAlias refuses adding yet another distinct native thread.
    expect(
      store.bindRouteAlias(
        'cli_fork_app:oc_fork_group:om_m0_legacy',
        'cli_fork_app:oc_fork_group:omt_legacy_d',
      ),
    ).toBe(false)

    const sentProactive: SendLarkProactiveOptions[] = []
    const listMessagesCalls: Array<{ chatId: string; threadId?: string }> = []
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_fork', connected: true },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_bob', name: 'Bob' }),
      getMessageDetail: vi.fn().mockResolvedValue(undefined),
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      uploadImageBuffer: vi.fn().mockResolvedValue('img_legacy_key'),
      sendReply: vi.fn().mockResolvedValue({
        messageId: 'om_legacy_out',
        rootId: 'om_topic_b_root',
        threadId: 'omt_legacy_b',
      }),
      sendProactiveMessage: vi.fn(async (opts: SendLarkProactiveOptions) => {
        sentProactive.push(opts)
        return { messageId: `om_p_${sentProactive.length}`, rootId: opts.replyToMessageId }
      }),
      listMessages: vi.fn(async (opts: { chatId: string; threadId?: string }) => {
        listMessagesCalls.push(opts)
        return []
      }),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    } as unknown as LarkBotTransport
    manager.connections.transports.set('bot-fork', {
      transport: fakeTransport,
      appId: 'cli_fork_app',
      appSecret: 'mock-secret-value',
    } as never)

    // Trigger an active turn inside Topic B (`omt_legacy_b`, root `om_topic_b_root`) while Topic C is the LAST alias.
    const legacyTurn = manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({
        messageId: 'om_in_topic_b',
        rootId: 'om_topic_b_root',
        parentId: 'om_topic_b_root',
        threadId: 'omt_legacy_b',
        text: '@_bot_1 发张图到这个话题',
      }),
    )
    const gate = await runtime.waitForNextTurn()
    expect(gate.sessionId).toBe(legacySessionId)

    // During execution, context / send / history MUST anchor to Topic B (NOT Topic C!).
    const activeCtx = manager.resolveAgentContext(legacySessionId)
    expect(activeCtx.replyToMessageId).toBe('om_topic_b_root')
    expect(activeCtx.threadId).toBe('omt_legacy_b')
    expect(activeCtx.replyInThread).toBe(true)

    await manager.agentSend({
      sessionId: legacySessionId,
      textOnly: true,
      images: [{ fileName: 'quote.png', dataBase64: Buffer.from('img').toString('base64') }],
    })
    expect(sentProactive[0]).toMatchObject({
      replyToMessageId: 'om_topic_b_root',
      replyInThread: true,
      msgType: 'image',
    })

    await manager.agentHistory({ sessionId: legacySessionId })
    expect(listMessagesCalls[0]).toMatchObject({
      chatId: 'oc_fork_group',
      threadId: 'omt_legacy_b',
    })

    gate.resolve('发好啦')
    await legacyTurn

    // Also verify sessionMode='per_message' + replyMode='reply' honors executing turn replyInThread=false.
    store.upsertGroup({
      ...store.getGroup('bot-fork', 'oc_fork_group')!,
      sessionMode: 'per_message',
      replyMode: 'reply',
    })
    const perMsgTurn = manager.inbound.handleInbound(
      'bot-fork',
      fakeTransport,
      makeGroupMsg({
        messageId: 'om_per_msg_1',
        text: '@_bot_1 发张普通引用回复图片',
      }),
    )
    const perMsgGate = await runtime.waitForNextTurn()
    const perMsgCtx = manager.resolveAgentContext(perMsgGate.sessionId)
    expect(perMsgCtx.replyToMessageId).toBe('om_per_msg_1')
    expect(perMsgCtx.replyInThread).toBe(false)

    await manager.agentSend({
      sessionId: perMsgGate.sessionId,
      textOnly: true,
      images: [{ fileName: 'reply.png', dataBase64: Buffer.from('img2').toString('base64') }],
    })
    expect(sentProactive[1]).toMatchObject({
      replyToMessageId: 'om_per_msg_1',
      replyInThread: false,
      msgType: 'image',
    })

    perMsgGate.resolve('完成')
    await perMsgTurn

    await manager.stop()
    store.close()
  })
})
