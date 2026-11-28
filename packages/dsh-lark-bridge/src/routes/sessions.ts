import { ok, type LarkRouteDefinition } from './router.js'

export const sessionRoutes: readonly LarkRouteDefinition[] = [
  {
    method: 'GET',
    pattern: '/bindings',
    policy: 'owner_or_cli',
    handler: ({ manager }) => {
      const bindings = manager.store.listBindings().map((b) => ({
        ...b,
        sessionUrl: manager.sessionWebUrl(b.sessionId),
      }))
      const dreamSessions = (manager.store.listDreamSessions?.() ?? []).map((s) => ({
        ...s,
        sessionUrl: manager.sessionWebUrl(s.sessionId, { allowGuestViewer: false }),
      }))
      const triageSessions = (manager.store.listTriageSessions?.() ?? []).map((s) => ({
        ...s,
        sessionUrl: manager.sessionWebUrl(s.sessionId, { allowGuestViewer: false }),
      }))
      return ok({
        ok: true,
        bindings,
        dreamSessions,
        triageSessions,
        archivedSessionIds: manager.listArchivedSessionIds(),
      })
    },
  },
  {
    method: 'DELETE',
    pattern: '/dream-sessions/:sessionId',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const sessionId = params.sessionId!
      const target = manager.store.listDreamSessions?.().find((s) => s.sessionId === sessionId)
      if (target?.status === 'running') {
        return ok({ ok: false, error: 'dream_session_running' }, 400)
      }
      const deleted = manager.store.deleteDreamSession?.(sessionId) ?? false
      return ok({ ok: deleted }, deleted ? 200 : 404)
    },
  },
  {
    method: 'DELETE',
    pattern: '/triage-sessions',
    policy: 'owner',
    handler: ({ manager, url }) => {
      const botId = url.searchParams.get('botId')?.trim() || undefined
      const deletedCount = manager.store.clearTriageSessions?.(botId) ?? 0
      return ok({ ok: true, deletedCount })
    },
  },
  {
    method: 'DELETE',
    pattern: '/triage-sessions/:sessionId',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const deleted = manager.store.deleteTriageSession?.(params.sessionId!) ?? false
      return ok({ ok: deleted }, deleted ? 200 : 404)
    },
  },
  {
    method: 'POST',
    pattern: '/sessions/sweep',
    policy: 'owner',
    handler: async ({ manager }) => {
      const archivedCount = await manager.sweepIdleBindings()
      return ok({ ok: true, archivedCount })
    },
  },
  {
    method: 'DELETE',
    pattern: '/bindings/*routeKey',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const deleted = await manager.unbindRoute(params.routeKey!, { archive: true })
      return ok({ ok: deleted }, deleted ? 200 : 404)
    },
  },
  {
    method: 'GET',
    pattern: '/events',
    policy: 'owner_or_cli',
    handler: ({ manager, url }) => {
      const traceId = url.searchParams.get('traceId')?.trim()
      if (traceId) {
        return ok({ ok: true, events: manager.store.listEventsByTrace(traceId) })
      }
      const limit = Number(url.searchParams.get('limit') ?? 100)
      return ok({ ok: true, events: manager.store.listEvents(limit) })
    },
  },
]
