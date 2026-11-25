import { useCallback, useEffect, useState } from 'react'
import { bridgeApi } from './api.js'
import { hasActivePendingSelfReload } from './components/PluginUpdateDialog.js'
import { FALLBACK_LISTENER_TEMPLATES, FALLBACK_TRIAGE_DEFAULTS } from './presets.js'
import { updateSessionFilterRuntimes } from './session-model-filter.js'
import type {
  AuditEvent,
  AuthStatusPayload,
  BotRecord,
  CockpitPayload,
  DreamSession,
  GroupView,
  ListenerTemplate,
  ModelGroup,
  PluginUpdatesOverview,
  ReminderItem,
  RuntimeOption,
  ScheduleView,
  SessionBinding,
  TriageDefaultsPayload,
  TriageSession,
} from './types.js'

export interface BridgeData {
  cockpit: CockpitPayload | null
  bots: BotRecord[]
  groups: GroupView[]
  schedules: ScheduleView[]
  scheduleAvailable: boolean
  reminders: ReminderItem[]
  bindings: SessionBinding[]
  dreamSessions: DreamSession[]
  triageSessions: TriageSession[]
  events: AuditEvent[]
  runtimes: RuntimeOption[]
  models: ModelGroup[]
  listenerTemplates: ListenerTemplate[]
  triageDefaults: TriageDefaultsPayload
  auth: AuthStatusPayload | null
  pluginUpdates: PluginUpdatesOverview | null
}

const EMPTY: BridgeData = {
  cockpit: null,
  bots: [],
  groups: [],
  schedules: [],
  scheduleAvailable: true,
  reminders: [],
  bindings: [],
  dreamSessions: [],
  triageSessions: [],
  events: [],
  runtimes: [],
  models: [],
  listenerTemplates: [...FALLBACK_LISTENER_TEMPLATES],
  triageDefaults: FALLBACK_TRIAGE_DEFAULTS,
  auth: null,
  pluginUpdates: null,
}
const POLL_MS = 6000

/** Polls live bridge state; catalogs (runtimes, models, auth) load on mount and on demand. */
export function useBridgeData(): BridgeData & {
  refresh: () => Promise<void>
  refreshAuth: () => Promise<void>
  refreshRuntimes: () => Promise<void>
  refreshPluginUpdates: (options?: { check?: boolean; force?: boolean }) => Promise<PluginUpdatesOverview | null>
  error: string
} {
  const [data, setData] = useState<BridgeData>(EMPTY)
  const [error, setError] = useState('')

  const refreshPluginUpdates = useCallback(
    async (options: { check?: boolean; force?: boolean } = {}): Promise<PluginUpdatesOverview | null> => {
      try {
        const pluginUpdates = options.force
          ? await bridgeApi.checkPluginUpdates(true)
          : await bridgeApi.pluginUpdates(options)
        setData((prev) => ({ ...prev, pluginUpdates }))
        return pluginUpdates
      } catch {
        return null
      }
    },
    [],
  )

  const refreshAuth = useCallback(async () => {
    try {
      const auth = await bridgeApi.authStatus()
      setData((prev) => ({ ...prev, auth }))
    } catch {
      // Non-fatal.
    }
  }, [])

  const refreshRuntimes = useCallback(async () => {
    try {
      const [catalog, models] = await Promise.all([
        bridgeApi.runtimeCatalog(),
        bridgeApi.models(),
      ])
      updateSessionFilterRuntimes(catalog.runtimes, catalog.exposedPresets)
      setData((prev) => ({
        ...prev,
        runtimes: catalog.runtimes,
        models,
      }))
    } catch {
      // Non-fatal.
    }
  }, [])

  const refresh = useCallback(async () => {
    const corePromise = Promise.all([
      bridgeApi.cockpit(),
      bridgeApi.bots(),
      bridgeApi.groups(),
    ]).then(([cockpit, bots, groups]) => {
      setData((prev) => ({
        ...prev,
        cockpit,
        bots,
        groups,
        listenerTemplates: cockpit.listenerTemplates?.length
          ? [...cockpit.listenerTemplates]
          : prev.listenerTemplates,
        triageDefaults: cockpit.triageDefaults ?? prev.triageDefaults,
      }))
      setError('')
    })

    const secondaryPromise = Promise.all([
      bridgeApi.schedules(),
      bridgeApi.reminders('all'),
      bridgeApi.sessionsOverview(),
      bridgeApi.events(),
    ]).then(([schedulePayload, reminders, sessionOverview, events]) => {
      setData((prev) => ({
        ...prev,
        schedules: schedulePayload.schedules,
        scheduleAvailable: schedulePayload.available,
        reminders,
        bindings: sessionOverview.bindings,
        dreamSessions: sessionOverview.dreamSessions,
        triageSessions: sessionOverview.triageSessions,
        events,
      }))
    })

    try {
      await Promise.all([corePromise, secondaryPromise])
    } catch (err) {
      if (!hasActivePendingSelfReload()) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshAuth()
    void refreshRuntimes()
    void refreshPluginUpdates({ check: true })
    void bridgeApi
      .listenerTemplates()
      .then((listenerTemplates) => {
        if (listenerTemplates.length) {
          setData((prev) => ({ ...prev, listenerTemplates }))
        }
      })
      .catch(() => {})
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh, refreshAuth, refreshRuntimes, refreshPluginUpdates])

  return { ...data, refresh, refreshAuth, refreshRuntimes, refreshPluginUpdates, error }
}

export function formatDuration(ms: number): string {
  if (!ms) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function formatTime(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function formatIsoTime(iso?: string): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`
}
