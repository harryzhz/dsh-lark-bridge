import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkPlatformManager, slugifyBotId } from '../src/open-platform.js'

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
})
