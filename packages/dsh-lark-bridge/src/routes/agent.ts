import type { AgentCliSendInput } from '../bridge-manager.js'
import type { ScheduleCreateInputLike } from '../schedule-notifier.js'
import type { LarkScheduleDeliveryMode, LarkScheduleNotifyOn } from '../types.js'
import {
  UPLOAD_MAX_BODY_BYTES,
  bodyRecord,
  ok,
  type LarkRouteDefinition,
} from './router.js'

export const agentRoutes: readonly LarkRouteDefinition[] = [
  {
    method: 'GET',
    pattern: '/agent/context',
    policy: 'owner_or_cli',
    handler: ({ manager, url, request }) => {
      const extSessionId = request.externalSessionId?.trim() || undefined
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const resolved = extSessionId
        ? manager.resolveAgentContext(sessionId, extSessionId)
        : manager.resolveAgentContext(sessionId)
      return ok({ ok: true, ...resolved })
    },
  },
  {
    method: 'POST',
    pattern: '/agent/send',
    policy: 'owner_or_cli',
    maxBodyBytes: UPLOAD_MAX_BODY_BYTES,
    handler: async ({ manager, request }) => {
      const extSessionId = request.externalSessionId?.trim() || undefined
      const body = bodyRecord(request.body) as unknown as AgentCliSendInput
      const sendInput = extSessionId ? { ...body, externalSessionId: extSessionId } : body
      const result = await manager.agentSend(sendInput)
      return ok({ ok: true, ...result })
    },
  },
  {
    method: 'POST',
    pattern: '/agent/silence',
    policy: 'owner_or_cli',
    handler: ({ manager, request }) => {
      const extSessionId = request.externalSessionId?.trim() || undefined
      const body = bodyRecord(request.body) as { sessionId?: string; reason?: string }
      const result = manager.agentSilenceTurn({
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(extSessionId ? { externalSessionId: extSessionId } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
      })
      return ok({ ok: true, ...result })
    },
  },
  {
    method: 'GET',
    pattern: '/agent/history',
    policy: 'owner_or_cli',
    handler: async ({ manager, url, request }) => {
      const extSessionId = request.externalSessionId?.trim() || undefined
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const botId = url.searchParams.get('botId') ?? undefined
      const chatId = url.searchParams.get('chatId') ?? undefined
      const threadId = url.searchParams.get('threadId') ?? undefined
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined
      const result = await manager.agentHistory({
        ...(sessionId ? { sessionId } : {}),
        ...(extSessionId ? { externalSessionId: extSessionId } : {}),
        ...(botId ? { botId } : {}),
        ...(chatId ? { chatId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(limit && Number.isFinite(limit) ? { limit } : {}),
      })
      return ok({ ok: true, ...result })
    },
  },
  {
    method: 'GET',
    pattern: '/agent/messages/:messageId',
    policy: 'owner_or_cli',
    handler: async ({ manager, url, request, params }) => {
      const extSessionId = request.externalSessionId?.trim() || undefined
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const botId = url.searchParams.get('botId') ?? undefined
      const downloadResources = url.searchParams.get('download') === '1'
      const includeRaw = url.searchParams.get('raw') === '1'
      const detail = await manager.agentGetMessage({
        ...(sessionId ? { sessionId } : {}),
        ...(extSessionId ? { externalSessionId: extSessionId } : {}),
        ...(botId ? { botId } : {}),
        messageId: params.messageId!,
        downloadResources,
        includeRaw,
      })
      if (!detail) {
        return ok({ ok: false, error: 'message_not_found' }, 404)
      }
      return ok({ ok: true, message: detail })
    },
  },
  {
    method: 'POST',
    pattern: '/agent/schedules',
    policy: 'owner_or_cli',
    handler: async ({ manager, request }) => {
      const extSessionId = request.externalSessionId?.trim() || undefined
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
        ...(extSessionId ? { externalSessionId: extSessionId } : {}),
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
    },
  },
  {
    method: ['PATCH', 'PUT'],
    pattern: '/agent/schedules/:scheduleId',
    policy: 'owner_or_cli_no_operator',
    handler: async ({ manager, request, params }) => {
      const body = bodyRecord(request.body) as {
        title?: unknown
        prompt?: unknown
        timing?: ScheduleCreateInputLike['timing']
        cwd?: unknown
        agentPreset?: unknown
        active?: unknown
      }
      if (body.active !== undefined && typeof body.active !== 'boolean') {
        return ok({ ok: false, error: 'active must be a boolean' }, 400)
      }
      const updated = await manager.agentUpdateSchedule(params.scheduleId!, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
        ...(body.timing !== undefined ? { timing: body.timing } : {}),
        ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
        ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset } : {}),
        ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
      })
      if (!updated.ok) {
        const status =
          updated.code === 'schedule_not_found'
            ? 404
            : updated.code === 'schedule_conflict'
              ? 409
              : 400
        return ok(updated, status)
      }
      return ok(updated)
    },
  },
  {
    method: 'DELETE',
    pattern: '/agent/schedules/:scheduleId',
    policy: 'owner_or_cli_no_operator',
    handler: async ({ manager, params }) => {
      const deleted = await manager.agentDeleteSchedule(params.scheduleId!)
      if (!deleted.ok) {
        const status =
          deleted.code === 'schedule_not_found'
            ? 404
            : deleted.code === 'schedule_conflict'
              ? 409
              : 400
        return ok(deleted, status)
      }
      return ok(deleted)
    },
  },
]
