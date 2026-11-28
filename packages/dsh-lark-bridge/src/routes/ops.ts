import { bodyRecord, ok, type LarkRouteDefinition } from './router.js'

const healthHandler: LarkRouteDefinition['handler'] = ({ manager, auth }) => {
  const lifecycle = manager.getLifecycleStatus?.()
  return ok({
    ok: true,
    principal: auth.principalKind,
    botCount: manager.store.listBots().length,
    groupCount: manager.store.listGroups().length,
    activeBindings: manager.store.listBindings().length,
    ...(lifecycle ? { phase: lifecycle.phase, draining: lifecycle.draining } : {}),
  })
}

const cockpitHandler: LarkRouteDefinition['handler'] = ({ manager }) => {
  const statuses = manager.listBotStatuses()
  const cockpit = manager.store.buildCockpit(statuses, (sid) => manager.sessionWebUrl(sid))
  const alerts = manager.getDiagnostics?.().alerts ?? []
  return ok({ ok: true, ...cockpit, alerts })
}

export const opsRoutes: readonly LarkRouteDefinition[] = [
  // ── Health & Overview ──────────────────────────────────────────────────
  { method: 'GET', pattern: '/', policy: 'ops_read', handler: healthHandler },
  { method: 'GET', pattern: '/health', policy: 'ops_read', handler: healthHandler },
  { method: 'GET', pattern: '/cockpit', policy: 'ops_read', handler: cockpitHandler },
  { method: 'GET', pattern: '/overview', policy: 'ops_read', handler: cockpitHandler },

  // ── Graceful Lifecycle / Drain Control Plane ───────────────────────────
  {
    method: 'GET',
    pattern: '/lifecycle/status',
    policy: 'ops_read',
    handler: ({ manager }) => ok({ ok: true, ...manager.getLifecycleStatus() }),
  },
  {
    method: 'POST',
    pattern: '/lifecycle/drain',
    policy: 'owner_or_operator',
    handler: async ({ manager, request }) => {
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
    },
  },
  {
    method: 'POST',
    pattern: '/lifecycle/resume-intake',
    policy: 'owner_or_operator',
    handler: async ({ manager }) => {
      const status = await manager.cancelDrain()
      return ok({ ok: true, ...status })
    },
  },

  // ── Diagnostics & Observability ────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/diagnostics',
    policy: 'ops_read',
    handler: ({ manager }) => ok(manager.getDiagnostics()),
  },
  {
    method: 'POST',
    pattern: '/diagnostics/split-brain/:botId/clear',
    policy: 'owner',
    handler: ({ manager, params }) => {
      const cleared = manager.clearSplitBrainAlert(params.botId!)
      return ok({ ok: true, cleared })
    },
  },
  {
    method: 'GET',
    pattern: '/observability',
    policy: 'ops_read',
    handler: async ({ manager, url }) => {
      const rawWindow = url.searchParams.get('window')?.trim()
      const window =
        rawWindow === '24h' || rawWindow === '7d' || rawWindow === '30d' || rawWindow === '90d'
          ? rawWindow
          : '24h'
      const botId = url.searchParams.get('botId')?.trim() || undefined
      const chatId = url.searchParams.get('chatId')?.trim() || undefined
      const senderId = url.searchParams.get('senderId')?.trim() || undefined
      const refreshStorage =
        url.searchParams.get('refreshStorage') === '1' ||
        url.searchParams.get('refreshStorage') === 'true'
      const payload = await manager.getObservability({
        window,
        ...(botId ? { botId } : {}),
        ...(chatId ? { chatId } : {}),
        ...(senderId ? { senderId } : {}),
        refreshStorage,
      })
      return ok({ ok: true, ...payload })
    },
  },
  {
    method: 'POST',
    pattern: '/observability/checkpoint',
    policy: 'owner_or_operator',
    handler: ({ manager }) => {
      const result = manager.store.checkpointWal({ mode: 'TRUNCATE' })
      const stats = manager.store.getStorageStats()
      return ok({ ok: true, checkpoint: result, storage: stats })
    },
  },

  // ── Plugin Release Check & Restart-Free Hot-Update Control Plane ───────
  {
    method: 'GET',
    pattern: '/plugins/updates',
    policy: 'ops_read',
    handler: async ({ manager, url }) => {
      const check = url.searchParams.get('check') === '1' || url.searchParams.get('check') === 'true'
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
      const overview = await manager.pluginUpdater.getOverview({ check, force })
      return ok(overview)
    },
  },
  {
    method: 'GET',
    pattern: '/plugins/update-status',
    policy: 'ops_read',
    handler: ({ manager, url }) => {
      const operationId = url.searchParams.get('operationId')?.trim() || undefined
      const operation = manager.pluginUpdater.getOperation(operationId)
      return ok({ ok: true, ...(operation ? { operation } : {}) })
    },
  },
  {
    method: 'POST',
    pattern: '/plugins/check',
    policy: 'ops_read',
    handler: async ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const force = body.force !== false
      const overview = await manager.pluginUpdater.getOverview({ check: true, force })
      return ok(overview)
    },
  },
  {
    method: 'POST',
    pattern: '/plugins/update/force',
    policy: 'owner_or_operator',
    handler: ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const operationId =
        typeof body.operationId === 'string' && body.operationId.trim()
          ? body.operationId.trim()
          : undefined
      const result = manager.pluginUpdater.forceActiveDrain(operationId)
      return ok({ ok: true, ...result })
    },
  },
  {
    method: 'POST',
    pattern: '/plugins/update',
    policy: 'owner_or_operator',
    handler: async ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const rawTarget = typeof body.target === 'string' ? body.target.trim().toLowerCase() : 'all'
      const target =
        rawTarget === 'bridge' || rawTarget === 'lark-bridge' || rawTarget === '@harryzhz/dsh-lark-bridge'
          ? 'bridge'
          : rawTarget === 'external-agents' || rawTarget === 'ext' || rawTarget === '@harryzhz/dsh-external-agents'
            ? 'external-agents'
            : rawTarget === 'all' || rawTarget === ''
              ? 'all'
              : undefined
      if (!target) {
        return ok({ ok: false, error: `不支持的插件目标：${rawTarget}` }, 400)
      }
      const version = typeof body.version === 'string' && body.version.trim() ? body.version.trim() : undefined
      const drainTimeoutMs =
        typeof body.drainTimeoutMs === 'number' && Number.isFinite(body.drainTimeoutMs)
          ? body.drainTimeoutMs
          : undefined
      const operation = await manager.pluginUpdater.startUpdate({
        target,
        ...(version ? { version } : {}),
        ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
        force: body.force === true,
        allowMigrateLocal: body.allowMigrateLocal === true,
        allowRestartRequired: body.allowRestartRequired === true,
      })
      return ok({ ok: true, operation }, 202)
    },
  },

  // ── Desktop Renderer Channel, Viewer Secret & Console Login Tickets ────
  {
    method: 'GET',
    pattern: '/desktop/open-wait',
    policy: 'owner',
    deniedError: 'owner_session_required',
    handler: async ({ manager, url, request }) => {
      const timeoutMs = url.searchParams.get('timeoutMs')
        ? Number(url.searchParams.get('timeoutMs'))
        : undefined
      const command = await manager.sessionHandoff.waitForCommand(timeoutMs, request.signal)
      return ok({ ok: true, command })
    },
  },
  {
    method: 'POST',
    pattern: '/desktop/open-ack',
    policy: 'owner',
    deniedError: 'owner_session_required',
    handler: ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
      const opened = body.opened !== false
      const matched = requestId ? manager.sessionHandoff.ackCommand(requestId, opened) : false
      return ok({ ok: true, matched })
    },
  },
  {
    method: 'POST',
    pattern: '/viewer/rotate-secret',
    policy: 'owner',
    handler: ({ manager }) => {
      manager.store.rotateViewerTicketSecret()
      manager.sessionViewer?.invalidateAccess(true)
      return ok({ ok: true })
    },
  },
  {
    method: 'POST',
    pattern: '/console-login/issue',
    policy: 'owner',
    handler: ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const botId = typeof body.botId === 'string' && body.botId.trim() ? body.botId.trim() : 'owner'
      const bot = manager.store.getBot(botId)
      const botName =
        bot?.name ??
        (typeof body.botName === 'string' && body.botName.trim() ? body.botName.trim() : 'DSH 控制台')
      const issued = manager.issueConsoleLoginLink({
        botId: bot?.id ?? botId,
        botName,
        adminOpenId: 'owner_session',
      })
      if (!issued) {
        return ok({ ok: false, error: 'console_login_unavailable' }, 503)
      }
      return ok({ ok: true, ...issued })
    },
  },
]
