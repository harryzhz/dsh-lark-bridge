import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { LarkBotTransport, LarkPlatformManager } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { ensureCliAuthEndpoint, OPERATOR_TOKEN_HEADER } from '../src/cli-support.js'
import { createLarkHttpHandler, type ConnectionAdmitter } from '../src/http-api.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { handleSlashCommand } from '../src/slash-commands.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-bridge-test-'))
  tempDirs.push(dir)
  return dir
}

function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  opts: { method?: string; url: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const rawBody = opts.body !== undefined ? JSON.stringify(opts.body) : ''
    const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as unknown as IncomingMessage
    req.method = opts.method ?? 'GET'
    req.url = opts.url
    req.headers = opts.headers ?? {}

    let status = 200
    let body = ''
    const res = {
      writeHead(code: number) {
        status = code
        return res
      },
      end(chunk?: string | Buffer) {
        if (chunk) body += chunk.toString()
        resolve({ status, json: body ? JSON.parse(body) : {} })
      },
    } as unknown as ServerResponse

    Promise.resolve(handler(req, res)).catch(reject)
  })
}

describe('LarkBridgeStore, RuntimeCatalog, CLI Auth & HTTP API', () => {
  it('manages bots, standalone group configs, template prompt sync, CLI bearer auth, agent endpoints, and cockpit telemetry', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const cliAuth = ensureCliAuthEndpoint(dir, 'http://192.168.1.10:3880')
    const platform = new LarkPlatformManager(dir, vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)

    const externalMap = new Map([
      [
        'codex',
        {
          id: 'codex',
          displayName: 'Codex',
          description: 'Codex runtime',
          providerId: 'codex-cli',
          defaultModel: 'gpt-6.1-sol',
          defaultReasoningEffort: 'xhigh',
        },
      ],
      [
        'agy',
        {
          id: 'agy',
          displayName: 'Antigravity',
          description: 'Antigravity ACP',
          providerId: 'agy-cli',
          defaultModel: 'gemini-4-neon-xhigh',
        },
      ],
      [
        'claude-code',
        {
          id: 'claude-code',
          displayName: 'ClaudeCode',
          description: 'Claude Code ACP',
          providerId: 'claude-code-cli',
          defaultModel: 'default',
        },
      ],
      [
        'trae',
        {
          id: 'trae',
          displayName: 'Trae',
          description: 'Trae CLI app-server',
          providerId: 'trae-cli',
          defaultModel: 'Doubao-Seed-2.0-Code',
        },
      ],
    ])

    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      get(service: string) {
        if (service === 'externalRuntimes') {
          return {
            list: () => [...externalMap.values()],
            get: (id: string) => externalMap.get(id),
          }
        }
        if (service === 'agentPresets') {
          return {
            remoteExportList: async () => ({
              presets: [
                { id: 'codex', name: 'Codex', description: 'Codex preset', isDefault: true },
                { id: 'agy', name: 'Antigravity', description: 'Antigravity preset', isDefault: false },
                { id: 'claude-code', name: 'ClaudeCode', description: 'ClaudeCode preset', isDefault: false },
                { id: 'trae', name: 'Trae', description: 'Trae preset', isDefault: false },
                { id: 'standard', isDefault: false },
              ],
            }),
          }
        }
        return undefined
      },
      llm: {
        listProviders: () => [{ id: 'codex-cli', name: 'Codex' }],
        listModels: async () => [{ provider: 'codex-cli', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
      },
      agents: { get: () => undefined },
    } as unknown as Context

    const runtimes = new RuntimeCatalog(fakeCtx)
    const agentSend = vi.fn().mockResolvedValue({ messageIds: ['om_sent_1'], botId: 'dsh-bot', targetId: 'oc_team' })

    const manager = {
      store,
      runtimes,
      platform,
      cliAuth,
      listBotStatuses: () => [
        {
          botId: 'dsh-bot',
          larkAppId: 'cli_123',
          name: 'DSH-Bot',
          avatarUrl: 'https://example.com/bot.png',
          enabled: true,
          connected: true,
          botOpenId: 'ou_bot',
          activeBindings: 0,
        },
      ],
      hydrateAllowedUserProfiles: vi.fn(async (bot: { allowedUsers: string[] }) =>
        bot.allowedUsers.map((id) => ({ openId: id, name: id === 'ou_user_1' ? 'Alex Chen' : id })),
      ),
      resolveAgentContext: vi.fn(() => ({
        bound: true,
        source: 'session_binding',
        botId: 'dsh-bot',
        botName: 'DSH-Bot',
        larkAppId: 'cli_123',
        botOpenId: 'ou_bot',
        chatId: 'oc_team',
        chatName: '核心研发协作群',
        bots: [],
        groups: [],
      })),
      agentSend,
      syncBot: vi.fn().mockResolvedValue(undefined),
      syncBotProfile: vi.fn().mockResolvedValue({ openId: 'ou_bot', name: 'DSH-Bot', avatarUrl: 'https://example.com/bot.png' }),
      syncJoinedChats: vi.fn().mockImplementation(async () => {
        const discovered = [
          {
            botId: 'dsh-bot',
            botName: 'DSH-Bot',
            larkAppId: 'cli_123',
            chatId: 'oc_team',
            name: '核心研发协作群',
          },
        ]
        store.mergeDiscoveredChats('dsh-bot', discovered)
        return discovered
      }),
      listGroupMembers: vi.fn().mockResolvedValue([
        { openId: 'ou_user_1', name: 'Alex Chen', memberType: 'user' },
        { openId: 'ou_bot_2', name: 'HelperBot', memberType: 'bot' },
      ]),
      searchUsers: vi.fn().mockResolvedValue([
        { openId: 'ou_user_1', name: 'Alex Chen', email: 'alex@example.com' },
      ]),
      syncGroupWorkspace: vi.fn().mockResolvedValue(undefined),
      unbindRoute: vi.fn().mockResolvedValue(true),
      sweepIdleBindings: vi.fn().mockResolvedValue(2),
      sessionWebUrl: (sid: string) => `http://192.168.1.10:3880/#session=${sid}`,
    } as unknown as LarkBridgeManager

    let allowAuth = false
    const fakeConnection: ConnectionAdmitter = {
      admit: () =>
        allowAuth
          ? { peer: { principal: { kind: 'owner' } } }
          : { rejection: 401 as const },
    }

    const handler = createLarkHttpHandler(fakeCtx, fakeConnection, manager)

    // 1. Rejects unauthenticated requests, but admits valid CLI bearer token for agent endpoints
    const unauth = await invokeHandler(handler, { url: '/api/lark-bridge/cockpit' })
    expect(unauth.status).toBe(401)

    const cliCtxRes = await invokeHandler(handler, {
      url: '/api/lark-bridge/agent/context?sessionId=s1',
      headers: { authorization: `Bearer ${cliAuth.token}` },
    })
    expect(cliCtxRes.status).toBe(200)
    expect(cliCtxRes.json.chatId).toBe('oc_team')

    const cliSendRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/agent/send',
      headers: { authorization: `Bearer ${cliAuth.token}` },
      body: { text: '进度播报' },
    })
    expect(cliSendRes.status).toBe(200)
    expect(agentSend).toHaveBeenCalledWith({ text: '进度播报' })

    // CLI token cannot mutate bot credentials or open-platform auth
    const cliBlockedAuth = await invokeHandler(handler, {
      url: '/api/lark-bridge/auth/status',
      headers: { authorization: `Bearer ${cliAuth.token}` },
    })
    expect(cliBlockedAuth.status).toBe(403)

    // 2. Exposes dynamic runtimes catalog for owner Web session (all runtimes support reasoningEffort UI)
    allowAuth = true
    const runtimesRes = await invokeHandler(handler, { url: '/api/lark-bridge/runtimes' })
    expect(runtimesRes.status).toBe(200)
    const runtimeList = runtimesRes.json.runtimes as Array<Record<string, unknown>>
    expect(runtimeList.map((r) => [r.id, r.name, r.kind, r.group, r.supportsReasoningEffort])).toEqual([
      ['codex', 'Codex', 'external', 'custom', true],
      ['agy', 'Antigravity', 'external', 'custom', true],
      ['claude-code', 'ClaudeCode', 'external', 'custom', true],
      ['trae', 'Trae', 'external', 'custom', true],
      ['standard', '标准模式', 'native', 'builtin', true],
    ])

    // 3. Creates bot with allowedUsers & signature, redacts secret, and hydrates allowedUserProfiles
    const created = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots',
      body: {
        id: 'dsh-bot',
        name: 'DSH-Bot',
        larkAppId: 'cli_123',
        larkAppSecret: 'super-secret-value',
        description: '研发团队智能机器人',
        signature: '由 DSH 驱动',
        defaultWorkingDir: '~',
        allowedUsers: ['ou_user_1'],
        groupReplyMode: 'new-topic',
        groupSessionMode: 'thread',
        role: { enabled: true, name: '研发专家', systemPrompt: '严谨简洁' },
      },
    })
    expect(created.status).toBe(201)
    expect((created.json.bot as Record<string, unknown>).hasSecret).toBe(true)
    expect((created.json.bot as Record<string, unknown>).larkAppSecret).toBeUndefined()

    const botsListRes = await invokeHandler(handler, { url: '/api/lark-bridge/bots' })
    const firstBot = (botsListRes.json.bots as Array<Record<string, unknown>>)[0]!
    expect(firstBot.allowedUserProfiles).toEqual([{ openId: 'ou_user_1', name: 'Alex Chen' }])

    // 4. Slash command /status uses "工作区"
    const replies: string[] = []
    await handleSlashCommand(
      {
        ctx: fakeCtx,
        store,
        runtimes,
        unbindRoute: vi.fn().mockResolvedValue(true),
        sessionWebUrl: (sid) => sid,
        runTurn: vi.fn().mockResolvedValue(''),
      },
      {
        bot: store.getBot('dsh-bot')!,
        command: { name: 'status', args: '' },
        routeKey: 'dsh-bot:oc_team',
        workingDir: '/repo',
        workspaceName: 'DSH-Bot',
        reply: async (text) => {
          replies.push(text)
        },
      },
    )
    expect(replies[0]).toContain('工作区：DSH-Bot')

    // 5. Partial PUT preserves secret and updates workspaceName
    const updated = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/bots/dsh-bot',
      body: {
        name: 'DSH-Bot',
        larkAppId: 'cli_123',
        larkAppSecret: '',
        defaultWorkingDir: '~',
        workspaceName: 'DSH 研发工作区',
      },
    })
    expect(updated.status).toBe(200)
    expect(store.getBot('dsh-bot')?.larkAppSecret).toBe('super-secret-value')
    expect(store.getBot('dsh-bot')?.workspaceName).toBe('DSH 研发工作区')

    // 6. Syncs discovered Lark chats, fetches & filters group members & user search, and updates listener template prompt
    await invokeHandler(handler, { method: 'POST', url: '/api/lark-bridge/sync-chats' })
    const membersRes = await invokeHandler(handler, { url: '/api/lark-bridge/groups/dsh-bot/oc_team/members' })
    expect(membersRes.status).toBe(200)
    expect((membersRes.json.members as unknown[]).length).toBe(2)
    expect(manager.listGroupMembers).toHaveBeenCalledWith('dsh-bot', 'oc_team')

    const filteredMembersRes = await invokeHandler(handler, {
      url: '/api/lark-bridge/groups/dsh-bot/oc_team/members?q=alex&includeAvatars=0',
    })
    expect(filteredMembersRes.status).toBe(200)
    expect(filteredMembersRes.json.members).toEqual([
      { openId: 'ou_user_1', name: 'Alex Chen', memberType: 'user' },
    ])
    expect(manager.listGroupMembers).toHaveBeenCalledWith('dsh-bot', 'oc_team', {
      includeAvatars: false,
    })

    const searchRes = await invokeHandler(handler, { url: '/api/lark-bridge/bots/dsh-bot/users/search?q=Alex' })
    expect(searchRes.status).toBe(200)
    expect((searchRes.json.users as Array<{ name: string }>)[0]?.name).toBe('Alex Chen')

    const savedGroup = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/groups/dsh-bot/oc_team',
      body: {
        enabled: true,
        workspaceName: '核心工程工作区',
        replyMode: 'reply',
        sessionMode: 'per_message',
        listener: {
          enabled: true,
          templateKey: 'project',
          name: '项目讨论',
          prompt: '定制后的项目讨论监听提示词：遇到架构问题先查代码再回答',
          memberOverrides: { ou_bot_2: true },
          replyMode: 'new-topic',
          sessionMode: 'thread',
        },
      },
    })
    expect(savedGroup.status).toBe(200)
    const templatesRes = await invokeHandler(handler, { url: '/api/lark-bridge/listener-templates' })
    const projectTpl = (templatesRes.json.templates as Array<{ key: string; prompt: string }>).find(
      (t) => t.key === 'project',
    )
    expect(projectTpl?.prompt).toBe('定制后的项目讨论监听提示词：遇到架构问题先查代码再回答')

    const groupViews = await invokeHandler(handler, { url: '/api/lark-bridge/groups' })
    const firstView = (groupViews.json.groups as Array<Record<string, unknown>>)[0]!
    expect(firstView.chatName).toBe('核心研发协作群')
    expect(firstView.effectiveWorkspaceName).toBe('核心工程工作区')

    // 7. Cockpit hourly telemetry includes silentSkipped24h & peakHourlyCount
    store.recordMetric({ botId: 'dsh-bot', chatId: 'oc_team', kind: 'inbound' })
    store.recordMetric({ botId: 'dsh-bot', chatId: 'oc_team', kind: 'replied', latencyMs: 1200 })
    store.recordMetric({ botId: 'dsh-bot', chatId: 'oc_team', kind: 'silent_skip' })
    const cockpitRes = await invokeHandler(handler, { url: '/api/lark-bridge/cockpit' })
    expect(cockpitRes.status).toBe(200)
    const summary = cockpitRes.json.summary as Record<string, unknown>
    expect(summary.inbound24h).toBe(1)
    expect(summary.silentSkipped24h).toBe(1)
    expect(summary.peakHourlyCount).toBe(1)
  })

  it('validates working directory existence before saving Bot, AutoCreateBot, or Group configs', async () => {
    const dataDir = makeTempDir()
    const validBotDir = makeTempDir()
    const validGroupDir = makeTempDir()
    const missingDir = join(dataDir, 'nonexistent-workspace-dir')
    const regularFile = join(dataDir, 'not-a-directory.txt')
    writeFileSync(regularFile, 'hello\n', 'utf8')

    const store = new LarkBridgeStore(dataDir)
    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      llm: { listProviders: () => [] },
      on: () => () => {},
      get: () => undefined,
    } as unknown as Context
    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    const admitter: ConnectionAdmitter = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    // 1. POST /bots rejects nonexistent directory and does NOT persist bot
    const badCreate = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots',
      body: {
        id: 'bad-bot',
        name: 'BadBot',
        enabled: false,
        larkAppId: 'cli_bad',
        larkAppSecret: 'sec_bad',
        defaultWorkingDir: missingDir,
      },
    })
    expect(badCreate.status).toBe(400)
    expect(String(badCreate.json.error)).toContain('工作目录不存在')
    expect(store.getBot('bad-bot')).toBeUndefined()

    // 2. POST /bots rejects regular file path (not a directory)
    const fileCreate = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots',
      body: {
        id: 'file-bot',
        name: 'FileBot',
        enabled: false,
        larkAppId: 'cli_file',
        larkAppSecret: 'sec_file',
        defaultWorkingDir: regularFile,
      },
    })
    expect(fileCreate.status).toBe(400)
    expect(String(fileCreate.json.error)).toContain('工作目录路径不是文件夹')
    expect(store.getBot('file-bot')).toBeUndefined()

    // 3. POST /bots/auto-create rejects nonexistent directory before starting platform job
    const badAutoCreate = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/auto-create',
      body: {
        mode: 'open_platform',
        name: 'AutoBot',
        defaultWorkingDir: missingDir,
      },
    })
    expect(badAutoCreate.status).toBe(400)
    expect(String(badAutoCreate.json.error)).toContain('工作目录不存在')

    // 4. Create valid bot, then verify PUT /bots/:id with nonexistent dir fails without overwriting validBotDir
    const okCreate = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots',
      body: {
        id: 'ok-bot',
        name: 'OkBot',
        enabled: false,
        larkAppId: 'cli_ok',
        larkAppSecret: 'sec_ok',
        defaultWorkingDir: validBotDir,
      },
    })
    expect(okCreate.status).toBe(201)

    const badUpdate = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/bots/ok-bot',
      body: {
        name: 'OkBot',
        enabled: false,
        larkAppId: 'cli_ok',
        larkAppSecret: '',
        defaultWorkingDir: missingDir,
      },
    })
    expect(badUpdate.status).toBe(400)
    expect(String(badUpdate.json.error)).toContain('工作目录不存在')
    expect(store.getBot('ok-bot')?.defaultWorkingDir).toBe(validBotDir)

    // 5. PUT /groups/:botId/:chatId rejects nonexistent custom workingDir, accepts valid custom dir & empty inherited dir
    const badGroup = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/groups/ok-bot/oc_group_1',
      body: {
        enabled: true,
        workingDir: missingDir,
      },
    })
    expect(badGroup.status).toBe(400)
    expect(String(badGroup.json.error)).toContain('工作目录不存在')
    expect(store.getGroup('ok-bot', 'oc_group_1')).toBeUndefined()

    const okGroupCustom = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/groups/ok-bot/oc_group_1',
      body: {
        enabled: true,
        workingDir: validGroupDir,
      },
    })
    expect(okGroupCustom.status).toBe(200)
    expect(store.getGroup('ok-bot', 'oc_group_1')?.workingDir).toBe(validGroupDir)

    const okGroupInherit = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/groups/ok-bot/oc_group_1',
      body: {
        enabled: true,
        workingDir: '',
      },
    })
    expect(okGroupInherit.status).toBe(200)
    expect(store.getGroup('ok-bot', 'oc_group_1')?.workingDir).toBe('')

    await manager.stop()
  })

  it('resolves native preset provider/model/effort and mounts preset plugins while keeping external runtimes isolated', async () => {
    const mountCalls: Array<{ ctx: unknown; presetId: string | undefined }> = []
    let defaultSelection:
      | { provider?: string; model?: string; reasoningEffort?: string }
      | undefined = {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    }
    let providers: Array<{ id: string; name: string }> = [
      { id: 'codex-cli', name: 'Codex' },
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' },
    ]
    const providerModels: Record<string, Array<{ provider: string; id: string; name: string }>> = {
      'codex-cli': [{ provider: 'codex-cli', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
      deepseek: [
        { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
      openai: [{ provider: 'openai', id: 'gpt-5', name: 'GPT-5' }],
    }

    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      get(service: string) {
        if (service === 'externalRuntimes') {
          const codex = {
            id: 'codex',
            displayName: 'Codex',
            description: 'Codex runtime',
            providerId: 'codex-cli',
            defaultModel: 'gpt-6.1-sol',
          }
          return {
            list: () => [codex],
            get: (id: string) => (id === 'codex' ? codex : undefined),
          }
        }
        if (service === 'agentDefaultModel') {
          return { currentSelection: () => defaultSelection }
        }
        if (service === 'agentPresets') {
          return {
            remoteExportList: async () => ({ presets: [{ id: 'standard', isDefault: true }] }),
            mount: async (agentCtx: unknown, presetId?: string) => {
              mountCalls.push({ ctx: agentCtx, presetId })
              if (presetId === 'codex') throw new Error('agent-preset/not-found')
            },
          }
        }
        return undefined
      },
      llm: {
        listProviders: () => providers,
        listModels: async (providerId: string) => providerModels[providerId] ?? [],
      },
    } as unknown as Context

    const catalog = new RuntimeCatalog(fakeCtx)
    const fakeAgentCtx = { on: vi.fn() } as unknown as Context

    // 1. Native `standard` with blank model inherits DSH agentDefaultModel (provider + model + effort) and mounts preset
    const nativeDefault = await catalog.resolveAgentLaunch({
      agentPreset: 'standard',
      requireNativeModel: true,
    })
    expect(nativeDefault.isExternal).toBe(false)
    expect(nativeDefault.provider).toBe('deepseek')
    expect(nativeDefault.model).toBe('deepseek-chat')
    expect(nativeDefault.reasoningEffort).toBe('high')
    await nativeDefault.mountPreset(fakeAgentCtx)
    expect(mountCalls).toEqual([{ ctx: fakeAgentCtx, presetId: 'standard' }])

    // 2. Native `standard` with explicit model (saved by UI without provider) locates the owning native provider
    const nativeExplicit = await catalog.resolveAgentLaunch({
      agentPreset: 'standard',
      explicitModel: 'gpt-5',
      requireNativeModel: true,
    })
    expect(nativeExplicit.isExternal).toBe(false)
    expect(nativeExplicit.provider).toBe('openai')
    expect(nativeExplicit.model).toBe('gpt-5')
    expect(nativeExplicit.reasoningEffort).toBeUndefined()

    // 3. When DSH global default points to an external CLI provider (`codex-cli`), native `standard` ignores it and falls back to native LLM
    defaultSelection = { provider: 'codex-cli', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }
    const nativeFallback = await catalog.resolveAgentLaunch({
      agentPreset: 'standard',
      requireNativeModel: true,
    })
    expect(nativeFallback.isExternal).toBe(false)
    expect(nativeFallback.provider).toBe('deepseek')
    expect(nativeFallback.model).toBe('deepseek-chat')
    expect(nativeFallback.reasoningEffort).toBeUndefined()

    // 4. External runtime (`codex`) resolves its external providerId and ignores missing preset-registry rows on mount
    const extLaunch = await catalog.resolveAgentLaunch({
      agentPreset: 'codex',
      explicitModel: 'gpt-6.1-sol',
      explicitReasoningEffort: 'xhigh',
      requireNativeModel: true,
    })
    expect(extLaunch.isExternal).toBe(true)
    expect(extLaunch.provider).toBe('codex-cli')
    expect(extLaunch.model).toBe('gpt-6.1-sol')
    expect(extLaunch.reasoningEffort).toBe('xhigh')
    await expect(extLaunch.mountPreset(fakeAgentCtx)).resolves.toBeUndefined()

    // 5. Native `standard` with zero configured native providers fails fast with actionable Chinese guidance
    providers = [{ id: 'codex-cli', name: 'Codex' }]
    await expect(
      catalog.resolveAgentLaunch({
        agentPreset: 'standard',
        requireNativeModel: true,
      }),
    ).rejects.toThrow(/内置运行时 "standard" 缺少可用的原生模型配置/)
  })

  it('lists Open Platform apps with connection flags and imports existing apps without exposing secrets', async () => {
    const dataDir = makeTempDir()
    const validDir = makeTempDir()
    const missingDir = join(dataDir, 'missing-workspace')
    const store = new LarkBridgeStore(dataDir)
    store.upsertBot({
      id: 'existing-bot',
      name: 'Existing Bot',
      enabled: false,
      larkAppId: 'cli_connected_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: validDir,
    })

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      llm: { listProviders: () => [] },
      on: () => () => {},
      get: () => undefined,
    } as unknown as Context
    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    vi.spyOn(manager, 'syncBot').mockResolvedValue(undefined)
    vi.spyOn(manager, 'ensureBotProfileHydrated').mockResolvedValue(undefined)
    vi.spyOn(manager.platform, 'listOpenPlatformApps').mockResolvedValue({
      authenticated: true,
      identity: {
        userId: 'u_demo_1',
        userName: 'Alex Chen',
        tenantId: 't_demo',
        tenantName: 'Acme Corp',
      },
      apps: [
        {
          appId: 'cli_connected_1',
          name: 'Existing Bot',
          description: 'Already linked',
          avatarUrl: 'https://example.com/a.png',
          hasBotAbility: true,
          abilities: ['bot'],
          appStatus: 2,
        },
        {
          appId: 'cli_ready_2',
          name: '研发值班助手',
          description: '自动同步自开放平台',
          avatarUrl: 'https://example.com/b.png',
          hasBotAbility: true,
          abilities: ['bot'],
          appStatus: 2,
        },
      ],
    })
    vi.spyOn(manager.platform, 'fetchOpenPlatformAppCredentials').mockResolvedValue({
      appId: 'cli_ready_2',
      appSecret: 'mock-test-secret',
      name: '研发值班助手',
      description: '自动同步自开放平台',
      avatarUrl: 'https://example.com/b.png',
      hasBotAbility: true,
    })

    const admitter: ConnectionAdmitter = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    // 1. CLI bearer token cannot list Open Platform apps or import existing apps
    const cliList = await invokeHandler(handler, {
      url: '/api/lark-bridge/auth/open-platform/apps',
      headers: { authorization: `Bearer ${manager.cliAuth.token}` },
    })
    expect(cliList.status).toBe(403)
    const cliImport = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/import-existing',
      headers: { authorization: `Bearer ${manager.cliAuth.token}` },
      body: { larkAppId: 'cli_ready_2', defaultWorkingDir: validDir },
    })
    expect(cliImport.status).toBe(403)

    // 2. Owner session receives annotated Open Platform app list
    const listRes = await invokeHandler(handler, {
      url: '/api/lark-bridge/auth/open-platform/apps',
    })
    expect(listRes.status).toBe(200)
    expect(listRes.json.authenticated).toBe(true)
    const apps = listRes.json.apps as Array<Record<string, unknown>>
    expect(apps).toHaveLength(2)
    expect(apps[0]).toMatchObject({
      appId: 'cli_connected_1',
      alreadyConnected: true,
      connectedBotId: 'existing-bot',
      connectedBotName: 'Existing Bot',
    })
    expect(apps[1]).toMatchObject({
      appId: 'cli_ready_2',
      alreadyConnected: false,
    })
    expect(JSON.stringify(listRes.json)).not.toContain('mock-test-secret')

    // 3. Rejects invalid workingDir before calling Open Platform credentials API
    const badDirRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/import-existing',
      body: { larkAppId: 'cli_ready_2', defaultWorkingDir: missingDir },
    })
    expect(badDirRes.status).toBe(400)
    expect(String(badDirRes.json.error)).toContain('工作目录不存在')

    // 4. Rejects already connected app
    const dupRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/import-existing',
      body: { larkAppId: 'cli_connected_1', defaultWorkingDir: validDir },
    })
    expect(dupRes.status).toBe(400)
    expect(String(dupRes.json.error)).toContain('已接入')

    // 5. Imports new existing app without manual basic info, persists secret locally, redacts from response
    const importedRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/import-existing',
      body: {
        larkAppId: 'cli_ready_2',
        defaultWorkingDir: validDir,
        workspaceName: 'OpsSpace',
        agentPreset: 'standard',
      },
    })
    expect(importedRes.status).toBe(201)
    const botView = importedRes.json.bot as Record<string, unknown>
    expect(botView.name).toBe('研发值班助手')
    expect(botView.description).toBe('自动同步自开放平台')
    expect(botView.avatarUrl).toBe('https://example.com/b.png')
    expect(botView.larkAppId).toBe('cli_ready_2')
    expect(botView.hasSecret).toBe(true)
    expect(botView.larkAppSecret).toBeUndefined()
    expect(botView.id).toBe('bot-ready2')

    const persisted = store.getBot('bot-ready2')
    expect(persisted?.larkAppSecret).toBe('mock-test-secret')
    expect(persisted?.workspaceName).toBe('OpsSpace')
    expect(importedRes.json.eventSync).toBeUndefined()

    // 6. Optional baseline event sync during existing app import
    const syncSpy = vi.spyOn(manager.platform, 'syncAppBaselineEvents').mockResolvedValue({
      synced: true,
      addedEvents: ['im.message.recalled_v1'],
      addedCallbacks: [],
      version: '1.0.5',
    })
    vi.spyOn(manager.platform, 'fetchOpenPlatformAppCredentials').mockResolvedValueOnce({
      appId: 'cli_ready_3',
      appSecret: 'mock-test-secret-3',
      name: '自动补齐助手',
      description: '测试补齐事件',
      hasBotAbility: true,
    })

    const syncedImportRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots/import-existing',
      body: {
        larkAppId: 'cli_ready_3',
        defaultWorkingDir: validDir,
        workspaceName: 'OpsSpace',
        agentPreset: 'standard',
        syncBaselineEvents: true,
      },
    })
    expect(syncedImportRes.status).toBe(201)
    expect(syncSpy).toHaveBeenCalledWith('cli_ready_3')
    expect(syncedImportRes.json.eventSync).toEqual({
      synced: true,
      addedEvents: ['im.message.recalled_v1'],
      addedCallbacks: [],
      version: '1.0.5',
    })
    expect(
      store.listEvents(20).some((e) => e.kind === 'lifecycle' && e.summary.includes('已补齐基线事件')),
    ).toBe(true)

    await manager.stop()
  })

  it('enforces owner-only auth boundaries against operator tokens and non-owner principals across all privileged endpoints', async () => {
    const dir = makeTempDir()
    const validDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    store.upsertBot({
      id: 'bot-sec',
      name: '安全测试助手',
      enabled: false,
      larkAppId: 'cli_sec_test',
      larkAppSecret: 'sec_test_1',
      defaultWorkingDir: validDir,
    })

    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      sessions: { get: () => undefined },
      llm: { listProviders: () => [] },
      on: () => () => {},
      get: () => undefined,
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    const mem = manager.memory.upsert({
      botId: 'bot-sec',
      scope: 'bot',
      type: 'project',
      title: '安全回归测试条目',
      content: '用于验证 operator 与非 owner 无法执行物理删除。',
    })

    const viewerAdmitter: ConnectionAdmitter = {
      admit: () => ({ peer: { principal: { kind: 'viewer' } } }),
    }
    const handler = createLarkHttpHandler(fakeCtx, viewerAdmitter, manager)
    const opHeaders = { [OPERATOR_TOKEN_HEADER]: manager.operatorAuth.token }
    const cliAndOpHeaders = {
      authorization: `Bearer ${manager.cliAuth.token}`,
      [OPERATOR_TOKEN_HEADER]: manager.operatorAuth.token,
    }

    // 1. Pure operator token can access health, lifecycle, and diagnostics
    expect((await invokeHandler(handler, { url: '/api/lark-bridge/health', headers: opHeaders })).status).toBe(200)
    expect((await invokeHandler(handler, { url: '/api/lark-bridge/lifecycle/status', headers: opHeaders })).status).toBe(200)
    expect((await invokeHandler(handler, { url: '/api/lark-bridge/diagnostics', headers: opHeaders })).status).toBe(200)
    expect(
      (
        await invokeHandler(handler, {
          method: 'POST',
          url: '/api/lark-bridge/lifecycle/drain',
          headers: opHeaders,
          body: { reason: 'test-drain' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await invokeHandler(handler, {
          method: 'POST',
          url: '/api/lark-bridge/lifecycle/resume-intake',
          headers: opHeaders,
        })
      ).status,
    ).toBe(200)

    // 2. Pure operator token is blocked fail-closed from business and owner-only endpoints
    const operatorBlockedCases: Array<{ method: string; url: string; body?: unknown }> = [
      { method: 'GET', url: '/api/lark-bridge/fs/dirs' },
      { method: 'POST', url: '/api/lark-bridge/fs/dirs', body: { parentPath: validDir, name: 'x' } },
      { method: 'GET', url: '/api/lark-bridge/auth/status' },
      { method: 'POST', url: '/api/lark-bridge/bots', body: { name: 'X', larkAppId: 'cli_x', larkAppSecret: 's', defaultWorkingDir: validDir } },
      { method: 'POST', url: '/api/lark-bridge/bots/auto-create', body: {} },
      { method: 'POST', url: '/api/lark-bridge/bots/import-existing', body: {} },
      { method: 'PUT', url: '/api/lark-bridge/bots/bot-sec', body: { name: 'Hacked' } },
      { method: 'DELETE', url: '/api/lark-bridge/bots/bot-sec' },
      { method: 'POST', url: '/api/lark-bridge/bots/bot-sec/dream', body: {} },
      { method: 'DELETE', url: '/api/lark-bridge/triage-sessions' },
      { method: 'DELETE', url: '/api/lark-bridge/triage-sessions/sess-1' },
      { method: 'POST', url: '/api/lark-bridge/reminders/rem-1/approve' },
      { method: 'POST', url: '/api/lark-bridge/console-login/issue', body: {} },
      { method: 'DELETE', url: `/api/lark-bridge/memory/${encodeURIComponent(mem.entry.id)}?hard=1` },
      { method: 'GET', url: '/api/lark-bridge/bots' },
      { method: 'POST', url: '/api/lark-bridge/agent/send', body: { text: 'blocked' } },
    ]
    for (const c of operatorBlockedCases) {
      const res = await invokeHandler(handler, { ...c, headers: opHeaders })
      expect(res.status, `operator ${c.method} ${c.url}`).toBe(403)
      expect(res.json.error).toBe('operator_scope_forbidden')
    }

    // 3. Non-owner web principal (`viewer`) and CLI+operator dual headers are blocked on all owner-only endpoints
    const ownerOnlyCases: Array<{ method: string; url: string; body?: unknown; expectedError?: string }> = [
      { method: 'GET', url: '/api/lark-bridge/fs/dirs' },
      { method: 'POST', url: '/api/lark-bridge/fs/dirs', body: { parentPath: validDir, name: 'x' } },
      { method: 'GET', url: '/api/lark-bridge/auth/status' },
      { method: 'POST', url: '/api/lark-bridge/bots', body: { name: 'X', larkAppId: 'cli_x', larkAppSecret: 's', defaultWorkingDir: validDir } },
      { method: 'POST', url: '/api/lark-bridge/bots/auto-create', body: {} },
      { method: 'POST', url: '/api/lark-bridge/bots/import-existing', body: {} },
      { method: 'PUT', url: '/api/lark-bridge/bots/bot-sec', body: { name: 'Hacked' } },
      { method: 'DELETE', url: '/api/lark-bridge/bots/bot-sec' },
      { method: 'POST', url: '/api/lark-bridge/bots/bot-sec/dream', body: {} },
      { method: 'DELETE', url: '/api/lark-bridge/triage-sessions' },
      { method: 'DELETE', url: '/api/lark-bridge/triage-sessions/sess-1' },
      { method: 'POST', url: '/api/lark-bridge/reminders/rem-1/approve' },
      { method: 'POST', url: '/api/lark-bridge/console-login/issue', body: {} },
      { method: 'POST', url: '/api/lark-bridge/viewer/rotate-secret' },
      { method: 'GET', url: '/api/lark-bridge/runtime-profiles' },
      { method: 'POST', url: '/api/lark-bridge/diagnostics/split-brain/bot-sec/clear' },
      { method: 'POST', url: '/api/lark-bridge/desktop/open-ack', body: {}, expectedError: 'owner_session_required' },
      { method: 'DELETE', url: `/api/lark-bridge/memory/${encodeURIComponent(mem.entry.id)}?hard=1` },
    ]
    for (const c of ownerOnlyCases) {
      const viewerRes = await invokeHandler(handler, c)
      expect(viewerRes.status, `viewer ${c.method} ${c.url}`).toBe(403)
      expect(viewerRes.json.error).toBe(c.expectedError ?? 'owner_web_session_required')

      const dualRes = await invokeHandler(handler, { ...c, headers: cliAndOpHeaders })
      expect(dualRes.status, `cli+op ${c.method} ${c.url}`).toBe(403)
      expect(dualRes.json.error).toBe(c.expectedError ?? 'owner_web_session_required')
    }

    // Memory entry must still exist intact after blocked hard-delete attempts
    expect(manager.memory.get(mem.entry.id, { recordRecall: false })?.id).toBe(mem.entry.id)
    await manager.stop()
  })

  it('initializes new bots and newly configured groups with expected conversation & message defaults without overriding existing inherited groups', async () => {
    const dir = makeTempDir()
    const validDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      get: () => undefined,
      llm: { listProviders: () => [], listModels: async () => [] },
      agents: { get: () => undefined },
    } as unknown as Context
    const runtimes = new RuntimeCatalog(fakeCtx)
    const manager = {
      ctx: fakeCtx,
      store,
      runtimes,
      listBotStatuses: () => [],
      hydrateAllowedUserProfiles: vi.fn(async () => []),
      syncBot: vi.fn().mockResolvedValue(undefined),
      removeBot: vi.fn().mockResolvedValue(undefined),
      syncGroupWorkspace: vi.fn().mockResolvedValue(undefined),
      syncJoinedChats: vi.fn().mockImplementation(async (botId?: string) => {
        const chats = [
          {
            botId: botId ?? 'bot-defaults',
            chatId: 'oc_new_group',
            name: '新接入协作群',
            description: '',
          },
        ]
        store.mergeDiscoveredChats(botId ?? 'bot-defaults', chats)
        return chats
      }),
      listGroupMembers: vi.fn().mockResolvedValue([]),
      searchUsers: vi.fn().mockResolvedValue([]),
      unbindRoute: vi.fn().mockResolvedValue(true),
      sessionWebUrl: (sid: string) => `http://127.0.0.1:3880/sessions/${sid}`,
      platform: {
        getAuthStatus: vi.fn().mockResolvedValue({
          openPlatform: { authenticated: false },
          userAuth: [],
        }),
      },
    } as unknown as LarkBridgeManager

    const fakeConnection: ConnectionAdmitter = {
      admit: () => ({ peer: { principal: { kind: 'owner' } } }),
    }
    const handler = createLarkHttpHandler(fakeCtx, fakeConnection, manager)

    // 1. Minimal POST /bots gets Citlalin-aligned conversation & message defaults
    const createdBot = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/bots',
      body: {
        id: 'bot-defaults',
        name: 'DefaultBot',
        larkAppId: 'cli_defaults',
        larkAppSecret: 'sec_defaults',
        defaultWorkingDir: validDir,
      },
    })
    expect(createdBot.status).toBe(201)
    expect(createdBot.json.bot).toMatchObject({
      groupAccessMode: 'configured_only',
      mentionTriggerMode: 'mention_and_active_thread',
      groupSessionMode: 'thread',
      idleCloseMinutes: 720,
      groupReplyMode: 'reply',
      receivedReactionEmoji: 'OnIt',
      cotEnabled: true,
      cotToolResultEnabled: true,
      sendIntermediateMessages: false,
      useInteractiveCard: true,
      dshSessionLinkInCard: true,
      sessionLinkGuestReadOnly: true,
      replyFooterEnabled: true,
      replyFooterModel: true,
      replyFooterSignature: true,
      signature: 'AI 可能出错，请谨慎判断结果~',
      router: expect.objectContaining({
        enabled: true,
        scope: 'all_group',
        timeoutMs: 15_000,
        maxTriageImages: 5,
        recentMessageCount: 6,
        contextTtlMinutes: 30,
        includeLastReply: true,
        coalesceQueuedMessages: true,
      }),
      experimental: expect.objectContaining({
        dreaming: expect.objectContaining({
          enabled: true,
          scheduleTime: '03:00',
          minNewSessions: 2,
          maxSessionsPerRun: 0,
          maxCharsPerSession: 5000,
          maxRemindersPerRun: 5,
          maxDurationMinutes: 45,
          deepConsolidation: true,
          reasoningEffort: 'high',
          cleanupAndCorrect: true,
        }),
        proactive: expect.objectContaining({
          remindersEnabled: true,
          reminderCreationMode: 'silent',
          delegationFollowupEnabled: true,
          quietHoursEnabled: true,
          quietHoursStart: '00:00',
          quietHoursEnd: '08:00',
          autoCodeEnabled: true,
          branchPrefix: 'agent/',
        }),
      }),
    })
    expect('longTurnProgressNotice' in (createdBot.json.bot as Record<string, unknown>)).toBe(false)

    // 2. Discovered unconfigured group view starts disabled (configured_only) with new-group conversation defaults
    await invokeHandler(handler, { method: 'POST', url: '/api/lark-bridge/sync-chats' })
    const unconfiguredViews = await invokeHandler(handler, { url: '/api/lark-bridge/groups' })
    const unconfigured = (unconfiguredViews.json.groups as Array<Record<string, unknown>>)[0]!
    expect(unconfigured.configured).toBe(false)
    expect(unconfigured.config).toMatchObject({
      enabled: false,
      mentionTriggerMode: 'inherit',
      sessionMode: 'inherit',
      idleCloseMinutes: 360,
      replyMode: 'new-topic',
      receivedReactionEmoji: 'inherit',
      intermediateMessages: 'inherit',
      replyFormat: 'text',
      dshSessionLinkInCard: 'inherit',
      sessionLinkGuestReadOnly: 'inherit',
      replyFooterModel: 'inherit',
      signatureMode: 'inherit',
      signature: '',
    })

    // 3. First PUT /groups with minimal payload persists new-group conversation defaults
    const enabledRes = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/groups/bot-defaults/oc_new_group',
      body: { enabled: true },
    })
    expect(enabledRes.status).toBe(200)
    expect(enabledRes.json.group).toMatchObject({
      enabled: true,
      idleCloseMinutes: 360,
      replyMode: 'new-topic',
      replyFormat: 'text',
      mentionTriggerMode: 'inherit',
      sessionMode: 'inherit',
    })

    // 4. Switching idleCloseMinutes back to inherit (null) is preserved across subsequent partial updates
    const inheritIdleRes = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/groups/bot-defaults/oc_new_group',
      body: {
        idleCloseMinutes: null,
        replyMode: 'inherit',
        replyFormat: 'inherit',
      },
    })
    expect(inheritIdleRes.status).toBe(200)
    expect((inheritIdleRes.json.group as Record<string, unknown>).idleCloseMinutes).toBeUndefined()
    expect(inheritIdleRes.json.group).toMatchObject({
      replyMode: 'inherit',
      replyFormat: 'inherit',
    })

    const subsequentPartialRes = await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/groups/bot-defaults/oc_new_group',
      body: { workspaceName: '自定义工作区' },
    })
    expect(subsequentPartialRes.status).toBe(200)
    expect((subsequentPartialRes.json.group as Record<string, unknown>).idleCloseMinutes).toBeUndefined()
    expect(subsequentPartialRes.json.group).toMatchObject({
      workspaceName: '自定义工作区',
      replyMode: 'inherit',
      replyFormat: 'inherit',
    })

    store.close()
  })

  it('defaults the Feishu app creator as bot admin across manual, import-existing, and auto-create flows without resurrecting cleared admins', async () => {
    const dir = makeTempDir()
    const validDir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      sessions: { get: () => undefined },
      llm: { listProviders: () => [], listModels: async () => [] },
      on: () => () => {},
      get: () => undefined,
    } as unknown as Context

    const manager = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    const creatorByAppId: Record<string, string | undefined> = {
      cli_manual_creator: 'ou_creator_manual',
      cli_manual_explicit: 'ou_creator_manual',
      cli_import_true_creator: 'ou_true_creator',
      cli_import_email_fallback: undefined,
      cli_auto_op: undefined,
    }
    const emailOpenIdByApp: Record<string, string | undefined> = {
      'sam@example.com': 'ou_importer_sam',
      'alex@example.com': 'ou_auto_alex',
    }
    const userSummaryByOpenId: Record<
      string,
      { openId: string; name: string; email?: string; avatarUrl?: string } | undefined
    > = {
      ou_creator_manual: {
        openId: 'ou_creator_manual',
        name: 'Alex Chen',
        email: 'alex@example.com',
        avatarUrl: 'https://example.com/alex.png',
      },
      ou_device_creator: {
        openId: 'ou_device_creator',
        name: 'Lin Xiao',
        avatarUrl: 'https://example.com/lin.png',
      },
      // Simulate 41050 contact scope miss for ou_true_creator so we verify importer's name is NOT misapplied
      ou_true_creator: undefined,
    }

    const fetchProfileSpy = vi
      .spyOn(LarkBotTransport.prototype, 'fetchBotProfile')
      .mockImplementation(async function (this: LarkBotTransport) {
        const appId = this.state.larkAppId
        const creatorOpenId = creatorByAppId[appId]
        return {
          openId: `ou_bot_${appId}`,
          name: this.state.name,
          avatarUrl: 'https://example.com/bot.png',
          description: 'desc',
          ...(creatorOpenId ? { creatorOpenId } : {}),
        }
      })
    const resolveEmailSpy = vi
      .spyOn(LarkBotTransport.prototype, 'resolveOpenIdByEmail')
      .mockImplementation(async (email: string) => emailOpenIdByApp[email])
    const resolveSummarySpy = vi
      .spyOn(LarkBotTransport.prototype, 'resolveUserSummary')
      .mockImplementation(async (openId: string, fallbackName?: string) => {
        const found = userSummaryByOpenId[openId]
        if (found) return found
        return fallbackName ? { openId, name: fallbackName } : undefined
      })
    const startSpy = vi
      .spyOn(LarkBotTransport.prototype, 'start')
      .mockImplementation(async function (this: LarkBotTransport) {
        const profile = await this.fetchBotProfile()
        const cbs = (this as unknown as { callbacks?: { onBotProfile?: (p: typeof profile) => void } })
          .callbacks
        cbs?.onBotProfile?.(profile)
      })
    const stopSpy = vi.spyOn(LarkBotTransport.prototype, 'stop').mockResolvedValue(undefined)

    try {
      const admitter: ConnectionAdmitter = {
        admit: () => ({ peer: { principal: { kind: 'owner' } } }),
      }
      const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

      // 1. Manual POST /bots with empty adminUsers auto-seeds app creator & profile
      const manualRes = await invokeHandler(handler, {
        method: 'POST',
        url: '/api/lark-bridge/bots',
        body: {
          id: 'bot-manual-creator',
          name: 'ManualCreatorBot',
          larkAppId: 'cli_manual_creator',
          larkAppSecret: 'sec_manual_1',
          defaultWorkingDir: validDir,
          adminUsers: [],
        },
      })
      expect(manualRes.status).toBe(201)
      expect(manualRes.json.bot).toMatchObject({
        id: 'bot-manual-creator',
        adminUsers: ['ou_creator_manual'],
        adminUserProfiles: [
          {
            openId: 'ou_creator_manual',
            name: 'Alex Chen',
            email: 'alex@example.com',
            avatarUrl: 'https://example.com/alex.png',
          },
        ],
      })

      // 2. Clearing adminUsers via PUT /bots/:id stays empty even after sync-profile
      const clearRes = await invokeHandler(handler, {
        method: 'PUT',
        url: '/api/lark-bridge/bots/bot-manual-creator',
        body: {
          ...store.getBot('bot-manual-creator'),
          larkAppSecret: '',
          adminUsers: [],
          adminUserProfiles: [],
        },
      })
      expect(clearRes.status).toBe(200)
      expect((clearRes.json.bot as Record<string, unknown>).adminUsers).toEqual([])
      await invokeHandler(handler, {
        method: 'POST',
        url: '/api/lark-bridge/bots/bot-manual-creator/sync-profile',
      })
      expect(store.getBot('bot-manual-creator')?.adminUsers).toEqual([])

      // 3. Manual POST /bots with explicit adminUsers does NOT overwrite caller's admins
      const explicitRes = await invokeHandler(handler, {
        method: 'POST',
        url: '/api/lark-bridge/bots',
        body: {
          id: 'bot-manual-explicit',
          name: 'ExplicitAdminBot',
          larkAppId: 'cli_manual_explicit',
          larkAppSecret: 'sec_manual_2',
          defaultWorkingDir: validDir,
          adminUsers: ['ou_explicit_admin'],
        },
      })
      expect(explicitRes.status).toBe(201)
      expect((explicitRes.json.bot as Record<string, unknown>).adminUsers).toEqual([
        'ou_explicit_admin',
      ])

      // 4a. import-existing uses authoritative Feishu app creator_id and does NOT mislabel with importer's name
      vi.spyOn(manager.platform, 'getCachedIdentity').mockReturnValue({
        userId: 'u_sam',
        userName: 'Sam',
        email: 'sam@example.com',
        tenantId: 't_demo',
        tenantName: 'Acme Corp',
      })
      vi.spyOn(manager.platform, 'fetchOpenPlatformAppCredentials').mockResolvedValueOnce({
        appId: 'cli_import_true_creator',
        appSecret: 'sec_import_1',
        name: 'ImportedTeamBot',
        description: 'Team bot',
        avatarUrl: 'https://example.com/bot.png',
        hasBotAbility: true,
      })
      const importTrueCreatorRes = await invokeHandler(handler, {
        method: 'POST',
        url: '/api/lark-bridge/bots/import-existing',
        body: { larkAppId: 'cli_import_true_creator', defaultWorkingDir: validDir },
      })
      expect(importTrueCreatorRes.status).toBe(201)
      expect(importTrueCreatorRes.json.bot).toMatchObject({
        adminUsers: ['ou_true_creator'],
        adminUserProfiles: [],
      })

      // 4b. import-existing falls back to logged-in Open Platform email when application/v6 lacks creator_id
      vi.spyOn(manager.platform, 'fetchOpenPlatformAppCredentials').mockResolvedValueOnce({
        appId: 'cli_import_email_fallback',
        appSecret: 'sec_import_2',
        name: 'LegacyImportedBot',
        description: 'Legacy bot',
        avatarUrl: 'https://example.com/bot.png',
        hasBotAbility: true,
      })
      const importFallbackRes = await invokeHandler(handler, {
        method: 'POST',
        url: '/api/lark-bridge/bots/import-existing',
        body: { larkAppId: 'cli_import_email_fallback', defaultWorkingDir: validDir },
      })
      expect(importFallbackRes.status).toBe(201)
      expect(importFallbackRes.json.bot).toMatchObject({
        adminUsers: ['ou_importer_sam'],
        adminUserProfiles: [
          {
            openId: 'ou_importer_sam',
            name: 'Sam',
            email: 'sam@example.com',
          },
        ],
      })

      // 5a. Auto-create SDK device_flow seeds creatorOpenId directly and hydrates profile
      vi.spyOn(manager.platform, 'startAutoCreateBot').mockImplementationOnce((_req, onCreated) => {
        void onCreated({
          id: 'bot-device-flow',
          name: 'DeviceFlowBot',
          description: 'Personal bot',
          larkAppId: 'cli_device_flow',
          larkAppSecret: 'sec_device_1',
          creatorOpenId: 'ou_device_creator',
        })
        return { jobId: 'job-device-1', status: 'working', stepMessage: 'working' }
      })
      await manager.startAutoCreateBot({
        mode: 'device_flow',
        name: 'DeviceFlowBot',
        defaultWorkingDir: validDir,
      })
      await vi.waitFor(() => {
        expect(store.getBot('bot-device-flow')?.adminUserProfiles).toHaveLength(1)
      })
      expect(store.getBot('bot-device-flow')).toMatchObject({
        adminUsers: ['ou_device_creator'],
        adminUserProfiles: [
          {
            openId: 'ou_device_creator',
            name: 'Lin Xiao',
            avatarUrl: 'https://example.com/lin.png',
          },
        ],
      })

      // 5b. Auto-create open_platform falls back to creatorEmail when application/v6 omits creator_id
      vi.spyOn(manager.platform, 'startAutoCreateBot').mockImplementationOnce((_req, onCreated) => {
        void onCreated({
          id: 'bot-auto-op',
          name: 'AutoOpBot',
          description: 'Auto created bot',
          larkAppId: 'cli_auto_op',
          larkAppSecret: 'sec_auto_op',
          creatorName: 'Alex Chen',
          creatorEmail: 'alex@example.com',
        })
        return { jobId: 'job-op-1', status: 'working', stepMessage: 'working' }
      })
      await manager.startAutoCreateBot({
        mode: 'open_platform',
        name: 'AutoOpBot',
        defaultWorkingDir: validDir,
      })
      await vi.waitFor(() => {
        expect(store.getBot('bot-auto-op')?.adminUsers).toEqual(['ou_auto_alex'])
      })
      expect(store.getBot('bot-auto-op')?.adminUserProfiles).toEqual([
        {
          openId: 'ou_auto_alex',
          name: 'Alex Chen',
          email: 'alex@example.com',
        },
      ])
    } finally {
      fetchProfileSpy.mockRestore()
      resolveEmailSpy.mockRestore()
      resolveSummarySpy.mockRestore()
      startSpy.mockRestore()
      stopSpy.mockRestore()
      await manager.stop()
    }
  })
})
