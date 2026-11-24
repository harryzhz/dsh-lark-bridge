import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkPlatformManager, normalizeVisibleSuggest, slugifyBotId } from '../src/open-platform.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-core-op-test-'))
  tempDirs.push(dir)
  return dir
}

function writeFakeSession(dir: string): void {
  writeFileSync(
    join(dir, 'open-platform-session.json'),
    JSON.stringify({
      cookies: [
        {
          name: 'session',
          value: 'mock-session-cookie',
          domain: 'open.feishu.cn',
          path: '/',
          secure: true,
          httpOnly: true,
          hostOnly: false,
        },
      ],
    }),
    'utf8',
  )
}

function makeConsoleHtml(): string {
  return `<!doctype html><html><script>
    window.csrfToken = "mock-csrf-token";
    window.user = {"id":"u_demo_1","name":"Alex Chen","email":"alex@example.com","tenantId":"t_demo","tenantName":"Acme Corp"};
  </script></html>`
}

describe('LarkPlatformManager Open Platform existing apps listing & credential import', () => {
  it('returns unauthenticated empty list when no open-platform session exists', async () => {
    const dir = makeTempDir()
    const fetcher = vi.fn()
    const mgr = new LarkPlatformManager(dir, fetcher as unknown as typeof fetch)

    const res = await mgr.listOpenPlatformApps()
    expect(res).toEqual({ authenticated: false, apps: [] })
    expect(fetcher).not.toHaveBeenCalled()

    await expect(mgr.fetchOpenPlatformAppCredentials('cli_app_1')).rejects.toThrow(
      /尚未登录飞书开放平台/,
    )
  })

  it('lists, normalizes, deduplicates, and prioritizes Open Platform apps with bot ability first', async () => {
    const dir = makeTempDir()
    writeFakeSession(dir)

    const fetcher = vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.endsWith('/app')) {
        return new Response(makeConsoleHtml(), { status: 200 })
      }
      if (target.endsWith('/developers/v1/app/list')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              totalCount: 4,
              apps: [
                {
                  appID: 'cli_nobot',
                  name: 'NoBot Portal',
                  desc: 'Web portal only',
                  avatar: 'https://example.com/nobot.png',
                  ability: ['web_page'],
                  appStatus: 2,
                  updateTime: 3000,
                },
                {
                  appID: 'cli_bot_old',
                  name: 'Old Bot',
                  desc: 'Older assistant',
                  avatar: 'https://example.com/old.png',
                  ability: ['bot'],
                  appStatus: 2,
                  version: '1.0.0',
                  updateTime: 1000,
                },
                {
                  appID: 'cli_bot_new',
                  name: 'Fallback Name',
                  primaryLang: 'zh_cn',
                  i18n: {
                    zh_cn: { name: '研发协作助手', description: '团队研发助手简介' },
                  },
                  avatar: 'https://example.com/new.png',
                  ability: ['bot', 'web_page'],
                  appStatus: 2,
                  version: '1.2.0',
                  role: 1,
                  updateTime: 2500,
                },
                {
                  appID: 'cli_bot_draft',
                  name: 'Draft Bot',
                  desc: '',
                  avatar: 'https://example.com/draft.png',
                  ability: ['bot'],
                  appStatus: 0,
                  updateTime: 4000,
                },
                {
                  appID: 'cli_bot_new',
                  name: 'Duplicate Should Be Ignored',
                  ability: ['bot'],
                  appStatus: 2,
                  updateTime: 9999,
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })

    const mgr = new LarkPlatformManager(dir, fetcher as unknown as typeof fetch)
    const res = await mgr.listOpenPlatformApps()

    expect(res.authenticated).toBe(true)
    expect(res.identity?.userName).toBe('Alex Chen')
    expect(res.apps.map((a) => a.appId)).toEqual([
      'cli_bot_new',
      'cli_bot_old',
      'cli_bot_draft',
      'cli_nobot',
    ])
    expect(res.apps[0]).toMatchObject({
      appId: 'cli_bot_new',
      name: '研发协作助手',
      description: '团队研发助手简介',
      avatarUrl: 'https://example.com/new.png',
      hasBotAbility: true,
      appStatus: 2,
      version: '1.2.0',
    })
  })

  it('fetches app credentials & profile from Open Platform and handles secretRestricted gracefully', async () => {
    const dir = makeTempDir()
    writeFakeSession(dir)

    const fetcher = vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.endsWith('/app')) {
        return new Response(makeConsoleHtml(), { status: 200 })
      }
      if (target.endsWith('/developers/v1/app/cli_ready')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              primaryLang: 'zh_cn',
              i18n: { zh_cn: { name: '发布值班机器人', description: '自动响应发布告警' } },
              avatar: 'https://example.com/oncall.png',
              ability: ['bot'],
              secretRestricted: false,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (target.endsWith('/developers/v1/secret/cli_ready')) {
        return new Response(
          JSON.stringify({ code: 0, data: { secret: 'mock_secret_value' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (target.endsWith('/developers/v1/app/cli_locked')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { name: 'Locked App', ability: ['bot'], secretRestricted: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (target.endsWith('/developers/v1/secret/cli_locked')) {
        return new Response(
          JSON.stringify({ code: 10003, msg: 'permission denied' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })

    const mgr = new LarkPlatformManager(dir, fetcher as unknown as typeof fetch)

    const creds = await mgr.fetchOpenPlatformAppCredentials('cli_ready')
    expect(creds).toEqual({
      appId: 'cli_ready',
      appSecret: 'mock_secret_value',
      name: '发布值班机器人',
      description: '自动响应发布告警',
      avatarUrl: 'https://example.com/oncall.png',
      hasBotAbility: true,
    })

    const profile = await mgr.fetchBotAppProfile('cli_ready')
    expect(profile).toEqual({
      name: '发布值班机器人',
      description: '自动响应发布告警',
      avatarUrl: 'https://example.com/oncall.png',
    })

    await expect(mgr.fetchOpenPlatformAppCredentials('cli_locked')).rejects.toThrow(
      /密钥查看限制/,
    )
    expect(slugifyBotId('研发助手', 'cli_ab12cd34')).toBe('bot-ab12cd')
    expect(slugifyBotId('Release Bot', 'cli_ab12cd34')).toBe('release-bot')
  })

  it('normalizes visible/online rich objects into string ID arrays when syncBotBaseInfo creates a new app version', async () => {
    expect(
      normalizeVisibleSuggest({
        Head: { RespFormat: 0 },
        departments: [{ id: 'dept_1', name: 'Engineering' }, 'dept_1', 'dept_2'],
        members: [{ id: 'u_1001', name: 'Alex', avatar: 'https://example.com/a.png' }, { id: 'u_1002' }],
        groups: [{ groupId: 'grp_9', name: 'Core' }],
        isAll: 0,
      }),
    ).toEqual({
      departments: ['dept_1', 'dept_2'],
      members: ['u_1001', 'u_1002'],
      groups: ['grp_9'],
      isAll: 0,
    })
    expect(normalizeVisibleSuggest({ Head: { RespFormat: 0 } })).toBeUndefined()

    const dir = makeTempDir()
    writeFakeSession(dir)

    const postedBodies = new Map<string, Record<string, unknown>>()
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      const pathname = new URL(target).pathname
      if (init?.method === 'POST' && typeof init.body === 'string' && init.body) {
        postedBodies.set(pathname, JSON.parse(init.body) as Record<string, unknown>)
      }
      if (pathname === '/app') {
        return new Response(makeConsoleHtml(), { status: 200 })
      }
      if (pathname === '/developers/v1/app/cli_demo_sync') {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              primaryLang: 'zh_cn',
              langs: ['zh_cn'],
              name: 'Old Name',
              desc: 'Old desc',
              avatar: 'https://example.com/icon.png',
              i18n: { zh_cn: { name: 'Old Name', description: 'Old desc' } },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/visible/online/cli_demo_sync') {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              Head: { RespFormat: 0 },
              whiteList: {
                departments: [{ id: 'dept_a', name: 'Platform' }],
                members: [
                  {
                    id: '6900000000000000001',
                    name: 'Alex Chen',
                    avatar: 'https://example.com/u1.png',
                    displayName: { value: 'Alex Chen' },
                  },
                ],
                groups: [{ id: 'grp_a', name: 'Beta' }],
                isAll: 0,
              },
              blackList: {
                departments: [],
                members: [{ id: '6900000000000000002', name: 'Blocked User' }],
                groups: [],
                isAll: 0,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/base_info/cli_demo_sync') {
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (pathname === '/developers/v1/app_version/list/cli_demo_sync') {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              versions: [{ versionId: 'ver_1', appVersion: '1.0.9', versionStatus: 2 }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/app_version/create/cli_demo_sync') {
        return new Response(
          JSON.stringify({ code: 0, data: { versionId: 'ver_2' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/publish/commit/cli_demo_sync/ver_2') {
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const mgr = new LarkPlatformManager(dir, fetcher as unknown as typeof fetch)
    const res = await mgr.syncBotBaseInfo('cli_demo_sync', {
      name: 'New Bot Name',
      description: 'Updated description',
    })

    expect(res).toEqual({ synced: true })
    expect(postedBodies.get('/developers/v1/app_version/create/cli_demo_sync')).toMatchObject({
      appVersion: '1.0.10',
      visibleSuggest: {
        departments: ['dept_a'],
        members: ['6900000000000000001'],
        groups: ['grp_a'],
        isAll: 0,
      },
      blackVisibleSuggest: {
        departments: [],
        members: ['6900000000000000002'],
        groups: [],
        isAll: 0,
      },
    })
    expect(postedBodies.has('/developers/v1/publish/commit/cli_demo_sync/ver_2')).toBe(true)
  })

  it('idempotently syncs missing baseline events & publishes a patch version, and skips publish when already complete', async () => {
    const dir = makeTempDir()
    writeFakeSession(dir)

    let currentEvents = [
      'im.message.receive_v1',
      'im.chat.member.bot.added_v1',
      'im.chat.member.bot.deleted_v1',
      'im.message.reaction.created_v1',
      'im.message.reaction.deleted_v1',
    ]
    let currentCallbacks = ['card.action.trigger']
    const postedBodies: Array<{ pathname: string; body: Record<string, unknown> }> = []

    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname
      const body =
        init?.method === 'POST' && typeof init.body === 'string' && init.body
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {}
      if (init?.method === 'POST') {
        postedBodies.push({ pathname, body })
      }
      if (pathname === '/app') {
        return new Response(makeConsoleHtml(), { status: 200 })
      }
      if (pathname === '/developers/v1/event/cli_existing_1') {
        return new Response(
          JSON.stringify({ code: 0, data: { eventMode: 4, events: currentEvents } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/callback/cli_existing_1') {
        return new Response(
          JSON.stringify({ code: 0, data: { callbackMode: 4, callbacks: currentCallbacks } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/event/update/cli_existing_1') {
        const added = Array.isArray(body.appEvents) ? (body.appEvents as string[]) : []
        currentEvents = [...new Set([...currentEvents, ...added])]
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (pathname === '/developers/v1/visible/online/cli_existing_1') {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              whiteList: { departments: [], members: [{ id: 'u_demo_1' }], groups: [], isAll: 0 },
              blackList: { departments: [], members: [], groups: [], isAll: 0 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/app_version/list/cli_existing_1') {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { versions: [{ appVersion: '1.0.2', versionId: 'ver_old', versionStatus: 2 }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/app_version/create/cli_existing_1') {
        return new Response(
          JSON.stringify({ code: 0, data: { versionId: 'ver_next_3' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (pathname === '/developers/v1/publish/commit/cli_existing_1/ver_next_3') {
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const mgr = new LarkPlatformManager(dir, fetcher as unknown as typeof fetch)

    // 1. Missing im.message.recalled_v1 -> adds only missing event and publishes 1.0.3
    const first = await mgr.syncAppBaselineEvents('cli_existing_1')
    expect(first).toEqual({
      synced: true,
      addedEvents: ['im.message.recalled_v1'],
      addedCallbacks: [],
      version: '1.0.3',
    })
    const eventUpdate = postedBodies.find((p) => p.pathname === '/developers/v1/event/update/cli_existing_1')
    expect(eventUpdate?.body).toMatchObject({
      operation: 'add',
      appEvents: ['im.message.recalled_v1'],
      eventMode: 4,
    })
    expect(postedBodies.some((p) => p.pathname === '/developers/v1/publish/commit/cli_existing_1/ver_next_3')).toBe(
      true,
    )

    // 2. Second run when already subscribed -> idempotently skips update & publish
    postedBodies.length = 0
    const second = await mgr.syncAppBaselineEvents('cli_existing_1')
    expect(second).toEqual({
      synced: true,
      skipped: true,
      addedEvents: [],
      addedCallbacks: [],
    })
    expect(postedBodies.some((p) => p.pathname.includes('/event/update/'))).toBe(false)
    expect(postedBodies.some((p) => p.pathname.includes('/app_version/create/'))).toBe(false)
  })
})
