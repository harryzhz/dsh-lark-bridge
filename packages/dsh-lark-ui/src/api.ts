import type {
  AuditEvent,
  AuthStatusPayload,
  AutoCreateBotInput,
  BotConfig,
  BotRecord,
  ChatMemberItem,
  CockpitPayload,
  DirectoryBrowseResult,
  DreamRunState,
  DreamSession,
  GroupConfig,
  GroupView,
  ImportExistingBotInput,
  ListenerTemplate,
  ModelGroup,
  OpenPlatformAppsPayload,
  QrJobView,
  ReminderItem,
  RuntimeOption,
  ScheduleBinding,
  ScheduleView,
  SessionBinding,
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
    const res = await request<{ bindings: SessionBinding[]; dreamSessions?: DreamSession[] }>('/bindings')
    return {
      bindings: res.bindings ?? [],
      dreamSessions: res.dreamSessions ?? [],
    }
  },
  deleteDreamSession: (sessionId: string) => del(`/dream-sessions/${seg(sessionId)}`),
  events: async (limit = 120) => (await request<{ events: AuditEvent[] }>(`/events?limit=${limit}`)).events,
  runtimes: async () => (await request<{ runtimes: RuntimeOption[] }>('/runtimes')).runtimes,
  models: async () => (await request<{ groups: ModelGroup[] }>('/models')).groups,
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
  importExistingBot: (input: ImportExistingBotInput) => post<{ bot: BotConfig }>('/bots/import-existing', input),
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
}
