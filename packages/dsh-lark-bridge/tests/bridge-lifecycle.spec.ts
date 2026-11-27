import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

import { LarkBridgeManager } from '../src/bridge-manager.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-lifecycle-test-'))
  tempDirs.push(dir)
  return dir
}

describe('LarkBridgeManager prompt injection, title hygiene & auto-archiving', () => {
  it('injects role + proactive protocol + context + listener inside <system_reminder>, leaves workDir clean of .local, protects clean user-intent titles, and auto-archives silent/expired sessions', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir()

    const store = new LarkBridgeStore(dir)
    const bot = store.upsertBot({
      id: 'dsh-bot',
      name: 'DSH-Bot',
      enabled: false,
      larkAppId: 'cli_test',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: workDir,
      idleCloseMinutes: 1,
      role: {
        enabled: true,
        name: '资深工程师',
        systemPrompt: '先给结论，再附代码定位。',
      },
      experimental: {
        dreaming: {
          enabled: true,
        },
        proactive: {
          remindersEnabled: true,
          reminderCreationMode: 'silent',
          autoCodeEnabled: true,
          branchPrefix: 'agent/',
        },
      },
    })
    store.upsertGroup({
      botId: 'dsh-bot',
      chatId: 'oc_team',
      chatName: '研发协作群',
      enabled: true,
      idleCloseMinutes: null,
      listener: {
        enabled: true,
        templateKey: 'project',
        name: '项目讨论',
        prompt: '你只监听技术相关的消息，其他消息保持静默',
        replyMode: 'new-topic',
        sessionMode: 'per_message',
        allowSilentEmptyReply: true,
      },
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    }

    const archivedSessionIds: string[] = []
    const sessionTitles = new Map<string, string>()
    const submittedPrompts: string[] = []
    let nextReply = ''

    const liveSessions = new Map<string, { id: string; events: SessionEvent[] }>()

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((f) => f !== fn),
          )
        }
      },
      sessions: {
        get: (id: string) => {
          const found = liveSessions.get(id)
          return found ? ({ id: found.id, snapshotEvents: () => found.events } as unknown as Session) : undefined
        },
      },
      agents: {
        get: () => undefined,
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const events: SessionEvent[] = []
          const sessionObj = {
            id: sessionId,
            header: { cwd: workDir, agentPreset: 'codex' },
            append: vi.fn(),
            snapshotEvents: () => events,
          } as unknown as Session
          liveSessions.set(sessionId, { id: sessionId, events })
          const agent = {
            session: sessionObj,
            followup: (userMsg: { content: Array<{ type: string; text?: string }> }) => {
              const text = userMsg.content.map((b) => b.text ?? '').join('\n')
              submittedPrompts.push(text)
              events.push({
                type: 'user/message',
                data: { content: userMsg.content, source: { kind: 'user' } },
              } as unknown as SessionEvent)
              emit('session/event', sessionObj, { type: 'turn/start', data: { turn: 1 } })
              if (nextReply) {
                emit('session/event', sessionObj, {
                  type: 'assistant/message',
                  data: { turn: 1, message: { content: [{ type: 'text', text: nextReply }] } },
                })
              }
              emit('session/event', sessionObj, {
                type: 'turn/end',
                data: { turn: 1, reason: { kind: 'complete' } },
              })
            },
          }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get(service: string) {
        if (service === 'workspaceRegistry') {
          return {
            archivedSessionIds,
            list: () => [],
            create: async (_dir: string, title?: string) => ({
              title: title ?? 'DSH-Bot',
              setTitle: vi.fn(),
              attachSession: vi.fn(),
            }),
            archiveSession: vi.fn(async (sid: string) => {
              if (!archivedSessionIds.includes(sid)) archivedSessionIds.push(sid)
            }),
          }
        }
        if (service === 'sessionTitle') {
          return {
            get: (s: Session) => (sessionTitles.has(s.id) ? { title: sessionTitles.get(s.id), source: { kind: 'user' } } : undefined),
            rename: (s: Session, next: string) => {
              sessionTitles.set(s.id, next)
            },
          }
        }
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://192.168.1.10:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    await manager.start()

    store.upsertBot({ ...bot, enabled: true })
    const fakeTransport = {
      state: { botOpenId: 'ou_bot' },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_user_1', name: 'Alex Chen' }),
      addReaction: vi.fn().mockResolvedValue('r1'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockResolvedValue({ messageId: 'om_reply_1' }),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    }

    // 1. Silent-skipped listener message -> injects role + memory + context + listener + <user_message>, clean title, and auto-archives!
    nextReply = ''
    await (manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }).handleInbound(
      'dsh-bot',
      fakeTransport,
      {
        botId: 'dsh-bot',
        larkAppId: 'cli_test',
        botOpenId: 'ou_bot',
        messageId: 'om_msg_1',
        chatId: 'oc_team',
        chatType: 'group',
        msgType: 'text',
        senderOpenId: 'ou_user_1',
        senderType: 'user',
        text: '收到，谢谢大家',
        rawContent: '{"text":"收到，谢谢大家"}',
        mentions: [],
        imageKeys: [],
        createTimeMs: Date.now(),
      },
    )

    expect(submittedPrompts[0]?.match(/<system_reminder>/g)).toHaveLength(1)
    expect(submittedPrompts[0]).toContain('<role name="资深工程师">')
    expect(submittedPrompts[0]).toContain('<proactive reminders="silent" auto_code="on">')
    expect(submittedPrompts[0]).toContain('.worktrees/')
    expect(submittedPrompts[0]).toContain('<lark_context bot_id="dsh-bot"')
    expect(submittedPrompts[0]).toContain('sender_name="Alex Chen"')
    expect(submittedPrompts[0]).toContain('<listener name="项目讨论"')
    expect(submittedPrompts[0]).toContain('<user_message>\n收到，谢谢大家\n</user_message>')
    expect(existsSync(join(workDir, '.local'))).toBe(false)
    expect(fakeTransport.sendReply).not.toHaveBeenCalled()
    expect(archivedSessionIds).toHaveLength(1)
    const firstSid = archivedSessionIds[0]!
    expect(sessionTitles.get(firstSid)).toBe('收到，谢谢大家')

    // 2. Simulate fallback overwriting title with XML -> installSessionTitleGuard immediately repairs it!
    const sessionObj = {
      id: firstSid,
      snapshotEvents: () => liveSessions.get(firstSid)!.events,
    } as unknown as Session
    emit('session/event', sessionObj, {
      type: 'session/title',
      data: { title: '<system_reminder>\n<listener name="项目讨论">', source: { kind: 'fallback' } },
    })
    expect(sessionTitles.get(firstSid)).toBe('收到，谢谢大家')

    // 3. Mentioned thread session -> expires after idleCloseMs -> sweepIdleBindings archives it!
    nextReply = '排查结论：一切正常'
    await (manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }).handleInbound(
      'dsh-bot',
      fakeTransport,
      {
        botId: 'dsh-bot',
        larkAppId: 'cli_test',
        botOpenId: 'ou_bot',
        messageId: 'om_msg_2',
        chatId: 'oc_team',
        chatType: 'group',
        msgType: 'text',
        senderOpenId: 'ou_user_1',
        senderType: 'user',
        text: '@_user_1 帮我检查核心网关服务健康状态',
        rawContent: '{}',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DSH-Bot' }],
        imageKeys: [],
        createTimeMs: Date.now(),
      },
    )
    expect(fakeTransport.sendReply).toHaveBeenCalledTimes(1)
    const activeBinding = store.listBindings()[0]!
    expect(sessionTitles.get(activeBinding.sessionId)).toBe('帮我检查核心网关服务健康状态')

    store.upsertBinding({
      ...activeBinding,
      lastActivityMs: Date.now() - 120_000,
    })
    const swept = await manager.sweepIdleBindings()
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(archivedSessionIds).toContain(activeBinding.sessionId)

    // 4. Group-level independent Agent runtime override takes priority over bot runtime and rotates mismatched bindings
    store.upsertGroup({
      ...store.getGroup('dsh-bot', 'oc_team')!,
      runtimeMode: 'override',
      agentPreset: 'agy',
      model: 'gemini-4-neon-high',
      reasoningEffort: '',
      sessionMode: 'chat',
    })
    await (manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }).handleInbound(
      'dsh-bot',
      fakeTransport,
      {
        botId: 'dsh-bot',
        larkAppId: 'cli_test',
        botOpenId: 'ou_bot',
        messageId: 'om_msg_3',
        chatId: 'oc_team',
        chatType: 'group',
        msgType: 'text',
        senderOpenId: 'ou_user_1',
        senderType: 'user',
        text: '@_user_1 测试本群独立运行时',
        rawContent: '{}',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DSH-Bot' }],
        imageKeys: [],
        createTimeMs: Date.now(),
      },
    )
    const createCalls = (fakeCtx.agents.create as ReturnType<typeof vi.fn>).mock.calls
    const lastCreateArg = createCalls[createCalls.length - 1]?.[0] as {
      meta: { agentPreset: string }
      agentOptions: { model?: string; reasoningEffort?: string }
    }
    expect(lastCreateArg.meta.agentPreset).toBe('agy')
    expect(lastCreateArg.agentOptions.model).toBe('gemini-4-neon-high')
    expect(lastCreateArg.agentOptions.reasoningEffort).toBeUndefined()

    const groupView = store.listGroupViews('dsh-bot').find((g) => g.chatId === 'oc_team')
    expect(groupView).toMatchObject({
      runtimeSource: 'group',
      effectiveAgentPreset: 'agy',
      effectiveModel: 'gemini-4-neon-high',
    })

    // 5. Group-level message overrides (reaction, card footer, and idleCloseMinutes=0/null)
    const savedWithIdle = store.upsertGroup({
      ...store.getGroup('dsh-bot', 'oc_team')!,
      idleCloseMinutes: 0,
      receivedReactionEmoji: 'THUMBSUP',
      replyFormat: 'card',
      dshSessionLinkInCard: 'off',
      replyFooterModel: 'off',
      signatureMode: 'custom',
      signature: '本群专属卡片签名',
    })
    expect(savedWithIdle.idleCloseMinutes).toBe(0)
    await manager.unbindRoute(store.listBindings()[0]!.routeKey, { archive: false })
    fakeTransport.addReaction.mockClear()
    fakeTransport.sendReply.mockClear()
    nextReply = '已使用本群专属配置回复'

    await (manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }).handleInbound(
      'dsh-bot',
      fakeTransport,
      {
        botId: 'dsh-bot',
        larkAppId: 'cli_test',
        botOpenId: 'ou_bot',
        messageId: 'om_msg_4',
        chatId: 'oc_team',
        chatType: 'group',
        msgType: 'text',
        senderOpenId: 'ou_user_1',
        senderType: 'user',
        text: '@_user_1 验证群级消息配置',
        rawContent: '{}',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DSH-Bot' }],
        imageKeys: [],
        createTimeMs: Date.now(),
      },
    )
    expect(fakeTransport.addReaction).toHaveBeenCalledWith('om_msg_4', 'THUMBSUP')

    const sentReplyArg = fakeTransport.sendReply.mock.calls[0]?.[0] as { card?: Record<string, unknown> }
    const sentCardStr = JSON.stringify(sentReplyArg?.card ?? {})
    expect(sentCardStr).toContain('本群专属卡片签名')
    expect(sentCardStr).not.toContain('在 DSH 接管会话')

    // Verify idleCloseMinutes: 0 keeps session from expiring even when bot.idleCloseMinutes = 1
    const zeroIdleBinding = store.listBindings()[0]!
    expect(zeroIdleBinding.idleCloseMs).toBeUndefined()
    store.upsertBinding({
      ...zeroIdleBinding,
      lastActivityMs: Date.now() - 600_000,
    })
    expect(await manager.sweepIdleBindings()).toBe(0)

    // Verify resetting idleCloseMinutes to null removes the group override
    const resetIdleGroup = store.upsertGroup({
      ...store.getGroup('dsh-bot', 'oc_team')!,
      idleCloseMinutes: null,
    })
    expect(resetIdleGroup.idleCloseMinutes).toBeUndefined()

    // 6. Multi-group same-directory conflict resolution (prevents Group B overwriting Group A's workspace title)
    const exclusiveRepoDir = join(workDir, 'order-service')
    const sharedRepoDir = join(workDir, 'core-service')
    store.upsertGroup({
      botId: 'dsh-bot',
      chatId: 'oc_order_only',
      chatName: '订单研发群',
      enabled: true,
      workingDir: exclusiveRepoDir,
      workspaceName: '',
    })
    store.upsertGroup({
      botId: 'dsh-bot',
      chatId: 'oc_svc_alert',
      chatName: '【核心服务】告警群',
      enabled: true,
      workingDir: sharedRepoDir,
      workspaceName: '',
    })
    store.upsertGroup({
      botId: 'dsh-bot',
      chatId: 'oc_svc_release',
      chatName: '核心服务发布群',
      enabled: true,
      workingDir: sharedRepoDir,
      workspaceName: '',
    })

    const expectedSharedRoot = workDir.split('/').filter(Boolean).pop()!
    const viewsByChat = new Map(store.listGroupViews('dsh-bot').map((v) => [v.chatId, v]))
    // Bot and groups without explicit workspaceName default to leaf directory name
    expect(store.resolveBotWorkspaceName(store.getBot('dsh-bot')!)).toBe(expectedSharedRoot)
    expect(viewsByChat.get('oc_team')?.effectiveWorkspaceName).toBe(expectedSharedRoot)
    expect(viewsByChat.get('oc_order_only')?.effectiveWorkspaceName).toBe('order-service')
    expect(viewsByChat.get('oc_svc_alert')?.effectiveWorkspaceName).toBe('core-service')
    expect(viewsByChat.get('oc_svc_release')?.effectiveWorkspaceName).toBe('core-service')

    // 7. Multi-bot same-defaultWorkingDir stays consistent on leaf directory name, and explicit peer workspaceName wins
    const peerBot = store.upsertBot({
      id: 'peer-bot',
      name: 'PeerBot',
      enabled: true,
      larkAppId: 'cli_peer',
      larkAppSecret: 'sec_peer',
      defaultWorkingDir: workDir,
    })
    expect(store.resolveBotWorkspaceName(store.getBot('dsh-bot')!)).toBe(expectedSharedRoot)
    expect(store.resolveBotWorkspaceName(peerBot)).toBe(expectedSharedRoot)
    expect(
      store.listGroupViews('dsh-bot').find((v) => v.chatId === 'oc_team')?.effectiveWorkspaceName,
    ).toBe(expectedSharedRoot)

    store.upsertBot({
      ...peerBot,
      workspaceName: '共享主工作区',
    })
    expect(store.resolveBotWorkspaceName(store.getBot('dsh-bot')!)).toBe('共享主工作区')
    expect(
      store.listGroupViews('dsh-bot').find((v) => v.chatId === 'oc_team')?.effectiveWorkspaceName,
    ).toBe('共享主工作区')

    await manager.stop()
  })

  it('resolves native provider/model and mounts preset plugins on create and cold resume for built-in standard preset, while forwarding agentOptions on external cold resume without native setup', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const bot = store.upsertBot({
      id: 'std-bot',
      name: 'StandardBot',
      enabled: false,
      larkAppId: 'cli_std',
      larkAppSecret: 'sec_std',
      defaultWorkingDir: workDir,
      agentPreset: 'standard',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      p2pReplyMode: 'reply',
      useCardReply: false,
    })
    const codexBot = store.upsertBot({
      id: 'codex-bot',
      name: 'CodexBot',
      enabled: false,
      larkAppId: 'cli_codex',
      larkAppSecret: 'sec_codex',
      defaultWorkingDir: workDir,
      agentPreset: 'codex',
      model: 'gpt-6.1-sol',
      p2pReplyMode: 'reply',
      useCardReply: false,
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    }

    const mountedPresets: string[] = []
    const createCalls: Array<{ sessionId: string; meta?: unknown; agentOptions?: unknown }> = []
    const resumeCalls: Array<{ resumeSessionId: string; agentOptions?: unknown; hasSetup: boolean }> = []
    const liveAgents = new Map<string, unknown>()

    const makeAgent = (sessionId: string, presetId: string) => {
      const events: SessionEvent[] = []
      const sessionObj = {
        id: sessionId,
        header: { cwd: workDir, agentPreset: presetId },
        append: vi.fn(),
        snapshotEvents: () => events,
      } as unknown as Session
      return {
        session: sessionObj,
        model: {
          current: () => ({ provider: presetId === 'codex' ? 'codex-cli' : 'deepseek', model: 'deepseek-reasoner' }),
          select: vi.fn(),
        },
        followup: () => {
          emit('session/event', sessionObj, { type: 'turn/start', data: { turn: 1 } })
          emit('session/event', sessionObj, {
            type: 'assistant/message',
            data: { turn: 1, message: { content: [{ type: 'text', text: '收到' }] } },
          })
          emit('session/event', sessionObj, {
            type: 'turn/end',
            data: { turn: 1, reason: { kind: 'complete' } },
          })
        },
      }
    }

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
        }
      },
      sessions: { get: () => undefined },
      llm: {
        listProviders: () => [
          { id: 'codex-cli', name: 'Codex' },
          { id: 'deepseek', name: 'DeepSeek' },
        ],
        listModels: async (providerId: string) =>
          providerId === 'deepseek'
            ? [
                { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
                { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
              ]
            : [{ provider: 'codex-cli', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
      },
      agents: {
        get: (id: string) => liveAgents.get(id),
        create: vi.fn(
          async (opts: {
            sessionId: string
            meta?: { agentPreset?: string }
            agentOptions?: unknown
            setup?: (c: unknown, a: unknown) => Promise<void> | void
          }) => {
            createCalls.push({
              sessionId: opts.sessionId,
              meta: opts.meta,
              agentOptions: opts.agentOptions,
            })
            const agent = makeAgent(opts.sessionId, opts.meta?.agentPreset ?? 'standard')
            await opts.setup?.({ on: vi.fn() }, agent)
            liveAgents.set(opts.sessionId, agent)
            return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
          },
        ),
        resume: vi.fn(
          async (opts: {
            resumeSessionId: string
            agentOptions?: unknown
            setup?: (c: unknown, a: unknown) => Promise<void> | void
          }) => {
            resumeCalls.push({
              resumeSessionId: opts.resumeSessionId,
              agentOptions: opts.agentOptions,
              hasSetup: typeof opts.setup === 'function',
            })
            const preset = opts.agentOptions ? 'standard' : 'codex'
            const agent = makeAgent(opts.resumeSessionId, preset)
            await opts.setup?.({ on: vi.fn() }, agent)
            liveAgents.set(opts.resumeSessionId, agent)
            return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
          },
        ),
      },
      get(service: string) {
        if (service === 'externalRuntimes') {
          const codex = {
            id: 'codex',
            displayName: 'Codex',
            description: 'Codex',
            providerId: 'codex-cli',
            defaultModel: 'gpt-6.1-sol',
          }
          return {
            list: () => [codex],
            get: (id: string) => (id === 'codex' ? codex : undefined),
          }
        }
        if (service === 'agentPresets') {
          return {
            remoteExportList: async () => ({ presets: [{ id: 'standard', isDefault: true }] }),
            mount: async (_ctx: unknown, presetId?: string) => {
              if (presetId) mountedPresets.push(presetId)
            },
          }
        }
        if (service === 'workspaceRegistry') {
          return {
            list: () => [],
            create: async (_d: string, title?: string) => ({
              title: title ?? 'ws',
              setTitle: vi.fn(),
              attachSession: vi.fn(),
            }),
          }
        }
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://192.168.1.10:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    await manager.start()
    store.upsertBot({ ...bot, enabled: true })
    store.upsertBot({ ...codexBot, enabled: true })

    const fakeTransport = {
      state: { botOpenId: 'ou_bot' },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_u1', name: 'Tester' }),
      addReaction: vi.fn().mockResolvedValue('r1'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockResolvedValue({ messageId: 'om_r1' }),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    }

    const handleInbound = (
      manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }
    ).handleInbound.bind(manager)

    // 1. Initial turn for built-in `standard` preset passes provider + model + effort and mounts preset
    await handleInbound('std-bot', fakeTransport, {
      messageId: 'om_std_1',
      chatId: 'oc_p2p_std',
      chatType: 'p2p',
      senderOpenId: 'ou_u1',
      text: '你好',
      mentions: [],
      imageKeys: [],
    })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.agentOptions).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    })
    expect(mountedPresets).toEqual(['standard'])

    // 2. Cold resume for built-in `standard` preset re-supplies native agentOptions and re-mounts preset
    liveAgents.clear()
    await handleInbound('std-bot', fakeTransport, {
      messageId: 'om_std_2',
      chatId: 'oc_p2p_std',
      chatType: 'p2p',
      senderOpenId: 'ou_u1',
      text: '继续',
      mentions: [],
      imageKeys: [],
    })
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]?.agentOptions).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    })
    expect(resumeCalls[0]?.hasSetup).toBe(true)
    expect(mountedPresets).toEqual(['standard', 'standard'])

    // 3. External `codex` cold resume forwards launch agentOptions as fallback without native preset setup
    await handleInbound('codex-bot', fakeTransport, {
      messageId: 'om_cx_1',
      chatId: 'oc_p2p_cx',
      chatType: 'p2p',
      senderOpenId: 'ou_u1',
      text: 'hi',
      mentions: [],
      imageKeys: [],
    })
    liveAgents.clear()
    await handleInbound('codex-bot', fakeTransport, {
      messageId: 'om_cx_2',
      chatId: 'oc_p2p_cx',
      chatType: 'p2p',
      senderOpenId: 'ou_u1',
      text: 'next',
      mentions: [],
      imageKeys: [],
    })
    expect(resumeCalls).toHaveLength(2)
    expect(resumeCalls[1]?.agentOptions).toEqual({
      provider: 'codex-cli',
      model: 'gpt-6.1-sol',
    })
    expect(resumeCalls[1]?.hasSetup).toBe(false)

    await manager.stop()
  })

  it('prevents un-replied listener threads from leaking empty-output fallback replies, cleans up silent bindings, and preserves silent followup after reply', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const bot = store.upsertBot({
      id: 'daily-bot',
      name: 'DailyBot',
      enabled: false,
      larkAppId: 'cli_daily',
      larkAppSecret: 'sec_daily',
      defaultWorkingDir: workDir,
      mentionTriggerMode: 'mention_and_active_thread',
      useInteractiveCard: false,
    })
    store.upsertGroup({
      botId: 'daily-bot',
      chatId: 'oc_daily',
      chatName: '研发日常群',
      enabled: true,
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '无需回复或 @他人 时直接输出空文本保持静默。',
        scope: 'all',
        replyMode: 'reply',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
        excludeKeywords: ['@'],
      },
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    }
    const archivedSessionIds: string[] = []
    const disposedSessionIds: string[] = []
    const liveAgents = new Map<string, unknown>()
    const pendingTurns: Array<{ session: Session; turn: number; finish: (replyText: string) => void }> = []
    const turnCounters = new Map<string, number>()

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
        }
      },
      sessions: { get: () => undefined },
      agents: {
        get: (id: string) => liveAgents.get(id),
        create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          const sessionObj = {
            id: sessionId,
            header: { cwd: workDir, agentPreset: 'codex' },
            append: vi.fn(),
            snapshotEvents: () => [],
          } as unknown as Session
          const agent = {
            session: sessionObj,
            followup: () => {
              const turn = (turnCounters.get(sessionId) ?? 0) + 1
              turnCounters.set(sessionId, turn)
              emit('session/event', sessionObj, { type: 'turn/start', data: { turn } })
              pendingTurns.push({
                session: sessionObj,
                turn,
                finish: (replyText: string) => {
                  if (replyText) {
                    emit('session/event', sessionObj, {
                      type: 'assistant/message',
                      data: { turn, message: { content: [{ type: 'text', text: replyText }] } },
                    })
                  }
                  emit('session/event', sessionObj, {
                    type: 'turn/end',
                    data: { turn, reason: { kind: 'completed' } },
                  })
                },
              })
            },
          }
          liveAgents.set(sessionId, agent)
          return {
            agent,
            dispose: vi.fn(async () => {
              disposedSessionIds.push(sessionId)
              liveAgents.delete(sessionId)
            }),
          }
        }),
      },
      get(service: string) {
        if (service === 'workspaceRegistry') {
          return {
            list: () => [],
            create: async (_d: string, title?: string) => ({
              title: title ?? 'ws',
              setTitle: vi.fn(),
              attachSession: vi.fn(),
            }),
            archiveSession: vi.fn(async (sid: string) => {
              if (!archivedSessionIds.includes(sid)) archivedSessionIds.push(sid)
            }),
          }
        }
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://192.0.2.10:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    await manager.start()
    store.upsertBot({ ...bot, enabled: true })

    const fakeTransport = {
      state: { botOpenId: 'ou_bot' },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_user_1', name: 'Alex Chen' }),
      addReaction: vi.fn().mockResolvedValue('r1'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockResolvedValue({ messageId: 'om_reply_sent' }),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    }
    const handleInbound = (
      manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }
    ).handleInbound.bind(manager)

    // Case 1: Turn 1 starts on a listener thread (hasReplied=false). While Turn 1 is still running,
    // a quoted reply mentioning another member (`@Sam 空降`) arrives -> filtered by excludeKeywords=['@']
    // instead of being hijacked into active-thread!
    const turn1Promise = handleInbound('daily-bot', fakeTransport, {
      botId: 'daily-bot',
      larkAppId: 'cli_daily',
      botOpenId: 'ou_bot',
      messageId: 'om_root_1',
      chatId: 'oc_daily',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '感觉周围人变多了',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    await vi.waitFor(() => expect(pendingTurns).toHaveLength(1))
    expect(store.listBindings()).toHaveLength(1)
    expect(store.listBindings()[0]?.hasReplied).toBe(false)

    await handleInbound('daily-bot', fakeTransport, {
      botId: 'daily-bot',
      larkAppId: 'cli_daily',
      botOpenId: 'ou_bot',
      messageId: 'om_quote_excluded',
      chatId: 'oc_daily',
      chatType: 'group',
      rootId: 'om_root_1',
      parentId: 'om_root_1',
      msgType: 'text',
      senderOpenId: 'ou_user_2',
      senderType: 'user',
      text: '@_user_2 空降',
      rawContent: '{}',
      mentions: [{ key: '@_user_2', openId: 'ou_peer', name: 'Sam' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    // Still only 1 agent turn created; excluded message never triggered the agent or sent fallback text
    expect(pendingTurns).toHaveLength(1)
    expect(fakeTransport.sendReply).not.toHaveBeenCalled()

    // Turn 1 finishes silently -> binding is removed and session is archived (no zombie thread binding!)
    const sid1 = pendingTurns[0]!.session.id
    pendingTurns.shift()!.finish('')
    await turn1Promise
    expect(fakeTransport.sendReply).not.toHaveBeenCalled()
    expect(store.listBindings()).toHaveLength(0)
    expect(disposedSessionIds).toContain(sid1)
    expect(archivedSessionIds).toContain(sid1)

    // Case 2: Listener thread DOES reply -> binding stays active with hasReplied=true;
    // subsequent active-thread message returning empty text silently skips instead of sending fallback
    const turn2Promise = handleInbound('daily-bot', fakeTransport, {
      botId: 'daily-bot',
      larkAppId: 'cli_daily',
      botOpenId: 'ou_bot',
      messageId: 'om_root_2',
      chatId: 'oc_daily',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '这个报错有谁遇到过吗',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    await vi.waitFor(() => expect(pendingTurns).toHaveLength(1))
    pendingTurns.shift()!.finish('刚查了代码，是连接池超时配置过小。')
    await turn2Promise

    expect(fakeTransport.sendReply).toHaveBeenCalledTimes(1)
    expect(store.listBindings()).toHaveLength(1)
    expect(store.listBindings()[0]?.hasReplied).toBe(true)

    const turn2FollowupPromise = handleInbound('daily-bot', fakeTransport, {
      botId: 'daily-bot',
      larkAppId: 'cli_daily',
      botOpenId: 'ou_bot',
      messageId: 'om_root_2_reply',
      chatId: 'oc_daily',
      chatType: 'group',
      rootId: 'om_root_2',
      parentId: 'om_root_2',
      msgType: 'text',
      senderOpenId: 'ou_user_2',
      senderType: 'user',
      text: '收到，我马上去改',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    await vi.waitFor(() => expect(pendingTurns).toHaveLength(1))
    pendingTurns.shift()!.finish('')
    await turn2FollowupPromise

    // Silent skip honored (no "（已完成，无文本输出）" sent) and active thread binding stays alive
    expect(fakeTransport.sendReply).toHaveBeenCalledTimes(1)
    expect(store.listBindings()).toHaveLength(1)

    // Case 3: Two overlapping listener turns on an un-replied thread -> first silent turn does NOT
    // prematurely dispose the agent while second turn is still in flight; cleanup runs once both finish silently
    const turn3aPromise = handleInbound('daily-bot', fakeTransport, {
      botId: 'daily-bot',
      larkAppId: 'cli_daily',
      botOpenId: 'ou_bot',
      messageId: 'om_root_3',
      chatId: 'oc_daily',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '上午好',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    await vi.waitFor(() => expect(pendingTurns).toHaveLength(1))

    const turn3bPromise = handleInbound('daily-bot', fakeTransport, {
      botId: 'daily-bot',
      larkAppId: 'cli_daily',
      botOpenId: 'ou_bot',
      messageId: 'om_root_3_reply',
      chatId: 'oc_daily',
      chatType: 'group',
      rootId: 'om_root_3',
      parentId: 'om_root_3',
      msgType: 'text',
      senderOpenId: 'ou_user_2',
      senderType: 'user',
      text: '早呀',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    // Wait until turn3b has acquired the same session and registered in-flight behind turn3a (FIFO serialized)
    const sid3 = pendingTurns[0]!.session.id
    await vi.waitFor(() =>
      expect(
        (manager as unknown as { inFlightTurns: Map<string, number> }).inFlightTurns.get(sid3),
      ).toBe(2),
    )
    expect(pendingTurns).toHaveLength(1)

    // First turn finishes silently while second turn is queued -> must keep handle & binding alive
    pendingTurns.shift()!.finish('')
    await turn3aPromise
    expect(disposedSessionIds).not.toContain(sid3)
    expect(store.listBindings().some((b) => b.sessionId === sid3)).toBe(true)

    // Second turn immediately runs on the same session and finishes silently -> now safely disposes, unbinds, and archives
    await vi.waitFor(() => expect(pendingTurns).toHaveLength(1))
    expect(pendingTurns[0]!.session.id).toBe(sid3)
    pendingTurns.shift()!.finish('')
    await turn3bPromise
    expect(disposedSessionIds).toContain(sid3)
    expect(archivedSessionIds).toContain(sid3)
    expect(store.listBindings().some((b) => b.sessionId === sid3)).toBe(false)

    await manager.stop()
  })

  it('keeps the same session across quoted-chain to topic promotion, chat-mode reply followup, concurrent creation, and store reload', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const bot = store.upsertBot({
      id: 'collab-bot',
      name: 'CollabBot',
      enabled: false,
      larkAppId: 'cli_collab',
      larkAppSecret: 'sec_collab',
      defaultWorkingDir: workDir,
      groupReplyMode: 'reply',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
      useInteractiveCard: false,
    })
    store.upsertGroup({
      botId: 'collab-bot',
      chatId: 'oc_collab',
      chatName: '协作研发群',
      enabled: true,
      replyMode: 'reply',
      sessionMode: 'inherit',
      mentionTriggerMode: 'inherit',
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '必要时参与讨论，否则静默。',
        scope: 'all',
        replyMode: 'reply',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
        excludeKeywords: ['@'],
      },
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    }
    const archivedSessionIds: string[] = []
    const disposedSessionIds: string[] = []
    const liveAgents = new Map<string, unknown>()
    const submittedBySession = new Map<string, string[]>()
    const turnCounters = new Map<string, number>()
    let releaseSlowCreate: (() => void) | undefined
    let slowCreateGate = false

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
        }
      },
      sessions: { get: () => undefined },
      agents: {
        get: (id: string) => liveAgents.get(id),
        create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          if (slowCreateGate) {
            await new Promise<void>((resolve) => {
              releaseSlowCreate = resolve
            })
          }
          const sessionObj = {
            id: sessionId,
            header: { cwd: workDir, agentPreset: 'codex' },
            append: vi.fn(),
            snapshotEvents: () => [],
          } as unknown as Session
          const agent = {
            session: sessionObj,
            followup: (userMsg: { content: Array<{ type: string; text?: string }> }) => {
              const turn = (turnCounters.get(sessionId) ?? 0) + 1
              turnCounters.set(sessionId, turn)
              const prompts = submittedBySession.get(sessionId) ?? []
              prompts.push(userMsg.content.map((b) => b.text ?? '').join('\n'))
              submittedBySession.set(sessionId, prompts)
              emit('session/event', sessionObj, { type: 'turn/start', data: { turn } })
              emit('session/event', sessionObj, {
                type: 'assistant/message',
                data: { turn, message: { content: [{ type: 'text', text: `回复第 ${turn} 轮` }] } },
              })
              emit('session/event', sessionObj, {
                type: 'turn/end',
                data: { turn, reason: { kind: 'completed' } },
              })
            },
          }
          liveAgents.set(sessionId, agent)
          return {
            agent,
            dispose: vi.fn(async () => {
              disposedSessionIds.push(sessionId)
              liveAgents.delete(sessionId)
            }),
          }
        }),
      },
      get(service: string) {
        if (service === 'workspaceRegistry') {
          return {
            list: () => [],
            create: async (_d: string, title?: string) => ({
              title: title ?? 'ws',
              setTitle: vi.fn(),
              attachSession: vi.fn(),
            }),
            archiveSession: vi.fn(async (sid: string) => {
              if (!archivedSessionIds.includes(sid)) archivedSessionIds.push(sid)
            }),
          }
        }
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://192.0.2.10:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    await manager.start()
    store.upsertBot({ ...bot, enabled: true })

    let nextSendResult: { messageId?: string; rootId?: string; threadId?: string } = {
      messageId: 'om_m2',
      rootId: 'om_m1',
    }
    const fakeTransport = {
      state: { botOpenId: 'ou_bot' },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_user_1', name: 'Sam' }),
      addReaction: vi.fn().mockResolvedValue('r1'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn(async () => nextSendResult),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
    }
    const handleInbound = (
      manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }
    ).handleInbound.bind(manager)

    // 1. M1 (top-level @bot) creates S1 and replies as a regular quote M2 (no threadId)
    await handleInbound('collab-bot', fakeTransport, {
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      botOpenId: 'ou_bot',
      messageId: 'om_m1',
      chatId: 'oc_collab',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '@_bot_1 帮忙 review 下 MR 234',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'CollabBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(store.listBindings()).toHaveLength(1)
    const s1 = store.listBindings()[0]!.sessionId

    // 2. Group switches to replyMode='new-topic'; M3 quotes M2 (rootId=om_m1, no threadId) with @bot.
    //    Bot replies M4 with reply_in_thread=true -> Feishu promotes M3 to topic root (rootId=om_m3, threadId=omt_promoted_1).
    store.upsertGroup({
      ...store.getGroup('collab-bot', 'oc_collab')!,
      replyMode: 'new-topic',
    })
    nextSendResult = {
      messageId: 'om_m4',
      rootId: 'om_m3',
      threadId: 'omt_promoted_1',
    }
    await handleInbound('collab-bot', fakeTransport, {
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      botOpenId: 'ou_bot',
      messageId: 'om_m3',
      chatId: 'oc_collab',
      chatType: 'group',
      rootId: 'om_m1',
      parentId: 'om_m2',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '@_bot_1 需要 cherry-pick 拉新分支吗？',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'CollabBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(store.listBindings()).toHaveLength(1)
    expect(store.listBindings()[0]?.sessionId).toBe(s1)
    expect(store.listBindings()[0]?.routeKey).toBe('cli_collab:oc_collab:om_m3')
    expect(store.listBindings()[0]?.aliasRouteKeys).toEqual(['cli_collab:oc_collab:omt_promoted_1'])
    expect(store.getBinding('cli_collab:oc_collab:om_m1')).toBeUndefined()
    expect(manager.resolveAgentContext(s1).replyToMessageId).toBe('om_m3')

    // 3. M5 ("你帮我拉下", un-mentioned, inside promoted topic: rootId=om_m3, threadId=omt_promoted_1)
    //    MUST reuse S1 via active-thread instead of falling through to listener & creating S2!
    nextSendResult = {
      messageId: 'om_m6',
      rootId: 'om_m3',
      threadId: 'omt_promoted_1',
    }
    await handleInbound('collab-bot', fakeTransport, {
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      botOpenId: 'ou_bot',
      messageId: 'om_m5',
      chatId: 'oc_collab',
      chatType: 'group',
      rootId: 'om_m3',
      parentId: 'om_m3',
      threadId: 'omt_promoted_1',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '你帮我拉下',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(fakeCtx.agents.create).toHaveBeenCalledTimes(1)
    expect(store.listBindings()).toHaveLength(1)
    expect(submittedBySession.get(s1)).toHaveLength(3)
    expect(submittedBySession.get(s1)?.[2]).toContain('<user_message>\n你帮我拉下\n</user_message>')
    expect(submittedBySession.get(s1)?.[2]).not.toContain('<listener ')

    // 4. Persisted reload preserves both aliasRouteKeys and explicit hasReplied=false
    store.upsertBinding({
      routeKey: 'cli_collab:oc_collab:om_pending_listener',
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      chatType: 'group',
      chatId: 'oc_collab',
      workspaceName: 'ws',
      sessionId: 'session-pending-listener',
      agentPreset: 'codex',
      workingDir: workDir,
      trigger: 'listener',
      hasReplied: false,
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })
    const reloadedStore = new LarkBridgeStore(dir)
    expect(reloadedStore.getBinding('cli_collab:oc_collab:om_m3')?.sessionId).toBe(s1)
    expect(reloadedStore.getBinding('cli_collab:oc_collab:omt_promoted_1')?.sessionId).toBe(s1)
    expect(reloadedStore.getBinding('cli_collab:oc_collab:om_pending_listener')?.hasReplied).toBe(false)
    store.deleteBinding('cli_collab:oc_collab:om_pending_listener')

    // 5. Unbinding via alias routeKey disposes handle by sessionId, clears all aliases, and archives S1
    expect(await manager.unbindRoute('cli_collab:oc_collab:om_m3', { archive: true })).toBe(true)
    expect(store.getBinding('cli_collab:oc_collab:om_m1')).toBeUndefined()
    expect(store.getBinding('cli_collab:oc_collab:om_m3')).toBeUndefined()
    expect(store.getBinding('cli_collab:oc_collab:omt_promoted_1')).toBeUndefined()
    expect(disposedSessionIds).toContain(s1)
    expect(archivedSessionIds).toContain(s1)

    // 6. replyMode='chat' + sessionMode='thread' binds sent.messageId so quoting the bot's chat reply continues the session
    store.upsertGroup({
      ...store.getGroup('collab-bot', 'oc_collab')!,
      replyMode: 'chat',
      sessionMode: 'thread',
    })
    nextSendResult = { messageId: 'om_bot_chat_msg' }
    await handleInbound('collab-bot', fakeTransport, {
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      botOpenId: 'ou_bot',
      messageId: 'om_chat_q1',
      chatId: 'oc_collab',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '@_bot_1 查下服务延迟',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'CollabBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    const sChat = store.getBinding('cli_collab:oc_collab:om_chat_q1')?.sessionId
    expect(sChat).toBeTruthy()
    expect(store.getBinding('cli_collab:oc_collab:om_bot_chat_msg')?.sessionId).toBe(sChat)

    nextSendResult = { messageId: 'om_bot_chat_msg_2', rootId: 'om_bot_chat_msg' }
    await handleInbound('collab-bot', fakeTransport, {
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      botOpenId: 'ou_bot',
      messageId: 'om_chat_q2',
      chatId: 'oc_collab',
      chatType: 'group',
      rootId: 'om_bot_chat_msg',
      parentId: 'om_bot_chat_msg',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '能看下 P99 吗',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(fakeCtx.agents.create).toHaveBeenCalledTimes(2)
    expect(submittedBySession.get(sChat!)).toHaveLength(2)

    // 7. Concurrent first messages for the same new thread serialize creation instead of spawning duplicate sessions
    slowCreateGate = true
    const createCountBeforeRace = (fakeCtx.agents.create as ReturnType<typeof vi.fn>).mock.calls.length
    nextSendResult = { messageId: 'om_race_reply', rootId: 'om_race_root', threadId: 'omt_race' }
    const race1 = handleInbound('collab-bot', fakeTransport, {
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      botOpenId: 'ou_bot',
      messageId: 'om_race_root',
      chatId: 'oc_collab',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '@_bot_1 第一条并发消息',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'CollabBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    const race2 = handleInbound('collab-bot', fakeTransport, {
      botId: 'collab-bot',
      larkAppId: 'cli_collab',
      botOpenId: 'ou_bot',
      messageId: 'om_race_second',
      chatId: 'oc_collab',
      chatType: 'group',
      rootId: 'om_race_root',
      parentId: 'om_race_root',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '@_bot_1 第二条并发消息',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'CollabBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    await vi.waitFor(() => expect(releaseSlowCreate).toBeTypeOf('function'))
    slowCreateGate = false
    releaseSlowCreate!()
    await Promise.all([race1, race2])

    expect((fakeCtx.agents.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      createCountBeforeRace + 1,
    )
    const raceSid = store.getBinding('cli_collab:oc_collab:om_race_root')!.sessionId
    expect(submittedBySession.get(raceSid)).toHaveLength(2)

    await manager.stop()
  })

  it('cleans up in-flight reactions and notifies users on HMR/plugin stop, manual abort, and crash recovery without spamming silent listeners', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir()

    const store = new LarkBridgeStore(dir)
    store.upsertBot({
      id: 'ops-bot',
      name: 'OpsBot',
      enabled: true,
      larkAppId: 'cli_ops',
      larkAppSecret: 'sec_ops',
      defaultWorkingDir: workDir,
      receivedReactionEmoji: 'OnIt',
    })
    store.upsertGroup({
      botId: 'ops-bot',
      chatId: 'oc_ops',
      chatName: '运维群',
      enabled: true,
      replyMode: 'new-topic',
      sessionMode: 'thread',
      listener: {
        enabled: true,
        templateKey: 'project',
        name: '静默巡检',
        prompt: '无需回复时输出空文本',
        replyMode: 'new-topic',
        sessionMode: 'per_message',
        allowSilentEmptyReply: true,
      },
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const fiberDisposables: Array<() => void> = []
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
    }

    let turnBehavior: 'complete' | 'hang' | 'user-abort' = 'hang'
    let createdCount = 0
    const liveSessions = new Map<string, Session>()
    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        const off = () => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((f) => f !== fn),
          )
        }
        fiberDisposables.push(off)
        return off
      },
      effect(execute: () => () => void) {
        const cleanup = execute()
        let active = true
        const off = () => {
          if (!active) return
          active = false
          cleanup()
        }
        fiberDisposables.push(off)
        return off
      },
      sessions: {
        get: (id: string) => liveSessions.get(id),
      },
      agents: {
        get: () => undefined,
        create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          createdCount += 1
          const sessionObj = {
            id: sessionId,
            header: { cwd: workDir, agentPreset: 'codex' },
            append: vi.fn(),
            snapshotEvents: () => [],
          } as unknown as Session
          liveSessions.set(sessionId, sessionObj)
          const agent = {
            session: sessionObj,
            followup: () => {
              emit('session/event', sessionObj, { type: 'turn/start', data: { turn: 1 } })
              if (turnBehavior === 'complete') {
                emit('session/event', sessionObj, {
                  type: 'assistant/message',
                  data: {
                    turn: 1,
                    step: 1,
                    message: { content: [{ type: 'text', text: '配置一切正常。' }] },
                  },
                })
                emit('session/event', sessionObj, {
                  type: 'turn/end',
                  data: { turn: 1, reason: { kind: 'completed' } },
                })
              } else if (turnBehavior === 'user-abort') {
                emit('session/event', sessionObj, {
                  type: 'turn/end',
                  data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
                })
              }
            },
          }
          return {
            agent,
            dispose: vi.fn(async () => {
              emit('session/event', sessionObj, {
                type: 'turn/end',
                data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
              })
            }),
          }
        }),
      },
      get() {
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    const removedReactions: Array<{ messageId: string; reactionId: string }> = []
    const sentReplies: Array<{
      chatId: string
      replyToMessageId?: string
      text?: string
      card?: Record<string, unknown>
    }> = []
    let reactionSeq = 0
    const fakeTransport = {
      state: { botOpenId: 'ou_bot', connected: true },
      addReaction: vi.fn(async () => `react_${++reactionSeq}`),
      removeReaction: vi.fn(async (messageId: string, reactionId: string) => {
        removedReactions.push({ messageId, reactionId })
      }),
      sendReply: vi.fn(
        async (opts: {
          chatId: string
          replyToMessageId?: string
          text?: string
          card?: Record<string, unknown>
        }) => {
          sentReplies.push(opts)
          return { messageId: `om_reply_${sentReplies.length}` }
        },
      ),
      stop: vi.fn(async () => {}),
    }

    const handleInbound = (
      manager as unknown as {
        handleInbound: (botId: string, transport: unknown, msg: unknown) => Promise<void>
      }
    ).handleInbound.bind(manager)

    // 0. Normal completed turn with Cordis ctx.effect present -> delivers actual reply (never falsely aborts)
    turnBehavior = 'complete'
    await handleInbound('ops-bot', fakeTransport, {
      botId: 'ops-bot',
      larkAppId: 'cli_ops',
      botOpenId: 'ou_bot',
      messageId: 'om_normal_ok_1',
      chatId: 'oc_ops',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '@_bot_1 看下状态',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'OpsBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })

    expect(removedReactions).toEqual([{ messageId: 'om_normal_ok_1', reactionId: 'react_1' }])
    expect(sentReplies).toHaveLength(1)
    expect(JSON.stringify(sentReplies[0]!.card ?? sentReplies[0]!.text)).toContain('配置一切正常。')
    expect(sentReplies[0]!.text ?? '').not.toContain('服务重载或停机已中断')
    expect(store.listPendingTurns()).toHaveLength(0)

    // 1. User manually stops an active turn -> reaction removed once, user notified, audit event carries sessionId
    turnBehavior = 'user-abort'
    removedReactions.length = 0
    sentReplies.length = 0
    await handleInbound('ops-bot', fakeTransport, {
      botId: 'ops-bot',
      larkAppId: 'cli_ops',
      botOpenId: 'ou_bot',
      messageId: 'om_user_stop_1',
      chatId: 'oc_ops',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '@_bot_1 查下配置',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'OpsBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })

    expect(removedReactions).toEqual([{ messageId: 'om_user_stop_1', reactionId: 'react_2' }])
    expect(sentReplies).toHaveLength(1)
    expect(sentReplies[0]!.text).toContain('已被手动停止')
    expect(store.listPendingTurns()).toHaveLength(0)
    const stopAudit = store.listEvents().find((e) => e.kind === 'error' && e.summary.includes('手动停止'))
    expect(stopAudit?.sessionId).toBeTruthy()

    // 2. Reproduce HMR LIFO unload while a turn is in-flight -> preserves checkpoint & reaction
    //    instead of spamming an error reply, then auto-resumes seamlessly after restart.
    turnBehavior = 'hang'
    removedReactions.length = 0
    sentReplies.length = 0
    const inFlightPromise = handleInbound('ops-bot', fakeTransport, {
      botId: 'ops-bot',
      larkAppId: 'cli_ops',
      botOpenId: 'ou_bot',
      messageId: 'om_hmr_1',
      chatId: 'oc_ops',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '@_bot_1 帮我核实',
      rawContent: '{}',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'OpsBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })

    await vi.waitFor(() => {
      expect(store.listPendingTurns()).toHaveLength(1)
      expect(store.listPendingTurns()[0]?.sessionId).toBeTruthy()
    })
    const hmrSessionId = store.listPendingTurns()[0]!.sessionId!

    // Cordis LIFO disposal: detaches `ctx.on` and runs `turn-runner` effect before `manager.stop()` runs.
    for (const dispose of fiberDisposables.splice(0).reverse()) {
      dispose()
    }
    await manager.stop()
    await inFlightPromise

    // Reaction stays on the message, no premature error spam, pending_turns holds interrupted checkpoint.
    expect(removedReactions).toEqual([])
    expect(sentReplies).toHaveLength(0)
    const suspendedPending = store.listPendingTurns()
    expect(suspendedPending).toHaveLength(1)
    expect(suspendedPending[0]?.status).toBe('interrupted')
    expect(suspendedPending[0]?.sessionId).toBe(hmrSessionId)
    expect(suspendedPending[0]?.reactionId).toBe('react_3')
    const hmrLifecycleAudit = store
      .listEvents()
      .find((e) => e.kind === 'lifecycle' && e.sessionId === hmrSessionId)
    expect(hmrLifecycleAudit?.summary).toContain('待重启自动恢复')
    expect(createdCount).toBe(3)

    // 3. Restart & recovery:
    //    - `om_hmr_1` (with persisted inboundMsg within recovery budget) auto-resumes on the same session,
    //      delivers the actual reply, and removes `react_3` without adding a duplicate reaction.
    //    - Legacy/non-recoverable rows (without `inboundMsg`) still clean up reactions and notify only
    //      interactive turns (never spamming silent listeners).
    store.upsertPendingTurn({
      id: 'pt-interactive',
      botId: 'ops-bot',
      chatId: 'oc_ops',
      chatName: '运维群',
      messageId: 'om_crash_interactive',
      routeKey: 'cli_ops:oc_ops:om_crash_interactive',
      replyMode: 'new-topic',
      trigger: 'mention',
      allowSilentEmptyReply: false,
      reactionId: 'react_crash_1',
      sessionId: 'session-crash-1',
      startedAtMs: Date.now() - 10_000,
    })
    store.upsertPendingTurn({
      id: 'pt-silent-listener',
      botId: 'ops-bot',
      chatId: 'oc_ops',
      chatName: '运维群',
      messageId: 'om_crash_listener',
      routeKey: 'cli_ops:oc_ops:om_crash_listener',
      replyMode: 'new-topic',
      trigger: 'listener',
      allowSilentEmptyReply: true,
      reactionId: 'react_crash_2',
      sessionId: 'session-crash-2',
      startedAtMs: Date.now() - 10_000,
    })

    const reloadedStore = new LarkBridgeStore(dir)
    expect(reloadedStore.listPendingTurns()).toHaveLength(3)

    turnBehavior = 'complete'
    const recoveredManager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      reloadedStore,
    )
    removedReactions.length = 0
    sentReplies.length = 0
    fakeTransport.addReaction.mockClear()
    ;(
      recoveredManager as unknown as {
        transports: Map<string, { config: unknown; transport: unknown }>
      }
    ).transports.set('ops-bot', { config: reloadedStore.getBot('ops-bot'), transport: fakeTransport })

    const recoveredCount = await recoveredManager.recoverStalePendingTurns()
    await recoveredManager.inbound.waitForRecoveries()
    expect(recoveredCount).toBe(3)
    expect(reloadedStore.listPendingTurns()).toHaveLength(0)
    // Auto-resumed turn reused `react_3` without adding a second reaction.
    expect(fakeTransport.addReaction).not.toHaveBeenCalled()
    expect(removedReactions).toEqual(
      expect.arrayContaining([
        { messageId: 'om_hmr_1', reactionId: 'react_3' },
        { messageId: 'om_crash_interactive', reactionId: 'react_crash_1' },
        { messageId: 'om_crash_listener', reactionId: 'react_crash_2' },
      ]),
    )
    expect(removedReactions).toHaveLength(3)
    // Interactive reply delivered for auto-resumed `om_hmr_1`, interrupt notice for legacy `om_crash_interactive`,
    // and zero spam for silent listener `om_crash_listener`.
    expect(sentReplies).toHaveLength(2)
    const resumedReply = sentReplies.find((r) => r.replyToMessageId === 'om_hmr_1')
    expect(JSON.stringify(resumedReply?.card ?? resumedReply?.text)).toContain('配置一切正常。')
    const legacyReply = sentReplies.find((r) => r.replyToMessageId === 'om_crash_interactive')
    expect(legacyReply?.text).toContain('服务重启中断')
    expect(
      reloadedStore.listEvents().some((e) => e.sessionId === 'session-crash-1' && e.kind === 'error'),
    ).toBe(true)
    expect(
      reloadedStore.listEvents().some((e) => e.sessionId === 'session-crash-2' && e.kind === 'error'),
    ).toBe(true)
    await recoveredManager.stop()
  })

  it('suppresses zero-width & sentinel silent replies, serializes concurrent turns without double replies, persists dedup & runtimeProfileId across restart, and silences listener errors', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    store.upsertBot({
      id: 'audit-bot',
      name: 'AuditBot',
      enabled: true,
      larkAppId: 'cli_audit',
      larkAppSecret: 'sec_audit',
      defaultWorkingDir: workDir,
      agentPreset: 'agy',
      runtimeProfileId: 'demo-proxy',
      model: 'gemini-4-carbon',
      groupReplyMode: 'reply',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
      useInteractiveCard: false,
    })
    store.upsertGroup({
      botId: 'audit-bot',
      chatId: 'oc_audit',
      chatName: '联合验收群',
      enabled: true,
      replyMode: 'reply',
      sessionMode: 'thread',
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '无需回复时输出 <no_reply/>',
        scope: 'all',
        replyMode: 'reply',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
      },
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
    }
    const archivedSessionIds: string[] = []
    const liveAgents = new Map<string, unknown>()
    const queuedBehavior: Array<{ reply?: string; error?: string; delayMs?: number }> = []
    const turnCounters = new Map<string, number>()

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
        }
      },
      sessions: { get: () => undefined },
      agents: {
        get: (id: string) => liveAgents.get(id),
        create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          const sessionObj = {
            id: sessionId,
            header: { cwd: workDir, agentPreset: 'agy' },
            append: vi.fn(),
            snapshotEvents: () => [],
          } as unknown as Session
          const agent = {
            session: sessionObj,
            followup: (userMsg: { id?: string }) => {
              const turn = (turnCounters.get(sessionId) ?? 0) + 1
              turnCounters.set(sessionId, turn)
              const spec = queuedBehavior.shift() ?? { reply: `第 ${turn} 轮回复` }
              setTimeout(() => {
                emit('session/event', sessionObj, { type: 'turn/start', data: { turn } })
                emit('session/event', sessionObj, {
                  type: 'user/message',
                  data: { id: userMsg.id, source: { kind: 'user' } },
                })
                if (spec.error) {
                  emit('session/event', sessionObj, {
                    type: 'turn/end',
                    data: { turn, reason: { kind: 'error', error: { message: spec.error } } },
                  })
                  return
                }
                if (spec.reply !== undefined) {
                  emit('session/event', sessionObj, {
                    type: 'assistant/message',
                    data: { turn, message: { content: [{ type: 'text', text: spec.reply }] } },
                  })
                }
                emit('session/event', sessionObj, {
                  type: 'turn/end',
                  data: { turn, reason: { kind: 'completed' } },
                })
              }, spec.delayMs ?? 15)
            },
          }
          liveAgents.set(sessionId, agent)
          return {
            agent,
            dispose: vi.fn(async () => {
              liveAgents.delete(sessionId)
            }),
          }
        }),
      },
      get(service: string) {
        if (service === 'workspaceRegistry') {
          return {
            list: () => [],
            create: async (_d: string, title?: string) => ({
              title: title ?? 'ws',
              setTitle: vi.fn(),
              attachSession: vi.fn(),
            }),
            archiveSession: vi.fn(async (sid: string) => {
              archivedSessionIds.push(sid)
            }),
          }
        }
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    const sentReplies: Array<{ replyToMessageId?: string; text?: string; replyMode?: string }> = []
    const fakeTransport = {
      state: { botOpenId: 'ou_bot', connected: true },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_u1', name: 'Tester' }),
      addReaction: vi.fn().mockResolvedValue('r1'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn(async (opts: { replyToMessageId?: string; text?: string; replyMode?: string }) => {
        sentReplies.push(opts)
        return { messageId: `om_out_${sentReplies.length}`, rootId: opts.replyToMessageId }
      }),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const handleInbound = (
      manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }
    ).handleInbound.bind(manager)

    // 1. Listener returning only `\u200b` or `<no_reply/>` must NOT send blank messages and must clean up temp sessions
    queuedBehavior.push({ reply: '\u200b' }, { reply: '<no_reply/>' })
    await handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_zwsp_1',
      chatId: 'oc_audit',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '好的收到',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    await handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_sentinel_1',
      chatId: 'oc_audit',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '+1',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(sentReplies).toHaveLength(0)
    expect(store.listBindings()).toHaveLength(0)
    expect(archivedSessionIds).toHaveLength(2)

    // 2. Listener encountering a runtime error must stay silent in chat and clean up un-replied temp session
    queuedBehavior.push({ error: 'upstream timeout' })
    await handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_listener_err_1',
      chatId: 'oc_audit',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '今天天气不错',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(sentReplies).toHaveLength(0)
    expect(store.listBindings()).toHaveLength(0)
    expect(archivedSessionIds).toHaveLength(3)

    // 3. Direct @bot returning `\u200b` falls back to explicit non-blank text (never sends a blank bubble)
    //    Also verifies bot-originated messages skip human contact lookup (`resolveUserSummary`).
    fakeTransport.resolveUserSummary.mockClear()
    queuedBehavior.push({ reply: '\u200b' })
    await handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_mention_zwsp',
      chatId: 'oc_audit',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_peer_bot',
      senderType: 'bot',
      text: '@_b hi',
      rawContent: '{}',
      mentions: [{ key: '@_b', openId: 'ou_bot', name: 'AuditBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(fakeTransport.resolveUserSummary).not.toHaveBeenCalled()
    expect(sentReplies).toHaveLength(1)
    expect(sentReplies[0]?.text).toBe('（已完成，无文本输出）')

    // 4. Two concurrent async turns on the same thread serialize FIFO and each gets its own distinct reply
    sentReplies.length = 0
    queuedBehavior.push({ reply: '回复A', delayMs: 40 }, { reply: '回复B', delayMs: 10 })
    const pA = handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_conc_1',
      chatId: 'oc_audit',
      chatType: 'group',
      rootId: 'om_mention_zwsp',
      parentId: 'om_mention_zwsp',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '问题 A',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    const pB = handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_conc_2',
      chatId: 'oc_audit',
      chatType: 'group',
      rootId: 'om_mention_zwsp',
      parentId: 'om_mention_zwsp',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '问题 B',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    await Promise.all([pA, pB])
    expect(sentReplies).toEqual([
      expect.objectContaining({ replyToMessageId: 'om_conc_1', text: '回复A', replyMode: 'reply' }),
      expect.objectContaining({ replyToMessageId: 'om_conc_2', text: '回复B', replyMode: 'reply' }),
    ])

    // 5. Stale replaced transport events are dropped
    ;(manager as unknown as { transports: Map<string, { config: unknown; transport: unknown }> }).transports.set(
      'audit-bot',
      {
        config: store.getBot('audit-bot'),
        transport: { state: { botOpenId: 'ou_bot' }, stop: vi.fn().mockResolvedValue(undefined) },
      },
    )
    sentReplies.length = 0
    await handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_stale_transport_msg',
      chatId: 'oc_audit',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '@_b stale',
      rawContent: '{}',
      mentions: [{ key: '@_b', openId: 'ou_bot', name: 'AuditBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(sentReplies).toHaveLength(0)

    await manager.stop()

    // 6. Reloading store preserves both runtimeProfileId on bindings and seenMessages for cross-restart dedup
    const reloadedStore = new LarkBridgeStore(dir)
    const reloadedBinding = reloadedStore.getBinding('cli_audit:oc_audit:om_mention_zwsp')
    expect(reloadedBinding?.runtimeProfileId).toBe('demo-proxy')
    expect(reloadedStore.listSeenMessages().some((e) => e.key === 'cli_audit:om_conc_1')).toBe(true)

    const restartedManager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      reloadedStore,
    )
    sentReplies.length = 0
    await (
      restartedManager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }
    ).handleInbound('audit-bot', fakeTransport, {
      botId: 'audit-bot',
      larkAppId: 'cli_audit',
      botOpenId: 'ou_bot',
      messageId: 'om_conc_1',
      chatId: 'oc_audit',
      chatType: 'group',
      rootId: 'om_mention_zwsp',
      parentId: 'om_mention_zwsp',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '问题 A（重启后迟到的飞书重试）',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    })
    expect(sentReplies).toHaveLength(0)
    await restartedManager.stop()
  })

  it('instructs @Bot turns not to stay silent and intercepts literal <no_reply/> sentinels before Feishu delivery', async () => {
    const dir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    store.upsertBot({
      id: 'oncall-bot',
      name: 'OncallBot',
      enabled: true,
      larkAppId: 'cli_oncall',
      larkAppSecret: 'sec_oncall',
      defaultWorkingDir: workDir,
      agentPreset: 'codex',
      groupReplyMode: 'new-topic',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
      useInteractiveCard: false,
      sendIntermediateMessages: true,
    })
    store.upsertGroup({
      botId: 'oncall-bot',
      chatId: 'oc_alert_demo',
      chatName: '告警排查测试群',
      enabled: true,
      replyMode: 'new-topic',
      sessionMode: 'thread',
      role: {
        mode: 'override',
        name: 'Demo Oncall',
        systemPrompt: '只负责处理服务告警，不要回复任何无关问题。',
      },
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
    }
    const receivedPrompts: string[] = []
    const liveAgents = new Map<string, unknown>()
    const queuedTurns: Array<{ intermediate?: string; reply: string }> = [
      { intermediate: '<no_reply/>', reply: '<no_reply/>' },
      { reply: '`<no_reply/>`' },
      { reply: '请使用 `<no_reply/>` 表示旁听静默' },
    ]
    let turnCounter = 0
    const warnSpy = vi.fn()

    const fakeCtx = {
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
        }
      },
      sessions: { get: () => undefined },
      agents: {
        get: (id: string) => liveAgents.get(id),
        create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          const sessionObj = {
            id: sessionId,
            header: { cwd: workDir, agentPreset: 'codex' },
            append: vi.fn(),
            snapshotEvents: () => [],
          } as unknown as Session
          const agent = {
            session: sessionObj,
            followup: (userMsg: { id?: string; content: Array<{ type: string; text?: string }> }) => {
              receivedPrompts.push(userMsg.content.map((c) => c.text ?? '').join('\n'))
              const turn = ++turnCounter
              const spec = queuedTurns.shift() ?? { reply: 'ok' }
              setTimeout(() => {
                emit('session/event', sessionObj, { type: 'turn/start', data: { turn } })
                emit('session/event', sessionObj, {
                  type: 'user/message',
                  data: { id: userMsg.id, source: { kind: 'user' } },
                })
                if (spec.intermediate) {
                  emit('session/event', sessionObj, {
                    type: 'assistant/message',
                    data: {
                      turn,
                      step: 1,
                      message: {
                        content: [
                          { type: 'text', text: spec.intermediate },
                          { type: 'tool-call', id: `tc_${turn}`, name: 'bash', arguments: '{}' },
                        ],
                      },
                    },
                  })
                  emit('session/event', sessionObj, {
                    type: 'tool/call',
                    data: { turn, step: 1, callId: `tc_${turn}`, name: 'bash', arguments: '{}' },
                  })
                }
                emit('session/event', sessionObj, {
                  type: 'assistant/message',
                  data: { turn, step: 2, message: { content: [{ type: 'text', text: spec.reply }] } },
                })
                emit('session/event', sessionObj, {
                  type: 'turn/end',
                  data: { turn, reason: { kind: 'completed' } },
                })
              }, 10)
            },
          }
          liveAgents.set(sessionId, agent)
          return {
            agent,
            dispose: vi.fn(async () => {
              liveAgents.delete(sessionId)
            }),
          }
        }),
      },
      get(service: string) {
        if (service === 'workspaceRegistry') {
          return {
            list: () => [],
            create: async (_d: string, title?: string) => ({
              title: title ?? 'ws',
              setTitle: vi.fn(),
              attachSession: vi.fn(),
            }),
            archiveSession: vi.fn(async () => {}),
          }
        }
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    const sentReplies: Array<{ replyToMessageId?: string; text?: string }> = []
    const fakeTransport = {
      state: { botOpenId: 'ou_bot', connected: true },
      resolveUserSummary: vi.fn().mockResolvedValue({ openId: 'ou_u1', name: 'Alex' }),
      addReaction: vi.fn().mockResolvedValue('r1'),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn(async (opts: { replyToMessageId?: string; text?: string }) => {
        sentReplies.push(opts)
        return { messageId: `om_out_${sentReplies.length}`, rootId: 'om_m1', threadId: 'omt_t1' }
      }),
      downloadImageAsBase64: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const handleInbound = (
      manager as unknown as { handleInbound: (b: string, t: unknown, m: unknown) => Promise<void> }
    ).handleInbound.bind(manager)

    // Turn 1: explicit @Bot asking off-topic question -> model emits <no_reply/> in both intermediate and final
    await handleInbound('oncall-bot', fakeTransport, {
      botId: 'oncall-bot',
      larkAppId: 'cli_oncall',
      botOpenId: 'ou_bot',
      messageId: 'om_m1',
      chatId: 'oc_alert_demo',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '@_b 你是啥模型？',
      rawContent: '{}',
      mentions: [{ key: '@_b', openId: 'ou_bot', name: 'OncallBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })

    // Turn 2: follow-up @Bot inside the same thread -> model emits backticked `<no_reply/>`
    await handleInbound('oncall-bot', fakeTransport, {
      botId: 'oncall-bot',
      larkAppId: 'cli_oncall',
      botOpenId: 'ou_bot',
      messageId: 'om_m2',
      rootId: 'om_m1',
      parentId: 'om_m1',
      threadId: 'omt_t1',
      chatId: 'oc_alert_demo',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '@_b 背后是啥模型？',
      rawContent: '{}',
      mentions: [{ key: '@_b', openId: 'ou_bot', name: 'OncallBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })

    // Turn 3: normal prose discussing `<no_reply/>` must pass through intact
    await handleInbound('oncall-bot', fakeTransport, {
      botId: 'oncall-bot',
      larkAppId: 'cli_oncall',
      botOpenId: 'ou_bot',
      messageId: 'om_m3',
      rootId: 'om_m1',
      parentId: 'om_m1',
      threadId: 'omt_t1',
      chatId: 'oc_alert_demo',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_u1',
      senderType: 'user',
      text: '@_b 静默标记是什么？',
      rawContent: '{}',
      mentions: [{ key: '@_b', openId: 'ou_bot', name: 'OncallBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    })

    // Prompt on both turn 1 and turn 2 explicitly surfaces trigger="mention" & polite-refusal rule
    expect(receivedPrompts[0]).toContain('trigger="mention"')
    expect(receivedPrompts[0]).toContain('本轮禁止静默')
    expect(receivedPrompts[1]).toContain('trigger="mention"')
    expect(receivedPrompts[1]).toContain('简短礼貌说明职责边界并拒答')

    // Raw `<no_reply/>` NEVER leaks to Feishu (neither intermediate nor final); fallback is delivered instead
    expect(sentReplies).toHaveLength(3)
    expect(sentReplies[0]?.text).not.toContain('<no_reply/>')
    expect(sentReplies[0]?.text).toContain('职责范围')
    expect(sentReplies[1]?.text).not.toContain('<no_reply/>')
    expect(sentReplies[1]?.text).toContain('职责范围')
    // Normal prose discussing the sentinel is preserved untouched
    expect(sentReplies[2]?.text).toBe('请使用 `<no_reply/>` 表示旁听静默')

    // Warning & audit event record the interception
    expect(warnSpy).toHaveBeenCalledTimes(2)
    const interceptedAudits = store
      .listEvents(20)
      .filter((e) => e.kind === 'reply' && e.summary.includes('已拦截非静默轮次的 <no_reply/>'))
    expect(interceptedAudits).toHaveLength(2)

    await manager.stop()
    store.close()
  })
})
