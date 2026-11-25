import type {
  AuditEvent,
  AuthStatusPayload,
  AutoCreateBotInput,
  BaselineEventSyncResult,
  BotConfig,
  BotRecord,
  CatalogModelItem,
  ChatMemberItem,
  CockpitPayload,
  DirectoryBrowseResult,
  DreamRunState,
  DreamSession,
  ExposedRuntimePreset,
  GroupConfig,
  GroupView,
  ImportExistingBotInput,
  ListenerTemplate,
  MemoryConfidence,
  MemoryEntry,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  ModelGroup,
  ObservabilityPayload,
  ObservabilityWindow,
  OpenPlatformAppsPayload,
  ManagedPluginId,
  PluginUpdateOperation,
  PluginUpdatesOverview,
  QrJobView,
  ReminderItem,
  RuntimeCatalogPayload,
  RuntimeOption,
  RuntimeProfileInput,
  RuntimeProfileSummary,
  ScheduleBinding,
  ScheduleView,
  SessionBinding,
  TriageSession,
  UserSearchHit,
} from './types.js'

const API_BASE = '/api/lark-bridge'
const RPC_CHANNEL = '/api'
const RPC_ENDPOINT = 'lark-bridge-rpc'

export interface BridgeConnectionRpcLike {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly message?: string; readonly code?: string } }
  >
}

let activeConnectionRpc: BridgeConnectionRpcLike | undefined

/**
 * Bind DSH's transport-independent `ctx.connection.rpc` carrier so all UI requests
 * work identically across DSH Web, Electron Desktop (`file://` + `__DSH_TRANSPORT__`),
 * and in-process carriers. Pass `undefined` on plugin dispose to detach.
 */
export function configureBridgeTransport(
  rpc: BridgeConnectionRpcLike | undefined,
  expectedCurrent?: BridgeConnectionRpcLike,
): void {
  if (rpc === undefined && expectedCurrent !== undefined && activeConnectionRpc !== expectedCurrent) {
    return
  }
  activeConnectionRpc = rpc
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const parsedBody =
    typeof init?.body === 'string' && init.body.length > 0 ? (JSON.parse(init.body) as unknown) : undefined

  if (activeConnectionRpc) {
    const rpcResult = await activeConnectionRpc.call(
      RPC_CHANNEL,
      RPC_ENDPOINT,
      {
        method,
        path,
        ...(parsedBody !== undefined ? { body: parsedBody } : {}),
      },
      init?.signal ?? undefined,
    )
    if (!rpcResult.ok) {
      throw new Error(rpcResult.error?.message || rpcResult.error?.code || 'RPC request failed')
    }
    const data = rpcResult.value as T & { ok?: boolean; error?: string }
    if (data && typeof data === 'object' && data.ok === false) {
      throw new Error(data.error || 'Request failed')
    }
    return data
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const data = (await res.json()) as T & { ok?: boolean; error?: string }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })
const seg = encodeURIComponent

/** Typed client for the bridge's authenticated HTTP API. */
export const bridgeApi = {
  cockpit: () => request<CockpitPayload>('/cockpit'),
  bots: async () => (await request<{ bots: BotRecord[] }>('/bots')).bots,
  groups: async () => (await request<{ groups: GroupView[] }>('/groups')).groups,
  bindings: async () => (await request<{ bindings: SessionBinding[] }>('/bindings')).bindings,
  sessionsOverview: async () => {
    const res = await request<{
      bindings: SessionBinding[]
      dreamSessions?: DreamSession[]
      triageSessions?: TriageSession[]
    }>('/bindings')
    return {
      bindings: res.bindings ?? [],
      dreamSessions: res.dreamSessions ?? [],
      triageSessions: res.triageSessions ?? [],
    }
  },
  deleteDreamSession: (sessionId: string) => del(`/dream-sessions/${seg(sessionId)}`),
  deleteTriageSession: (sessionId: string) => del(`/triage-sessions/${seg(sessionId)}`),
  clearTriageSessions: () => del('/triage-sessions'),
  events: async (limit = 120) => (await request<{ events: AuditEvent[] }>(`/events?limit=${limit}`)).events,
  runtimes: async () => (await request<{ runtimes: RuntimeOption[] }>('/runtimes')).runtimes,
  runtimeCatalog: async (): Promise<RuntimeCatalogPayload> => {
    const res = await request<{ runtimes?: RuntimeOption[]; exposedPresets?: ExposedRuntimePreset[] }>('/runtimes')
    return {
      runtimes: res.runtimes ?? [],
      exposedPresets: res.exposedPresets ?? [],
    }
  },
  models: async () => (await request<{ groups: ModelGroup[] }>('/models')).groups,
  profileModels: async (runtimeId: string, profileId?: string, refresh = false) => {
    const params = new URLSearchParams({ runtimeId })
    if (profileId) params.set('profileId', profileId)
    if (refresh) params.set('refresh', '1')
    return (await request<{ models?: CatalogModelItem[] }>(`/models?${params.toString()}`)).models ?? []
  },
  runtimeProfiles: async (runtimeId?: string) =>
    (
      await request<{ profiles?: RuntimeProfileSummary[] }>(
        `/runtime-profiles${runtimeId ? `?runtimeId=${seg(runtimeId)}` : ''}`,
      )
    ).profiles ?? [],
  createRuntimeProfile: async (input: RuntimeProfileInput) =>
    (await post<{ profile: RuntimeProfileSummary }>('/runtime-profiles', input)).profile,
  updateRuntimeProfile: async (runtimeId: string, profileId: string, input: RuntimeProfileInput) =>
    (
      await put<{ profile: RuntimeProfileSummary }>(
        `/runtime-profiles/${seg(runtimeId)}/${seg(profileId)}`,
        input,
      )
    ).profile,
  deleteRuntimeProfile: (runtimeId: string, profileId: string) =>
    del(`/runtime-profiles/${seg(runtimeId)}/${seg(profileId)}`),
  probeRuntimeProfile: async (runtimeId: string, profileId?: string) =>
    (
      await post<{ models?: CatalogModelItem[] }>(
        `/runtime-profiles/${seg(runtimeId)}/${seg(profileId || '_default')}/probe`,
      )
    ).models ?? [],
  listenerTemplates: async () => (await request<{ templates: ListenerTemplate[] }>('/listener-templates')).templates,
  resetListenerTemplates: async () => (await post<{ templates: ListenerTemplate[] }>('/listener-templates')).templates,

  authStatus: () => request<AuthStatusPayload>('/auth/status'),
  startOpenPlatformLogin: async () => (await post<{ job: QrJobView }>('/auth/open-platform/login')).job,
  logoutOpenPlatform: () => post('/auth/open-platform/logout'),
  openPlatformApps: () => request<OpenPlatformAppsPayload>('/auth/open-platform/apps'),
  startUserAuthLogin: async (botId: string) => (await post<{ job: QrJobView }>(`/auth/user/${seg(botId)}/login`)).job,
  revokeUserAuth: (botId: string) => del(`/auth/user/${seg(botId)}`),
  pollAuthJob: async (jobId: string) => (await request<{ job: QrJobView }>(`/auth/jobs/${seg(jobId)}`)).job,

  createBot: (bot: BotConfig) => post<{ bot: BotConfig; platformSync?: { synced: boolean; message?: string } }>('/bots', bot),
  autoCreateBot: async (input: AutoCreateBotInput) => (await post<{ job: QrJobView }>('/bots/auto-create', input)).job,
  importExistingBot: (input: ImportExistingBotInput) =>
    post<{ bot: BotConfig; eventSync?: BaselineEventSyncResult }>('/bots/import-existing', input),
  updateBot: (id: string, bot: BotConfig) =>
    put<{ bot: BotConfig; platformSync?: { synced: boolean; message?: string } }>(`/bots/${seg(id)}`, bot),
  toggleBot: (id: string) => post(`/bots/${seg(id)}/toggle`),
  reconnectBot: (id: string) => post(`/bots/${seg(id)}/reconnect`),
  syncBotProfile: (id: string) =>
    post<{
      profile: { openId?: string; name?: string; avatarUrl?: string; description?: string }
    }>(`/bots/${seg(id)}/sync-profile`),
  deleteBot: (id: string) => del(`/bots/${seg(id)}`),
  syncBotChats: async (id: string) => (await post<{ count: number }>(`/bots/${seg(id)}/sync-chats`)).count,
  runBotDream: async (id: string, force = true) =>
    (await post<{ dreamState: DreamRunState }>(`/bots/${seg(id)}/dream`, { force })).dreamState,
  memories: async (
    params: {
      botId?: string
      scope?: MemoryScope
      status?: MemoryStatus | 'all'
      type?: MemoryType
      q?: string
      limit?: number
    } = {},
  ) => {
    const qs = new URLSearchParams()
    if (params.botId?.trim()) qs.set('botId', params.botId.trim())
    if (params.scope) qs.set('scope', params.scope)
    if (params.status) qs.set('status', params.status)
    if (params.type) qs.set('type', params.type)
    if (params.q?.trim()) qs.set('q', params.q.trim())
    if (params.limit) qs.set('limit', String(params.limit))
    const suffix = qs.toString()
    return request<{ entries: MemoryEntry[]; markdownPath?: string }>(
      `/memory${suffix ? `?${suffix}` : ''}`,
    )
  },
  upsertMemory: async (input: {
    id?: string
    botId: string
    scope: MemoryScope
    scopeId?: string
    type: MemoryType
    title: string
    content: string
    tags?: string[]
    confidence?: MemoryConfidence
    pinned?: boolean
  }) => (await post<{ action: 'created' | 'updated'; entry: MemoryEntry }>('/memory', input)).entry,
  updateMemory: async (
    id: string,
    patch: {
      scope?: MemoryScope
      scopeId?: string
      type?: MemoryType
      title?: string
      content?: string
      tags?: string[]
      confidence?: MemoryConfidence
      pinned?: boolean
      status?: MemoryStatus
    },
  ) => (await put<{ entry: MemoryEntry }>(`/memory/${seg(id)}`, patch)).entry,
  supersedeMemory: async (
    id: string,
    input: {
      reason: string
      type?: MemoryType
      scope?: MemoryScope
      scopeId?: string
      title?: string
      content?: string
      tags?: string[]
      confidence?: MemoryConfidence
      pinned?: boolean
    },
  ) =>
    post<{ oldEntry: MemoryEntry; replacementEntry?: MemoryEntry }>(
      `/memory/${seg(id)}/supersede`,
      input,
    ),
  archiveMemory: (id: string, reason?: string) =>
    del(`/memory/${seg(id)}${reason ? `?reason=${seg(reason)}` : ''}`),
  deleteMemory: (id: string) => del(`/memory/${seg(id)}?hard=1`),
  searchUsers: async (botId: string, q: string) =>
    (await request<{ users: UserSearchHit[] }>(`/bots/${seg(botId)}/users/search?q=${seg(q)}`)).users,

  syncAllChats: async () => (await post<{ syncedCount: number }>('/sync-chats')).syncedCount,
  groupMembers: async (botId: string, chatId: string) =>
    (await request<{ members: ChatMemberItem[] }>(`/groups/${seg(botId)}/${seg(chatId)}/members`)).members,
  saveGroup: (group: GroupConfig) =>
    put<{ group: GroupConfig; listenerTemplates: ListenerTemplate[] }>(
      `/groups/${seg(group.botId)}/${seg(group.chatId)}`,
      group,
    ),
  resetGroup: (botId: string, chatId: string) => del(`/groups/${seg(botId)}/${seg(chatId)}`),

  schedules: () => request<{ available: boolean; schedules: ScheduleView[] }>('/schedules'),
  saveSchedule: (id: string, binding: Omit<ScheduleBinding, 'scheduleId'>) => put(`/schedules/${seg(id)}`, binding),
  resetSchedule: (id: string) => del(`/schedules/${seg(id)}`),
  runSchedule: (id: string) => post(`/schedules/${seg(id)}/run`),

  reminders: async (status: 'active' | 'archived' | 'all' = 'all') =>
    (await request<{ reminders: ReminderItem[] }>(`/reminders?status=${seg(status)}`)).reminders,
  updateReminder: async (
    id: string,
    patch: { title?: string; prompt?: string; reason?: string; at?: string },
  ) => (await put<{ reminder: ReminderItem }>(`/reminders/${seg(id)}`, patch)).reminder,
  approveReminder: async (id: string) =>
    (await post<{ reminder: ReminderItem }>(`/reminders/${seg(id)}/approve`)).reminder,
  cancelReminder: async (id: string) =>
    (await post<{ reminder: ReminderItem }>(`/reminders/${seg(id)}/cancel`)).reminder,
  runReminder: async (id: string) =>
    (await post<{ reminder: ReminderItem }>(`/reminders/${seg(id)}/run`, { async: true })).reminder,
  deleteReminder: (id: string) => del(`/reminders/${seg(id)}`),

  browseDirs: (path?: string) =>
    request<DirectoryBrowseResult>(`/fs/dirs${path ? `?path=${seg(path)}` : ''}`),
  createDir: async (parentPath: string, name: string) =>
    (await post<{ path: string }>('/fs/dirs', { parentPath, name })).path,

  waitDesktopOpenCommand: (timeoutMs = 20_000, signal?: AbortSignal) =>
    request<{ command: { requestId: string; sessionId: string } | null }>(
      `/desktop/open-wait?timeoutMs=${Math.floor(timeoutMs)}`,
      signal ? { signal } : undefined,
    ),
  ackDesktopOpenCommand: (requestId: string, opened: boolean) =>
    post<{ matched: boolean }>('/desktop/open-ack', { requestId, opened }),

  unbind: (routeKey: string) => del(`/bindings/${seg(routeKey)}`),
  rotateViewerSecret: () => post<{ ok: boolean }>('/viewer/rotate-secret'),
  diagnostics: () => request<Record<string, unknown>>('/diagnostics'),
  observability: (params: {
    window?: ObservabilityWindow
    botId?: string
    chatId?: string
    refreshStorage?: boolean
  } = {}) => {
    const qs = new URLSearchParams()
    if (params.window) qs.set('window', params.window)
    if (params.botId?.trim()) qs.set('botId', params.botId.trim())
    if (params.chatId?.trim()) qs.set('chatId', params.chatId.trim())
    if (params.refreshStorage) qs.set('refreshStorage', '1')
    const suffix = qs.toString()
    return request<ObservabilityPayload>(`/observability${suffix ? `?${suffix}` : ''}`)
  },
  checkpointWal: () =>
    post<{
      ok: boolean
      checkpoint: {
        beforeWalBytes: number
        afterWalBytes: number
        truncated: boolean
      }
    }>('/observability/checkpoint'),
  clearSplitBrainAlert: (botId: string) =>
    post<{ ok: boolean; cleared: boolean }>(`/diagnostics/split-brain/${seg(botId)}/clear`),

  pluginUpdates: (options: { check?: boolean; force?: boolean } = {}) => {
    const qs = new URLSearchParams()
    if (options.check) qs.set('check', '1')
    if (options.force) qs.set('force', '1')
    const suffix = qs.toString()
    return request<PluginUpdatesOverview>(`/plugins/updates${suffix ? `?${suffix}` : ''}`)
  },
  checkPluginUpdates: (force = true) => post<PluginUpdatesOverview>('/plugins/check', { force }),
  startPluginUpdate: async (options: {
    target?: ManagedPluginId | 'all'
    version?: string
    force?: boolean
    allowMigrateLocal?: boolean
  } = {}) => (await post<{ operation: PluginUpdateOperation }>('/plugins/update', options)).operation,
  pluginUpdateStatus: async (operationId?: string) =>
    (
      await request<{ operation?: PluginUpdateOperation }>(
        `/plugins/update-status${operationId ? `?operationId=${seg(operationId)}` : ''}`,
      )
    ).operation,
}
