import { useState } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import { Avatar } from '../components/fields.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from '../components/options.js'
import { formatDuration, formatTime } from '../state.js'
import type {
  AuditEventKind,
  CockpitPayload,
  DiagnosticAlert,
  ModelGroup,
  PluginUpdatesOverview,
  RuntimeOption,
} from '../types.js'

const EVENT_TONE: Record<AuditEventKind, { label: string; tone: 'neutral' | 'success' | 'info' | 'warning' | 'danger' | 'quiet' }> = {
  inbound: { label: '收到', tone: 'info' },
  triage: { label: '分流', tone: 'info' },
  reply: { label: '回复', tone: 'success' },
  silent_skip: { label: '静默', tone: 'neutral' },
  command: { label: '命令', tone: 'neutral' },
  ignored: { label: '过滤', tone: 'quiet' },
  error: { label: '异常', tone: 'danger' },
  lifecycle: { label: '连接', tone: 'neutral' },
}

export function eventTag(kind: AuditEventKind) {
  const meta = EVENT_TONE[kind]
  return <Tag tone={meta.tone}>{meta.label}</Tag>
}

export function OverviewView({
  cockpit,
  runtimes,
  models,
  pluginUpdates,
  onOpenPluginUpdates,
  onOpenObservability,
}: {
  cockpit: CockpitPayload | null
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  pluginUpdates?: PluginUpdatesOverview | null
  onOpenPluginUpdates?: () => void
  onOpenObservability?: () => void
}) {
  const [hoveredHourKey, setHoveredHourKey] = useState<string | null>(null)
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Record<string, boolean>>({})

  if (!cockpit) return <div className="fb-card fb-empty">加载中…</div>
  const { summary, hourlySeries, botRows, topGroups, recentEvents } = cockpit
  const visibleAlerts = (cockpit.alerts ?? []).filter(
    (a) => a.severity !== 'info' && !dismissedAlertIds[a.id],
  )
  const updatablePlugins = (pluginUpdates?.plugins ?? []).filter((p) => p.updateAvailable)
  const handleAckAlert = async (alert: DiagnosticAlert) => {
    setDismissedAlertIds((prev) => ({ ...prev, [alert.id]: true }))
    if (alert.code === 'split_brain' && alert.botId) {
      await bridgeApi.clearSplitBrainAlert(alert.botId).catch(() => {})
    }
  }
  const slotTotals = hourlySeries.map((h) => Math.max(h.inbound, h.replied) + h.errors)
  const peak = Math.max(1, ...slotTotals)
  const silent24h = summary.silentSkipped24h ?? 0
  const peakCount = summary.peakHourlyCount ?? Math.max(0, ...slotTotals)
  const hoveredSlot = hoveredHourKey ? hourlySeries.find((h) => h.hourKey === hoveredHourKey) : undefined

  const firstHour = hourlySeries[0]?.label ?? ''
  const lastHour = hourlySeries[hourlySeries.length - 1]?.label ?? ''

  return (
    <>
      {updatablePlugins.length > 0 && onOpenPluginUpdates && (
        <section className="fb-section">
          <div className="fb-card fb-alert-card">
            <div className="fb-alert-row">
              <div className="fb-alert-main">
                <div className="fb-alert-head">
                  <Tag tone="info">发现新版本</Tag>
                  <span>
                    {updatablePlugins
                      .map((p) => `${p.displayName} ${p.latest?.tagName ?? ''}`)
                      .join('、')}
                  </span>
                </div>
                <div className="fb-alert-detail">
                  {pluginUpdates?.hotReloadSupported
                    ? '支持原地免重启热更新，点击即可校验发布包并自动排空切换'
                    : pluginUpdates?.hotReloadUnavailableReason || '点击查看插件更新详情'}
                </div>
              </div>
              <Button size="sm" variant="primary" onClick={onOpenPluginUpdates}>
                查看并更新
              </Button>
            </div>
          </div>
        </section>
      )}
      {visibleAlerts.length > 0 && (
        <section className="fb-section">
          <div className="fb-card fb-alert-card">
            {visibleAlerts.map((alert) => (
              <div key={alert.id} className="fb-alert-row">
                <div className="fb-alert-main">
                  <div className="fb-alert-head">
                    <Tag tone={alert.severity === 'error' ? 'danger' : 'warning'}>
                      {alert.severity === 'error' ? '异常' : '告警'}
                    </Tag>
                    <span>{alert.title}</span>
                  </div>
                  <div className="fb-alert-detail">{alert.detail}</div>
                  <div className="fb-alert-hint">{alert.suggestion}</div>
                </div>
                {alert.code === 'split_brain' && alert.botId && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void handleAckAlert(alert)
                    }}
                  >
                    已处理
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="fb-section">
        <div className="fb-stats">
          <Stat label="智能体在线" value={`${summary.onlineBots}`} unit={`/ ${summary.totalBots}`} foot={summary.serviceHealthy ? '连接正常' : '存在离线智能体'} />
          <Stat label="24 小时消息" value={`${summary.inbound24h}`} foot={`回复/推送 ${summary.replied24h} · 成功率 ${summary.successRate24h}%`} />
          <Stat label="活跃会话" value={`${summary.activeBindings}`} foot={`主动监听 ${summary.activeListeners} 个群`} />
          <Stat label="平均响应" value={formatDuration(summary.avgLatencyMs)} foot={`P95 ${formatDuration(summary.p95LatencyMs)}`} />
        </div>
      </section>

      <section className="fb-section">
        <div className="fb-section-head">
          <span className="fb-section-title">近 24 小时消息与通知趋势（按小时）</span>
          <div className="fb-chart-legend fb-num">
            <span className="fb-legend-item">
              <i className="fb-swatch" data-kind="inbound" />
              收到消息 {summary.inbound24h}
            </span>
            <span className="fb-legend-item">
              <i className="fb-swatch" data-kind="replied" />
              回复/推送 {summary.replied24h}
            </span>
            {silent24h > 0 && (
              <span className="fb-legend-item">
                静默跳过 {silent24h}
              </span>
            )}
            {summary.errors24h > 0 && (
              <span className="fb-legend-item">
                <i className="fb-swatch" data-kind="error" />
                异常 {summary.errors24h}
              </span>
            )}
            {onOpenObservability && (
              <button
                type="button"
                className="fb-inline-jump"
                onClick={onOpenObservability}
              >
                查看洞察 →
              </button>
            )}
          </div>
        </div>
        <div className="fb-card fb-chart">
          <div className="fb-chart-caption fb-num">
            {hoveredSlot ? (
              <span>
                <strong>{hoveredSlot.label}–{hoveredSlot.label.slice(0, 2)}:59</strong>
                {` · 收到 ${hoveredSlot.inbound} 条 · 回复/推送 ${hoveredSlot.replied} 条`}
                {(hoveredSlot.silentSkipped ?? 0) > 0 ? ` · 静默 ${hoveredSlot.silentSkipped} 条` : ''}
                {hoveredSlot.errors > 0 ? ` · 异常 ${hoveredSlot.errors} 条` : ''}
                {(hoveredSlot.avgLatencyMs ?? 0) > 0 ? ` · 均耗 ${formatDuration(hoveredSlot.avgLatencyMs!)}` : ''}
              </span>
            ) : peakCount > 0 ? (
              <span>
                {`统计窗口 ${firstHour} 至 ${lastHour}（当前小时） · 小时峰值 ${peakCount} 条 · 悬停柱条查看单小时明细`}
              </span>
            ) : (
              <span>过去 24 小时暂无飞书消息或定时通知记录</span>
            )}
          </div>

          <div className="fb-bars" onMouseLeave={() => setHoveredHourKey(null)}>
            {hourlySeries.map((h, idx) => {
              const activity = Math.max(h.inbound, h.replied)
              const total = activity + h.errors
              const isCurrentHour = idx === hourlySeries.length - 1
              const isHovered = hoveredHourKey === h.hourKey
              return (
                <div
                  key={h.hourKey}
                  className="fb-bar-col"
                  data-active={isHovered ? '' : undefined}
                  onMouseEnter={() => setHoveredHourKey(h.hourKey)}
                >
                  <span className="fb-bar-val fb-num">{total > 0 ? total : ''}</span>
                  <div className="fb-bar" data-current={isCurrentHour ? '' : undefined}>
                    {h.errors > 0 && (
                      <div
                        className="fb-bar-error"
                        style={{ height: `${Math.max(8, (h.errors / peak) * 100)}%` }}
                      />
                    )}
                    {h.inbound > 0 ? (
                      <div
                        className="fb-bar-fill"
                        style={{ height: `${Math.max(10, (h.inbound / peak) * 100)}%` }}
                      />
                    ) : h.replied > 0 ? (
                      <div
                        className="fb-bar-reply"
                        style={{ height: `${Math.max(10, (h.replied / peak) * 100)}%` }}
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="fb-bar-axis">
            {hourlySeries.map((h, i) => {
              const isLast = i === hourlySeries.length - 1
              const showLabel = i % 4 === 0 || isLast
              // Avoid overlapping the penultimate label if right next to last
              if (!isLast && i >= hourlySeries.length - 2) return <span key={h.hourKey} />
              return <span key={h.hourKey}>{showLabel ? h.label : ''}</span>
            })}
          </div>
        </div>
      </section>

      <div className="fb-split fb-section">
        <section>
          <div className="fb-section-head">
            <span className="fb-section-title">智能体</span>
          </div>
          <div className="fb-card fb-list">
            {botRows.length === 0 && <div className="fb-empty">暂无智能体</div>}
            {botRows.map((b) => (
              <div key={b.botId} className="fb-item">
                <Avatar src={b.avatarUrl} name={b.name} kind="bot" size="sm" />
                <div className="fb-item-main">
                  <div className="fb-item-title">
                    <span>{b.name}</span>
                    <StateDot state={b.connected ? 'done' : b.enabled ? 'error' : 'idle'} />
                  </div>
                  <div className="fb-item-meta">
                    {resolveRuntimeDisplayName(b.agentPreset, runtimes, b.runtimeProfileId)}
                    {(() => {
                      const label = resolveModelDisplayName(b.agentPreset, b.model, runtimes, models)
                      return label ? ` · ${label}` : ''
                    })()}{' '}
                    · 工作区 {b.workspaceName} · 收到 {b.inboundTotal} · 均耗 {formatDuration(b.avgLatencyMs)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section>
          <div className="fb-section-head">
            <span className="fb-section-title">活跃群聊</span>
          </div>
          <div className="fb-card fb-list">
            {topGroups.length === 0 && <div className="fb-empty">暂无群聊消息</div>}
            {topGroups.slice(0, 5).map((g) => (
              <div key={g.key} className="fb-item">
                <div className="fb-item-main">
                  <div className="fb-item-title">
                    <span title={g.chatName}>{g.chatName}</span>
                  </div>
                  <div className="fb-item-meta">
                    {g.botName} · 工作区 {g.workspaceName} · 收到 {g.inboundTotal} · 回复 {g.repliedTotal}
                  </div>
                </div>
                {g.activeSessions > 0 && <Tag tone="info">{g.activeSessions} 个会话</Tag>}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="fb-section">
        <div className="fb-section-head">
          <span className="fb-section-title">最近动态</span>
        </div>
        <div className="fb-card fb-list">
          {recentEvents.length === 0 && <div className="fb-empty">暂无动态</div>}
          {recentEvents.slice(0, 8).map((e) => (
            <div key={e.id} className="fb-item">
              {eventTag(e.kind)}
              <div className="fb-item-main">
                <div className="fb-item-meta" title={e.summary} style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 13 }}>
                  {e.chatName ? `${e.chatName} · ` : ''}
                  {e.summary}
                </div>
              </div>
              <span className="fb-item-time">{formatTime(e.timestampMs)}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function Stat({ label, value, unit, foot }: { label: string; value: string; unit?: string; foot: string }) {
  return (
    <div className="fb-card fb-stat">
      <div className="fb-stat-label">{label}</div>
      <div className="fb-stat-value">
        {value}
        {unit && <span className="fb-stat-unit">{unit}</span>}
      </div>
      <div className="fb-stat-foot">{foot}</div>
    </div>
  )
}
