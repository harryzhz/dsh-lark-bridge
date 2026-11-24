import { useState, type ComponentType, type ReactNode } from 'react'
import {
  Button,
  IconAlarmClockOutlineRegular,
  IconGaugeOutlineRegular,
  IconNewChatOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconUsersOutlineRegular,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi, configureBridgeTransport, type BridgeConnectionRpcLike } from './api.js'
import { BotConfigDialog } from './components/BotConfigDialog.js'
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog.js'
import { GroupConfigDialog } from './components/GroupConfigDialog.js'
import { LarkAuthDialog } from './components/LarkAuthDialog.js'
import { LarkSidebarIcon, RobotTabIcon, ShieldAuthIcon } from './components/LarkLogo.js'
import { ReminderEditDialog } from './components/ReminderEditDialog.js'
import { ScheduleConfigDialog } from './components/ScheduleConfigDialog.js'
import { installSessionModelFilter } from './session-model-filter.js'
import {
  activateDshSession,
  activateDshSessionDetailed,
  parseSessionDeepLinkFromLocation,
  stripSessionDeepLinkUrl,
  type LayoutNavigationLike,
  type SessionActivationResult,
  type WorkspaceNavigationScope,
} from './session-navigation.js'
import { useBridgeData } from './state.js'
import { ensureLarkUiStyles } from './styles.js'
import type { BotConfig, BotRecord, GroupView, ReminderItem, ScheduleView } from './types.js'
import { BotsView } from './views/BotsView.js'
import { GroupsView } from './views/GroupsView.js'
import { OverviewView } from './views/OverviewView.js'
import { SchedulesView } from './views/SchedulesView.js'
import { SessionsView } from './views/SessionsView.js'

const PANEL_ID = 'lark-bridge'
const SCHEDULE_PANEL_ID = 'schedules'

type Tab = 'overview' | 'bots' | 'groups' | 'schedules' | 'sessions'

const TABS: ReadonlyArray<{ key: Tab; label: string; icon: ReactNode }> = [
  { key: 'overview', label: '概览', icon: <IconGaugeOutlineRegular size={16} /> },
  { key: 'bots', label: '智能体', icon: <RobotTabIcon size={16} /> },
  { key: 'groups', label: '群聊', icon: <IconUsersOutlineRegular size={16} /> },
  { key: 'schedules', label: '自动化', icon: <IconAlarmClockOutlineRegular size={16} /> },
  { key: 'sessions', label: '会话', icon: <IconNewChatOutlineRegular size={16} /> },
]

let openDshSession: ((sessionId: string) => Promise<SessionActivationResult>) | undefined
let openDshSchedules: (() => void) | undefined

function LarkBridgePage() {
  const data = useBridgeData()
  const [tab, setTab] = useState<Tab>('overview')
  const [editingBot, setEditingBot] = useState<BotRecord | 'new' | null>(null)
  const [editingGroup, setEditingGroup] = useState<GroupView | null>(null)
  const [editingSchedule, setEditingSchedule] = useState<ScheduleView | null>(null)
  const [editingReminder, setEditingReminder] = useState<ReminderItem | null>(null)
  const [authOpen, setAuthOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)
  const [syncing, setSyncing] = useState(false)

  const act = async (task: () => Promise<unknown>, success?: string) => {
    try {
      await task()
      if (success) setToast({ text: success, ok: true })
    } catch (err) {
      setToast({ text: `操作失败：${err instanceof Error ? err.message : String(err)}`, ok: false })
    } finally {
      await data.refresh()
    }
  }

  const saveBot = async (config: BotConfig, existingId: string | null) => {
    const { larkAppSecret, ...rest } = config
    const body = { ...rest, ...(larkAppSecret?.trim() ? { larkAppSecret: larkAppSecret.trim() } : {}) } as BotConfig
    const res = await (existingId ? bridgeApi.updateBot(existingId, body) : bridgeApi.createBot(body))
    const syncNote =
      res.platformSync && !res.platformSync.synced && res.platformSync.message
        ? `（本地已保存；${res.platformSync.message}）`
        : ''
    setToast({ text: `已保存${syncNote}`, ok: true })
    await data.refresh()
  }

  const syncChats = () => {
    setSyncing(true)
    void act(async () => setToast({ text: `已同步 ${await bridgeApi.syncAllChats()} 个群聊`, ok: true })).finally(() => setSyncing(false))
  }

  const handleOpenSession = (sessionId: string) => {
    const opener = openDshSession
    if (!opener) {
      setToast({ text: '会话视图尚未就绪，请稍后重试', ok: false })
      return
    }
    void opener(sessionId).then((res) => {
      if (!res.ok) {
        setToast({ text: res.message, ok: false })
      }
    })
  }

  const opIdentity = data.auth?.openPlatform.authenticated ? data.auth.openPlatform.identity : undefined

  return (
    <div className="fb-page">
      <div className="fb-container">
        <header className="fb-header">
          <h1 className="fb-title">飞书桥接</h1>
          <div className="fb-actions">
            <Button
              variant="outline"
              icon={<ShieldAuthIcon size={16} />}
              onClick={() => {
                void data.refreshAuth()
                setAuthOpen(true)
              }}
            >
              {opIdentity ? `已认证 · ${opIdentity.userName}` : '飞书认证'}
            </Button>
            {tab === 'bots' && (
              <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setEditingBot('new')}>
                新增智能体
              </Button>
            )}
            {tab === 'groups' && (
              <Button variant="outline" icon={<IconRefreshOutlineRegular size={16} />} disabled={syncing || data.bots.length === 0} onClick={syncChats}>
                同步群聊
              </Button>
            )}
          </div>
        </header>

        <nav className="fb-tabs" aria-label="飞书桥接">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="fb-tab"
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => setTab(t.key)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {data.error && <div className="fb-card fb-empty">无法连接桥接服务：{data.error}</div>}

        {tab === 'overview' && <OverviewView cockpit={data.cockpit} runtimes={data.runtimes} models={data.models} />}
        {tab === 'bots' && (
          <BotsView
            bots={data.bots}
            runtimes={data.runtimes}
            models={data.models}
            actions={{
              edit: setEditingBot,
              toggle: (bot) => void act(() => bridgeApi.toggleBot(bot.id)),
              reconnect: (bot) => void act(() => bridgeApi.reconnectBot(bot.id), '已重新连接'),
              syncProfile: (bot) => void act(() => bridgeApi.syncBotProfile(bot.id), '已同步飞书头像与签名'),
              syncChats: (bot) => void act(async () => setToast({ text: `已同步 ${await bridgeApi.syncBotChats(bot.id)} 个群聊`, ok: true })),
              remove: (bot) =>
                setConfirm({
                  title: `删除「${bot.name}」？`,
                  description: '智能体及其群聊配置会被移除，已有会话记录保留。',
                  confirmLabel: '删除',
                  run: () => act(() => bridgeApi.deleteBot(bot.id), '已删除'),
                }),
            }}
          />
        )}
        {tab === 'groups' && (
          <GroupsView
            groups={data.groups}
            bots={data.bots}
            runtimes={data.runtimes}
            models={data.models}
            actions={{
              edit: setEditingGroup,
              setEnabled: (g, enabled) => void act(() => bridgeApi.saveGroup({ ...g.config, enabled })),
              reset: (g) =>
                setConfirm({
                  title: `恢复「${g.chatName}」的默认配置？`,
                  description: '本群的单独设置会被清除，之后跟随智能体配置。',
                  confirmLabel: '恢复默认',
                  run: () => act(() => bridgeApi.resetGroup(g.botId, g.chatId), '已恢复默认'),
                }),
            }}
          />
        )}
        {tab === 'schedules' && (
          <SchedulesView
            available={data.scheduleAvailable}
            schedules={data.schedules}
            reminders={data.reminders}
            groups={data.groups}
            bots={data.bots}
            onOpenScheduleManager={data.scheduleAvailable ? () => openDshSchedules?.() : undefined}
            actions={{
              edit: setEditingSchedule,
              toggle: (s, enabled) =>
                void act(() =>
                  bridgeApi.saveSchedule(s.id, {
                    enabled,
                    targets: s.binding.targets,
                    deliveryMode: s.binding.deliveryMode,
                    notifyOn: s.binding.notifyOn,
                    sendIntermediateMessages: s.binding.sendIntermediateMessages,
                  }),
                ),
              runNow: (s) => void act(() => bridgeApi.runSchedule(s.id), '已触发执行'),
              openSession: handleOpenSession,
              reset: (s) =>
                setConfirm({
                  title: `恢复「${s.title}」的默认通知设置？`,
                  description: '将清除手动绑定的通知群聊与推送策略。',
                  confirmLabel: '恢复默认',
                  run: () => act(() => bridgeApi.resetSchedule(s.id), '已恢复默认'),
                }),
            }}
            reminderActions={{
              edit: setEditingReminder,
              approve: (r) => void act(() => bridgeApi.approveReminder(r.id), '已确认创建提醒事项'),
              cancel: (r) => void act(() => bridgeApi.cancelReminder(r.id), '提醒事项已取消并归档'),
              runNow: (r) => void act(() => bridgeApi.runReminder(r.id), '已触发执行'),
              remove: (r) => void act(() => bridgeApi.deleteReminder(r.id), '已删除记录'),
              openSession: handleOpenSession,
            }}
          />
        )}
        {tab === 'sessions' && (
          <SessionsView
            bindings={data.bindings}
            dreamSessions={data.dreamSessions}
            triageSessions={data.triageSessions}
            events={data.events}
            bots={data.bots}
            runtimes={data.runtimes}
            models={data.models}
            onOpen={handleOpenSession}
            onUnbind={(b) => void act(() => bridgeApi.unbind(b.routeKey), '会话已归档')}
            onDeleteDreamSession={(s) =>
              void act(() => bridgeApi.deleteDreamSession(s.sessionId), '已移除记录')
            }
            onDeleteTriageSession={(s) =>
              void act(() => bridgeApi.deleteTriageSession(s.sessionId), '已移除记录')
            }
            onClearTriageSessions={() =>
              setConfirm({
                title: '清空智能分流会话记录？',
                description: '仅清理桥接列表中的分流记录索引，不影响正在进行的群聊对话。',
                confirmLabel: '清空记录',
                run: () => act(() => bridgeApi.clearTriageSessions(), '已清空分流记录'),
              })
            }
            onRotateViewerSecret={() =>
              setConfirm({
                title: '重置所有只读会话链接？',
                description:
                  '重置后将更换签名密钥并断开当前所有访客只读连接，此前已发送到飞书群的只读链接全部失效，新消息卡片不受影响。',
                confirmLabel: '重置密钥',
                run: () => act(() => bridgeApi.rotateViewerSecret(), '已重置只读链接密钥，历史分享链接已失效'),
              })
            }
          />
        )}
      </div>

      <BotConfigDialog
        target={editingBot}
        bots={data.bots}
        runtimes={data.runtimes}
        models={data.models}
        triageDefaults={data.triageDefaults}
        auth={data.auth}
        onClose={() => setEditingBot(null)}
        onSave={saveBot}
        onAutoCreated={async () => {
          setToast({ text: '智能体已自动创建并接入', ok: true })
          await data.refresh()
          await data.refreshAuth()
        }}
        onExistingImported={async (botName) => {
          setToast({ text: `智能体「${botName}」已接入`, ok: true })
          await data.refresh()
        }}
        onRefresh={data.refresh}
        onProfilesChanged={data.refreshRuntimes}
        onAuthUpdated={data.refreshAuth}
        onOpenAuth={() => setAuthOpen(true)}
        onOpenSession={handleOpenSession}
      />
      <GroupConfigDialog
        target={editingGroup}
        bots={data.bots}
        runtimes={data.runtimes}
        models={data.models}
        listenerTemplates={data.listenerTemplates}
        triageDefaults={data.triageDefaults}
        onClose={() => setEditingGroup(null)}
        onProfilesChanged={data.refreshRuntimes}
        onSave={async (config) => {
          await bridgeApi.saveGroup(config)
          setToast({ text: '已保存', ok: true })
          await data.refresh()
        }}
      />
      <ScheduleConfigDialog
        target={editingSchedule}
        groups={data.groups}
        bots={data.bots}
        onOpenScheduleManager={data.scheduleAvailable ? () => openDshSchedules?.() : undefined}
        onClose={() => setEditingSchedule(null)}
        onSave={async (scheduleId, binding) => {
          await bridgeApi.saveSchedule(scheduleId, binding)
          setToast({ text: '已保存', ok: true })
          await data.refresh()
        }}
      />
      <ReminderEditDialog
        target={editingReminder}
        onClose={() => setEditingReminder(null)}
        onSave={async (id, patch) => {
          await bridgeApi.updateReminder(id, patch)
          setToast({ text: '提醒事项已更新', ok: true })
          await data.refresh()
        }}
      />
      <LarkAuthDialog
        open={authOpen}
        auth={data.auth}
        bots={data.bots}
        onClose={() => setAuthOpen(false)}
        onUpdated={async () => {
          await data.refreshAuth()
          await data.refresh()
        }}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      {toast && <Toast key={toast.text} text={toast.text} {...(toast.ok ? { tone: 'success' as const } : {})} onDone={() => setToast(null)} />}
    </div>
  )
}

function stripSessionDeepLinkInBrowser(): void {
  const cleaned = stripSessionDeepLinkUrl(window.location.href)
  if (cleaned !== undefined) {
    try {
      window.history.replaceState(null, '', cleaned)
    } catch {
      // Ignore History API restrictions on non-HTTP origins (e.g. Electron file://).
    }
  }
}

interface LarkViewerBootConfig {
  readonly sessionId?: string
  readonly readOnly?: boolean
}

export function isReadOnlyViewerPage(): boolean {
  const g = globalThis as {
    __DSH_LARK_VIEWER__?: LarkViewerBootConfig
    __DSH_REMOTE_ACCESS__?: { readonly owner?: boolean }
  }
  return Boolean(g.__DSH_LARK_VIEWER__?.readOnly || g.__DSH_REMOTE_ACCESS__?.owner === false)
}

export function isDesktopAppRenderer(): boolean {
  if (isReadOnlyViewerPage()) return false
  const loc = typeof window !== 'undefined' ? window.location : undefined
  if (loc?.protocol === 'dsh-app:') return true
  const g = globalThis as { dshDesktop?: unknown; __DSH_TRANSPORT__?: unknown }
  return Boolean(g.dshDesktop || g.__DSH_TRANSPORT__)
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface ClientContext {
  slots: {
    inject: (slot: string, fn: () => unknown) => void
    register: (def: Record<string, unknown>, component: ComponentType<any>) => unknown
  }
  get?: (name: string) => unknown
  connection?: { rpc?: BridgeConnectionRpcLike }
  uiWorkspace?: { openSession?: (id: string) => void }
  layout?: LayoutNavigationLike
  inject?: (deps: readonly string[], callback: (scope: any) => void) => unknown
  effect?: (fn: () => () => void, label?: string) => void
}

function readOptionalService<T>(
  ctx: ClientContext,
  name: 'connection' | 'layout' | 'uiWorkspace',
): T | undefined {
  if (typeof ctx.get === 'function') {
    return ctx.get(name) as T | undefined
  }
  return ctx[name] as T | undefined
}

function applyReadOnlyViewerMode(ctx: ClientContext): void {
  let layoutRef: LayoutNavigationLike | undefined = readOptionalService<LayoutNavigationLike>(ctx, 'layout')
  const g = globalThis as { __DSH_LARK_VIEWER__?: LarkViewerBootConfig }
  const targetSessionId =
    g.__DSH_LARK_VIEWER__?.sessionId?.trim() || parseSessionDeepLinkFromLocation(window.location)

  ctx.inject?.(['layout'], (scope: { layout: LayoutNavigationLike; effect?: ClientContext['effect'] }) => {
    layoutRef = scope.layout
    scope.effect?.(() => () => {
      if (layoutRef === scope.layout) {
        const current = readOptionalService<LayoutNavigationLike>(ctx, 'layout')
        layoutRef = current === scope.layout ? undefined : current
      }
    }, 'dsh-lark-ui.viewer-layout-ref')
  })

  if (!targetSessionId) return

  ctx.inject?.(
    ['uiWorkspace', 'workspaces', 'sessions'],
    (scope: WorkspaceNavigationScope & { effect?: ClientContext['effect'] }) => {
      let disposed = false
      void activateDshSession({
        sessionId: targetSessionId,
        scope,
        getLayout: () => layoutRef ?? readOptionalService<LayoutNavigationLike>(ctx, 'layout'),
        isDisposed: () => disposed,
        allowUnarchive: false,
      })
      scope.effect?.(() => () => {
        disposed = true
      }, 'dsh-lark-ui.viewer-session-opener')
    },
  )
}

export const inject = ['slots'] as const

export function apply(ctx: ClientContext): void {
  if (isReadOnlyViewerPage()) {
    applyReadOnlyViewerMode(ctx)
    return
  }

  ensureLarkUiStyles()

  let layoutRef: LayoutNavigationLike | undefined = readOptionalService<LayoutNavigationLike>(ctx, 'layout')
  let activateReadySession: ((sessionId: string) => Promise<SessionActivationResult>) | undefined
  let activatorWaiters: Array<(fn: ((sessionId: string) => Promise<SessionActivationResult>) | undefined) => void> = []
  let pendingDeepLinkSessionId = parseSessionDeepLinkFromLocation(window.location)

  const resolveActivatorWaiters = (fn: ((sessionId: string) => Promise<SessionActivationResult>) | undefined) => {
    const list = activatorWaiters
    activatorWaiters = []
    for (const wake of list) wake(fn)
  }

  const openSessionAndAwaitDetailed = async (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionActivationResult> => {
    const sid = sessionId.trim()
    if (!sid) return { ok: false, reason: 'empty', message: '无效的会话 ID' }
    if (activateReadySession) {
      return await activateReadySession(sid)
    }
    if (signal?.aborted) return { ok: false, reason: 'disposed', message: '页面已卸载' }
    const activator = await new Promise<
      ((id: string) => Promise<SessionActivationResult>) | undefined
    >((resolve) => {
      const wake = (fn: ((id: string) => Promise<SessionActivationResult>) | undefined) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(fn)
      }
      const onAbort = () => {
        activatorWaiters = activatorWaiters.filter((w) => w !== wake)
        wake(undefined)
      }
      const timer = setTimeout(() => {
        activatorWaiters = activatorWaiters.filter((w) => w !== wake)
        wake(undefined)
      }, 3000)
      signal?.addEventListener('abort', onAbort, { once: true })
      activatorWaiters.push(wake)
    })
    return activator
      ? await activator(sid)
      : { ok: false, reason: 'disposed', message: '会话视图尚未就绪，请稍后重试' }
  }

  const openSessionAndAwait = async (sessionId: string, signal?: AbortSignal): Promise<boolean> => {
    const res = await openSessionAndAwaitDetailed(sessionId, signal)
    return res.ok
  }

  let desktopListenerRpc: BridgeConnectionRpcLike | undefined
  let desktopListenerAbort: AbortController | undefined
  const stopDesktopListener = (expectedRpc?: BridgeConnectionRpcLike) => {
    if (expectedRpc !== undefined && desktopListenerRpc !== expectedRpc) return
    desktopListenerAbort?.abort()
    desktopListenerAbort = undefined
    desktopListenerRpc = undefined
  }
  const ensureDesktopListener = (rpc: BridgeConnectionRpcLike) => {
    if (!isDesktopAppRenderer() || desktopListenerRpc === rpc) return
    stopDesktopListener()
    const abort = new AbortController()
    desktopListenerRpc = rpc
    desktopListenerAbort = abort
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const res = await bridgeApi.waitDesktopOpenCommand(20_000, abort.signal)
          if (abort.signal.aborted) break
          const cmd = res.command
          if (cmd?.sessionId && cmd.requestId) {
            const opened = await openSessionAndAwait(cmd.sessionId, abort.signal).catch(() => false)
            await bridgeApi.ackDesktopOpenCommand(cmd.requestId, opened).catch(() => {})
            if (opened) {
              try {
                window.focus?.()
              } catch {
                // Non-fatal.
              }
            }
          }
        } catch {
          if (abort.signal.aborted) break
          await abortableDelay(1500, abort.signal)
        }
      }
    })()
  }

  const rootRpc = readOptionalService<{ rpc?: BridgeConnectionRpcLike }>(ctx, 'connection')?.rpc
  if (rootRpc) {
    configureBridgeTransport(rootRpc)
    ensureDesktopListener(rootRpc)
    ctx.effect?.(() => () => {
      stopDesktopListener(rootRpc)
      configureBridgeTransport(undefined, rootRpc)
    }, 'dsh-lark-ui.connection-rpc')
  }
  ctx.inject?.(['connection'], (scope: { connection?: { rpc?: BridgeConnectionRpcLike }; effect?: ClientContext['effect'] }) => {
    if (!scope.connection?.rpc) return
    const rpc = scope.connection.rpc
    configureBridgeTransport(rpc)
    ensureDesktopListener(rpc)
    scope.effect?.(() => () => {
      stopDesktopListener(rpc)
      configureBridgeTransport(undefined, rpc)
    }, 'dsh-lark-ui.connection-rpc-scope')
  })

  ctx.inject?.(['modelDirectories', 'sessions'], (scope) => {
    installSessionModelFilter(scope)
  })

  const navigateSchedules = () => {
    const layout = layoutRef ?? readOptionalService<LayoutNavigationLike>(ctx, 'layout')
    if (layout?.selectPanel) {
      if (!layout.hasMainPanel || layout.hasMainPanel(SCHEDULE_PANEL_ID)) {
        layout.selectPanel(SCHEDULE_PANEL_ID)
      }
    }
  }
  openDshSchedules = navigateSchedules

  ctx.inject?.(['layout'], (scope: { layout: LayoutNavigationLike; effect?: ClientContext['effect'] }) => {
    layoutRef = scope.layout
    scope.effect?.(() => () => {
      if (layoutRef === scope.layout) {
        const current = readOptionalService<LayoutNavigationLike>(ctx, 'layout')
        layoutRef = current === scope.layout ? undefined : current
      }
    }, 'dsh-lark-ui.layout-ref')
  })

  const navigate = (sessionId: string): Promise<SessionActivationResult> =>
    openSessionAndAwaitDetailed(sessionId)
  openDshSession = navigate

  ctx.inject?.(
    ['uiWorkspace', 'workspaces', 'sessions'],
    (scope: WorkspaceNavigationScope & { effect?: ClientContext['effect'] }) => {
      let disposed = false
      const openAndRevealSession = (sessionId: string) =>
        activateDshSessionDetailed({
          sessionId,
          scope,
          getLayout: () => layoutRef ?? readOptionalService<LayoutNavigationLike>(ctx, 'layout'),
          isDisposed: () => disposed,
        })

      activateReadySession = openAndRevealSession
      resolveActivatorWaiters(openAndRevealSession)

      if (pendingDeepLinkSessionId) {
        const targetSid = pendingDeepLinkSessionId
        pendingDeepLinkSessionId = undefined
        stripSessionDeepLinkInBrowser()
        void openAndRevealSession(targetSid)
      }

      scope.effect?.(() => () => {
        disposed = true
        if (activateReadySession === openAndRevealSession) {
          activateReadySession = undefined
        }
      }, 'dsh-lark-ui.workspace-session-opener')
    },
  )

  const consumeUrlDeepLink = () => {
    const sid = parseSessionDeepLinkFromLocation(window.location)
    if (!sid) return
    if (activateReadySession) {
      pendingDeepLinkSessionId = undefined
      stripSessionDeepLinkInBrowser()
      void activateReadySession(sid)
    } else {
      pendingDeepLinkSessionId = sid
    }
  }
  window.addEventListener('hashchange', consumeUrlDeepLink)
  window.addEventListener('popstate', consumeUrlDeepLink)
  ctx.effect?.(() => () => {
    stopDesktopListener()
    resolveActivatorWaiters(undefined)
    window.removeEventListener('hashchange', consumeUrlDeepLink)
    window.removeEventListener('popstate', consumeUrlDeepLink)
    if (openDshSession === navigate) openDshSession = undefined
    if (openDshSchedules === navigateSchedules) openDshSchedules = undefined
  }, 'dsh-lark-ui.session-deep-link')

  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LarkBridgePage))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: '飞书桥接' }, LarkSidebarIcon),
  )
}
