import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InboundLarkMessage, LarkBotTransport, LarkHistoryMessage } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import {
  INSTANCE_LOCK_FILENAME,
  InstanceLock,
  InstanceLockConflictError,
} from '../src/instance-lock.js'
import { LarkBridgeStore } from '../src/store.js'
import {
  MAX_AUTO_RESUME_AGE_MS,
  MAX_AUTO_RESUME_TOTAL_AGE_MS,
  MAX_GRACEFUL_AUTO_RESUME_ATTEMPTS,
  canAutoResumePendingTurn,
  inspectPersistedTurnCompletion,
} from '../src/turn-recovery.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-resilience-'): string {
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

function makeToolCallStream(args: Record<string, unknown>): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'tc_res_1' as never,
          name: 'route_message',
          arguments: JSON.stringify(args),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
}

function makeMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-res',
    larkAppId: 'cli_res_1',
    botOpenId: 'ou_bot_res',
    messageId: 'om_msg_1',
    chatId: 'oc_team_res',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_alex',
    senderType: 'user',
    text: '你好',
    rawContent: '{}',
    mentions: [],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

function createFakeHostContext(options: {
  readonly triageStream?: (opts: GenerateOptions) => AsyncIterable<StreamChunk>
  readonly manualTurnControl?: boolean
  readonly workerReply?: (prompt: string, turn: number) => string
  readonly persistedEventsBySession?: Map<string, readonly SessionEvent[]>
} = {}) {
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agents = new Map<string, { session: Session; followup: (msg: unknown) => void }>()
  const triagePrompts: string[] = []
  const submittedWorkerPrompts: string[] = []
  const pendingResolvers: Array<(replyText: string) => void> = []
  let turnSeq = 0

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  const makeAgent = (sessionId: string, cwd: string, agentPreset: string) => {
    const session = {
      id: sessionId,
      header: { cwd, agentPreset },
      snapshotEvents: () => options.persistedEventsBySession?.get(sessionId) ?? [],
    } as unknown as Session
    const agent = {
      session,
      followup: (userMsg: { id?: string; content: Array<{ type: string; text?: string }> }) => {
        const turn = ++turnSeq
        const promptText = userMsg.content.map((b) => b.text ?? '').join('\n')
        submittedWorkerPrompts.push(promptText)
        emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
        emit(session, { type: 'user/message', data: { id: userMsg.id, turn } } as unknown as SessionEvent)
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
          pendingResolvers.push(finish)
        } else {
          const replyText = options.workerReply
            ? options.workerReply(promptText, turn)
            : `回复 #${turn}`
          queueMicrotask(() => finish(replyText))
        }
      },
    }
    agents.set(sessionId, agent)
    return { agent, dispose: vi.fn(async () => {}) }
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaceRegistry') {
        return {
          list: () => [],
          archivedSessionIds: [] as string[],
          create: async (cwd: string, title?: string) => ({
            id: 'ws-res',
            title: title ?? 'demo',
            cwd,
            sessionIds: [] as string[],
            setTitle: vi.fn(),
            attachSession: vi.fn(),
          }),
          archiveSession: vi.fn().mockReturnValue(true),
        }
      }
      if (key === 'sessionPersistence' && options.persistedEventsBySession) {
        return {
          open: async (sid: string) => {
            const events = options.persistedEventsBySession!.get(String(sid)) ?? []
            return {
              header: { cwd: '/Users/demo/project' },
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
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listConfigurableProviders: () => [
        { provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      ],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
      }),
      stream: (opts: GenerateOptions) => {
        const userBlocks = opts.messages?.[0]?.content ?? []
        const userText = userBlocks
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('\n')
        triagePrompts.push(userText)
        if (options.triageStream) return options.triageStream(opts)
        return makeToolCallStream({ action: 'silent', reason: '默认静默' })
      },
    },
    sessions: {
      get: (id: string) => agents.get(String(id))?.session,
    },
    agents: {
      get: (id: string) => agents.get(String(id)),
      create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) =>
        makeAgent(opts.sessionId, opts.meta.cwd, opts.meta.agentPreset),
      resume: async (opts: { resumeSessionId: string }) =>
        makeAgent(String(opts.resumeSessionId), '/Users/demo/project', 'standard'),
    },
  } as unknown as Context

  return {
    ctx,
    triagePrompts,
    submittedWorkerPrompts,
    resolveNextTurn: (reply: string) => pendingResolvers.shift()?.(reply),
    pendingTurnCount: () => pendingResolvers.length,
  }
}

function seedBotAndGroup(store: LarkBridgeStore, workDir: string) {
  store.upsertBot({
    id: 'bot-res',
    name: 'ResBot',
    enabled: true,
    larkAppId: 'cli_res_1',
    larkAppSecret: 'sec_test_value',
    defaultWorkingDir: workDir,
    agentPreset: 'standard',
    provider: 'deepseek',
    model: 'deepseek-chat',
    useInteractiveCard: false,
    router: {
      enabled: true,
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
    botId: 'bot-res',
    chatId: 'oc_team_res',
    chatName: '研发协作群',
    enabled: true,
    replyMode: 'new-topic',
    sessionMode: 'thread',
    mentionTriggerMode: 'mention_and_active_thread',
    listener: {
      enabled: true,
      name: '工作日常',
      prompt: '过滤噪音，关注实质问题',
      scope: 'all',
      replyMode: 'reply',
      sessionMode: 'thread',
      allowSilentEmptyReply: true,
      autoCloseAfterCompletion: false,
      senderFilterMode: 'include_only',
      senderOpenIds: ['ou_alex'],
      excludeKeywords: ['@'],
    },
  })
}

function createFakeTransport(options: {
  readonly listMessages?: (opts: { chatId: string; threadId?: string; limit?: number }) => Promise<LarkHistoryMessage[]>
} = {}) {
  const sentReplies: Array<{ replyToMessageId?: string; text?: string; card?: unknown }> = []
  const removedReactions: Array<{ messageId: string; reactionId: string }> = []
  let reactionSeq = 0
  let paused = false

  const transport = {
    state: { botOpenId: 'ou_bot_res', connected: true },
    get paused() {
      return paused
    },
    addReaction: vi.fn(async () => `react_${++reactionSeq}`),
    removeReaction: vi.fn(async (messageId: string, reactionId: string) => {
      removedReactions.push({ messageId, reactionId })
    }),
    sendReply: vi.fn(async (opts: { replyToMessageId?: string; text?: string; card?: unknown }) => {
      sentReplies.push(opts)
      return {
        messageId: `om_bot_reply_${sentReplies.length}`,
        rootId: opts.replyToMessageId,
        threadId: `omt_thread_${sentReplies.length}`,
      }
    }),
    resolveUserSummary: vi.fn(async (openId: string) => {
      if (openId === 'ou_alex') return { openId, name: 'Alex' }
      if (openId === 'ou_sam') return { openId, name: 'Sam' }
      return undefined
    }),
    getCachedUserName: vi.fn((openId?: string) => (openId === 'ou_sam' ? 'Sam' : undefined)),
    listMessages: vi.fn(async (opts: { chatId: string; threadId?: string; limit?: number }) => {
      if (options.listMessages) return options.listMessages(opts)
      return []
    }),
    pauseInbound: vi.fn(async () => {
      paused = true
      transport.state.connected = false
    }),
    start: vi.fn(async () => {
      paused = false
      transport.state.connected = true
    }),
    stop: vi.fn(async () => {
      paused = true
      transport.state.connected = false
    }),
  }

  return { transport: transport as unknown as LarkBotTransport, raw: transport, sentReplies, removedReactions }
}

describe('Restart resilience, triage context persistence/backfill & graceful drain', () => {
  it('persists triage group context (including ignored messages, worker replies & ephemeral quick-reply threads) across restart', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-wd-')
    const store1 = new LarkBridgeStore(dir)
    seedBotAndGroup(store1, workDir)

    let triageAction: 'quick_reply' | 'handoff' | 'silent' = 'quick_reply'
    const host1 = createFakeHostContext({
      triageStream: () =>
        triageAction === 'quick_reply'
          ? makeToolCallStream({
              action: 'quick_reply',
              reason: '轻松打招呼',
              reply_text: '在的，有什么需要帮看的随时说～',
            })
          : makeToolCallStream({ action: triageAction, reason: '需要处理' }),
    })

    const manager1 = new LarkBridgeManager(
      host1.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store1,
    )
    const { transport: t1 } = createFakeTransport()
    manager1.connections.transports.set('bot-res', { config: store1.getBot('bot-res')!, transport: t1 })

    const now = Date.now()
    // 1. Ignored group message from non-allowlisted member `ou_sam` still enters chat-level triage context.
    await manager1.inbound.handleInbound(
      'bot-res',
      t1,
      makeMsg({
        messageId: 'om_ignored_sam_1',
        senderOpenId: 'ou_sam',
        text: '刚发布了网关限流配置变更',
        createTimeMs: now - 5_000,
      }),
    )

    // 2. Direct @Bot turn produces a worker reply -> synced into chatScopeKey too.
    await manager1.inbound.handleInbound(
      'bot-res',
      t1,
      makeMsg({
        messageId: 'om_mention_1',
        senderOpenId: 'ou_alex',
        text: '@_bot 确认下发布窗口',
        mentions: [{ key: '@_bot', openId: 'ou_bot_res', name: 'ResBot' }],
        createTimeMs: now - 4_000,
      }),
    )

    // 3. Passive listener message gets quick_reply -> creates persisted ephemeral thread + alias.
    await manager1.inbound.handleInbound(
      'bot-res',
      t1,
      makeMsg({
        messageId: 'om_qr_1',
        senderOpenId: 'ou_alex',
        text: '在吗？',
        createTimeMs: now - 2_000,
      }),
    )

    await manager1.stop()
    store1.close()

    // 4. Cold restart: reopen SQLite store and spin up a brand new LarkBridgeManager.
    const store2 = new LarkBridgeStore(dir)
    triageAction = 'handoff'
    const host2 = createFakeHostContext({
      triageStream: () => makeToolCallStream({ action: 'handoff', reason: '升级正式排查' }),
    })
    const manager2 = new LarkBridgeManager(
      host2.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store2,
    )
    const { transport: t2 } = createFakeTransport()
    manager2.connections.transports.set('bot-res', { config: store2.getBot('bot-res')!, transport: t2 })

    // 4a. Top-level listener message after restart sees ignored Sam message + Bot's worker reply + router reply.
    await manager2.inbound.handleInbound(
      'bot-res',
      t2,
      makeMsg({
        messageId: 'om_after_restart_top',
        senderOpenId: 'ou_alex',
        text: '刚那个限流变更生效了吗',
        createTimeMs: Date.now(),
      }),
    )
    expect(host2.triagePrompts[0]).toContain('<recent_context>')
    expect(host2.triagePrompts[0]).toContain('[Sam] 刚发布了网关限流配置变更')
    expect(host2.triagePrompts[0]).toContain('[智能体] 回复 #1')
    expect(host2.triagePrompts[0]).toContain('[智能分流] 在的，有什么需要帮看的随时说～')

    // 4b. Follow-up inside the pre-restart quick_reply thread still resolves ephemeralThread and injects handoff context!
    await manager2.inbound.handleInbound(
      'bot-res',
      t2,
      makeMsg({
        messageId: 'om_after_restart_followup',
        rootId: 'om_qr_1',
        threadId: 'omt_thread_2',
        senderOpenId: 'ou_alex',
        text: '帮我查下最近错误日志',
        createTimeMs: Date.now() + 100,
      }),
    )
    expect(host2.submittedWorkerPrompts.some((p) => p.includes('<triage_handoff_context>'))).toBe(true)
    expect(host2.submittedWorkerPrompts.some((p) => p.includes('在的，有什么需要帮看的随时说～'))).toBe(true)

    await manager2.stop()
    store2.close()
  })

  it('backfills recent Feishu chat messages on cold start when triage context bucket is empty and avoids duplicate self-message', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-wd-')
    const store = new LarkBridgeStore(dir)
    seedBotAndGroup(store, workDir)

    const now = Date.now()
    const host = createFakeHostContext({
      triageStream: () => makeToolCallStream({ action: 'silent', reason: '外部文档链接，静默' }),
    })
    const manager = new LarkBridgeManager(
      host.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store,
    )

    const { transport, raw } = createFakeTransport({
      listMessages: async () => [
        {
          messageId: 'om_hist_1',
          chatId: 'oc_team_res',
          senderOpenId: 'ou_sam',
          senderName: 'Sam',
          senderType: 'user',
          msgType: 'text',
          text: '刚同步了团队架构图',
          createTimeMs: now - 120_000,
          resources: [],
        },
        {
          messageId: 'om_hist_2',
          chatId: 'oc_team_res',
          senderOpenId: 'ou_bot_res',
          senderType: 'bot',
          msgType: 'text',
          text: '收到，已记录',
          createTimeMs: now - 60_000,
          resources: [],
        },
        {
          messageId: 'om_current_1',
          chatId: 'oc_team_res',
          senderOpenId: 'ou_alex',
          senderName: 'Alex',
          senderType: 'user',
          msgType: 'text',
          text: 'https://docs.example.com/waf',
          createTimeMs: now,
          resources: [],
        },
      ],
    })
    manager.connections.transports.set('bot-res', { config: store.getBot('bot-res')!, transport })

    await manager.inbound.handleInbound(
      'bot-res',
      transport,
      makeMsg({
        messageId: 'om_current_1',
        text: 'https://docs.example.com/waf',
        createTimeMs: now,
      }),
    )

    expect(raw.listMessages).toHaveBeenCalledTimes(1)
    expect(host.triagePrompts[0]).toContain('<recent_context>')
    expect(host.triagePrompts[0]).toContain('- [Sam] 刚同步了团队架构图')
    expect(host.triagePrompts[0]).toContain('- [智能体] 收到，已记录')
    // Current message must NOT be duplicated inside <recent_context>.
    const recentSection = host.triagePrompts[0]!.split('<incoming_message>')[0]!
    expect(recentSection).not.toContain('https://docs.example.com/waf')

    // Second message in the same chat hits local cache without calling Feishu listMessages again.
    await manager.inbound.handleInbound(
      'bot-res',
      transport,
      makeMsg({
        messageId: 'om_current_2',
        text: '还有一篇参考文档',
        createTimeMs: now + 5_000,
      }),
    )
    expect(raw.listMessages).toHaveBeenCalledTimes(1)
    expect(host.triagePrompts[1]).toContain('https://docs.example.com/waf')

    await manager.stop()
    store.close()
  })

  it('enforces lifecycle drain auth boundary, pauses inbound intake while waiting for active turns, and supports InstanceLock smooth handoff', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-wd-')
    const store = new LarkBridgeStore(dir)
    seedBotAndGroup(store, workDir)

    const host = createFakeHostContext({ manualTurnControl: true })
    const manager = new LarkBridgeManager(
      host.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store,
    )
    const { transport, raw, sentReplies } = createFakeTransport()
    manager.connections.transports.set('bot-res', { config: store.getBot('bot-res')!, transport })

    // 1. Agent CLI Bearer token cannot drain or resume-intake (403), only read status.
    const cliStatus = await dispatchLarkApiRequest(host.ctx, manager, {
      method: 'GET',
      path: '/api/lark-bridge/lifecycle/status',
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliStatus.status).toBe(200)

    const cliDrain = await dispatchLarkApiRequest(host.ctx, manager, {
      method: 'POST',
      path: '/api/lark-bridge/lifecycle/drain',
      body: { reason: 'unauthorized_attempt' },
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliDrain.status).toBe(403)
    expect((cliDrain.payload as { error?: string }).error).toBe('owner_or_operator_required')

    // 2. Start an in-flight turn, then initiate operator drain with wait=true.
    const turnPromise = manager.inbound.handleInbound(
      'bot-res',
      transport,
      makeMsg({
        messageId: 'om_drain_active',
        text: '@_bot 正在处理长任务',
        mentions: [{ key: '@_bot', openId: 'ou_bot_res', name: 'ResBot' }],
      }),
    )
    await vi.waitFor(() => expect(host.pendingTurnCount()).toBe(1))

    const drainResPromise = dispatchLarkApiRequest(host.ctx, manager, {
      method: 'POST',
      path: '/api/lark-bridge/lifecycle/drain',
      body: { wait: true, timeoutMs: 5000, reason: 'planned_upgrade' },
      isCliAuthenticated: true,
      isOperatorAuthenticated: true,
      principalKind: 'operator',
    })

    await vi.waitFor(() => expect(raw.pauseInbound).toHaveBeenCalledTimes(1))
    expect(manager.getLifecycleStatus().draining).toBe(true)

    // New inbound messages arriving during drain are ignored without starting new work.
    await manager.inbound.handleInbound(
      'bot-res',
      transport,
      makeMsg({
        messageId: 'om_drain_rejected',
        text: '@_bot 排空期间新消息',
        mentions: [{ key: '@_bot', openId: 'ou_bot_res', name: 'ResBot' }],
      }),
    )
    expect(host.pendingTurnCount()).toBe(1)

    // Complete the in-flight turn -> reply delivers cleanly via REST and waitForDrain resolves.
    host.resolveNextTurn('排空前已完整处理完毕')
    await turnPromise
    const drainRes = await drainResPromise
    expect(drainRes.status).toBe(200)
    expect((drainRes.payload as { drained?: boolean }).drained).toBe(true)
    expect(sentReplies).toHaveLength(1)
    expect(sentReplies[0]?.text).toContain('排空前已完整处理完毕')

    // 3. Resume intake clears draining state.
    const resumeRes = await dispatchLarkApiRequest(host.ctx, manager, {
      method: 'POST',
      path: '/api/lark-bridge/lifecycle/resume-intake',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(resumeRes.status).toBe(200)
    expect((resumeRes.payload as { draining?: boolean }).draining).toBe(false)

    // 4. InstanceLock.acquireAsync waits smoothly for a same-host predecessor releasing bridge.lock,
    //    while failing immediately on cross-host conflict.
    const lockDir = makeTempDir('dsh-lark-lock-')
    const aliveOtherPid = process.ppid > 0 && process.ppid !== process.pid ? process.ppid : 1
    const lockFile = join(lockDir, INSTANCE_LOCK_FILENAME)
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: aliveOtherPid,
        host: hostname(),
        instanceId: 'old-proc',
        startedAtMs: Date.now() - 2_000,
        heartbeatAtMs: Date.now(),
        mode: 'bridge',
      }),
      'utf8',
    )
    const releaseTimer = setTimeout(() => rmSync(lockFile, { force: true }), 120)
    try {
      const nextLock = new InstanceLock(lockDir, 'bridge')
      const status = await nextLock.acquireAsync({ waitMs: 2_000, pollMs: 30 })
      expect(status.held).toBe(true)
      nextLock.release()
    } finally {
      clearTimeout(releaseTimer)
    }

    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: aliveOtherPid,
        host: 'other-host.example.com',
        instanceId: 'remote-proc',
        startedAtMs: Date.now() - 2_000,
        heartbeatAtMs: Date.now(),
        mode: 'bridge',
      }),
      'utf8',
    )
    const remoteLock = new InstanceLock(lockDir, 'bridge')
    const t0 = Date.now()
    await expect(remoteLock.acquireAsync({ waitMs: 5_000, pollMs: 50 })).rejects.toThrow(
      InstanceLockConflictError,
    )
    expect(Date.now() - t0).toBeLessThan(500)

    await manager.stop()
    store.close()
  })

  it('delivers already-completed persisted turn without re-running agent, and enforces retry cap + 15-min age window', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-wd-')
    const store = new LarkBridgeStore(dir)
    seedBotAndGroup(store, workDir)

    const now = Date.now()
    const persistedEventsBySession = new Map<string, readonly SessionEvent[]>([
      [
        'session-finished-before-send',
        [
          { type: 'turn/start', seq: 0, time: now - 5_000, data: { turn: 1 } },
          {
            type: 'user/message',
            seq: 1,
            time: now - 5_000,
            data: {
              content: [{ type: 'text', text: '<lark_context message_id="om_already_done" />\n查下构建' }],
            },
          },
          {
            type: 'assistant/message',
            seq: 2,
            time: now - 2_000,
            data: {
              turn: 1,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: '构建已通过，共 42 项单测全绿。' }],
              },
            },
          },
          {
            type: 'turn/end',
            seq: 3,
            time: now - 2_000,
            data: { turn: 1, reason: { kind: 'completed' } },
          },
        ] as unknown as SessionEvent[],
      ],
    ])

    // Case A: Turn actually completed right before process exit -> deliver final reply directly, 0 agent runs.
    store.upsertPendingTurn({
      id: 'pt-completed',
      botId: 'bot-res',
      chatId: 'oc_team_res',
      messageId: 'om_already_done',
      routeKey: 'cli_res_1:oc_team_res:om_already_done',
      replyMode: 'new-topic',
      trigger: 'mention',
      allowSilentEmptyReply: false,
      reactionId: 'react_done_1',
      sessionId: 'session-finished-before-send',
      startedAtMs: now - 6_000,
      status: 'interrupted',
      inboundMsg: makeMsg({
        messageId: 'om_already_done',
        text: '@_bot 查下构建',
        mentions: [{ key: '@_bot', openId: 'ou_bot_res', name: 'ResBot' }],
      }),
    })

    // Case B: Poison-pill retry cap reached (`recoveryAttempts: 1`) -> clean up & notify instead of looping.
    store.upsertPendingTurn({
      id: 'pt-poison',
      botId: 'bot-res',
      chatId: 'oc_team_res',
      messageId: 'om_poison_1',
      routeKey: 'cli_res_1:oc_team_res:om_poison_1',
      replyMode: 'new-topic',
      trigger: 'mention',
      allowSilentEmptyReply: false,
      reactionId: 'react_poison_1',
      startedAtMs: now - 10_000,
      status: 'interrupted',
      recoveryAttempts: 1,
      inboundMsg: makeMsg({
        messageId: 'om_poison_1',
        text: '@_bot 毒丸消息',
        mentions: [{ key: '@_bot', openId: 'ou_bot_res', name: 'ResBot' }],
      }),
    })

    // Case C: Expired recovery window (> 15 min old) -> clean up & notify, do not zombie-replay.
    store.upsertPendingTurn({
      id: 'pt-expired',
      botId: 'bot-res',
      chatId: 'oc_team_res',
      messageId: 'om_expired_1',
      routeKey: 'cli_res_1:oc_team_res:om_expired_1',
      replyMode: 'new-topic',
      trigger: 'mention',
      allowSilentEmptyReply: false,
      reactionId: 'react_expired_1',
      startedAtMs: now - MAX_AUTO_RESUME_AGE_MS - 60_000,
      status: 'interrupted',
      recoveryAttempts: 0,
      inboundMsg: makeMsg({
        messageId: 'om_expired_1',
        text: '@_bot 过旧消息',
        mentions: [{ key: '@_bot', openId: 'ou_bot_res', name: 'ResBot' }],
      }),
    })

    const host = createFakeHostContext({ persistedEventsBySession })
    const manager = new LarkBridgeManager(
      host.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store,
    )
    const { transport, sentReplies, removedReactions } = createFakeTransport()
    manager.connections.transports.set('bot-res', { config: store.getBot('bot-res')!, transport })

    const count = await manager.recoverStalePendingTurns(undefined, now)
    await manager.inbound.waitForRecoveries()

    expect(count).toBe(3)
    expect(store.listPendingTurns()).toHaveLength(0)
    // Zero new agent turns invoked for all 3 cases!
    expect(host.submittedWorkerPrompts).toHaveLength(0)
    expect(removedReactions).toEqual(
      expect.arrayContaining([
        { messageId: 'om_already_done', reactionId: 'react_done_1' },
        { messageId: 'om_poison_1', reactionId: 'react_poison_1' },
        { messageId: 'om_expired_1', reactionId: 'react_expired_1' },
      ]),
    )
    const doneReply = sentReplies.find((r) => r.replyToMessageId === 'om_already_done')
    expect(doneReply?.text).toContain('构建已通过，共 42 项单测全绿。')
    const poisonReply = sentReplies.find((r) => r.replyToMessageId === 'om_poison_1')
    expect(poisonReply?.text).toContain('服务重启中断')
    const expiredReply = sentReplies.find((r) => r.replyToMessageId === 'om_expired_1')
    expect(expiredReply?.text).toContain('服务重启中断')

    await manager.stop()
    store.close()
  })

  it('preserves and auto-resumes a long-running (>15m) active turn across graceful shutdown and consecutive reloads', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-wd-')
    const store1 = new LarkBridgeStore(dir)
    seedBotAndGroup(store1, workDir)

    const host1 = createFakeHostContext({ manualTurnControl: true })
    const manager1 = new LarkBridgeManager(
      host1.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store1,
    )
    const { transport: t1, sentReplies: sentReplies1 } = createFakeTransport()
    manager1.connections.transports.set('bot-res', { config: store1.getBot('bot-res')!, transport: t1 })

    const msg = makeMsg({
      messageId: 'om_long_20m',
      text: '@_bot 执行长耗时研发任务',
      mentions: [{ key: '@_bot', openId: 'ou_bot_res', name: 'ResBot' }],
    })
    const turnPromise = manager1.inbound.handleInbound('bot-res', t1, msg)
    await vi.waitFor(() => expect(host1.pendingTurnCount()).toBe(1))

    // Backdate startedAtMs by 20 minutes (> 15m MAX_AUTO_RESUME_AGE_MS) to simulate a long-running turn.
    const activeMap = (
      manager1.inbound as unknown as {
        activeTurns: Map<string, { startedAtMs: number; lastActivityAtMs: number }>
      }
    ).activeTurns
    const activeTurn = [...activeMap.values()][0]!
    const twentyMinAgo = Date.now() - 20 * 60_000
    activeTurn.startedAtMs = twentyMinAgo
    activeTurn.lastActivityAtMs = Date.now() - 5_000

    const lifecycle = manager1.getLifecycleStatus()
    expect(lifecycle.activeTurns).toHaveLength(1)
    expect(lifecycle.activeTurns[0]?.willAutoResume).toBe(true)
    expect(lifecycle.activeTurns[0]?.idleSec).toBeGreaterThanOrEqual(4)
    expect(lifecycle.activeTurns[0]?.lastActivityAtMs).toBeGreaterThan(twentyMinAgo)

    // Graceful shutdown must persist the >15m active turn instead of discarding it as expired.
    await manager1.stop()
    await turnPromise
    expect(sentReplies1).toHaveLength(0)

    const persisted = store1.listPendingTurns()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.status).toBe('interrupted')
    expect(persisted[0]?.interruptKind).toBe('graceful_shutdown')
    expect(persisted[0]?.interruptedAtMs).toBeTypeOf('number')
    store1.close()

    // Restart #1: 10 seconds after shutdown -> auto-resumes using downtime window, increments graceful budget only.
    const store2 = new LarkBridgeStore(dir)
    const host2 = createFakeHostContext({ manualTurnControl: true })
    const manager2 = new LarkBridgeManager(
      host2.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store2,
    )
    const { transport: t2, sentReplies: sentReplies2 } = createFakeTransport()
    manager2.connections.transports.set('bot-res', { config: store2.getBot('bot-res')!, transport: t2 })

    const recovered1 = await manager2.recoverStalePendingTurns(undefined, Date.now() + 10_000)
    expect(recovered1).toBe(1)
    await vi.waitFor(() => expect(host2.pendingTurnCount()).toBe(1))
    expect(host2.submittedWorkerPrompts[0]).toContain('<restart_recovery attempt="1"')

    // Restart #2 (consecutive deploy while still running): must still preserve & auto-resume!
    await manager2.stop()
    await manager2.inbound.waitForRecoveries()
    expect(sentReplies2).toHaveLength(0)
    const persistedAfterSecondStop = store2.listPendingTurns()
    expect(persistedAfterSecondStop).toHaveLength(1)
    expect(persistedAfterSecondStop[0]?.gracefulRecoveryAttempts).toBe(1)
    expect(persistedAfterSecondStop[0]?.recoveryAttempts ?? 0).toBe(0)
    store2.close()

    const store3 = new LarkBridgeStore(dir)
    const host3 = createFakeHostContext({
      workerReply: () => '历经两次优雅重启后顺利交付最终结果',
    })
    const manager3 = new LarkBridgeManager(
      host3.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
        enableInstanceLock: false,
      },
      store3,
    )
    const { transport: t3, sentReplies: sentReplies3 } = createFakeTransport()
    manager3.connections.transports.set('bot-res', { config: store3.getBot('bot-res')!, transport: t3 })

    const recovered2 = await manager3.recoverStalePendingTurns(undefined, Date.now() + 20_000)
    await manager3.inbound.waitForRecoveries()
    expect(recovered2).toBe(1)
    expect(host3.submittedWorkerPrompts[0]).toContain('<restart_recovery attempt="2"')
    expect(sentReplies3).toHaveLength(1)
    expect(sentReplies3[0]?.text).toContain('历经两次优雅重启后顺利交付最终结果')
    expect(store3.listPendingTurns()).toHaveLength(0)

    await manager3.stop()
    store3.close()
  })

  it('enforces downtime window, graceful attempt cap, and absolute age safety cap in canAutoResumePendingTurn', () => {
    const now = Date.now()
    const baseMsg = makeMsg({ messageId: 'om_policy_1' })

    // Long turn (45 min old) interrupted 30 seconds ago -> eligible at both shutdown and startup.
    expect(
      canAutoResumePendingTurn(
        {
          inboundMsg: baseMsg,
          startedAtMs: now - 45 * 60_000,
          interruptedAtMs: now - 30_000,
          interruptKind: 'graceful_shutdown',
          gracefulRecoveryAttempts: MAX_GRACEFUL_AUTO_RESUME_ATTEMPTS - 1,
          recoveryAttempts: 0,
        },
        now,
        { phase: 'startup' },
      ),
    ).toBe(true)

    // Downtime exceeded 15 minutes since interruption -> rejected at startup.
    expect(
      canAutoResumePendingTurn(
        {
          inboundMsg: baseMsg,
          startedAtMs: now - 45 * 60_000,
          interruptedAtMs: now - MAX_AUTO_RESUME_AGE_MS - 1_000,
          interruptKind: 'graceful_shutdown',
          gracefulRecoveryAttempts: 0,
          recoveryAttempts: 0,
        },
        now,
        { phase: 'startup' },
      ),
    ).toBe(false)

    // Graceful retry cap reached -> rejected even at shutdown.
    expect(
      canAutoResumePendingTurn(
        {
          inboundMsg: baseMsg,
          startedAtMs: now - 5 * 60_000,
          interruptKind: 'graceful_shutdown',
          gracefulRecoveryAttempts: MAX_GRACEFUL_AUTO_RESUME_ATTEMPTS,
          recoveryAttempts: 0,
        },
        now,
        { phase: 'shutdown' },
      ),
    ).toBe(false)

    // Absolute safety age cap (> 6 hours) -> rejected even at shutdown.
    expect(
      canAutoResumePendingTurn(
        {
          inboundMsg: baseMsg,
          startedAtMs: now - MAX_AUTO_RESUME_TOTAL_AGE_MS - 1_000,
          gracefulRecoveryAttempts: 0,
          recoveryAttempts: 0,
        },
        now,
        { phase: 'shutdown' },
      ),
    ).toBe(false)
  })

  it('scans the tail window of persisted sessions exceeding 2000 events when checking turn completion', async () => {
    const now = Date.now()
    const longEvents: SessionEvent[] = []
    for (let i = 0; i < 2300; i += 1) {
      longEvents.push({
        type: 'assistant/message',
        seq: i,
        time: now - 60_000 + i,
        data: {
          turn: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: `history-${i}` }] },
        },
      } as unknown as SessionEvent)
    }
    longEvents.push(
      { type: 'turn/start', seq: 2300, time: now - 5_000, data: { turn: 99 } } as unknown as SessionEvent,
      {
        type: 'user/message',
        seq: 2301,
        time: now - 5_000,
        data: {
          content: [{ type: 'text', text: '<lark_context message_id="om_tail_done" />\n检查末尾回合' }],
        },
      } as unknown as SessionEvent,
      {
        type: 'assistant/message',
        seq: 2302,
        time: now - 2_000,
        data: {
          turn: 99,
          message: { role: 'assistant', content: [{ type: 'text', text: '长会话末尾已完成回复' }] },
        },
      } as unknown as SessionEvent,
      {
        type: 'turn/end',
        seq: 2303,
        time: now - 2_000,
        data: { turn: 99, reason: { kind: 'completed' } },
      } as unknown as SessionEvent,
    )

    const persistedEventsBySession = new Map<string, readonly SessionEvent[]>([
      ['session-long-tail', longEvents],
    ])
    const host = createFakeHostContext({ persistedEventsBySession })
    const result = await inspectPersistedTurnCompletion(host.ctx, 'session-long-tail', 'om_tail_done')
    expect(result).toEqual({
      state: 'completed',
      replyText: '长会话末尾已完成回复',
      missedIntermediates: [],
      silencedByTool: false,
      turn: 99,
    })
  })
})
