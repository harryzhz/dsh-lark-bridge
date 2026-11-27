import { useMemo, useState } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import { Avatar } from '../components/fields.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from '../components/options.js'
import { formatTime } from '../state.js'
import type {
  AuditEventKind,
  CockpitPayload,
  DiagnosticAlert,
  ModelGroup,
  PluginUpdatesOverview,
  RuntimeOption,
} from '../types.js'
import { KpiCard, MiniRatioMeter, OverviewHourlyChart } from './ObservabilityCharts.js'
import { formatLatencyMs } from './observability-model.js'

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
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Record<string, boolean>>({})

  const inboundSpark = useMemo(
    () => (cockpit?.hourlySeries ?? []).map((h) => h.inbound),
    [cockpit],
  )
  const repliedSpark = useMemo(
    () => (cockpit?.hourlySeries ?? []).map((h) => h.replied),
    [cockpit],
  )
  const latencySpark = useMemo(
    () => (cockpit?.hourlySeries ?? []).map((h) => h.avgLatencyMs ?? 0),
    [cockpit],
  )

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
  const silent24h = summary.silentSkipped24h ?? 0
  const peakCount = summary.peakHourlyCount ?? Math.max(0, ...slotTotals)
  const firstHour = hourlySeries[0]?.label ?? ''
  const lastHour = hourlySeries[hourlySeries.length - 1]?.label ?? ''

  return (
    <div className="fb-obs-stack">
      {updatablePlugins.length > 0 && onOpenPluginUpdates && (
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
                  ? '支持原地免重启热更新，飞书桥接升级不中断在途会话'
                  : pluginUpdates?.hotReloadUnavailableReason || '点击查看插件更新详情'}
              </div>
            </div>
            <Button size="sm" variant="primary" onClick={onOpenPluginUpdates}>
              查看并更新
            </Button>
          </div>
        </div>
      )}

      {visibleAlerts.length > 0 && (
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
      )}

      <div className="fb-obs-kpi-grid">
        <KpiCard
          label="智能体在线"
          value={`${summary.onlineBots}`}
          unit={`/ ${summary.totalBots}`}
          delta={{
            text: summary.serviceHealthy ? 'ONLINE' : 'DEGRADED',
            tone: summary.serviceHealthy ? 'good' : 'bad',
          }}
          visual={
            <MiniRatioMeter
              online={summary.onlineBots}
              total={summary.totalBots}
              healthy={summary.serviceHealthy}
            />
          }
          foot={summary.serviceHealthy ? '飞书长连接运行正常' : '存在未连接智能体'}
        />
        <KpiCard
          label="24H 消息吞吐"
          value={`${summary.inbound24h}`}
          unit={`→ ${summary.replied24h}`}
          delta={{
            text: `${summary.successRate24h}%`,
            tone:
              summary.successRate24h >= 98
                ? 'good'
                : summary.successRate24h >= 95
                  ? 'neutral'
                  : 'bad',
          }}
          spark={inboundSpark}
          sparkTone="primary"
          foot={
            silent24h > 0
              ? `静默 ${silent24h} · 异常 ${summary.errors24h}`
              : `回复 ${summary.replied24h} · 异常 ${summary.errors24h}`
          }
        />
        <KpiCard
          label="活跃会话"
          value={`${summary.activeBindings}`}
          tag={`监听 ${summary.activeListeners} 群`}
          spark={repliedSpark}
          sparkTone="success"
          foot={
            topGroups.length > 0
              ? `活跃渠道 ${topGroups.length} · 峰值 ${peakCount}/h`
              : `主动监听 ${summary.activeListeners} 个群`
          }
        />
        <KpiCard
          label="24H 对话响应"
          value={formatLatencyMs(summary.avgLatencyMs)}
          tag={summary.p95LatencyMs > 0 ? `P95 ${formatLatencyMs(summary.p95LatencyMs)}` : '24H'}
          spark={latencySpark}
          sparkTone="warn"
          foot={(() => {
            const interactiveSamples = summary.interactiveLatencySamples24h ?? 0
            const queuedReplies = summary.queuedReplies24h ?? 0
            const avgQueueWait = summary.avgQueueWaitMs24h ?? 0
            const avgExec = summary.avgExecMs24h ?? 0
            const proactiveSamples = summary.proactiveSamples24h ?? 0
            const proactiveAvg = summary.proactiveAvgLatencyMs24h ?? 0
            if (summary.avgLatencyMs <= 0 && summary.p95LatencyMs <= 0) {
              return proactiveSamples > 0
                ? `仅后台任务 ${proactiveSamples} 次（均耗 ${formatLatencyMs(proactiveAvg)}）`
                : '近 24 小时暂无对话样本'
            }
            if (queuedReplies > 0 && avgQueueWait >= 500) {
              return `含排队均 ${formatLatencyMs(avgQueueWait)} · 执行均 ${formatLatencyMs(avgExec)}`
            }
            if (proactiveSamples > 0) {
              return `实时对话${interactiveSamples > 0 ? ` ${interactiveSamples} 次` : ''} · 后台均 ${formatLatencyMs(proactiveAvg)}`
            }
            return `实时对话${interactiveSamples > 0 ? ` ${interactiveSamples} 次` : ''} · 成功率 ${summary.successRate24h}%`
          })()}
        />
      </div>

      <section className="fb-card fb-obs-panel">
        <div className="fb-obs-panel-head">
          <div className="fb-obs-panel-title-wrap">
            <h2 className="fb-obs-panel-title">近 24 小时消息与通知趋势</h2>
            <span className="fb-obs-panel-sub fb-mono">
              {firstHour && lastHour ? `${firstHour}–${lastHour}` : '24H HOURLY'}
              {peakCount > 0 ? ` · PEAK ${peakCount}/H` : ''}
            </span>
          </div>
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
        <OverviewHourlyChart
          hourlySeries={hourlySeries}
          inboundTotal={summary.inbound24h}
          repliedTotal={summary.replied24h}
          silentTotal={silent24h}
          errorTotal={summary.errors24h}
          peakCount={peakCount}
        />
      </section>

      <div className="fb-obs-grid-2">
        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">智能体</h2>
              <span className="fb-obs-panel-sub fb-mono">
                {summary.onlineBots}/{summary.totalBots} ONLINE
              </span>
            </div>
          </div>
          <div className="fb-obs-list">
            {botRows.length === 0 && <div className="fb-obs-empty-inline">暂无智能体</div>}
            {botRows.map((b) => (
              <div key={b.botId} className="fb-obs-list-item">
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
                    · 工作区 {b.workspaceName} · 收到 {b.inboundTotal} · 均耗 {formatLatencyMs(b.avgLatencyMs)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">活跃群聊</h2>
              <span className="fb-obs-panel-sub fb-mono">
                TOP {Math.min(5, topGroups.length)}
              </span>
            </div>
          </div>
          <div className="fb-obs-list">
            {topGroups.length === 0 && <div className="fb-obs-empty-inline">暂无群聊消息</div>}
            {topGroups.slice(0, 5).map((g) => (
              <div key={g.key} className="fb-obs-list-item">
                <div className="fb-item-main">
                  <div className="fb-item-title">
                    <span title={g.chatName}>{g.chatName}</span>
                  </div>
                  <div className="fb-item-meta">
                    {g.botName} · 工作区 {g.workspaceName} · 收到 {g.inboundTotal} · 回复 {g.repliedTotal}
                  </div>
                </div>
                {g.activeSessions > 0 && <Tag tone="info">{g.activeSessions} 活跃</Tag>}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="fb-card fb-obs-panel">
        <div className="fb-obs-panel-head">
          <div className="fb-obs-panel-title-wrap">
            <h2 className="fb-obs-panel-title">最近动态</h2>
            <span className="fb-obs-panel-sub fb-mono">
              LATEST {Math.min(8, recentEvents.length)}
            </span>
          </div>
        </div>
        <div className="fb-obs-list">
          {recentEvents.length === 0 && <div className="fb-obs-empty-inline">暂无动态</div>}
          {recentEvents.slice(0, 8).map((e) => (
            <div key={e.id} className="fb-obs-list-item">
              {eventTag(e.kind)}
              <div className="fb-item-main">
                <div
                  className="fb-item-meta"
                  title={e.summary}
                  style={{ color: 'var(--dsw-alias-label-primary)', fontSize: 13 }}
                >
                  {e.chatName ? `${e.chatName} · ` : ''}
                  {e.summary}
                </div>
              </div>
              <span className="fb-item-time fb-mono">{formatTime(e.timestampMs)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
