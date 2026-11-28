import {
  SessionIdentityError,
  type ResolvedCliSessionIdentity,
} from '../bridge-manager.js'
import type { CreateReminderInput, UpdateReminderInput } from '../reminder-service.js'
import { bodyRecord, ok, type LarkRouteDefinition } from './router.js'

export const automationRoutes: readonly LarkRouteDefinition[] = [
  // ── Schedules ──────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/schedules',
    policy: 'owner_or_cli',
    handler: async ({ manager }) => {
      const payload = await manager.schedules.listViews()
      return ok({ ok: true, ...payload })
    },
  },
  {
    method: 'PUT',
    pattern: '/schedules/:scheduleId',
    policy: 'owner_or_cli',
    handler: ({ manager, request, params }) => {
      const body = bodyRecord(request.body)
      const saved = manager.store.upsertScheduleBinding({ ...body, scheduleId: params.scheduleId! })
      void manager.schedules.refreshScheduleContextCache()
      return ok({ ok: true, binding: saved })
    },
  },
  {
    method: 'DELETE',
    pattern: '/schedules/:scheduleId',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const deleted = manager.store.deleteScheduleBinding(params.scheduleId!)
      return ok({ ok: true, deleted })
    },
  },
  {
    method: 'POST',
    pattern: '/schedules/:scheduleId/run',
    policy: 'owner_or_cli',
    handler: async ({ manager, params }) => {
      const runRes = await manager.schedules.runNow(params.scheduleId!)
      return ok(runRes, runRes.ok ? 200 : 400)
    },
  },

  // ── Proactive One-Shot Reminders ───────────────────────────────────────
  {
    method: 'GET',
    pattern: '/reminders',
    policy: 'owner_or_cli',
    handler: ({ manager, url }) => {
      const rawFilter = url.searchParams.get('status')
      const filter = rawFilter === 'active' || rawFilter === 'archived' ? rawFilter : 'all'
      return ok({ ok: true, reminders: manager.store.listReminders(filter) })
    },
  },
  {
    method: 'POST',
    pattern: '/reminders',
    policy: 'owner_or_cli',
    handler: async ({ manager, request, auth }) => {
      if (!manager.reminders) {
        return ok({ ok: false, error: 'reminder_service_unavailable' }, 400)
      }
      const rawBody = bodyRecord(request.body) as unknown as CreateReminderInput & {
        sessionId?: string
      }
      const { sessionId: rawSessionId, creationMode: rawCreationMode, ...restBody } = rawBody
      const identity: ResolvedCliSessionIdentity =
        typeof manager.resolveCliSessionIdentity === 'function'
          ? manager.resolveCliSessionIdentity(
              typeof rawSessionId === 'string' ? rawSessionId : undefined,
              request.externalSessionId,
            )
          : ((): ResolvedCliSessionIdentity => {
              const rawStr = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
              const extStr = request.externalSessionId?.trim() ?? ''
              if (!rawStr && !extStr) {
                return { provided: false, unresolved: false }
              }
              const effectiveRaw = rawStr || `ext:${extStr}`
              const canonical =
                typeof manager.resolveCliSessionId === 'function'
                  ? manager.resolveCliSessionId(effectiveRaw)
                  : rawStr && !rawStr.startsWith('ext:')
                    ? rawStr
                    : undefined
              return {
                ...(canonical ? { canonicalSessionId: canonical } : {}),
                provided: true,
                unresolved: !canonical,
                rawSessionId: effectiveRaw,
              }
            })()
      const hasExplicitTarget = Boolean(
        typeof restBody.botId === 'string' &&
          restBody.botId.trim() &&
          ((typeof restBody.chatId === 'string' && restBody.chatId.trim()) ||
            (typeof restBody.userOpenId === 'string' && restBody.userOpenId.trim())),
      )
      if (identity.unresolved && !hasExplicitTarget) {
        throw new SessionIdentityError(
          'unresolved_session_context',
          `无法解析当前会话上下文（${identity.rawSessionId}），已拒绝创建提醒以防止归属到默认智能体；请显式指定 --bot 与 --chat/--user`,
          400,
        )
      }
      // CLI callers must never override the bot's configured creationMode (e.g. bypassing `confirm`).
      const body: CreateReminderInput = {
        ...restBody,
        ...(!auth.isCliAuthenticated && rawCreationMode !== undefined
          ? { creationMode: rawCreationMode }
          : {}),
        ...(identity.canonicalSessionId ? { sessionId: identity.canonicalSessionId } : {}),
      }
      const item = await manager.reminders.create(body)
      return ok({ ok: true, reminder: item }, 201)
    },
  },
  {
    method: 'PUT',
    pattern: '/reminders/:reminderId',
    policy: 'owner_or_cli',
    handler: ({ manager, request, params }) => {
      if (!manager.reminders) {
        return ok({ ok: false, error: 'reminder_service_unavailable' }, 400)
      }
      const body = bodyRecord(request.body) as unknown as UpdateReminderInput
      const updated = manager.reminders.update(params.reminderId!, body)
      return ok({ ok: true, reminder: updated })
    },
  },
  {
    method: 'POST',
    pattern: '/reminders/:reminderId/approve',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const approved = await manager.reminders.approve(params.reminderId!)
      return ok({ ok: true, reminder: approved })
    },
  },
  {
    method: 'POST',
    pattern: '/reminders/:reminderId/cancel',
    policy: 'owner_or_cli',
    handler: async ({ manager, params }) => {
      const cancelled = await manager.reminders.cancel(params.reminderId!, 'cancelled')
      return ok({ ok: true, reminder: cancelled })
    },
  },
  {
    method: 'POST',
    pattern: '/reminders/:reminderId/run',
    policy: 'owner_or_cli',
    handler: async ({ manager, request, params }) => {
      const reminderId = params.reminderId!
      const body = bodyRecord(request.body) as { async?: boolean }
      const reminder =
        body.async === true && typeof manager.reminders.triggerNow === 'function'
          ? await manager.reminders.triggerNow(reminderId)
          : await manager.reminders.runNow(reminderId)
      return ok({ ok: true, reminder })
    },
  },
  {
    method: 'DELETE',
    pattern: '/reminders/:reminderId',
    policy: 'owner_or_cli',
    handler: ({ manager, params }) => {
      const deleted = manager.store.deleteReminder(params.reminderId!)
      return ok({ ok: deleted }, deleted ? 200 : 404)
    },
  },
]
