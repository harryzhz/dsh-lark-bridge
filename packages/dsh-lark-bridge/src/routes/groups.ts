import { assertExistingWorkingDirectory } from '../fs-browser.js'
import { bodyRecord, ok, type LarkRouteDefinition } from './router.js'

export const groupRoutes: readonly LarkRouteDefinition[] = [
  {
    method: 'GET',
    pattern: '/groups',
    policy: 'owner_or_cli',
    handler: ({ manager, url }) => {
      const botId = url.searchParams.get('botId')?.trim() || undefined
      const groups = manager.store.listGroupViews(botId)
      return ok({ ok: true, groups })
    },
  },
  {
    method: 'POST',
    pattern: '/sync-chats',
    policy: 'owner',
    handler: async ({ manager }) => {
      const chats = await manager.syncJoinedChats()
      const groups = manager.store.listGroupViews()
      return ok({ ok: true, syncedCount: chats.length, groups })
    },
  },
  {
    method: 'GET',
    pattern: '/groups/:botId/:chatId/members',
    policy: 'owner_or_cli',
    handler: async ({ manager, url, params }) => {
      const botId = params.botId!
      const chatId = params.chatId!
      const rawQuery = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '')
        .trim()
        .toLowerCase()
      const skipAvatars = url.searchParams.get('includeAvatars') === '0'
      const allMembers = skipAvatars
        ? await manager.listGroupMembers(botId, chatId, { includeAvatars: false })
        : await manager.listGroupMembers(botId, chatId)
      const members = rawQuery
        ? allMembers.filter((m) =>
            [m.name, m.email ?? '', m.openId].some((field) =>
              field.toLowerCase().includes(rawQuery),
            ),
          )
        : allMembers
      return ok({ ok: true, members })
    },
  },
  {
    method: 'PUT',
    pattern: '/groups/:botId/:chatId',
    policy: 'owner',
    handler: async ({ manager, request, params }) => {
      const botId = params.botId!
      const chatId = params.chatId!
      const body = bodyRecord(request.body)
      const existingGroup = manager.store.getGroup(botId, chatId)
      const nextWorkingDir =
        typeof body.workingDir === 'string' ? body.workingDir : existingGroup?.workingDir ?? ''
      const nextEnabled =
        typeof body.enabled === 'boolean' ? body.enabled : existingGroup?.enabled ?? true
      if (nextWorkingDir.trim()) {
        assertExistingWorkingDirectory(nextWorkingDir)
      } else if (nextEnabled) {
        const bot = manager.store.getBot(botId)
        if (bot) {
          assertExistingWorkingDirectory(bot.defaultWorkingDir, '继承的智能体工作目录')
        }
      }
      const saved = manager.store.upsertGroup({ ...body, botId, chatId })
      manager.cancelDisabledTurns?.(botId, chatId)
      await manager.syncGroupWorkspace(botId, chatId)
      manager.sessionViewer?.invalidateAccess()
      return ok({
        ok: true,
        group: saved,
        listenerTemplates: manager.store.listListenerTemplates(),
      })
    },
  },
  {
    method: 'DELETE',
    pattern: '/groups/:botId/:chatId',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const botId = params.botId!
      const chatId = params.chatId!
      const deleted = manager.store.deleteGroup(botId, chatId)
      manager.cancelDisabledTurns?.(botId, chatId)
      manager.sessionViewer?.invalidateAccess()
      return ok({ ok: deleted }, deleted ? 200 : 404)
    },
  },
]
