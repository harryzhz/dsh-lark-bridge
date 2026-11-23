import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { LarkPlatformManager } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { ensureCliAuthEndpoint } from '../src/cli-support.js'
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

    await manager.stop()
  })
})
