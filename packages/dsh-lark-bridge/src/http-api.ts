import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { resolveEffectiveWorkspaceName, toPublicBotView } from '@dsh-lark/lark-core'
import type { AgentCliSendInput, LarkBridgeManager } from './bridge-manager.js'
import { OPERATOR_TOKEN_HEADER } from './cli-support.js'
import {
  assertExistingWorkingDirectory,
  browseHostDirectories,
  createHostSubdirectory,
} from './fs-browser.js'
import type { CreateReminderInput, UpdateReminderInput } from './reminder-service.js'
import { dispatchMemoryApiRequest } from './http-memory-routes.js'
import type { RuntimeProfileInput } from './runtime-catalog.js'
import type { ScheduleCreateInputLike } from './schedule-notifier.js'
import {
  LARK_SESSION_OPEN_PATH,
  handleSessionOpen,
  type LoopbackConnectionAuth,
} from './session-handoff.js'
import { LARK_VIEW_RPC_PATH, LARK_VIEW_STREAM_PATH } from './session-viewer.js'
import type { LarkScheduleDeliveryMode, LarkScheduleNotifyOn } from './types.js'

export interface ConnectionAdmitter extends LoopbackConnectionAuth {
  admit(req: IncomingMessage): { peer: unknown } | { rejection: 401 | 403 }
}

/** Shared `/api` exact Fetch route used by Web and Desktop UI clients via `ctx.connection.rpc`. */
export const LARK_BRIDGE_RPC_ENDPOINT = 'lark-bridge-rpc'
export const LARK_BRIDGE_RPC_PATH = `/api/${LARK_BRIDGE_RPC_ENDPOINT}`

export interface LarkApiRequest {
  readonly method: string
  /** Route relative to `/api/lark-bridge`, e.g. `/bots` or `/events?limit=120`. */
  readonly path: string
  readonly body?: unknown
  readonly isCliAuthenticated: boolean
  readonly isOperatorAuthenticated?: boolean
  readonly principalKind: string
  readonly signal?: AbortSignal
}

export interface LarkApiResponse {
  readonly status: number
  readonly payload: unknown
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const UPLOAD_MAX_BODY_BYTES = 25 * 1024 * 1024

async function readJsonBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new Error('Request payload too large')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function isSameOriginMutationAllowed(req: IncomingMessage, isCliAuth: boolean): boolean {
  if (isCliAuth) return true
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function ok(payload: unknown, status = 200): LarkApiResponse {
  return { status, payload }
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

/**
 * Transport-agnostic Lark Bridge API dispatcher shared by:
 * 1) `ctx.connection.fetch.register('/api/lark-bridge-rpc')` (Web & Electron Desktop UI)
 * 2) `ctx.webServer.register('/api/lark-bridge')` (`lark-bridge` CLI Bearer auth & direct HTTP)
 */
export async function dispatchLarkApiRequest(
  ctx: Context,
  manager: LarkBridgeManager,
  request: LarkApiRequest,
): Promise<LarkApiResponse> {
  const method = request.method.toUpperCase()
  const rawPath = request.path.startsWith('/') ? request.path : `/${request.path}`
  const url = new URL(rawPath, 'http://127.0.0.1')
  const pathname = url.pathname.replace(/^\/api\/lark-bridge\/?/, '').replace(/^\/+/, '')
  const segments = pathname ? pathname.split('/').map(decodeURIComponent) : []
  const { isCliAuthenticated, isOperatorAuthenticated, principalKind } = request
  const isOwnerWebSession =
    principalKind === 'owner' && !isCliAuthenticated && !isOperatorAuthenticated

  try {
    if (method === 'GET' && (pathname === '' || pathname === 'health')) {
      const lifecycle = manager.getLifecycleStatus?.()
      return ok({
        ok: true,
        principal: principalKind,
        botCount: manager.store.listBots().length,
        groupCount: manager.store.listGroups().length,
        activeBindings: manager.store.listBindings().length,
        ...(lifecycle ? { phase: lifecycle.phase, draining: lifecycle.draining } : {}),
      })
    }

    // ── Graceful lifecycle / drain control plane ─────────────────────────
    if (segments[0] === 'lifecycle') {
      if (method === 'GET' && segments[1] === 'status') {
        return ok({ ok: true, ...manager.getLifecycleStatus() })
      }
      const canOperateLifecycle =
        (principalKind === 'owner' && !isCliAuthenticated) || Boolean(isOperatorAuthenticated)
      if (method === 'POST' && segments[1] === 'drain') {
        if (!canOperateLifecycle) {
          return ok({ ok: false, error: 'owner_or_operator_required' }, 403)
        }
        const body = bodyRecord(request.body)
        const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined
        const wait = body.wait === true
        const timeoutMs =
          typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
            ? body.timeoutMs
            : undefined
        let status = await manager.beginDrain({ ...(reason ? { reason } : {}) })
        if (wait && !status.drained) {
          status = await manager.waitForDrain(timeoutMs, request.signal)
        }
        return ok({ ok: true, ...status })
      }
      if (method === 'POST' && segments[1] === 'resume-intake') {
        if (!canOperateLifecycle) {
          return ok({ ok: false, error: 'owner_or_operator_required' }, 403)
        }
        const status = await manager.cancelDrain()
        return ok({ ok: true, ...status })
      }
    }

    if (method === 'GET' && (pathname === 'cockpit' || pathname === 'overview')) {
      const statuses = manager.listBotStatuses()
      const cockpit = manager.store.buildCockpit(statuses, (sid) =>
        manager.sessionWebUrl(sid),
      )
      const alerts = manager.getDiagnostics?.().alerts ?? []
      return ok({ ok: true, ...cockpit, alerts })
    }

    if (method === 'GET' && pathname === 'diagnostics') {
      const diagnostics = manager.getDiagnostics()
      return ok(diagnostics)
    }

    if (
      method === 'POST' &&
      segments[0] === 'diagnostics' &&
      segments[1] === 'split-brain' &&
      segments[2] &&
      segments[3] === 'clear'
    ) {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      const cleared = manager.clearSplitBrainAlert(segments[2])
      return ok({ ok: true, cleared })
    }

    // ── Desktop renderer session-open channel (owner-only) ──────────────
    if (segments[0] === 'desktop') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_session_required' }, 403)
      }
      if (method === 'GET' && segments[1] === 'open-wait') {
        const timeoutMs = url.searchParams.get('timeoutMs')
          ? Number(url.searchParams.get('timeoutMs'))
          : undefined
        const command = await manager.sessionHandoff.waitForCommand(timeoutMs, request.signal)
        return ok({ ok: true, command })
      }
      if (method === 'POST' && segments[1] === 'open-ack') {
        const body = bodyRecord(request.body)
        const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
        const opened = body.opened !== false
        const matched = requestId ? manager.sessionHandoff.ackCommand(requestId, opened) : false
        return ok({ ok: true, matched })
      }
    }

    // ── Read-only viewer secret rotation (owner Web/Desktop session only) ─
    if (method === 'POST' && pathname === 'viewer/rotate-secret') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      manager.store.rotateViewerTicketSecret()
      manager.sessionViewer?.invalidateAccess(true)
      return ok({ ok: true })
    }

    // ── Agent CLI endpoints (never expose app secrets or OAuth tokens) ───
    if (segments[0] === 'agent') {
      if (method === 'GET' && segments[1] === 'context') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        return ok({ ok: true, ...manager.resolveAgentContext(sessionId) })
      }
      if (method === 'POST' && segments[1] === 'send') {
        const body = bodyRecord(request.body) as unknown as AgentCliSendInput
        const result = await manager.agentSend(body)
        return ok({ ok: true, ...result })
      }
      if (method === 'POST' && segments[1] === 'silence') {
        const body = bodyRecord(request.body) as { sessionId?: string; reason?: string }
        const result = manager.agentSilenceTurn({
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
          ...(body.reason ? { reason: body.reason } : {}),
        })
        return ok({ ok: true, ...result })
      }
      if (method === 'GET' && segments[1] === 'history') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        const botId = url.searchParams.get('botId') ?? undefined
        const chatId = url.searchParams.get('chatId') ?? undefined
        const threadId = url.searchParams.get('threadId') ?? undefined
        const limit = url.searchParams.get('limit')
          ? Number(url.searchParams.get('limit'))
          : undefined
        const result = await manager.agentHistory({
          ...(sessionId ? { sessionId } : {}),
          ...(botId ? { botId } : {}),
          ...(chatId ? { chatId } : {}),
          ...(threadId ? { threadId } : {}),
          ...(limit && Number.isFinite(limit) ? { limit } : {}),
        })
        return ok({ ok: true, ...result })
      }
      if (method === 'GET' && segments[1] === 'messages' && segments[2]) {
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        const botId = url.searchParams.get('botId') ?? undefined
        const downloadResources = url.searchParams.get('download') === '1'
        const includeRaw = url.searchParams.get('raw') === '1'
        const detail = await manager.agentGetMessage({
          ...(sessionId ? { sessionId } : {}),
          ...(botId ? { botId } : {}),
          messageId: segments[2],
          downloadResources,
          includeRaw,
        })
        if (!detail) {
          return ok({ ok: false, error: 'message_not_found' }, 404)
        }
        return ok({ ok: true, message: detail })
      }
      if (method === 'POST' && segments[1] === 'schedules') {
        const body = bodyRecord(request.body) as {
          sessionId?: string
          title?: string
          prompt?: string
          timing?: ScheduleCreateInputLike['timing']
          cwd?: string
          agentPreset?: string
          botId?: string
          chatId?: string
          deliveryMode?: LarkScheduleDeliveryMode
          notifyOn?: LarkScheduleNotifyOn
        }
        if (!body.title?.trim() || !body.prompt?.trim() || !body.timing) {
          return ok({ ok: false, error: 'title, prompt and timing are required' }, 400)
        }
        const created = await manager.agentCreateSchedule({
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
          title: body.title.trim(),
          prompt: body.prompt.trim(),
          timing: body.timing,
          ...(body.cwd ? { cwd: body.cwd } : {}),
          ...(body.agentPreset ? { agentPreset: body.agentPreset } : {}),
          ...(body.botId ? { botId: body.botId } : {}),
          ...(body.chatId ? { chatId: body.chatId } : {}),
          ...(body.deliveryMode ? { deliveryMode: body.deliveryMode } : {}),
          ...(body.notifyOn ? { notifyOn: body.notifyOn } : {}),
        })
        return ok({ ok: true, ...created }, 201)
      }
    }

    // ── Auth & Open Platform endpoints (owner Web/Desktop session only) ──
    if (segments[0] === 'auth') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      if (method === 'GET' && segments[1] === 'status') {
        const openPlatform = await manager.platform.inspectOpenPlatformSession()
        const userAuth = manager.platform.listUserAuthStatuses(
          manager.store.listBots().map((b) => b.id),
        )
        return ok({ ok: true, openPlatform, userAuth })
      }
      if (method === 'POST' && segments[1] === 'open-platform' && segments[2] === 'login') {
        const job = manager.platform.startOpenPlatformQrLogin()
        return ok({ ok: true, job })
      }
      if (method === 'POST' && segments[1] === 'open-platform' && segments[2] === 'logout') {
        manager.platform.logoutOpenPlatform()
        return ok({ ok: true })
      }
      if (method === 'GET' && segments[1] === 'open-platform' && segments[2] === 'apps') {
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
      }
      if (method === 'POST' && segments[1] === 'user' && segments[2] && segments[3] === 'login') {
        const bot = manager.store.getBot(segments[2])
        if (!bot) {
          return ok({ ok: false, error: 'bot_not_found' }, 404)
        }
        const job = manager.platform.startUserOAuthLogin(bot.id, bot.larkAppId, bot.larkAppSecret)
        return ok({ ok: true, job })
      }
      if (method === 'DELETE' && segments[1] === 'user' && segments[2] && segments.length === 3) {
        const deleted = manager.platform.revokeUserOAuth(segments[2])
        return ok({ ok: true, deleted })
      }
      if (method === 'GET' && segments[1] === 'jobs' && segments[2]) {
        const job = manager.platform.getJob(segments[2])
        if (!job) {
          return ok({ ok: false, error: 'job_not_found' }, 404)
        }
        return ok({ ok: true, job })
      }
    }

    // ── Memory (Runtime-Agnostic Long-Term Memory) ───────────────────────
    if (segments[0] === 'memory') {
      const handled = await dispatchMemoryApiRequest(manager, {
        method,
        segments,
        url,
        body: request.body,
        isCliAuthenticated,
        isOperatorAuthenticated: Boolean(isOperatorAuthenticated),
        principalKind,
      })
      if (handled) return handled
    }

    // ── Listener templates ────────────────────────────────────────────────
    if (pathname === 'listener-templates') {
      if (method === 'GET') {
        return ok({ ok: true, templates: manager.store.listListenerTemplates() })
      }
      if (method === 'POST') {
        return ok({ ok: true, templates: manager.store.resetListenerTemplates() })
      }
    }

    // ── Bots & Auto-create ────────────────────────────────────────────────
    if (method === 'GET' && pathname === 'bots') {
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
          const dreamState = manager.store.getDreamState?.(refreshed.id)
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
    }

    if (method === 'POST' && pathname === 'bots/auto-create') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      const body = bodyRecord(request.body)
      const job = await manager.startAutoCreateBot(body)
      return ok({ ok: true, job })
    }

    if (method === 'POST' && pathname === 'bots/import-existing') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      const body = bodyRecord(request.body)
      const { bot: saved, eventSync } = await manager.importExistingOpenPlatformBot(body)
      return ok({ ok: true, bot: toPublicBotView(saved), ...(eventSync ? { eventSync } : {}) }, 201)
    }

    if (method === 'POST' && pathname === 'bots') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      const body = bodyRecord(request.body)
      assertExistingWorkingDirectory(
        typeof body.defaultWorkingDir === 'string' ? body.defaultWorkingDir : '',
      )
      const saved = manager.store.upsertBot(body)
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
    }

    if (segments[0] === 'bots' && segments[1]) {
      const botId = segments[1]
      if (method === 'PUT' && segments.length === 2) {
        if (!isOwnerWebSession) {
          return ok({ ok: false, error: 'owner_web_session_required' }, 403)
        }
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
      }
      if (method === 'DELETE' && segments.length === 2) {
        if (!isOwnerWebSession) {
          return ok({ ok: false, error: 'owner_web_session_required' }, 403)
        }
        const existed = manager.store.deleteBot(botId)
        await manager.syncBot(botId)
        manager.sessionViewer?.invalidateAccess()
        return ok({ ok: existed }, existed ? 200 : 404)
      }
      if (method === 'POST' && segments[2] === 'toggle') {
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
      }
      if (method === 'POST' && segments[2] === 'reconnect') {
        const bot = manager.store.getBot(botId)
        if (!bot) {
          return ok({ ok: false, error: 'bot_not_found' }, 404)
        }
        if (bot.enabled) {
          assertExistingWorkingDirectory(bot.defaultWorkingDir)
        }
        await manager.syncBot(bot.id)
        return ok({ ok: true })
      }
      if (method === 'POST' && segments[2] === 'sync-profile') {
        const profile = await manager.syncBotProfile(botId)
        if (!profile) {
          return ok({ ok: false, error: 'bot_not_found' }, 404)
        }
        return ok({ ok: true, profile })
      }
      if (method === 'POST' && segments[2] === 'sync-chats') {
        const chats = await manager.syncJoinedChats(botId)
        return ok({ ok: true, count: chats.length })
      }
      if (method === 'POST' && segments[2] === 'dream') {
        if (!isOwnerWebSession) {
          return ok({ ok: false, error: 'owner_web_session_required' }, 403)
        }
        const bot = manager.store.getBot(botId)
        if (!bot) {
          return ok({ ok: false, error: 'bot_not_found' }, 404)
        }
        if (!manager.dreaming) {
          return ok({ ok: false, error: 'dreaming_service_unavailable' }, 400)
        }
        const body = bodyRecord(request.body) as { force?: boolean }
        const dreamState = await manager.dreaming.runForBot(botId, {
          force: body.force !== false,
        })
        return ok({ ok: true, dreamState })
      }
      if (method === 'GET' && segments[2] === 'users' && segments[3] === 'search') {
        const q = url.searchParams.get('q') ?? ''
        const users = await manager.searchUsers(botId, q)
        return ok({ ok: true, users })
      }
    }

    // ── Groups & Group Members ────────────────────────────────────────────
    if (method === 'GET' && pathname === 'groups') {
      const botId = url.searchParams.get('botId')?.trim() || undefined
      const groups = manager.store.listGroupViews(botId)
      return ok({ ok: true, groups })
    }

    if (method === 'POST' && pathname === 'sync-chats') {
      const chats = await manager.syncJoinedChats()
      const groups = manager.store.listGroupViews()
      return ok({ ok: true, syncedCount: chats.length, groups })
    }

    if (segments[0] === 'groups' && segments[1] && segments[2]) {
      const botId = segments[1]
      const chatId = segments[2]
      if (method === 'GET' && segments[3] === 'members' && segments.length === 4) {
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
      }
      if (method === 'PUT' && segments.length === 3) {
        const body = bodyRecord(request.body)
        const existingGroup = manager.store.getGroup(botId, chatId)
        const nextWorkingDir =
          typeof body.workingDir === 'string'
            ? body.workingDir
            : existingGroup?.workingDir ?? ''
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
      }
      if (method === 'DELETE' && segments.length === 3) {
        const deleted = manager.store.deleteGroup(botId, chatId)
        manager.cancelDisabledTurns?.(botId, chatId)
        manager.sessionViewer?.invalidateAccess()
        return ok({ ok: deleted }, deleted ? 200 : 404)
      }
    }

    // ── Sessions & Events ─────────────────────────────────────────────────
    if (method === 'GET' && pathname === 'bindings') {
      const bindings = manager.store.listBindings().map((b) => ({
        ...b,
        sessionUrl: manager.sessionWebUrl(b.sessionId),
      }))
      const dreamSessions = (manager.store.listDreamSessions?.() ?? []).map((s) => ({
        ...s,
        sessionUrl: manager.sessionWebUrl(s.sessionId),
      }))
      const triageSessions = (manager.store.listTriageSessions?.() ?? []).map((s) => ({
        ...s,
        sessionUrl: manager.sessionWebUrl(s.sessionId),
      }))
      return ok({
        ok: true,
        bindings,
        dreamSessions,
        triageSessions,
        archivedSessionIds: manager.listArchivedSessionIds(),
      })
    }

    if (method === 'DELETE' && segments[0] === 'dream-sessions' && segments[1] && segments.length === 2) {
      const sessionId = segments[1]
      const target = manager.store.listDreamSessions?.().find((s) => s.sessionId === sessionId)
      if (target?.status === 'running') {
        return ok({ ok: false, error: 'dream_session_running' }, 400)
      }
      const deleted = manager.store.deleteDreamSession?.(sessionId) ?? false
      return ok({ ok: deleted }, deleted ? 200 : 404)
    }

    if (method === 'DELETE' && pathname === 'triage-sessions') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      const botId = url.searchParams.get('botId')?.trim() || undefined
      const deletedCount = manager.store.clearTriageSessions?.(botId) ?? 0
      return ok({ ok: true, deletedCount })
    }

    if (method === 'DELETE' && segments[0] === 'triage-sessions' && segments[1] && segments.length === 2) {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      const deleted = manager.store.deleteTriageSession?.(segments[1]) ?? false
      return ok({ ok: deleted }, deleted ? 200 : 404)
    }

    if (method === 'POST' && pathname === 'sessions/sweep') {
      const archivedCount = await manager.sweepIdleBindings()
      return ok({ ok: true, archivedCount })
    }

    if (method === 'DELETE' && segments[0] === 'bindings' && segments[1]) {
      const routeKey = segments.slice(1).join('/')
      const deleted = await manager.unbindRoute(routeKey, { archive: true })
      return ok({ ok: deleted }, deleted ? 200 : 404)
    }

    if (method === 'GET' && pathname === 'events') {
      const traceId = url.searchParams.get('traceId')?.trim()
      if (traceId) {
        return ok({ ok: true, events: manager.store.listEventsByTrace(traceId) })
      }
      const limit = Number(url.searchParams.get('limit') ?? 100)
      return ok({ ok: true, events: manager.store.listEvents(limit) })
    }

    // ── Schedules ─────────────────────────────────────────────────────────
    if (method === 'GET' && pathname === 'schedules') {
      const payload = await manager.schedules.listViews()
      return ok({ ok: true, ...payload })
    }

    if (segments[0] === 'schedules' && segments[1]) {
      const scheduleId = segments[1]
      if (method === 'PUT' && segments.length === 2) {
        const body = bodyRecord(request.body)
        const saved = manager.store.upsertScheduleBinding({ ...body, scheduleId })
        void manager.schedules.refreshScheduleContextCache()
        return ok({ ok: true, binding: saved })
      }
      if (method === 'DELETE' && segments.length === 2) {
        const deleted = manager.store.deleteScheduleBinding(scheduleId)
        return ok({ ok: true, deleted })
      }
      if (method === 'POST' && segments[2] === 'run' && segments.length === 3) {
        const runRes = await manager.schedules.runNow(scheduleId)
        return ok(runRes, runRes.ok ? 200 : 400)
      }
    }

    // ── Proactive One-Shot Reminders (Web/Desktop Owner + CLI) ────────────
    if (pathname === 'reminders') {
      if (method === 'GET') {
        const rawFilter = url.searchParams.get('status')
        const filter =
          rawFilter === 'active' || rawFilter === 'archived' ? rawFilter : 'all'
        return ok({ ok: true, reminders: manager.store.listReminders(filter) })
      }
      if (method === 'POST') {
        if (!manager.reminders) {
          return ok({ ok: false, error: 'reminder_service_unavailable' }, 400)
        }
        const body = bodyRecord(request.body) as unknown as CreateReminderInput
        const item = await manager.reminders.create(body)
        return ok({ ok: true, reminder: item }, 201)
      }
    }

    if (segments[0] === 'reminders' && segments[1]) {
      const reminderId = segments[1]
      if (method === 'PUT' && segments.length === 2) {
        if (!manager.reminders) {
          return ok({ ok: false, error: 'reminder_service_unavailable' }, 400)
        }
        const body = bodyRecord(request.body) as unknown as UpdateReminderInput
        const updated = manager.reminders.update(reminderId, body)
        return ok({ ok: true, reminder: updated })
      }
      if (method === 'POST' && segments[2] === 'approve' && segments.length === 3) {
        if (!isOwnerWebSession) {
          return ok({ ok: false, error: 'owner_web_session_required' }, 403)
        }
        const approved = await manager.reminders.approve(reminderId)
        return ok({ ok: true, reminder: approved })
      }
      if (method === 'POST' && segments[2] === 'cancel' && segments.length === 3) {
        const cancelled = await manager.reminders.cancel(reminderId, 'cancelled')
        return ok({ ok: true, reminder: cancelled })
      }
      if (method === 'POST' && segments[2] === 'run' && segments.length === 3) {
        const body = bodyRecord(request.body) as { async?: boolean }
        const reminder =
          body.async === true && typeof manager.reminders.triggerNow === 'function'
            ? await manager.reminders.triggerNow(reminderId)
            : await manager.reminders.runNow(reminderId)
        return ok({ ok: true, reminder })
      }
      if (method === 'DELETE' && segments.length === 2) {
        const deleted = manager.store.deleteReminder(reminderId)
        return ok({ ok: deleted }, deleted ? 200 : 404)
      }
    }

    // ── Local Directory Browser (Owner Web/Desktop session strictly required) ─
    if (pathname === 'fs/dirs') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      if (method === 'GET') {
        const rawPath = url.searchParams.get('path') ?? undefined
        const listing = await browseHostDirectories(ctx, rawPath)
        return ok({ ok: true, ...listing })
      }
      if (method === 'POST') {
        const body = bodyRecord(request.body) as { parentPath?: string; name?: string }
        const createdPath = await createHostSubdirectory(
          ctx,
          body.parentPath ?? '',
          body.name ?? '',
        )
        return ok({ ok: true, path: createdPath }, 201)
      }
    }

    // ── Runtime Profiles (Owner Web/Desktop session strictly required) ────
    if (segments[0] === 'runtime-profiles') {
      if (!isOwnerWebSession) {
        return ok({ ok: false, error: 'owner_web_session_required' }, 403)
      }
      if (method === 'GET' && segments.length === 1) {
        const runtimeId = url.searchParams.get('runtimeId')?.trim() || undefined
        return ok({
          ok: true,
          supported: manager.runtimes.supportsProfiles(),
          profiles: manager.runtimes.listProfiles(runtimeId),
        })
      }
      if (method === 'POST' && segments.length === 1) {
        const body = bodyRecord(request.body) as unknown as Partial<RuntimeProfileInput>
        if (typeof body.runtimeId !== 'string' || !body.runtimeId.trim()) {
          return ok({ ok: false, error: 'runtimeId is required' }, 400)
        }
        if (typeof body.name !== 'string' || !body.name.trim()) {
          return ok({ ok: false, error: 'name is required' }, 400)
        }
        const profile = await manager.runtimes.upsertProfile({
          ...body,
          runtimeId: body.runtimeId.trim(),
          name: body.name.trim(),
        })
        return ok({ ok: true, profile }, 201)
      }
      if (segments[1] && segments[2]) {
        const runtimeId = segments[1]
        const profileId = segments[2]
        if (method === 'PUT' && segments.length === 3) {
          const body = bodyRecord(request.body) as unknown as Partial<RuntimeProfileInput>
          const existing = manager.runtimes.getProfile(runtimeId, profileId)
          const resolvedName =
            typeof body.name === 'string' && body.name.trim()
              ? body.name.trim()
              : existing?.name || profileId
          const profile = await manager.runtimes.upsertProfile({
            ...body,
            id: profileId,
            runtimeId,
            name: resolvedName,
          })
          return ok({ ok: true, profile })
        }
        if (method === 'DELETE' && segments.length === 3) {
          const deleted = await manager.runtimes.deleteProfile(runtimeId, profileId)
          return ok({ ok: deleted }, deleted ? 200 : 404)
        }
        if (method === 'POST' && segments[3] === 'probe' && segments.length === 4) {
          const targetProfileId = profileId === '_default' ? undefined : profileId
          const models = await manager.runtimes.probeProfileModels(runtimeId, targetProfileId)
          const providerId = manager.runtimes.providerFor(runtimeId) ?? ''
          return ok({
            ok: true,
            runtimeId,
            ...(targetProfileId ? { profileId: targetProfileId } : {}),
            provider: providerId,
            models: models.map((m) => ({
              provider: providerId,
              id: m.id,
              name: m.name,
              ...(m.isDefault ? { isDefault: true } : {}),
              ...(m.reasoningEfforts !== undefined
                ? { reasoningEfforts: [...m.reasoningEfforts] }
                : {}),
              ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
            })),
          })
        }
      }
    }

    // ── Runtimes & Models ─────────────────────────────────────────────────
    if (method === 'GET' && pathname === 'runtimes') {
      const runtimes = await manager.runtimes.list()
      const exposedPresets = manager.runtimes.listExposedPresets()
      return ok({ ok: true, runtimes, exposedPresets })
    }

    if (method === 'GET' && pathname === 'models') {
      const runtimeId = url.searchParams.get('runtimeId')?.trim() || ''
      if (runtimeId) {
        const profileId = url.searchParams.get('profileId')?.trim() || undefined
        const refresh = url.searchParams.get('refresh') === '1'
        const meta =
          (await manager.runtimes.modelsForRuntime(runtimeId, profileId, { force: refresh })) ?? []
        const providerId = manager.runtimes.providerFor(runtimeId) ?? ''
        return ok({
          ok: true,
          runtimeId,
          ...(profileId ? { profileId } : {}),
          provider: providerId,
          models: meta.map((m) => ({
            provider: providerId,
            id: m.id,
            name: m.name,
            ...(m.isDefault ? { isDefault: true } : {}),
            ...(m.reasoningEfforts !== undefined
              ? { reasoningEfforts: [...m.reasoningEfforts] }
              : {}),
            ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
          })),
        })
      }
      const providers = ctx.llm.listProviders()
      const groups = await Promise.all(
        providers.map(async (info) => {
          const isExternal = manager.runtimes?.isExternalProvider?.(info.id) ?? false
          try {
            const externalMeta = await manager.runtimes?.modelsForProvider?.(info.id)
            if (externalMeta) {
              const models = externalMeta.map((m) => ({
                provider: info.id,
                id: m.id,
                name: m.name,
                ...(m.isDefault ? { isDefault: true } : {}),
                ...(m.reasoningEfforts !== undefined
                  ? { reasoningEfforts: [...m.reasoningEfforts] }
                  : {}),
                ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
              }))
              return { provider: info.id, name: info.name, isExternal: true, models }
            }
            const rawModels = await ctx.llm.listModels(info.id)
            const models = await Promise.all(
              rawModels.map(async (m) => {
                if (typeof ctx.llm.resolveModelInfo !== 'function') return m
                const detail = await ctx.llm.resolveModelInfo(info.id, m.id).catch(() => undefined)
                if (!detail?.reasoning) return m
                const reasoningEfforts = detail.reasoning.efforts.map((e) => String(e.id)).filter(Boolean)
                const defaultEffort = detail.reasoning.defaultEffort
                  ? String(detail.reasoning.defaultEffort)
                  : undefined
                return {
                  ...m,
                  reasoningEfforts,
                  ...(defaultEffort ? { defaultEffort } : {}),
                }
              }),
            )
            return { provider: info.id, name: info.name, isExternal, models }
          } catch (err) {
            return {
              provider: info.id,
              name: info.name,
              isExternal,
              models: [],
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }),
      )
      return ok({ ok: true, groups })
    }

    return ok({ ok: false, error: 'not_found' }, 404)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return ok({ ok: false, error: message }, 400)
  }
}

export function createLarkHttpHandler(
  ctx: Context,
  connection: ConnectionAdmitter,
  manager: LarkBridgeManager,
): WebRoute['handler'] {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const advertisedOrigin = manager.getAdvertisedWebOrigin?.() ?? ''
    if (requestPath === LARK_SESSION_OPEN_PATH) {
      await handleSessionOpen(req, res, {
        liveOrigin: manager.getLiveWebOrigin?.() ?? '',
        advertisedOrigin,
        connection,
        handoff: manager.sessionHandoff,
        ...(manager.sessionViewer ? { viewer: manager.sessionViewer } : {}),
      })
      return
    }
    if (requestPath === LARK_VIEW_RPC_PATH) {
      if (!manager.sessionViewer) {
        sendJson(res, 503, { ok: false, error: 'viewer_unavailable' })
        return
      }
      await manager.sessionViewer.handleViewerRpc(req, res, { advertisedOrigin })
      return
    }
    if (requestPath === LARK_VIEW_STREAM_PATH) {
      if (!manager.sessionViewer) {
        sendJson(res, 503, { ok: false, error: 'viewer_unavailable' })
        return
      }
      await manager.sessionViewer.handleViewerStream(req, res, { advertisedOrigin })
      return
    }

    const authHeader =
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    const operatorHeader =
      typeof req.headers[OPERATOR_TOKEN_HEADER] === 'string'
        ? req.headers[OPERATOR_TOKEN_HEADER]
        : undefined
    const isCliAuthenticated = Boolean(manager.cliAuth?.verify(authHeader))
    const isOperatorAuthenticated = Boolean(manager.operatorAuth?.verify(operatorHeader))

    let principalKind = 'owner'
    if (isCliAuthenticated || isOperatorAuthenticated) {
      principalKind = isOperatorAuthenticated ? 'operator' : 'cli'
    } else {
      const admission = connection.admit(req)
      if ('rejection' in admission) {
        sendJson(res, admission.rejection, {
          ok: false,
          error: admission.rejection === 401 ? 'unauthorized' : 'forbidden',
        })
        return
      }
      const admittedPeer = admission.peer as { principal?: { kind?: string } }
      principalKind = admittedPeer?.principal?.kind ?? 'owner'
    }

    if (!isSameOriginMutationAllowed(req, isCliAuthenticated || isOperatorAuthenticated)) {
      sendJson(res, 403, { ok: false, error: 'cross_origin_forbidden' })
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()
    const rawUrl = req.url ?? '/'
    const isAgentSend = method === 'POST' && rawUrl.startsWith('/api/lark-bridge/agent/send')
    let body: unknown = undefined
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await readJsonBody(req, isAgentSend ? UPLOAD_MAX_BODY_BYTES : DEFAULT_MAX_BODY_BYTES)
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }

    const response = await dispatchLarkApiRequest(ctx, manager, {
      method,
      path: rawUrl,
      body,
      isCliAuthenticated,
      isOperatorAuthenticated,
      principalKind,
    })
    sendJson(res, response.status, response.payload)
  }
}

/**
 * Exact Fetch route handler for `ctx.connection.fetch.register({ path: LARK_BRIDGE_RPC_PATH, ... })`.
 * Speaks DSH Connection's standard `ClientRequest` / `ServerResponse` JSON envelope so the
 * browser UI works identically across DSH Web, Electron Desktop (`file://` + `__DSH_TRANSPORT__`),
 * and in-process carriers without custom auth headers or CORS workarounds.
 */
export function createLarkConnectionRpcHandler(
  ctx: Context,
  manager: LarkBridgeManager,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
    }
    let envelope: unknown
    try {
      envelope = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rec = envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : null
    const rpcId = typeof rec?.rpcId === 'string' ? rec.rpcId : 'invalid-request'
    if (
      !rec ||
      rec.type !== 'client-request' ||
      rec.method !== LARK_BRIDGE_RPC_ENDPOINT ||
      !rec.payload ||
      typeof rec.payload !== 'object'
    ) {
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: 'lark-bridge/bad-request',
              message: 'invalid lark-bridge RPC request envelope',
              details: {},
            },
          },
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    const payload = rec.payload as { method?: unknown; path?: unknown; body?: unknown }
    const method = typeof payload.method === 'string' ? payload.method : 'GET'
    const path = typeof payload.path === 'string' ? payload.path : '/'
    const dispatched = await dispatchLarkApiRequest(ctx, manager, {
      method,
      path,
      body: payload.body,
      isCliAuthenticated: false,
      principalKind: 'owner',
      signal: request.signal,
    })

    const data = dispatched.payload as { ok?: unknown; error?: unknown } | undefined
    if (dispatched.status >= 400 || data?.ok === false) {
      const errorMessage =
        typeof data?.error === 'string' && data.error.trim()
          ? data.error
          : `HTTP ${dispatched.status}`
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: 'lark-bridge/error',
              message: errorMessage,
              details: { status: dispatched.status },
            },
          },
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }

    return Response.json(
      {
        type: 'server-response',
        rpcId,
        result: {
          ok: true,
          value: dispatched.payload,
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
}
