import {
  buildDefaultNewBotSettings,
  resolveEffectiveWorkspaceName,
  toPublicBotView,
} from '@dsh-lark/lark-core'
import { assertExistingWorkingDirectory } from '../fs-browser.js'
import type { GeneratePromptInput, PromptGenerationTarget } from '../prompt-generator-service.js'
import { bodyRecord, ok, type LarkRouteDefinition } from './router.js'

export const botRoutes: readonly LarkRouteDefinition[] = [
  // ── Listener Templates ─────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/listener-templates',
    policy: 'owner_or_cli',
    handler: ({ manager }) => ok({ ok: true, templates: manager.store.listListenerTemplates() }),
  },
  {
    method: 'POST',
    pattern: '/listener-templates',
    policy: 'owner',
    handler: ({ manager }) => ok({ ok: true, templates: manager.store.resetListenerTemplates() }),
  },

  // ── AI-Assisted Role / Listener Prompt Generation ──────────────────────
  {
    method: 'POST',
    pattern: '/generate-prompt',
    policy: 'owner',
    handler: async ({ manager, request }) => {
      if (typeof manager.generatePrompt !== 'function') {
        return ok({ ok: false, error: 'prompt_generator_unavailable' }, 503)
      }
      const body = bodyRecord(request.body)
      const kind = body.kind === 'role' || body.kind === 'listener' ? body.kind : undefined
      if (!kind) {
        return ok({ ok: false, error: 'kind must be "role" or "listener"' }, 400)
      }
      const description = typeof body.description === 'string' ? body.description.trim() : ''
      if (!description) {
        return ok({ ok: false, error: '请先输入简短的需求描述' }, 400)
      }

      let target: PromptGenerationTarget = { kind: 'auto' }
      const rawTarget =
        body.target && typeof body.target === 'object' && !Array.isArray(body.target)
          ? (body.target as Record<string, unknown>)
          : undefined
      if (rawTarget?.kind === 'model') {
        const provider = typeof rawTarget.provider === 'string' ? rawTarget.provider.trim() : ''
        const model = typeof rawTarget.model === 'string' ? rawTarget.model.trim() : ''
        target = {
          kind: 'model',
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
        }
      } else if (rawTarget?.kind === 'runtime') {
        const agentPreset =
          typeof rawTarget.agentPreset === 'string' ? rawTarget.agentPreset.trim() : ''
        if (!agentPreset) {
          return ok({ ok: false, error: '请选择有效的 Agent 运行时' }, 400)
        }
        const runtimeProfileId =
          typeof rawTarget.runtimeProfileId === 'string' ? rawTarget.runtimeProfileId.trim() : ''
        const model = typeof rawTarget.model === 'string' ? rawTarget.model.trim() : ''
        const reasoningEffort =
          typeof rawTarget.reasoningEffort === 'string' ? rawTarget.reasoningEffort.trim() : ''
        target = {
          kind: 'runtime',
          agentPreset,
          ...(runtimeProfileId ? { runtimeProfileId } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }
      }

      const rawContext =
        body.context && typeof body.context === 'object' && !Array.isArray(body.context)
          ? (body.context as Record<string, unknown>)
          : undefined
      const roleMode =
        rawContext?.roleMode === 'bot' ||
        rawContext?.roleMode === 'append' ||
        rawContext?.roleMode === 'override'
          ? rawContext.roleMode
          : undefined

      const genInput: GeneratePromptInput = {
        kind,
        description,
        target,
        ...(typeof body.botId === 'string' && body.botId.trim() ? { botId: body.botId.trim() } : {}),
        ...(typeof body.chatId === 'string' && body.chatId.trim()
          ? { chatId: body.chatId.trim() }
          : {}),
        ...(rawContext
          ? {
              context: {
                ...(typeof rawContext.botName === 'string' ? { botName: rawContext.botName } : {}),
                ...(typeof rawContext.botDescription === 'string'
                  ? { botDescription: rawContext.botDescription }
                  : {}),
                ...(typeof rawContext.chatName === 'string' ? { chatName: rawContext.chatName } : {}),
                ...(roleMode ? { roleMode } : {}),
                ...(typeof rawContext.baseRoleName === 'string'
                  ? { baseRoleName: rawContext.baseRoleName }
                  : {}),
                ...(typeof rawContext.baseRolePrompt === 'string'
                  ? { baseRolePrompt: rawContext.baseRolePrompt }
                  : {}),
                ...(typeof rawContext.currentName === 'string'
                  ? { currentName: rawContext.currentName }
                  : {}),
                ...(typeof rawContext.currentPrompt === 'string'
                  ? { currentPrompt: rawContext.currentPrompt }
                  : {}),
              },
            }
          : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      }

      const generated = await manager.generatePrompt(genInput)
      return ok({ ok: true, ...generated })
    },
  },

  // ── Bots & Auto-Create / Import ────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/bots',
    policy: 'owner_or_cli',
    handler: async ({ manager }) => {
      await Promise.all(
        manager.store.listBots().map(async (bot) => {
          if (bot.enabled && (!bot.avatarUrl.trim() || !bot.description.trim())) {
            await manager.ensureBotProfileHydrated?.(bot.id)
          }
        }),
      )
      const statuses = new Map(manager.listBotStatuses().map((s) => [s.botId, s]))
      const memoryCounts = manager.memory?.countActiveByBot?.() ?? new Map<string, number>()
      const bots = await Promise.all(
        manager.store.listBots().map(async (bot) => {
          const allowedUserProfiles =
            typeof manager.hydrateAllowedUserProfiles === 'function'
              ? await manager.hydrateAllowedUserProfiles(bot)
              : bot.allowedUserProfiles
          const adminUserProfiles =
            typeof manager.hydrateAdminUserProfiles === 'function'
              ? await manager.hydrateAdminUserProfiles(bot)
              : bot.adminUserProfiles
          const refreshed = manager.store.getBot(bot.id) ?? bot
          const rawDreamState = manager.store.getDreamState?.(refreshed.id)
          const lastDreamSession = rawDreamState?.lastSessionId
            ? manager.store
                .listDreamSessions?.()
                .find((s) => s.sessionId === rawDreamState.lastSessionId)
            : undefined
          const dreamState = rawDreamState
            ? {
                ...rawDreamState,
                ...(lastDreamSession?.proactiveStats
                  ? {
                      proactiveStats: lastDreamSession.proactiveStats,
                      backlogRemaining: lastDreamSession.proactiveStats.backlogRemaining,
                    }
                  : {}),
              }
            : undefined
          return {
            ...toPublicBotView(refreshed),
            allowedUserProfiles,
            adminUserProfiles,
            avatarUrl: statuses.get(refreshed.id)?.avatarUrl || refreshed.avatarUrl || '',
            effectiveWorkspaceName:
              typeof manager.store.resolveBotWorkspaceName === 'function'
                ? manager.store.resolveBotWorkspaceName(refreshed)
                : resolveEffectiveWorkspaceName(refreshed),
            configuredGroupCount: manager.store.listGroups(refreshed.id).length,
            activeMemoryCount: memoryCounts.get(refreshed.id) ?? 0,
            status: statuses.get(refreshed.id),
            ...(dreamState ? { dreamState } : {}),
          }
        }),
      )
      return ok({ ok: true, bots })
    },
  },
  {
    method: 'POST',
    pattern: '/bots/auto-create',
    policy: 'owner',
    handler: async ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const job = await manager.startAutoCreateBot(body)
      return ok({ ok: true, job })
    },
  },
  {
    method: 'POST',
    pattern: '/bots/import-existing',
    policy: 'owner',
    handler: async ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const { bot: saved, eventSync } = await manager.importExistingOpenPlatformBot(body)
      return ok({ ok: true, bot: toPublicBotView(saved), ...(eventSync ? { eventSync } : {}) }, 201)
    },
  },
  {
    method: 'POST',
    pattern: '/bots',
    policy: 'owner',
    handler: async ({ manager, request }) => {
      const body = bodyRecord(request.body)
      assertExistingWorkingDirectory(
        typeof body.defaultWorkingDir === 'string' ? body.defaultWorkingDir : '',
      )
      const requestedId = typeof body.id === 'string' ? body.id.trim() : ''
      const existedBefore = Boolean(requestedId && manager.store.getBot(requestedId))
      let createPayload: Record<string, unknown> = body
      if (!existedBefore) {
        const availableRuntimes = await manager.runtimes.list().catch(() => [])
        const availableRuntimeIds = availableRuntimes.filter((r) => !r.broken).map((r) => r.id)
        const preset = typeof body.agentPreset === 'string' ? body.agentPreset.trim() : undefined
        const profileId =
          typeof body.runtimeProfileId === 'string' ? body.runtimeProfileId.trim() : undefined
        const defaults = buildDefaultNewBotSettings({
          availableRuntimeIds,
          ...(preset ? { defaultAgentPreset: preset } : {}),
          ...(profileId ? { defaultProfileId: profileId } : {}),
        })
        createPayload = {
          ...defaults,
          ...body,
          ...(body.router && typeof body.router === 'object' && !Array.isArray(body.router)
            ? { router: { ...defaults.router, ...(body.router as Record<string, unknown>) } }
            : {}),
          ...(body.experimental &&
          typeof body.experimental === 'object' &&
          !Array.isArray(body.experimental)
            ? {
                experimental: {
                  ...defaults.experimental,
                  ...(body.experimental as Record<string, unknown>),
                  ...(typeof (body.experimental as Record<string, unknown>).dreaming === 'object' &&
                  (body.experimental as Record<string, unknown>).dreaming !== null &&
                  !Array.isArray((body.experimental as Record<string, unknown>).dreaming)
                    ? {
                        dreaming: {
                          ...defaults.experimental.dreaming,
                          ...((body.experimental as Record<string, unknown>).dreaming as Record<
                            string,
                            unknown
                          >),
                        },
                      }
                    : {}),
                  ...(typeof (body.experimental as Record<string, unknown>).proactive === 'object' &&
                  (body.experimental as Record<string, unknown>).proactive !== null &&
                  !Array.isArray((body.experimental as Record<string, unknown>).proactive)
                    ? {
                        proactive: {
                          ...defaults.experimental.proactive,
                          ...((body.experimental as Record<string, unknown>).proactive as Record<
                            string,
                            unknown
                          >),
                        },
                      }
                    : {}),
                },
              }
            : {}),
        }
      }
      const saved = manager.store.upsertBot(createPayload)
      const hasManualDescription = Boolean(saved.description.trim())
      const platformSync = hasManualDescription
        ? await manager.platform.syncBotBaseInfo(saved.larkAppId, {
            name: saved.name,
            description: saved.description,
          })
        : undefined
      await manager.syncBot(saved.id, {
        preserveLocalDescription: hasManualDescription && !platformSync?.synced,
      })
      if (!saved.description.trim() || !saved.avatarUrl.trim()) {
        await manager.ensureBotProfileHydrated?.(saved.id)
      }
      if (!existedBefore && saved.adminUsers.length === 0) {
        await manager.ensureDefaultCreatorAdmin?.(saved.id)
      }
      const refreshed = manager.store.getBot(saved.id) ?? saved
      manager.sessionViewer?.invalidateAccess()
      return ok(
        {
          ok: true,
          bot: toPublicBotView(refreshed),
          ...(platformSync ? { platformSync } : {}),
        },
        201,
      )
    },
  },
  {
    method: 'PUT',
    pattern: '/bots/:botId',
    policy: 'owner',
    handler: async ({ manager, request, params }) => {
      const botId = params.botId!
      const prev = manager.store.getBot(botId)
      const body = bodyRecord(request.body)
      const nextDefaultDir =
        typeof body.defaultWorkingDir === 'string'
          ? body.defaultWorkingDir
          : prev?.defaultWorkingDir
      assertExistingWorkingDirectory(nextDefaultDir ?? '')
      const saved = manager.store.upsertBot({ ...body, id: botId })
      const descChanged = !prev || prev.description !== saved.description
      const profileChanged = !prev || prev.name !== saved.name || descChanged
      const platformSync = profileChanged
        ? await manager.platform.syncBotBaseInfo(saved.larkAppId, {
            name: saved.name,
            description: saved.description,
          })
        : undefined
      await manager.syncBot(saved.id, {
        preserveLocalDescription:
          descChanged && Boolean(saved.description.trim()) && !platformSync?.synced,
      })
      manager.sessionViewer?.invalidateAccess()
      const refreshed = manager.store.getBot(saved.id) ?? saved
      return ok({
        ok: true,
        bot: toPublicBotView(refreshed),
        ...(platformSync ? { platformSync } : {}),
      })
    },
  },
  {
    method: 'DELETE',
    pattern: '/bots/:botId',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const botId = params.botId!
      const existed = manager.store.deleteBot(botId)
      await manager.syncBot(botId)
      manager.sessionViewer?.invalidateAccess()
      return ok({ ok: existed }, existed ? 200 : 404)
    },
  },
  {
    method: 'POST',
    pattern: '/bots/:botId/toggle',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const botId = params.botId!
      const bot = manager.store.getBot(botId)
      if (!bot) {
        return ok({ ok: false, error: 'bot_not_found' }, 404)
      }
      if (!bot.enabled) {
        assertExistingWorkingDirectory(bot.defaultWorkingDir)
      }
      const updated = manager.store.upsertBot({ ...bot, enabled: !bot.enabled })
      await manager.syncBot(updated.id)
      manager.sessionViewer?.invalidateAccess()
      return ok({ ok: true, bot: toPublicBotView(updated) })
    },
  },
  {
    method: 'POST',
    pattern: '/bots/:botId/reconnect',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const botId = params.botId!
      const bot = manager.store.getBot(botId)
      if (!bot) {
        return ok({ ok: false, error: 'bot_not_found' }, 404)
      }
      if (bot.enabled) {
        assertExistingWorkingDirectory(bot.defaultWorkingDir)
      }
      await manager.syncBot(bot.id)
      return ok({ ok: true })
    },
  },
  {
    method: 'POST',
    pattern: '/bots/:botId/sync-profile',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const profile = await manager.syncBotProfile(params.botId!)
      if (!profile) {
        return ok({ ok: false, error: 'bot_not_found' }, 404)
      }
      return ok({ ok: true, profile })
    },
  },
  {
    method: 'POST',
    pattern: '/bots/:botId/sync-chats',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const chats = await manager.syncJoinedChats(params.botId!)
      return ok({ ok: true, count: chats.length })
    },
  },
  {
    method: 'POST',
    pattern: '/bots/:botId/dream',
    policy: 'owner',
    handler: async ({ manager, request, params }) => {
      const botId = params.botId!
      const bot = manager.store.getBot(botId)
      if (!bot) {
        return ok({ ok: false, error: 'bot_not_found' }, 404)
      }
      if (!manager.dreaming) {
        return ok({ ok: false, error: 'dreaming_service_unavailable' }, 400)
      }
      const body = bodyRecord(request.body) as { force?: boolean; includeRuleReflection?: boolean }
      const dreamState = await manager.dreaming.runForBot(botId, {
        force: body.force !== false,
        ...(body.includeRuleReflection !== undefined
          ? { includeRuleReflection: Boolean(body.includeRuleReflection) }
          : {}),
      })
      return ok({ ok: true, dreamState })
    },
  },
  {
    method: 'GET',
    pattern: '/bots/:botId/users/search',
    policy: 'owner_or_cli',
    handler: async ({ manager, url, params }) => {
      const q = url.searchParams.get('q') ?? ''
      const users = await manager.searchUsers(params.botId!, q)
      return ok({ ok: true, users })
    },
  },
]
