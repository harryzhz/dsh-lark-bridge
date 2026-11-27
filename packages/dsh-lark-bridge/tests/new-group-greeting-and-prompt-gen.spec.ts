import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkBotTransport } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotConnectionPool } from '../src/bot-connection-pool.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { PromptGeneratorService } from '../src/prompt-generator-service.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { LarkBridgeStore } from '../src/store.js'
import type { WorkspaceGrouping } from '../src/workspace-grouping.js'
import type { LarkBridgeManager } from '../src/bridge-manager.js'

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lark-bridge-greet-gen-'))
}

function createFakeBot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot-alpha',
    name: '协作助手',
    enabled: true,
    larkAppId: 'cli_test_alpha',
    larkAppSecret: 'secret_alpha',
    defaultWorkingDir: tmpdir(),
    groupAccessMode: 'configured_only',
    autoEnableNewGroup: true,
    newGroupGreetingEnabled: true,
    newGroupGreetingMessage: '',
    description: '协助团队排查问题与评审代码',
    role: { enabled: true, name: '研发搭档', systemPrompt: '你是研发搭档。' },
    ...overrides,
  }
}

describe('BotConnectionPool.handleBotAddedToChat', () => {
  const dirs: string[] = []
  const stores: LarkBridgeStore[] = []

  afterEach(() => {
    for (const s of stores.splice(0)) s.close()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function setupPool(botOverrides: Record<string, unknown> = {}) {
    const dir = createTempDir()
    dirs.push(dir)
    const store = new LarkBridgeStore(dir)
    stores.push(store)
    const bot = store.upsertBot(createFakeBot(botOverrides))
    const syncGroup = vi.fn(async () => {})
    const sendReply = vi.fn(async () => ({ messageId: 'om_greet_1' }))
    const fakeTransport = { sendReply } as unknown as LarkBotTransport
    const pool = new BotConnectionPool({
      ctx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as Context,
      store,
      runtimes: {} as RuntimeCatalog,
      workspaces: { syncGroup } as unknown as WorkspaceGrouping,
      platform: {} as never,
      directoryEnricher: {} as never,
      isDisposed: () => false,
      isDraining: () => false,
      onInboundMessage: async () => {},
      onCardAction: async () => {},
      onBotReady: () => {},
    })
    pool.transports.set(bot.id, { config: bot, transport: fakeTransport })
    return { store, pool, bot, fakeTransport, sendReply, syncGroup }
  }

  it('auto-enables a newly joined group and sends a greeting once with dedup', async () => {
    const { store, pool, bot, fakeTransport, sendReply, syncGroup } = setupPool()

    const first = await pool.handleBotAddedToChat(bot.id, fakeTransport, {
      botId: bot.id,
      larkAppId: bot.larkAppId,
      eventId: 'ev_added_1',
      chatId: 'oc_new_1',
      chatName: '新项目群',
      operatorOpenId: 'ou_user_1',
    })

    expect(first).toEqual({ enabled: true, greeted: true })
    const savedGroup = store.getGroup(bot.id, 'oc_new_1')
    expect(savedGroup?.enabled).toBe(true)
    expect(savedGroup?.chatName).toBe('新项目群')
    expect(syncGroup).toHaveBeenCalledWith(bot.id, 'oc_new_1')
    expect(sendReply).toHaveBeenCalledTimes(1)
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'oc_new_1',
        replyMode: 'chat',
        text: expect.stringContaining('协作助手（研发搭档）'),
      }),
    )

    // Duplicate delivery with same eventId or chatId within cooldown must not double-greet.
    const dup = await pool.handleBotAddedToChat(bot.id, fakeTransport, {
      botId: bot.id,
      larkAppId: bot.larkAppId,
      eventId: 'ev_added_1',
      chatId: 'oc_new_1',
      chatName: '新项目群',
    })
    expect(dup).toEqual({ enabled: false, greeted: false })
    expect(sendReply).toHaveBeenCalledTimes(1)
  })

  it('skips auto-enable and greeting when autoEnableNewGroup is false under configured_only', async () => {
    const { store, pool, bot, fakeTransport, sendReply } = setupPool({
      autoEnableNewGroup: false,
      groupAccessMode: 'configured_only',
    })

    const res = await pool.handleBotAddedToChat(bot.id, fakeTransport, {
      botId: bot.id,
      larkAppId: bot.larkAppId,
      chatId: 'oc_new_2',
      chatName: '静音群',
    })

    expect(res).toEqual({ enabled: false, greeted: false })
    expect(store.getGroup(bot.id, 'oc_new_2')).toBeUndefined()
    expect(sendReply).not.toHaveBeenCalled()
  })

  it('auto-enables without greeting when newGroupGreetingEnabled is false', async () => {
    const { store, pool, bot, fakeTransport, sendReply } = setupPool({
      autoEnableNewGroup: true,
      newGroupGreetingEnabled: false,
    })

    const res = await pool.handleBotAddedToChat(bot.id, fakeTransport, {
      botId: bot.id,
      larkAppId: bot.larkAppId,
      chatId: 'oc_new_3',
      chatName: '静默启用群',
    })

    expect(res).toEqual({ enabled: true, greeted: false })
    expect(store.getGroup(bot.id, 'oc_new_3')?.enabled).toBe(true)
    expect(sendReply).not.toHaveBeenCalled()
  })

  it('re-enables previously disabled group and uses custom greeting template', async () => {
    const { store, pool, bot, fakeTransport, sendReply } = setupPool({
      newGroupGreetingMessage: '你好 {{chat_name}}，{{bot_name}} 已就位！',
    })
    store.upsertGroup({ botId: bot.id, chatId: 'oc_rejoin', chatName: '回归群', enabled: false })

    const res = await pool.handleBotAddedToChat(bot.id, fakeTransport, {
      botId: bot.id,
      larkAppId: bot.larkAppId,
      chatId: 'oc_rejoin',
      chatName: '回归群',
    })

    expect(res).toEqual({ enabled: true, greeted: true })
    expect(store.getGroup(bot.id, 'oc_rejoin')?.enabled).toBe(true)
    expect(sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '你好 回归群，协作助手 已就位！',
      }),
    )
  })
})

describe('PromptGeneratorService and POST /api/lark-bridge/generate-prompt', () => {
  const dirs: string[] = []
  const stores: LarkBridgeStore[] = []

  afterEach(() => {
    for (const s of stores.splice(0)) s.close()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('generates role prompt using configured native model stream', async () => {
    const dir = createTempDir()
    dirs.push(dir)
    const store = new LarkBridgeStore(dir)
    stores.push(store)
    const bot = store.upsertBot(createFakeBot())

    const llmStream = vi.fn(async function* () {
      yield {
        type: 'text-delta',
        text: '{"name":"代码审计官","systemPrompt":"你是严格的代码审计官。\\n1. 优先排查权限与边界问题。"}',
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })

    const fakeCtx = {
      llm: {
        listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
        listModels: async () => [{ id: 'gpt-4o-mini', name: 'GPT-4o Mini' }],
        resolveModelInfo: async () => ({ name: 'GPT-4o Mini' }),
        stream: llmStream,
      },
      get: () => undefined,
    } as unknown as Context

    const runtimes = new RuntimeCatalog(fakeCtx)
    const service = new PromptGeneratorService({
      ctx: fakeCtx,
      store,
      runtimes,
      workspaces: { archiveSession: vi.fn(async () => true) } as unknown as WorkspaceGrouping,
    })

    const output = await service.generate({
      kind: 'role',
      description: '严格做安全代码审计',
      botId: bot.id,
      target: { kind: 'model', provider: 'openai', model: 'gpt-4o-mini' },
    })

    expect(output.kind).toBe('role')
    if (output.kind === 'role') {
      expect(output.role.name).toBe('代码审计官')
      expect(output.role.systemPrompt).toContain('权限与边界')
    }
    expect(output.engine).toMatchObject({
      kind: 'model',
      provider: 'openai',
      model: 'gpt-4o-mini',
      label: 'GPT-4o Mini',
    })
    expect(llmStream).toHaveBeenCalledTimes(1)
  })

  it('generates listener rule via Agent runtime and archives the ephemeral session', async () => {
    const dir = createTempDir()
    dirs.push(dir)
    const store = new LarkBridgeStore(dir)
    stores.push(store)
    const bot = store.upsertBot(createFakeBot({ agentPreset: 'codex' }))

    const dispose = vi.fn(async () => {})
    const archiveSession = vi.fn(async () => true)
    const sessionEventHandlers: Array<(s: unknown, ev: unknown) => void> = []
    const createAgent = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const session = { id: sessionId }
      const emit = (ev: Record<string, unknown>) => {
        for (const fn of sessionEventHandlers) fn(session, ev)
      }
      const agent = {
        session,
        followup: () => {
          emit({ type: 'turn/start', data: { turn: 1 } })
          emit({
            type: 'assistant/message',
            data: {
              turn: 1,
              step: 1,
              message: {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      name: '上线告警监听',
                      prompt: '仅监听故障告警卡片；其他消息输出 `<no_reply/>`。',
                      scope: 'top_level',
                      mentionFilter: 'exclude_peer',
                      replyMode: 'new-topic',
                      sessionMode: 'thread',
                      autoCloseAfterCompletion: false,
                      msgTypes: ['interactive', 'text'],
                      senderTypes: ['bot', 'user'],
                    }),
                  },
                ],
              },
            },
          })
          emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
        },
        abort: vi.fn(),
      }
      return { agent, dispose }
    })

    const fakeCtx = {
      llm: { listProviders: () => [] },
      agents: { create: createAgent },
      on: (event: string, fn: (s: unknown, ev: unknown) => void) => {
        if (event === 'session/event') sessionEventHandlers.push(fn)
        return () => {}
      },
      get: (key: string) =>
        key === 'externalRuntimes'
          ? {
              list: () => [
                {
                  id: 'codex',
                  displayName: 'Codex',
                  description: 'Codex CLI',
                  providerId: 'codex-cli',
                  defaultModel: 'gpt-6.1-sol',
                },
              ],
              get: (id: string) =>
                id === 'codex'
                  ? {
                      id: 'codex',
                      displayName: 'Codex',
                      description: 'Codex CLI',
                      providerId: 'codex-cli',
                      defaultModel: 'gpt-6.1-sol',
                    }
                  : undefined,
            }
          : undefined,
    } as unknown as Context

    const runtimes = new RuntimeCatalog(fakeCtx)
    const service = new PromptGeneratorService({
      ctx: fakeCtx,
      store,
      runtimes,
      workspaces: { archiveSession } as unknown as WorkspaceGrouping,
    })

    const output = await service.generate({
      kind: 'listener',
      description: '监听上线告警机器人卡片，自动查根因',
      botId: bot.id,
      target: { kind: 'runtime', agentPreset: 'codex' },
    })

    expect(output.kind).toBe('listener')
    if (output.kind === 'listener') {
      expect(output.listener.name).toBe('上线告警监听')
      expect(output.listener.msgTypes).toEqual(['interactive', 'text'])
      expect(output.listener.senderTypes).toEqual(['bot', 'user'])
      expect(output.listener.replyMode).toBe('new-topic')
    }
    expect(output.engine.kind).toBe('runtime')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(archiveSession).toHaveBeenCalledTimes(1)
  })

  it('enforces owner-only auth and input validation on POST /generate-prompt', async () => {
    const generatePrompt = vi.fn(async () => ({
      kind: 'role' as const,
      role: { name: '测试角色', systemPrompt: '你是测试角色。' },
      engine: { kind: 'model' as const, label: 'Test Model', provider: 'p', model: 'm' },
      durationMs: 12,
    }))
    const fakeManager = {
      generatePrompt,
      recordApiTiming: () => {},
    } as unknown as LarkBridgeManager
    const fakeCtx = {} as unknown as Context

    const cliDenied = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/generate-prompt',
      body: { kind: 'role', description: 'demo' },
      isCliAuthenticated: true,
      principalKind: 'owner',
    })
    expect(cliDenied.status).toBe(403)
    expect(generatePrompt).not.toHaveBeenCalled()

    const badKind = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/generate-prompt',
      body: { kind: 'invalid', description: 'demo' },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(badKind.status).toBe(400)

    const emptyDesc = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/generate-prompt',
      body: { kind: 'role', description: '   ' },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(emptyDesc.status).toBe(400)

    const okRes = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/generate-prompt',
      body: {
        kind: 'role',
        description: '后端专家',
        target: { kind: 'model', provider: 'p', model: 'm' },
      },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(okRes.status).toBe(200)
    expect(okRes.payload).toMatchObject({
      ok: true,
      kind: 'role',
      role: { name: '测试角色', systemPrompt: '你是测试角色。' },
    })
  })
})
