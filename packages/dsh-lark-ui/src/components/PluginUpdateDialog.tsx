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
export const PENDING_SELF_RELOAD_STORAGE_KEY = 'dsh-lark-bridge:pending-self-reload'

function markPendingSelfReload(operationId: string): void {
  try {
    window.sessionStorage.setItem(
      PENDING_SELF_RELOAD_STORAGE_KEY,
      JSON.stringify({ operationId, at: Date.now() }),
    )
  } catch {
    // Ignore storage restriction.
  }
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
      return { label: '卸载旧版', tone: 'info' }
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

export function PluginUpdateDialog({
  open,
  overview,
  onClose,
  onCheck,
  onUpdated,
}: {
  open: boolean
  overview: PluginUpdatesOverview | null
  onClose: () => void
  onCheck: (force?: boolean) => Promise<PluginUpdatesOverview | null>
  onUpdated: (message: string, ok: boolean) => Promise<void>
}) {
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
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
          await onCheck(true)
          await onUpdated(next.message, next.status === 'succeeded')
        }
      } catch {
        if (cancelled) return
        // During self-reload (`removeBundle` -> `installBundle`), `/api/lark-bridge-rpc` briefly returns 404/network error.
        misses += 1
        setReconnecting(true)
        if (misses >= 60) {
          setActionError('等待新版本恢复超时，请刷新页面查看当前插件状态')
          setReconnecting(false)
        }
      }
    }
    const timer = window.setInterval(() => void poll(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, activeOpId, onCheck, onUpdated])

  if (!open) return null

  const plugins = overview?.plugins ?? []
  const isBusy = checking || starting || Boolean(activeOpId)
  const updatableHotPlugins = plugins.filter((p) => p.updateAvailable && p.hotReloadSupported)

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

  const handleUpdate = async (target: ManagedPluginId | 'all') => {
    setStarting(true)
    setActionError('')
    setReconnecting(false)
    try {
      const op = await bridgeApi.startPluginUpdate({ target })
      if (op.items.some((item) => item.id === 'bridge')) {
        markPendingSelfReload(op.operationId)
      }
      setOperation(op)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const opMeta = operation ? opStateLabel(operation.status) : null

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
                : '更新过程会自动校验 SHA256、排空在途飞书回复并支持失败回滚'
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

        {actionError && <div className="fb-update-error">{actionError}</div>}

        {operation && opMeta && (
          <div className="fb-update-op-card">
            <div className="fb-update-op-head">
              <Tag tone={opMeta.tone}>{opMeta.label}</Tag>
              <span className="fb-update-op-msg">
                {reconnecting ? '正在热重载新版插件，等待服务恢复连接…' : operation.message}
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
