import { ok, type LarkRouteDefinition } from './router.js'

export const authRoutes: readonly LarkRouteDefinition[] = [
  {
    method: 'GET',
    pattern: '/auth/status',
    policy: 'owner',
    handler: async ({ manager }) => {
      const openPlatform = await manager.platform.inspectOpenPlatformSession()
      const userAuth = manager.platform.listUserAuthStatuses(
        manager.store.listBots().map((b) => b.id),
      )
      return ok({ ok: true, openPlatform, userAuth })
    },
  },
  {
    method: 'POST',
    pattern: '/auth/open-platform/login',
    policy: 'owner',
    handler: ({ manager }) => {
      const job = manager.platform.startOpenPlatformQrLogin()
      return ok({ ok: true, job })
    },
  },
  {
    method: 'POST',
    pattern: '/auth/open-platform/logout',
    policy: 'owner',
    handler: ({ manager }) => {
      manager.platform.logoutOpenPlatform()
      return ok({ ok: true })
    },
  },
  {
    method: 'GET',
    pattern: '/auth/open-platform/apps',
    policy: 'owner',
    handler: async ({ manager }) => {
      const result = await manager.platform.listOpenPlatformApps()
      const byAppId = new Map(manager.store.listBots().map((b) => [b.larkAppId, b]))
      const apps = result.apps.map((app) => {
        const existing = byAppId.get(app.appId)
        return {
          ...app,
          alreadyConnected: Boolean(existing),
          ...(existing ? { connectedBotId: existing.id, connectedBotName: existing.name } : {}),
        }
      })
      return ok({
        ok: true,
        authenticated: result.authenticated,
        ...(result.identity ? { identity: result.identity } : {}),
        apps,
      })
    },
  },
  {
    method: 'POST',
    pattern: '/auth/user/:botId/login',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const bot = manager.store.getBot(params.botId!)
      if (!bot) {
        return ok({ ok: false, error: 'bot_not_found' }, 404)
      }
      const job = manager.platform.startUserOAuthLogin(bot.id, bot.larkAppId, bot.larkAppSecret)
      return ok({ ok: true, job })
    },
  },
  {
    method: 'DELETE',
    pattern: '/auth/user/:botId',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const deleted = manager.platform.revokeUserOAuth(params.botId!)
      return ok({ ok: true, deleted })
    },
  },
  {
    method: 'GET',
    pattern: '/auth/jobs/:jobId',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const job = manager.platform.getJob(params.jobId!)
      if (!job) {
        return ok({ ok: false, error: 'job_not_found' }, 404)
      }
      return ok({ ok: true, job })
    },
  },
]
