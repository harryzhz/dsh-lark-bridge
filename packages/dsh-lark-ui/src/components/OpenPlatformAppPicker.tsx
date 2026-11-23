import { useMemo, useState } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BotRecord, OpenPlatformAppItem, QrJobView } from '../types.js'
import { Avatar } from './fields.js'

function appStatusTag(app: OpenPlatformAppItem, connected: boolean): { label: string; tone: 'quiet' | 'warning' } | null {
  if (connected) return { label: '已接入', tone: 'quiet' }
  if (!app.hasBotAbility) return { label: '未开启机器人', tone: 'warning' }
  if (app.appStatus === 0) return { label: '未发布', tone: 'quiet' }
  if (app.appStatus === 3) return { label: '已停用', tone: 'warning' }
  return null
}

function appWarningMessage(app: OpenPlatformAppItem | undefined): string | null {
  if (!app) return null
  if (!app.hasBotAbility) return '该应用尚未在飞书开放平台开启「机器人」能力，接入后可能无法收发消息'
  if (app.appStatus === 0) return '该应用尚未发布版本，接入后需在飞书开放平台发布启用'
  if (app.appStatus === 3) return '该应用当前处于已停用状态，接入后需在飞书开放平台重新启用'
  return null
}

export function OpenPlatformAppPicker({
  authenticated,
  apps,
  bots,
  loading,
  loadError,
  selectedAppId,
  loginJob,
  startingLogin,
  onSelect,
  onRefresh,
  onStartLogin,
}: {
  authenticated: boolean
  apps: readonly OpenPlatformAppItem[]
  bots: readonly BotRecord[]
  loading: boolean
  loadError: string
  selectedAppId: string
  loginJob: QrJobView | null
  startingLogin: boolean
  onSelect: (app: OpenPlatformAppItem) => void
  onRefresh: () => void
  onStartLogin: () => void
}) {
  const [query, setQuery] = useState('')

  const connectedByAppId = useMemo(() => {
    const map = new Map<string, string>()
    for (const bot of bots) {
      if (bot.larkAppId) map.set(bot.larkAppId, bot.name)
    }
    return map
  }, [bots])

  const filteredApps = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? apps.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.appId.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        )
      : [...apps]
    return matched.sort((a, b) => {
      const aConn = a.alreadyConnected || connectedByAppId.has(a.appId) ? 1 : 0
      const bConn = b.alreadyConnected || connectedByAppId.has(b.appId) ? 1 : 0
      return aConn - bConn
    })
  }, [apps, query, connectedByAppId])

  const selectedApp = useMemo(
    () => apps.find((a) => a.appId === selectedAppId),
    [apps, selectedAppId],
  )

  if (!authenticated) {
    const showQr = Boolean(loginJob && loginJob.status !== 'succeeded')
    return (
      <div className="fb-op-apps-panel">
        {showQr && loginJob ? (
          <div className="fb-qr-panel">
            {loginJob.qrSvgDataUrl && (
              <img className="fb-qr-img" src={loginJob.qrSvgDataUrl} alt="飞书开放平台登录二维码" />
            )}
            <div className="fb-qr-info">
              <div style={{ fontWeight: 500 }}>开放平台扫码登录</div>
              <div className="fb-row-desc">{loginJob.stepMessage}</div>
              {(loginJob.status === 'expired' || loginJob.status === 'failed') && (
                <div>
                  <Button size="sm" variant="outline" disabled={startingLogin} onClick={onStartLogin}>
                    刷新二维码
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="fb-banner">
            <div>
              <div className="fb-row-title">尚未登录飞书开放平台</div>
              <div className="fb-row-desc">扫码登录后自动读取已有应用列表，选中即可接入，无需手动填写基本信息与凭证</div>
            </div>
            <Button size="sm" variant="primary" disabled={startingLogin} onClick={onStartLogin}>
              {startingLogin ? '准备中…' : '扫码登录'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  const warning = appWarningMessage(selectedApp)

  return (
    <div className="fb-op-apps-panel">
      <div className="fb-op-apps-toolbar">
        <Input
          className="fb-search"
          icon={<IconSearchOutlineRegular size={15} />}
          placeholder="搜索应用名称或 App ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          icon={<IconRefreshOutlineRegular size={14} />}
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? '加载中…' : '刷新'}
        </Button>
      </div>

      <div className="fb-op-apps-list" role="listbox" aria-label="飞书开放平台已有应用">
        {loading && apps.length === 0 ? (
          <div className="fb-op-apps-empty">正在加载开放平台应用列表…</div>
        ) : loadError && apps.length === 0 ? (
          <div className="fb-op-apps-empty">
            <div>加载应用列表失败：{loadError}</div>
            <Button size="sm" variant="outline" onClick={onRefresh}>
              重试
            </Button>
          </div>
        ) : apps.length === 0 ? (
          <div className="fb-op-apps-empty">当前账号在飞书开放平台暂无已有应用</div>
        ) : filteredApps.length === 0 ? (
          <div className="fb-op-apps-empty">未找到匹配的飞书应用</div>
        ) : (
          filteredApps.map((app) => {
            const connectedName = connectedByAppId.get(app.appId) || app.connectedBotName
            const connected = app.alreadyConnected || Boolean(connectedName)
            const selected = !connected && app.appId === selectedAppId
            const tag = appStatusTag(app, connected)
            const metaText = [app.appId, app.description].filter(Boolean).join(' · ')
            return (
              <button
                key={app.appId}
                type="button"
                role="option"
                aria-selected={selected}
                className="fb-op-app-item"
                data-selected={selected ? '' : undefined}
                disabled={connected}
                onClick={() => onSelect(app)}
              >
                <Avatar src={app.avatarUrl} name={app.name} kind="bot" size="sm" />
                <div className="fb-op-app-main">
                  <div className="fb-op-app-title">
                    <span className="fb-op-app-name">{app.name}</span>
                    {tag && <Tag tone={tag.tone}>{tag.label}</Tag>}
                  </div>
                  <div className="fb-op-app-meta" title={metaText}>
                    <span className="fb-mono">{app.appId}</span>
                    {app.description ? ` · ${app.description}` : ''}
                  </div>
                </div>
                {selected && (
                  <span className="fb-op-app-check" aria-hidden="true">
                    <IconCheckOutlineRegular size={16} />
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>

      {warning && <div className="fb-op-apps-note">{warning}</div>}
    </div>
  )
}
