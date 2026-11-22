import { useCallback, useEffect, useState } from 'react'
import { bridgeApi } from './api.js'
import { FALLBACK_LISTENER_TEMPLATES } from './presets.js'
import { updateSessionFilterRuntimes } from './session-model-filter.js'
import type {
  AuditEvent,
  AuthStatusPayload,
  BotRecord,
  CockpitPayload,
  GroupView,
  ListenerTemplate,
  ModelGroup,
  ReminderItem,
  RuntimeOption,
  ScheduleView,
  SessionBinding,
} from './types.js'

export interface BridgeData {
  cockpit: CockpitPayload | null
  bots: BotRecord[]
  groups: GroupView[]
  schedules: ScheduleView[]
  scheduleAvailable: boolean
  reminders: ReminderItem[]
  bindings: SessionBinding[]
  events: AuditEvent[]
  runtimes: RuntimeOption[]
  models: ModelGroup[]
  listenerTemplates: ListenerTemplate[]
  auth: AuthStatusPayload | null
}

const EMPTY: BridgeData = {
  cockpit: null,
  bots: [],
  groups: [],
  schedules: [],
  scheduleAvailable: true,
  reminders: [],
  bindings: [],
  events: [],
  runtimes: [],
  models: [],
  listenerTemplates: [...FALLBACK_LISTENER_TEMPLATES],
  auth: null,
}
const POLL_MS = 6000

/** Polls live bridge state; catalogs (runtimes, models, auth) load on mount and on demand. */
export function useBridgeData(): BridgeData & {
  refresh: () => Promise<void>
  refreshAuth: () => Promise<void>
  error: string
} {
  const [data, setData] = useState<BridgeData>(EMPTY)
  const [error, setError] = useState('')

  const refreshAuth = useCallback(async () => {
    try {
      const auth = await bridgeApi.authStatus()
      setData((prev) => ({ ...prev, auth }))
    } catch {
      // Non-fatal.
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [cockpit, bots, groups, schedulePayload, reminders, bindings, events] = await Promise.all([
        bridgeApi.cockpit(),
        bridgeApi.bots(),
        bridgeApi.groups(),
        bridgeApi.schedules(),
        bridgeApi.reminders('all'),
        bridgeApi.bindings(),
        bridgeApi.events(),
      ])
      setData((prev) => ({
        ...prev,
        cockpit,
        bots,
        groups,
        schedules: schedulePayload.schedules,
        scheduleAvailable: schedulePayload.available,
        reminders,
        bindings,
        events,
        listenerTemplates: cockpit.listenerTemplates?.length
          ? [...cockpit.listenerTemplates]
          : prev.listenerTemplates,
      }))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshAuth()
    void Promise.all([bridgeApi.runtimes(), bridgeApi.models(), bridgeApi.listenerTemplates()])
      .then(([runtimes, models, listenerTemplates]) => {
        updateSessionFilterRuntimes(runtimes)
        setData((prev) => ({
          ...prev,
          runtimes,
          models,
          ...(listenerTemplates.length ? { listenerTemplates } : {}),
        }))
      })
      .catch(() => {})
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh, refreshAuth])

  return { ...data, refresh, refreshAuth, error }
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
