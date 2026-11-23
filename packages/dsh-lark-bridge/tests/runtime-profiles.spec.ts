import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

const appendPluginRecordMock = vi.fn()
vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return {
    ...actual,
    appendPluginRecord: (...args: unknown[]) => appendPluginRecordMock(...args),
  }
})
import type { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import {
  EXTERNAL_LAUNCH_RECORD_TYPE,
  RuntimeCatalog,
  type RuntimeProfileInput,
  type RuntimeProfileSummary,
} from '../src/runtime-catalog.js'
import { ScheduleNotifier } from '../src/schedule-notifier.js'
import { handleSlashCommand } from '../src/slash-commands.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-bridge-profiles-'))
  tempDirs.push(dir)
  return dir
}

function createFakeSession(agentPreset: string): {
  session: Session
  events: SessionEvent[]
} {
  const events: SessionEvent[] = []
  const session = {
    id: brandString<SessionId>('session-test-1'),
    header: { cwd: '/tmp', agentPreset },
    append(type: string, data: unknown) {
      events.push({ type, data } as SessionEvent)
    },
    snapshotEvents() {
      return [...events]
    },
  } as unknown as Session
  return { session, events }
}

function createRuntimeContext() {
  const profiles = new Map<string, RuntimeProfileSummary>([
    [
      'codex:personal',
      {
        id: 'personal',
        runtimeId: 'codex',
        name: 'personal',
        source: 'discovered',
        cliProfile: 'personal',
      },
    ],
    [
      'agy:demo-proxy',
      {
        id: 'demo-proxy',
        runtimeId: 'agy',
        name: 'Demo Proxy',
        source: 'user',
        configFile: '~/.config/demo-proxy/agy/settings.json',
        env: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787', GEMINI_API_KEY: '' },
        secretEnvKeys: ['GEMINI_API_KEY'],
        authMethodId: 'gemini-api-key',
        defaultModel: 'gemini-4-carbon',
        exposeAsPreset: true,
        presetId: 'agy:demo-proxy',
        providerId: 'agy--demo-proxy-cli',
      },
    ],
  ])

  const externalRuntimes = [
    {
      id: 'codex',
      displayName: 'Codex',
      description: 'Codex CLI',
      providerId: 'codex-cli',
      defaultModel: 'gpt-6.1-sol',
    },
    {
      id: 'agy',
      displayName: 'Antigravity',
      description: 'Antigravity ACP',
      providerId: 'agy-cli',
      defaultModel: 'gemini-4-neon',
    },
  ]

  const exposedPresets = () =>
    [...profiles.values()]
      .filter((p) => p.exposeAsPreset)
      .map((p) => ({
        id: `${p.runtimeId}:${p.id}`,
        parentRuntimeId: p.runtimeId,
        profileId: p.id,
        displayName: `${p.runtimeId} · ${p.name}`,
        description: p.description ?? '',
        providerId: `${p.runtimeId}--${p.id}-cli`,
        defaultModel: p.defaultModel ?? 'gemini-4-carbon',
      }))

  const directory = {
    list: () => externalRuntimes,
    get: (id: string) => externalRuntimes.find((r) => r.id === id),
    listExposedPresets: exposedPresets,
    getProfileCapabilities: (runtimeId: string) =>
      runtimeId === 'agy'
        ? {
            supportsCliProfile: false,
            supportsConfigFile: true,
            configFileHint: '~/.config/.../settings.json',
            supportsEnv: true,
            envHints: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY'],
            supportsArgs: true,
            supportsAuthMethod: true,
            authMethods: [{ id: 'gemini-api-key', name: 'Gemini API Key' }],
            supportsExposeAsPreset: true,
          }
        : {
            supportsCliProfile: true,
            supportsConfigFile: true,
            supportsEnv: true,
            supportsArgs: true,
            supportsAuthMethod: false,
            supportsExposeAsPreset: true,
          },
    listProfiles: (runtimeId?: string) =>
      [...profiles.values()].filter((p) => !runtimeId || p.runtimeId === runtimeId),
    getProfile: (runtimeId: string, profileId: string) =>
      profiles.get(`${runtimeId}:${profileId}`),
    upsertProfile: async (input: RuntimeProfileInput): Promise<RuntimeProfileSummary> => {
      const id = input.id?.trim() || input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const saved: RuntimeProfileSummary = {
        id,
        runtimeId: input.runtimeId,
        name: input.name,
        source: 'user',
        ...(input.description ? { description: input.description } : {}),
        ...(input.cliProfile ? { cliProfile: input.cliProfile } : {}),
        ...(input.configFile ? { configFile: input.configFile } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.authMethodId ? { authMethodId: input.authMethodId } : {}),
        ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
        ...(input.exposeAsPreset
          ? {
              exposeAsPreset: true,
              presetId: `${input.runtimeId}:${id}`,
              providerId: `${input.runtimeId}--${id}-cli`,
            }
          : {}),
      }
      profiles.set(`${input.runtimeId}:${id}`, saved)
      return saved
    },
    deleteProfile: async (runtimeId: string, profileId: string) =>
      profiles.delete(`${runtimeId}:${profileId}`),
    listModelsForProvider: async (providerId: string) =>
      providerId === 'agy-cli'
        ? [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', isDefault: true }]
        : [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', isDefault: true }],
    listModelsForRuntime: async (runtimeId: string, profileId?: string) => {
      if (runtimeId === 'agy' && profileId === 'demo-proxy') {
        return [
          {
            id: 'gemini-4-carbon',
            name: 'Gemini 4 Carbon',
            reasoningEfforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
            isDefault: true,
          },
        ]
      }
      return [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', isDefault: true }]
    },
    probeProfileModels: async (runtimeId: string, profileId?: string) => {
      if (runtimeId === 'agy' && profileId === 'demo-proxy') {
        return [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', isDefault: true }]
      }
      return [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', isDefault: true }]
    },
  }

  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    get(service: string) {
      if (service === 'externalRuntimes') return directory
      if (service === 'agentPresets') {
        return {
          remoteExportList: async () => ({
            presets: [
              { id: 'codex', name: 'Codex', isDefault: true },
              { id: 'agy', name: 'Antigravity', isDefault: false },
              ...exposedPresets().map((e) => ({
                id: e.id,
                name: e.displayName,
                isDefault: false,
              })),
              { id: 'standard', isDefault: false },
            ],
          }),
          mount: vi.fn(),
        }
      }
      return undefined
    },
    llm: {
      listProviders: () => [
        { id: 'codex-cli', name: 'Codex' },
        { id: 'agy-cli', name: 'Antigravity' },
      ],
      listModels: async () => [],
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
  } as unknown as Context

  return { ctx, profiles }
}

describe('RuntimeCatalog, HTTP API, Slash Commands & ScheduleNotifier profile support', () => {
  it('filters exposed profile presets out of base runtime list and writes launch record on mountPreset', async () => {
    const { ctx } = createRuntimeContext()
    const catalog = new RuntimeCatalog(ctx)

    const options = await catalog.list()
    expect(options.map((o) => o.id)).toEqual(['codex', 'agy', 'standard'])
    expect(options.some((o) => o.id === 'agy:demo-proxy')).toBe(false)

    const agyOpt = options.find((o) => o.id === 'agy')
    expect(agyOpt?.supportsProfiles).toBe(true)
    expect(agyOpt?.profiles?.map((p) => p.id)).toEqual(['demo-proxy'])
    expect(agyOpt?.profileCapabilities?.supportsConfigFile).toBe(true)
    expect(catalog.listExposedPresets().map((p) => p.presetId)).toEqual(['agy:demo-proxy'])

    const launch = await catalog.resolveAgentLaunch({
      agentPreset: 'agy',
      runtimeProfileId: 'demo-proxy',
    })
    expect(launch.isExternal).toBe(true)
    expect(launch.runtimeProfileId).toBe('demo-proxy')
    expect(launch.model).toBe('gemini-4-carbon')

    appendPluginRecordMock.mockClear()
    const { session } = createFakeSession('agy')
    await launch.mountPreset(undefined, { session })
    expect(appendPluginRecordMock).toHaveBeenCalledWith(session, EXTERNAL_LAUNCH_RECORD_TYPE, {
      runtimeId: 'agy',
      profileId: 'demo-proxy',
    })
  })

  it('enforces Owner-only access on /runtime-profiles and serves profile CRUD, probe, and per-profile models', async () => {
    const { ctx } = createRuntimeContext()
    const store = new LarkBridgeStore(makeTempDir())
    const runtimes = new RuntimeCatalog(ctx)
    const manager = { store, runtimes } as unknown as LarkBridgeManager

    // CLI Bearer token must be rejected with 403
    const cliDenied = await dispatchLarkApiRequest(ctx, manager, {
      method: 'GET',
      path: '/runtime-profiles',
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliDenied.status).toBe(403)

    // Owner GET /runtimes returns base runtimes + exposedPresets
    const runtimesRes = await dispatchLarkApiRequest(ctx, manager, {
      method: 'GET',
      path: '/runtimes',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(runtimesRes.status).toBe(200)
    const rtPayload = runtimesRes.payload as { runtimes: Array<{ id: string }>; exposedPresets: Array<{ presetId: string }> }
    expect(rtPayload.runtimes.map((r) => r.id)).toEqual(['codex', 'agy', 'standard'])
    expect(rtPayload.exposedPresets.map((p) => p.presetId)).toEqual(['agy:demo-proxy'])

    // Owner POST /runtime-profiles creates profile
    const createRes = await dispatchLarkApiRequest(ctx, manager, {
      method: 'POST',
      path: '/runtime-profiles',
      body: {
        runtimeId: 'codex',
        name: 'Work Env',
        cliProfile: 'work',
        exposeAsPreset: true,
      },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(createRes.status).toBe(201)
    const created = (createRes.payload as { profile: RuntimeProfileSummary }).profile
    expect(created.id).toBe('work-env')
    expect(created.presetId).toBe('codex:work-env')

    // Owner GET /models?runtimeId=agy&profileId=demo-proxy returns profile-specific models
    const modelsRes = await dispatchLarkApiRequest(ctx, manager, {
      method: 'GET',
      path: '/models?runtimeId=agy&profileId=demo-proxy',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(modelsRes.status).toBe(200)
    const modelIds = (modelsRes.payload as { models: Array<{ id: string }> }).models.map((m) => m.id)
    expect(modelIds).toEqual(['gemini-4-carbon'])

    // Owner POST /runtime-profiles/agy/demo-proxy/probe returns probed models
    const probeRes = await dispatchLarkApiRequest(ctx, manager, {
      method: 'POST',
      path: '/runtime-profiles/agy/demo-proxy/probe',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(probeRes.status).toBe(200)
    expect((probeRes.payload as { models: Array<{ id: string }> }).models[0]?.id).toBe('gemini-4-carbon')

    // Owner DELETE /runtime-profiles/codex/work-env removes it
    const delRes = await dispatchLarkApiRequest(ctx, manager, {
      method: 'DELETE',
      path: '/runtime-profiles/codex/work-env',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(delRes.status).toBe(200)
  })

  it('supports /agent <runtime> [profile] and /agent <runtime>:<profile> slash commands', async () => {
    const { ctx } = createRuntimeContext()
    const store = new LarkBridgeStore(makeTempDir())
    const runtimes = new RuntimeCatalog(ctx)
    const bot = store.upsertBot({
      id: 'b1',
      name: 'Bot1',
      larkAppId: 'cli_b1',
      larkAppSecret: 'sec_b1',
      agentPreset: 'codex',
      defaultWorkingDir: '~',
    })

    const replies: string[] = []
    const host = {
      ctx,
      store,
      runtimes,
      unbindRoute: vi.fn().mockResolvedValue(true),
      sessionWebUrl: (sid: string) => `http://127.0.0.1:3880/#session=${sid}`,
      runTurn: vi.fn(),
    }

    await handleSlashCommand(host, {
      bot,
      chatType: 'p2p',
      command: { name: 'agent', args: 'agy demo-proxy' },
      routeKey: 'cli_b1:oc_p2p:p2p',
      workingDir: '/tmp',
      workspaceName: 'tmp',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(store.getBot('b1')?.agentPreset).toBe('agy')
    expect(store.getBot('b1')?.runtimeProfileId).toBe('demo-proxy')
    expect(store.getBot('b1')?.model).toBe('gemini-4-carbon')
    expect(replies[0]).toContain('Demo Proxy')

    await handleSlashCommand(host, {
      bot: store.getBot('b1')!,
      chatType: 'p2p',
      command: { name: 'agent', args: 'codex:personal' },
      routeKey: 'cli_b1:oc_p2p:p2p',
      workingDir: '/tmp',
      workspaceName: 'tmp',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(store.getBot('b1')?.agentPreset).toBe('codex')
    expect(store.getBot('b1')?.runtimeProfileId).toBe('personal')

    await handleSlashCommand(host, {
      bot: store.getBot('b1')!,
      chatType: 'p2p',
      command: { name: 'agent', args: 'codex' },
      routeKey: 'cli_b1:oc_p2p:p2p',
      workingDir: '/tmp',
      workspaceName: 'tmp',
      reply: async (text) => {
        replies.push(text)
      },
    })
    expect(store.getBot('b1')?.runtimeProfileId).toBe('')
  })

  it('attaches launch profile record to blank scheduled sessions matching target runtime', () => {
    const { ctx } = createRuntimeContext()
    const store = new LarkBridgeStore(makeTempDir())
    const bot = store.upsertBot({
      id: 'b1',
      name: 'Bot1',
      larkAppId: 'cli_b1',
      larkAppSecret: 'sec_b1',
      agentPreset: 'agy',
      runtimeProfileId: 'demo-proxy',
      defaultWorkingDir: '~',
    })
    store.upsertScheduleBinding({
      scheduleId: 'sched-1',
      enabled: true,
      targets: [{ botId: bot.id, chatId: 'oc_g1' }],
      deliveryMode: 'chat',
      notifyOn: 'non_empty',
    })

    const notifier = new ScheduleNotifier({
      ctx,
      store,
      workspaces: {} as never,
      sendScheduleMessage: vi.fn(),
    })
    appendPluginRecordMock.mockClear()
    const { session } = createFakeSession('agy')
    notifier.enrichScheduleUserMessage(
      session.id,
      {
        role: 'user',
        source: { kind: 'schedule' },
        content: [{ type: 'text', text: 'schedule_id_json: "sched-1"\nRun check' }],
      } as never,
      session,
    )

    expect(appendPluginRecordMock).toHaveBeenCalledWith(session, EXTERNAL_LAUNCH_RECORD_TYPE, {
      runtimeId: 'agy',
      profileId: 'demo-proxy',
    })
  })
})
