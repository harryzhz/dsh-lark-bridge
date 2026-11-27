import { useEffect, useRef, useState } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  IconRefreshOutlineRegular,
  Modal,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import { formatIsoTime } from '../state.js'
import type {
  ManagedPluginId,
  ManagedPluginStatus,
  PluginUpdateOperation,
  PluginUpdatesOverview,
} from '../types.js'
import { GroupTitle, SettingRow } from './fields.js'

const ACTIVE_OP_STATES = new Set(['queued', 'verifying', 'draining', 'removing', 'installing', 'restoring'])
const SELF_RELOAD_MARKER_TTL_MS = 3 * 60_000
export const PENDING_SELF_RELOAD_STORAGE_KEY = 'dsh-lark-bridge:pending-self-reload'

export interface PendingSelfReloadMarker {
  readonly operationId: string
  readonly tab?: string
  readonly wasMounted?: boolean
  readonly at: number
}

export function markPendingSelfReload(operationId: string, tab?: string): void {
  try {
    const payload: PendingSelfReloadMarker = {
      operationId,
      ...(tab ? { tab } : {}),
      wasMounted: true,
      at: Date.now(),
    }
    window.sessionStorage.setItem(PENDING_SELF_RELOAD_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage restriction.
  }
}

export function clearPendingSelfReloadMarker(): void {
  try {
    window.sessionStorage.removeItem(PENDING_SELF_RELOAD_STORAGE_KEY)
  } catch {
    // Ignore storage restriction.
  }
}

export function hasActivePendingSelfReload(): boolean {
  try {
    const raw = window.sessionStorage.getItem(PENDING_SELF_RELOAD_STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as Partial<PendingSelfReloadMarker>
    return (
      typeof parsed.operationId === 'string' &&
      typeof parsed.at === 'number' &&
      Date.now() - parsed.at < SELF_RELOAD_MARKER_TTL_MS
    )
  } catch {
    return false
  }
}

export function consumePendingSelfReloadMarker(): PendingSelfReloadMarker | undefined {
  try {
    const raw = window.sessionStorage.getItem(PENDING_SELF_RELOAD_STORAGE_KEY)
    if (!raw) return undefined
    window.sessionStorage.removeItem(PENDING_SELF_RELOAD_STORAGE_KEY)
    const parsed = JSON.parse(raw) as Partial<PendingSelfReloadMarker>
    if (
      typeof parsed.operationId === 'string' &&
      typeof parsed.at === 'number' &&
      Date.now() - parsed.at < SELF_RELOAD_MARKER_TTL_MS
    ) {
      return {
        operationId: parsed.operationId,
        ...(typeof parsed.tab === 'string' ? { tab: parsed.tab } : {}),
        ...(typeof parsed.wasMounted === 'boolean' ? { wasMounted: parsed.wasMounted } : {}),
        at: parsed.at,
      }
    }
  } catch {
    // Ignore storage error.
  }
  return undefined
}

function isDrainTimeoutFailure(op: PluginUpdateOperation): boolean {
  if (op.status !== 'failed') return false
  if (op.failureCode === 'drain_timeout') return true
  const text = `${op.message ?? ''} ${op.error ?? ''}`
  return /排空超时|外部 Agent 会话运行中|--force/.test(text)
}

function resolveRetryTarget(op: PluginUpdateOperation): ManagedPluginId | 'all' {
  if (op.targetSelector) return op.targetSelector
  if (op.items.length === 1 && op.items[0]) return op.items[0].id
  return 'all'
}

function opStateLabel(status: PluginUpdateOperation['status']): {
  label: string
  tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral'
} {
  switch (status) {
    case 'queued':
      return { label: '排队中', tone: 'info' }
    case 'verifying':
      return { label: '校验发布包', tone: 'info' }
    case 'draining':
      return { label: '排空在途任务', tone: 'warning' }
    case 'removing':
      return { label: '准备切换', tone: 'info' }
    case 'installing':
      return { label: '安装热重载', tone: 'info' }
    case 'restoring':
      return { label: '回滚恢复', tone: 'warning' }
    case 'succeeded':
      return { label: '更新完成', tone: 'success' }
    case 'rolled_back':
      return { label: '已回滚', tone: 'warning' }
    case 'failed':
      return { label: '更新失败', tone: 'danger' }
  }
}

function sourceTagTone(kind: ManagedPluginStatus['sourceKind']): 'success' | 'info' | 'warning' | 'quiet' {
  switch (kind) {
    case 'github-release':
      return 'success'
    case 'registry':
      return 'info'
    case 'local-link':
    case 'local-file':
      return 'warning'
    default:
      return 'quiet'
  }
}

type PendingForceAction =
  | { readonly kind: 'preempt-drain'; readonly operationId: string }
  | { readonly kind: 'start-force'; readonly target: ManagedPluginId | 'all'; readonly label: string }

export function PluginUpdateDialog({
  open,
  overview,
  activeTab,
  onClose,
  onCheck,
  onUpdated,
}: {
  open: boolean
  overview: PluginUpdatesOverview | null
  activeTab?: string
  onClose: () => void
  onCheck: (force?: boolean) => Promise<PluginUpdatesOverview | null>
  onUpdated: (message: string, ok: boolean) => Promise<void>
}) {
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [forcingDrain, setForcingDrain] = useState(false)
  const [pendingForce, setPendingForce] = useState<PendingForceAction | null>(null)
  const [operation, setOperation] = useState<PluginUpdateOperation | null>(overview?.operation ?? null)
  const [reconnecting, setReconnecting] = useState(false)
  const [actionError, setActionError] = useState('')
  const settledNotifiedRef = useRef<string>('')

  useEffect(() => {
    if (overview?.operation) {
      setOperation((prev) => {
        if (!prev) return overview.operation ?? null
        if (prev.operationId === overview.operation?.operationId) {
          return overview.operation.updatedAtMs >= prev.updatedAtMs ? overview.operation : prev
        }
        return overview.operation ?? prev
      })
    }
  }, [overview?.operation])

  useEffect(() => {
    if (!open) {
      setActionError('')
      setReconnecting(false)
      setPendingForce(null)
      return
    }
    void onCheck(false)
  }, [open, onCheck])

  const activeOpId = operation && ACTIVE_OP_STATES.has(operation.status) ? operation.operationId : null

  useEffect(() => {
    if (!open || !activeOpId) return
    let cancelled = false
    let misses = 0
    const poll = async () => {
      try {
        const next = await bridgeApi.pluginUpdateStatus(activeOpId)
        if (cancelled) return
        misses = 0
        setReconnecting(false)
        if (!next) return
        setOperation(next)
        if (!ACTIVE_OP_STATES.has(next.status) && settledNotifiedRef.current !== next.operationId) {
          settledNotifiedRef.current = next.operationId
          clearPendingSelfReloadMarker()
          setPendingForce(null)
          await onCheck(true)
          await onUpdated(next.message, next.status === 'succeeded')
        }
      } catch {
        if (cancelled) return
        // During bridge self-swap (`removeBundle` -> `installBundle`), `/api/lark-bridge-rpc` is
        // briefly unregistered while the host holds the client graph to keep this UI mounted.
        misses += 1
        setReconnecting(true)
        if (misses >= 60) {
          clearPendingSelfReloadMarker()
          setActionError('等待新版本恢复超时，请刷新页面查看当前插件状态')
          setReconnecting(false)
        }
      }
    }
    const timer = window.setInterval(() => void poll(), 1200)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, activeOpId, onCheck, onUpdated])

  if (!open) return null

  const plugins = overview?.plugins ?? []
  const isBusy = checking || starting || forcingDrain || Boolean(activeOpId)
  const updatableHotPlugins = plugins.filter((p) => p.updateAvailable && p.hotReloadSupported)
  const inFlightTurns = overview?.inFlightTurns ?? 0
  const activeExternalAgents = overview?.activeExternalAgents ?? 0
  const bridgeSeamlessReload = overview?.bridgeSeamlessReload !== false
  const hasUpdatableExternal = updatableHotPlugins.some((p) => p.id === 'external-agents')
  const externalUpdateNeedsDrain = hasUpdatableExternal && activeExternalAgents > 0
  const showSeamlessNotice =
    !externalUpdateNeedsDrain && bridgeSeamlessReload && inFlightTurns > 0 && updatableHotPlugins.length > 0

  const handleCheck = async () => {
    setChecking(true)
    setActionError('')
    try {
      await onCheck(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  const handleUpdate = async (target: ManagedPluginId | 'all', options: { force?: boolean } = {}) => {
    setStarting(true)
    setActionError('')
    setReconnecting(false)
    setPendingForce(null)
    try {
      const op = await bridgeApi.startPluginUpdate({
        target,
        ...(options.force ? { force: true } : {}),
      })
      if (op.items.some((item) => item.id === 'bridge')) {
        markPendingSelfReload(op.operationId, activeTab)
      }
      setOperation(op)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const handlePreemptDrain = async (operationId: string) => {
    setForcingDrain(true)
    setActionError('')
    setPendingForce(null)
    try {
      const res = await bridgeApi.forcePluginUpdateDrain(operationId)
      if (res.operation) {
        setOperation(res.operation)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setForcingDrain(false)
    }
  }

  const opMeta = operation ? opStateLabel(operation.status) : null
  const showDrainPreempt = operation?.status === 'draining' && !reconnecting
  const showForceRetry =
    Boolean(operation && !activeOpId && isDrainTimeoutFailure(operation) && updatableHotPlugins.length > 0)
  const retryTarget = operation ? resolveRetryTarget(operation) : 'all'
  const defaultForceTarget: ManagedPluginId | 'all' =
    updatableHotPlugins.length === 1 && updatableHotPlugins[0] ? updatableHotPlugins[0].id : 'all'

  return (
    <Modal open onClose={onClose} title="插件版本与热更新" headless className="fb-schedule-dialog fb-update-dialog">
      <div className="fb-schedule-dialog-head">
        <div style={{ minWidth: 0 }}>
          <div className="fb-schedule-dialog-title">插件版本与热更新</div>
          <div className="fb-schedule-dialog-sub">
            检测 GitHub Release 发布包并原地热重载，无需重启 DSH Web
          </div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        <SettingRow
          title={
            <span className="fb-update-env-title">
              <StateDot state={overview?.hotReloadSupported ? 'done' : 'idle'} />
              <span>{overview?.hotReloadSupported ? '免重启热更新已就绪' : '当前环境暂不支持免重启热更新'}</span>
            </span>
          }
          desc={
            overview?.hotReloadSupported
              ? overview.checkedAtMs
                ? `最近检查：${formatIsoTime(new Date(overview.checkedAtMs).toISOString())}`
                : '校验 SHA256 并原地热重载，支持失败回滚；更新飞书桥接不中断在途会话'
              : overview?.hotReloadUnavailableReason || '请确认 DSH HMR 与 Plugin Manager 已启用'
          }
        >
          <Button
            size="sm"
            variant="outline"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={isBusy}
            onClick={() => void handleCheck()}
          >
            {checking ? '检查中…' : '检查更新'}
          </Button>
        </SettingRow>

        {externalUpdateNeedsDrain && !activeOpId && updatableHotPlugins.length > 0 && (
          <div className="fb-update-busy-banner">
            <span>
              当前有 {activeExternalAgents} 个外部会话运行中，更新外部运行时会先等待排空
            </span>
            {pendingForce?.kind !== 'start-force' && (
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() =>
                  setPendingForce({
                    kind: 'start-force',
                    target: defaultForceTarget,
                    label: defaultForceTarget === 'all' ? '全部插件' : updatableHotPlugins[0]?.displayName || '所选插件',
                  })
                }
              >
                强制更新
              </Button>
            )}
          </div>
        )}

        {showSeamlessNotice && !activeOpId && (
          <div className="fb-update-busy-banner">
            <span>
              当前有 {inFlightTurns} 个飞书回合运行中，更新飞书桥接将后台保活并在重载后自动续传
            </span>
          </div>
        )}

        {pendingForce?.kind === 'start-force' && !showForceRetry && (
          <div className="fb-update-force-confirm" style={{ marginBottom: 10 }}>
            <span>
              确认跳过排空并强制热更新「{pendingForce.label}」？进行中的外部会话会短暂中断（飞书回合会自动恢复）。
            </span>
            <div className="fb-update-force-confirm-btns">
              <Button
                size="sm"
                variant="outline"
                disabled={starting}
                onClick={() => setPendingForce(null)}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={starting}
                onClick={() => void handleUpdate(pendingForce.target, { force: true })}
              >
                {starting ? '启动中…' : '确认强制更新'}
              </Button>
            </div>
          </div>
        )}

        {actionError && <div className="fb-update-error">{actionError}</div>}

        {operation && opMeta && (
          <div className="fb-update-op-card">
            <div className="fb-update-op-head">
              <Tag tone={reconnecting ? 'info' : opMeta.tone}>
                {reconnecting ? '热重载切换中' : opMeta.label}
              </Tag>
              <span className="fb-update-op-msg">
                {reconnecting
                  ? '正在无缝切换至新版插件，后台在途会话不受中断，当前界面保持可见…'
                  : operation.message}
              </span>
            </div>
            {operation.items.length > 0 && (
              <div className="fb-update-op-items">
                {operation.items.map((item) => (
                  <div key={item.id} className="fb-update-op-item fb-num">
                    <span>{item.displayName}</span>
                    <span>
                      {item.fromVersion ? `v${item.fromVersion}` : '未安装'} → v{item.toVersion}
                      {item.status === 'succeeded' && item.hotReloaded
                        ? '（已热重载）'
                        : item.status === 'rolled_back'
                          ? '（已回滚）'
                          : item.status === 'failed'
                            ? '（失败）'
                            : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {showDrainPreempt && (
              <div className="fb-update-op-actions">
                {pendingForce?.kind === 'preempt-drain' ? (
                  <div className="fb-update-force-confirm">
                    <span>跳过等待将立即更新外部运行时，进行中的外部会话可能短暂中断，确认继续？</span>
                    <div className="fb-update-force-confirm-btns">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={forcingDrain}
                        onClick={() => setPendingForce(null)}
                      >
                        继续等待
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={forcingDrain}
                        onClick={() => void handlePreemptDrain(operation.operationId)}
                      >
                        {forcingDrain ? '执行中…' : '确认强制更新'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="fb-update-plugin-hint">如无需等待外部会话结束，可立即跳过排空</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={forcingDrain}
                      onClick={() =>
                        setPendingForce({ kind: 'preempt-drain', operationId: operation.operationId })
                      }
                    >
                      跳过等待，强制更新
                    </Button>
                  </>
                )}
              </div>
            )}

            {showForceRetry && (
              <div className="fb-update-op-actions">
                {pendingForce?.kind === 'start-force' ? (
                  <div className="fb-update-force-confirm">
                    <span>强制重试将跳过等待外部会话排空（飞书回合会自动恢复），确认继续？</span>
                    <div className="fb-update-force-confirm-btns">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={starting}
                        onClick={() => setPendingForce(null)}
                      >
                        取消
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={starting}
                        onClick={() => void handleUpdate(pendingForce.target, { force: true })}
                      >
                        {starting ? '启动中…' : '确认强制更新'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="fb-update-plugin-hint">存在活跃外部会话导致排空超时，可选择跳过等待直接热更新</span>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={isBusy}
                      onClick={() =>
                        setPendingForce({
                          kind: 'start-force',
                          target: retryTarget,
                          label:
                            retryTarget === 'all'
                              ? '全部待更新插件'
                              : operation.items[0]?.displayName || '目标插件',
                        })
                      }
                    >
                      强制重试更新
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <GroupTitle>受管插件</GroupTitle>
        <div className="fb-update-list">
          {plugins.length === 0 ? (
            <div className="fb-row-desc" style={{ padding: '16px 0' }}>
              正在读取插件状态…
            </div>
          ) : (
            plugins.map((plugin) => {
              const currentVer = plugin.runningVersion ?? plugin.installedVersion
              const latest = plugin.latest
              const canClickUpdate =
                plugin.installed && plugin.updateAvailable && plugin.hotReloadSupported && !isBusy
              return (
                <div key={plugin.id} className="fb-update-plugin-row">
                  <div className="fb-update-plugin-main">
                    <div className="fb-update-plugin-title">
                      <span>{plugin.displayName}</span>
                      <span className="fb-mono fb-update-pkg">{plugin.packageName}</span>
                      <Tag tone={sourceTagTone(plugin.sourceKind)}>{plugin.sourceLabel}</Tag>
                    </div>
                    <div className="fb-update-plugin-meta fb-num">
                      <span>当前：{currentVer ? `v${currentVer}` : '未安装'}</span>
                      {latest && (
                        <>
                          <span> · </span>
                          <a
                            className="fb-update-link"
                            href={latest.releaseUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            最新：{latest.tagName}
                          </a>
                          {latest.publishedAt && <span>（{formatIsoTime(latest.publishedAt)}）</span>}
                        </>
                      )}
                      {plugin.updateAvailable && <Tag tone="info">可更新</Tag>}
                      {!plugin.updateAvailable && latest && plugin.installed && (
                        <Tag tone="quiet">已是最新</Tag>
                      )}
                    </div>
                    {plugin.checkError && (
                      <div className="fb-update-plugin-hint">{plugin.checkError}</div>
                    )}
                    {plugin.updateBlockedReason && plugin.installed && (
                      <div className="fb-update-plugin-hint">{plugin.updateBlockedReason}</div>
                    )}
                    {latest?.releaseNotes && plugin.updateAvailable && (
                      <pre className="fb-update-notes">{latest.releaseNotes}</pre>
                    )}
                  </div>
                  <div className="fb-update-plugin-action">
                    <Button
                      size="sm"
                      variant={plugin.updateAvailable ? 'primary' : 'outline'}
                      disabled={!canClickUpdate}
                      onClick={() => void handleUpdate(plugin.id)}
                    >
                      {activeOpId && operation?.currentTarget === plugin.id
                        ? '更新中…'
                        : plugin.updateAvailable
                          ? '更新'
                          : '最新'}
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="fb-schedule-dialog-foot">
        {updatableHotPlugins.length > 1 && (
          <Button
            variant="primary"
            disabled={isBusy}
            onClick={() => void handleUpdate('all')}
          >
            {activeOpId ? '更新中…' : `全部热更新（${updatableHotPlugins.length}）`}
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      </div>
    </Modal>
  )
}
