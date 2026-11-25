import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconRefreshOutlineRegular,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import {
  Avatar,
  CountSegmentedSwitch,
  FilterTabs,
  resolveEffectiveBotId,
  SelectMenu,
} from '../components/fields.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from '../components/options.js'
import { formatTime } from '../state.js'
import type {
  BotRecord,
  ModelGroup,
  ObservabilityPayload,
  ObservabilityWindow,
  RuntimeOption,
} from '../types.js'
import {
  ActivityHeatmap,
  LatencyHistogram,
  ProductTimeSeriesChart,
  SegmentedBar,
  Sparkline,
  TechnicalTimeSeriesChart,
  type ProductChartMode,
  type SegmentedBarItem,
  type TechChartMode,
} from './ObservabilityCharts.js'
import {
  formatBytes,
  formatCompactNumber,
  formatDeltaBadge,
  formatLatencyMs,
  formatTokens,
  formatUptime,
  OBSERVABILITY_WINDOWS,
  P2P_CHAT_FILTER,
  resolveErrorCodeLabel,
  resolveTableLabel,
  resolveTriggerLabel,
} from './observability-model.js'

type ObservabilityLens = 'product' | 'technical'
type RankingTab = 'bots' | 'chats'

const POLL_IDLE_MS = 15_000
const POLL_BACKFILL_MS = 3_000

function KpiCard({
  label,
  tag,
  value,
  unit,
  foot,
  delta,
  spark,
  sparkTone = 'primary',
}: {
  readonly label: string
  readonly tag?: string
  readonly value: string
  readonly unit?: string
  readonly foot: string
  readonly delta?: { readonly text: string; readonly tone: 'good' | 'bad' | 'neutral' }
  readonly spark?: readonly number[]
  readonly sparkTone?: 'primary' | 'success' | 'warn' | 'danger'
}) {
  return (
    <div className="fb-card fb-obs-kpi">
      <div className="fb-obs-kpi-head">
        <span className="fb-obs-kpi-label">{label}</span>
        {delta ? (
          <span className="fb-obs-delta fb-mono" data-tone={delta.tone}>
            {delta.text}
          </span>
        ) : tag ? (
          <span className="fb-obs-kpi-tag fb-mono">{tag}</span>
        ) : null}
      </div>
      <div className="fb-obs-kpi-mid">
        <div className="fb-obs-kpi-val fb-num">
          <span>{value}</span>
          {unit && <span className="fb-obs-kpi-unit">{unit}</span>}
        </div>
        {spark && <Sparkline values={spark} tone={sparkTone} />}
      </div>
      <div className="fb-obs-kpi-foot fb-num">{foot}</div>
    </div>
  )
}

function ProductObservabilityPane({
  payload,
  runtimes,
  models,
  selectedBotId,
  selectedChatId,
  onSelectBot,
  onSelectChat,
}: {
  readonly payload: ObservabilityPayload
  readonly runtimes: readonly RuntimeOption[]
  readonly models: readonly ModelGroup[]
  readonly selectedBotId: string
  readonly selectedChatId: string
  readonly onSelectBot: (botId: string) => void
  readonly onSelectChat: (chatId: string) => void
}) {
  const [chartMode, setChartMode] = useState<ProductChartMode>('tokens')
  const [rankTab, setRankTab] = useState<RankingTab>('chats')
  const { product, series } = payload
  const { tokens, sessions, traffic, triage, proactive } = product

  const tokenSpark = useMemo(() => series.map((p) => p.totalTokens), [series])
  const sessionSpark = useMemo(() => series.map((p) => p.sessions), [series])
  const trafficSpark = useMemo(() => series.map((p) => p.inbound), [series])
  const replySpark = useMemo(() => series.map((p) => p.replied), [series])

  const tokenAnatomy = useMemo<SegmentedBarItem[]>(() => {
    const denom = Math.max(1, tokens.cacheRead + tokens.input + tokens.cacheWrite + tokens.output)
    const pct = (n: number) => Math.round((n / denom) * 1000) / 10
    return [
      {
        id: 'cache_read',
        label: '缓存命中读取',
        valueText: formatTokens(tokens.cacheRead),
        sharePct: pct(tokens.cacheRead),
        kind: 'cache',
      },
      {
        id: 'input',
        label: '非缓存输入',
        valueText: formatTokens(tokens.input),
        sharePct: pct(tokens.input),
        kind: 'primary',
      },
      {
        id: 'cache_write',
        label: '缓存写入',
        valueText: formatTokens(tokens.cacheWrite),
        sharePct: pct(tokens.cacheWrite),
        kind: 'muted',
      },
      {
        id: 'output',
        label: tokens.reasoning > 0 ? `输出（含思考 ${formatTokens(tokens.reasoning)}）` : '模型输出',
        valueText: formatTokens(tokens.output),
        sharePct: pct(tokens.output),
        kind: 'output',
      },
    ]
  }, [tokens])

  const proactiveTotal = proactive.scheduleRuns + proactive.reminderRuns + proactive.dreamRuns
  const maxTriggerCount = Math.max(1, ...product.triggers.map((t) => t.count))

  return (
    <div className="fb-obs-stack">
      <div className="fb-obs-kpi-grid">
        <KpiCard
          label="TOKEN 消耗"
          value={formatTokens(tokens.total)}
          delta={formatDeltaBadge(tokens.deltaPct)}
          spark={tokenSpark}
          sparkTone="primary"
          foot={`缓存命中 ${tokens.cacheHitRate}% · 单轮均耗 ${formatTokens(tokens.avgPerReply)}`}
        />
        <KpiCard
          label="活跃会话"
          value={formatCompactNumber(sessions.activeInWindow)}
          delta={formatDeltaBadge(sessions.deltaPct)}
          spark={sessionSpark}
          sparkTone="primary"
          foot={`新建 ${sessions.createdInWindow} · 在线绑定 ${sessions.liveBindings} · 归档 ${sessions.archivedInWindow}`}
        />
        <KpiCard
          label="消息与回复"
          value={formatCompactNumber(traffic.inbound)}
          unit={`→ ${formatCompactNumber(traffic.replied)}`}
          delta={formatDeltaBadge(traffic.deltaPct)}
          spark={trafficSpark}
          sparkTone="success"
          foot={`静默 ${traffic.silentSkipped} · 过滤 ${traffic.ignored} · 工具调用 ${formatCompactNumber(traffic.toolCalls)}`}
        />
        <KpiCard
          label="分流减负率"
          value={triage.total > 0 ? `${triage.deflectRate}%` : '—'}
          tag={triage.total > 0 ? `${triage.total} 次分流` : '未触发'}
          spark={replySpark}
          sparkTone="success"
          foot={
            triage.total > 0
              ? `静默 ${triage.silent} · 快回 ${triage.quickReply} · 移交 ${triage.handoff} · 均耗 ${formatLatencyMs(triage.avgLatencyMs)}`
              : `主动执行 ${proactiveTotal} 次 · 有效记忆 ${proactive.activeMemories} 条`
          }
        />
      </div>

      <section className="fb-card fb-obs-panel">
        <div className="fb-obs-panel-head">
          <div className="fb-obs-panel-title-wrap">
            <h2 className="fb-obs-panel-title">周期使用趋势</h2>
            <span className="fb-obs-panel-sub fb-mono">
              {chartMode === 'tokens'
                ? `${formatTokens(tokens.total)} TOKENS`
                : chartMode === 'traffic'
                  ? `${traffic.inbound} IN / ${traffic.replied} OUT`
                  : `${sessions.activeInWindow} SESSIONS / ${traffic.llmSteps} STEPS`}
            </span>
          </div>
          <FilterTabs
            label="产品趋势指标切换"
            value={chartMode}
            options={[
              { value: 'tokens' as const, label: 'Token 消耗' },
              { value: 'traffic' as const, label: '消息吞吐' },
              { value: 'sessions' as const, label: '会话与步数' },
            ]}
            onChange={setChartMode}
          />
        </div>
        <ProductTimeSeriesChart series={series} mode={chartMode} />
      </section>

      <div className="fb-obs-grid-64">
        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">Token 结构与模型消耗</h2>
              <span className="fb-obs-panel-sub fb-mono">CACHE HIT {tokens.cacheHitRate}%</span>
            </div>
          </div>

          <SegmentedBar items={tokenAnatomy} />

          <div className="fb-obs-divider" />

          {product.models.length === 0 ? (
            <div className="fb-obs-empty-inline">
              当前周期暂无模型 Token 采样，完成一次对话或等待历史会话索引完成后呈现
            </div>
          ) : (
            <div className="fb-obs-table-wrap">
              <table className="fb-obs-table fb-num">
                <thead>
                  <tr>
                    <th>模型 / 运行时</th>
                    <th className="fb-obs-tr">步数</th>
                    <th className="fb-obs-tr">输入</th>
                    <th className="fb-obs-tr">缓存命中</th>
                    <th className="fb-obs-tr">输出</th>
                    <th className="fb-obs-tr">总量</th>
                  </tr>
                </thead>
                <tbody>
                  {product.models.slice(0, 7).map((m) => (
                    <tr key={`${m.provider}::${m.model}`}>
                      <td>
                        <div className="fb-obs-cell-stack">
                          <span className="fb-obs-cell-main" title={m.model}>
                            {resolveModelDisplayName(m.agentPreset, m.model, runtimes, models) || m.model}
                          </span>
                          <span className="fb-obs-cell-sub fb-mono">
                            {[
                              m.agentPreset ? resolveRuntimeDisplayName(m.agentPreset, runtimes) : '',
                              m.provider,
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </span>
                        </div>
                      </td>
                      <td className="fb-obs-tr fb-mono">{m.steps}</td>
                      <td className="fb-obs-tr fb-mono">
                        {formatTokens(m.inputTokens + m.cacheWriteTokens)}
                      </td>
                      <td className="fb-obs-tr">
                        <span
                          className="fb-obs-pill fb-mono"
                          data-tone={m.cacheHitRate >= 50 ? 'good' : 'neutral'}
                        >
                          {m.cacheHitRate}%
                        </span>
                      </td>
                      <td className="fb-obs-tr fb-mono">{formatTokens(m.outputTokens)}</td>
                      <td className="fb-obs-tr">
                        <div className="fb-obs-bar-num">
                          <strong className="fb-mono">{formatTokens(m.totalTokens)}</strong>
                          <div className="fb-obs-mini-track">
                            <div
                              className="fb-obs-mini-fill"
                              style={{ width: `${Math.max(4, m.sharePct)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">分流漏斗与触发渠道</h2>
              <span className="fb-obs-panel-sub fb-mono">
                {triage.total > 0 ? `${triage.total} TRIAGE` : 'ROUTING'}
              </span>
            </div>
          </div>

          <div className="fb-obs-funnel fb-num">
            <div className="fb-obs-funnel-row">
              <span className="fb-obs-funnel-label">静默拦截（免唤醒）</span>
              <div className="fb-obs-funnel-bar">
                <div
                  className="fb-obs-funnel-fill"
                  data-kind="cache"
                  style={{
                    width: `${triage.total > 0 ? Math.max(2, (triage.silent / triage.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="fb-obs-funnel-val fb-mono">{triage.silent}</span>
            </div>
            <div className="fb-obs-funnel-row">
              <span className="fb-obs-funnel-label">轻量直出快回</span>
              <div className="fb-obs-funnel-bar">
                <div
                  className="fb-obs-funnel-fill"
                  data-kind="primary"
                  style={{
                    width: `${triage.total > 0 ? Math.max(2, (triage.quickReply / triage.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="fb-obs-funnel-val fb-mono">{triage.quickReply}</span>
            </div>
            <div className="fb-obs-funnel-row">
              <span className="fb-obs-funnel-label">转交主运行时</span>
              <div className="fb-obs-funnel-bar">
                <div
                  className="fb-obs-funnel-fill"
                  data-kind="output"
                  style={{
                    width: `${triage.total > 0 ? Math.max(2, (triage.handoff / triage.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="fb-obs-funnel-val fb-mono">{triage.handoff}</span>
            </div>
            {triage.fallback > 0 && (
              <div className="fb-obs-funnel-row">
                <span className="fb-obs-funnel-label">分流异常回退</span>
                <div className="fb-obs-funnel-bar">
                  <div
                    className="fb-obs-funnel-fill"
                    data-kind="error"
                    style={{
                      width: `${Math.max(4, (triage.fallback / Math.max(1, triage.total)) * 100)}%`,
                    }}
                  />
                </div>
                <span className="fb-obs-funnel-val fb-mono">{triage.fallback}</span>
              </div>
            )}
          </div>

          <div className="fb-obs-divider" />

          <div className="fb-obs-subhead">触发渠道分布</div>
          {product.triggers.length === 0 ? (
            <div className="fb-obs-empty-inline">当前周期暂无触发记录</div>
          ) : (
            <div className="fb-obs-bars-list fb-num">
              {product.triggers.slice(0, 6).map((tr) => (
                <div key={tr.trigger} className="fb-obs-hrow">
                  <div className="fb-obs-hrow-top">
                    <span>{resolveTriggerLabel(tr.trigger)}</span>
                    <span className="fb-mono fb-obs-muted">
                      {tr.count} 次{tr.totalTokens > 0 ? ` · ${formatTokens(tr.totalTokens)}` : ''}
                    </span>
                  </div>
                  <div className="fb-obs-mini-track">
                    <div
                      className="fb-obs-mini-fill"
                      style={{ width: `${Math.max(3, (tr.count / maxTriggerCount) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="fb-obs-grid-2">
        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">活跃节律与主动协作</h2>
              <span className="fb-obs-panel-sub fb-mono">7×24H MATRIX</span>
            </div>
          </div>

          <ActivityHeatmap
            cells={product.heatmap.cells}
            maxCount={product.heatmap.maxCount}
          />

          <div className="fb-obs-divider" />

          <div className="fb-obs-micro-grid fb-num">
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">有效记忆</span>
              <strong className="fb-mono">{proactive.activeMemories}</strong>
              <span className="fb-obs-muted">置顶 {proactive.pinnedMemories}</span>
            </div>
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">记忆累计召回</span>
              <strong className="fb-mono">{proactive.totalMemoryRecalls}</strong>
              <span className="fb-obs-muted">Dream {proactive.dreamRuns} 次</span>
            </div>
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">定时任务</span>
              <strong className="fb-mono">{proactive.configuredSchedules}</strong>
              <span className="fb-obs-muted">周期执行 {proactive.scheduleRuns}</span>
            </div>
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">提醒事项</span>
              <strong className="fb-mono">{proactive.activeReminders}</strong>
              <span className="fb-obs-muted">
                {proactive.pendingConfirmReminders > 0
                  ? `待确认 ${proactive.pendingConfirmReminders}`
                  : `已执行 ${proactive.reminderRuns}`}
              </span>
            </div>
          </div>
        </section>

        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">维度消耗排行</h2>
              <span className="fb-obs-panel-sub">点击条目下钻筛选</span>
            </div>
            <FilterTabs
              label="排行维度切换"
              value={rankTab}
              options={[
                { value: 'chats' as const, label: '群聊 / 私聊', count: product.chatRanking.length },
                { value: 'bots' as const, label: '智能体', count: product.botRanking.length },
              ]}
              onChange={setRankTab}
            />
          </div>

          {rankTab === 'bots' ? (
            product.botRanking.length === 0 ? (
              <div className="fb-obs-empty-inline">暂无智能体数据</div>
            ) : (
              <div className="fb-obs-rank-list fb-num">
                {product.botRanking.map((b) => {
                  const active = selectedBotId === b.botId
                  return (
                    <button
                      key={b.botId}
                      type="button"
                      className="fb-obs-rank-row"
                      data-active={active ? '' : undefined}
                      onClick={() => onSelectBot(active ? '' : b.botId)}
                    >
                      <Avatar src={b.avatarUrl} name={b.name} kind="bot" size="sm" />
                      <div className="fb-obs-rank-main">
                        <div className="fb-obs-rank-title">
                          <span>{b.name}</span>
                          <StateDot state={b.connected ? 'done' : b.enabled ? 'error' : 'idle'} />
                        </div>
                        <div className="fb-obs-rank-meta">
                          会话 {b.sessions} · 回复 {b.replied} · 缓存 {b.cacheHitRate}% · 均耗{' '}
                          {formatLatencyMs(b.avgLatencyMs)}
                        </div>
                      </div>
                      <div className="fb-obs-rank-side fb-mono">
                        <strong>{formatTokens(b.totalTokens)}</strong>
                        <span className="fb-obs-muted">tok</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          ) : product.chatRanking.length === 0 ? (
            <div className="fb-obs-empty-inline">当前周期暂无群聊或私聊数据</div>
          ) : (
            <div className="fb-obs-rank-list fb-num">
              {product.chatRanking.slice(0, 8).map((c) => {
                const targetFilter = c.chatType === 'p2p' ? P2P_CHAT_FILTER : c.chatId
                const active = selectedChatId === targetFilter
                return (
                  <button
                    key={c.key}
                    type="button"
                    className="fb-obs-rank-row"
                    data-active={active ? '' : undefined}
                    onClick={() => onSelectChat(active ? '' : targetFilter)}
                  >
                    <div className="fb-obs-rank-main">
                      <div className="fb-obs-rank-title">
                        <span title={c.chatName}>{c.chatName}</span>
                        {c.chatType === 'p2p' && <Tag tone="neutral">私聊</Tag>}
                        {c.activeBindings > 0 && <Tag tone="info">{c.activeBindings} 活跃</Tag>}
                      </div>
                      <div className="fb-obs-rank-meta">
                        {c.botName} · 会话 {c.sessions} · 收到 {c.inbound} · 回复 {c.replied}
                        {c.errors > 0 ? ` · 异常 ${c.errors}` : ''}
                      </div>
                    </div>
                    <div className="fb-obs-rank-side fb-mono">
                      <strong>{formatTokens(c.totalTokens)}</strong>
                      <span className="fb-obs-muted">{formatLatencyMs(c.avgLatencyMs)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function TechnicalObservabilityPane({
  payload,
  compacting,
  onCheckpointWal,
}: {
  readonly payload: ObservabilityPayload
  readonly compacting: boolean
  readonly onCheckpointWal: () => void
}) {
  const [chartMode, setChartMode] = useState<TechChartMode>('latency')
  const { technical, series } = payload
  const { sla, latency, connections, runtime, storage, errors } = technical

  const p95Spark = useMemo(() => series.map((p) => p.latencyP95Ms), [series])
  const errSpark = useMemo(() => series.map((p) => p.errors), [series])
  const rssSpark = useMemo(() => runtime.vitalsSeries.map((v) => v.rssBytes), [runtime.vitalsSeries])

  const storageSegments = useMemo<SegmentedBarItem[]>(() => {
    const kindMap: Record<string, SegmentedBarItem['kind']> = {
      dsh_sessions: 'primary',
      bridge_db: 'cache',
      bridge_wal: storage.walBloated ? 'error' : 'warn',
      dsh_attachments: 'output',
      bridge_backups: 'muted',
      dsh_logs_storages: 'muted',
      bridge_memory_dream: 'cache',
    }
    return storage.categories.slice(0, 6).map((c) => ({
      id: c.id,
      label: c.label,
      valueText: formatBytes(c.bytes),
      sharePct: c.sharePct,
      kind: kindMap[c.id] ?? 'muted',
    }))
  }, [storage])

  return (
    <div className="fb-obs-stack">
      <div className="fb-obs-kpi-grid">
        <KpiCard
          label="回复成功率 (SLA)"
          value={`${sla.successRate}%`}
          delta={formatDeltaBadge(sla.deltaPct, { unit: 'pp' })}
          spark={errSpark}
          sparkTone={sla.successRate >= 98 ? 'success' : sla.successRate >= 95 ? 'warn' : 'danger'}
          foot={`异常 ${sla.totalErrors} · 回退 ${sla.triageFallbackRate}% · 工具失败 ${sla.toolErrorRate}%`}
        />
        <KpiCard
          label="响应延迟 P50 / P95"
          value={formatLatencyMs(latency.p50Ms)}
          unit={`/ ${formatLatencyMs(latency.p95Ms)}`}
          delta={formatDeltaBadge(latency.deltaP95Pct, { invertGood: true })}
          spark={p95Spark}
          sparkTone="warn"
          foot={`P99 ${formatLatencyMs(latency.p99Ms)} · 均值 ${formatLatencyMs(latency.avgMs)} · 样本 ${latency.samples}`}
        />
        <KpiCard
          label="运行时与连接"
          value={`${connections.onlineBots}/${connections.enabledBots}`}
          unit="在线"
          tag={runtime.draining ? 'DRAINING' : `UP ${formatUptime(runtime.uptimeSec)}`}
          spark={rssSpark}
          sparkTone={connections.onlineBots === connections.enabledBots ? 'success' : 'danger'}
          foot={`RSS ${formatBytes(runtime.rssBytes)} · EL P95 ${runtime.eventLoopP95Ms}ms · 在途 ${runtime.activeTurns}`}
        />
        <KpiCard
          label="总存储占用"
          value={formatBytes(storage.totalBytes)}
          tag={storage.walBloated ? 'WAL 偏大' : storage.integrityOk ? 'WAL OK' : 'CHECK ERR'}
          foot={`主库 ${formatBytes(storage.dbBytes)} · WAL ${formatBytes(storage.walBytes)} · DSH ${formatBytes(storage.dshBytes)}`}
        />
      </div>

      <section className="fb-card fb-obs-panel">
        <div className="fb-obs-panel-head">
          <div className="fb-obs-panel-title-wrap">
            <h2 className="fb-obs-panel-title">性能与进程生命体征</h2>
            <span className="fb-obs-panel-sub fb-mono">
              {chartMode === 'latency'
                ? `P50 ${formatLatencyMs(latency.p50Ms)} · P95 ${formatLatencyMs(latency.p95Ms)} · ERR ${sla.totalErrors}`
                : `PID ${runtime.pid} · ${runtime.nodeVersion} · RSS ${formatBytes(runtime.rssBytes)}`}
            </span>
          </div>
          <FilterTabs
            label="技术曲线切换"
            value={chartMode}
            options={[
              { value: 'latency' as const, label: '延迟分位与异常' },
              { value: 'vitals' as const, label: '内存与事件循环' },
            ]}
            onChange={setChartMode}
          />
        </div>
        <TechnicalTimeSeriesChart
          series={series}
          vitals={runtime.vitalsSeries}
          mode={chartMode}
        />
      </section>

      <div className="fb-obs-grid-2">
        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">端到端延迟分布</h2>
              <span className="fb-obs-panel-sub fb-mono">{latency.samples} SAMPLES</span>
            </div>
          </div>

          <div className="fb-obs-percentile-strip fb-mono">
            <span>
              <em className="fb-obs-muted">P50</em> {formatLatencyMs(latency.p50Ms)}
            </span>
            <span>
              <em className="fb-obs-muted">P75</em> {formatLatencyMs(latency.p75Ms)}
            </span>
            <span>
              <em className="fb-obs-muted">P95</em> {formatLatencyMs(latency.p95Ms)}
            </span>
            <span>
              <em className="fb-obs-muted">P99</em> {formatLatencyMs(latency.p99Ms)}
            </span>
            <span>
              <em className="fb-obs-muted">MAX</em> {formatLatencyMs(latency.maxMs)}
            </span>
          </div>

          <LatencyHistogram buckets={latency.histogram} />

          <div className="fb-obs-divider" />

          <div className="fb-obs-kv-row fb-num">
            <span className="fb-obs-muted">智能分流网关延迟</span>
            <span className="fb-mono">
              均值 {formatLatencyMs(payload.product.triage.avgLatencyMs)} · P95{' '}
              {formatLatencyMs(payload.product.triage.p95LatencyMs)}
            </span>
          </div>
          <div className="fb-obs-kv-row fb-num">
            <span className="fb-obs-muted">事件循环抖动 (Event Loop)</span>
            <span className="fb-mono">
              均值 {runtime.eventLoopMeanMs}ms · P95 {runtime.eventLoopP95Ms}ms · 最大{' '}
              {runtime.eventLoopMaxMs}ms
            </span>
          </div>
        </section>

        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">稳定性与异常归因</h2>
              <span className="fb-obs-panel-sub fb-mono">
                {errors.breakdown.length > 0 ? `${errors.breakdown.length} 类异常` : 'ZERO ERRORS'}
              </span>
            </div>
          </div>

          {errors.breakdown.length === 0 ? (
            <div className="fb-obs-healthy-box">
              <StateDot state="done" />
              <span>当前统计周期内无异常、回退或工具失败记录</span>
            </div>
          ) : (
            <div className="fb-obs-bars-list fb-num">
              {errors.breakdown.slice(0, 6).map((err) => (
                <div key={err.code} className="fb-obs-hrow">
                  <div className="fb-obs-hrow-top">
                    <span>
                      {resolveErrorCodeLabel(err.code)}{' '}
                      <code className="fb-obs-inline-code">{err.code}</code>
                    </span>
                    <span className="fb-mono fb-obs-muted">
                      {err.count} 次 · {err.sharePct}%
                    </span>
                  </div>
                  <div className="fb-obs-mini-track">
                    <div
                      className="fb-obs-mini-fill"
                      data-kind="error"
                      style={{ width: `${Math.max(4, err.sharePct)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="fb-obs-divider" />

          <div className="fb-obs-subhead">
            最近异常日志{sla.interruptedRecoveries > 0 ? ` · 断点恢复/重连 ${sla.interruptedRecoveries} 次` : ''}
          </div>
          {errors.recent.length === 0 ? (
            <div className="fb-obs-empty-inline">近期无异常日志</div>
          ) : (
            <div className="fb-obs-err-feed">
              {errors.recent.slice(0, 5).map((ev) => (
                <div key={ev.id} className="fb-obs-err-item">
                  <span className="fb-obs-err-text" title={ev.summary}>
                    {ev.chatName ? `${ev.chatName} · ` : ''}
                    {ev.summary}
                  </span>
                  <span className="fb-obs-muted fb-mono">{formatTime(ev.timestampMs)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="fb-obs-grid-2">
        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">飞书长连接与并发引擎</h2>
              <span className="fb-obs-panel-sub fb-mono">
                ACK P50 {connections.avgAckP50Ms > 0 ? `${connections.avgAckP50Ms}ms` : '—'}
              </span>
            </div>
          </div>

          <div className="fb-obs-micro-grid fb-num">
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">活跃 Actor</span>
              <strong className="fb-mono">{runtime.activeActors}</strong>
              <span className="fb-obs-muted">排队 {runtime.queuedTurns}</span>
            </div>
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">在途回合</span>
              <strong className="fb-mono">{runtime.activeTurns}</strong>
              <span className="fb-obs-muted">断点表 {runtime.persistedPendingTurns}</span>
            </div>
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">WS SDK 异常</span>
              <strong className="fb-mono">{connections.totalSdkErrors}</strong>
              <span className="fb-obs-muted">
                多实例冲突 {connections.splitBrainCount}
              </span>
            </div>
            <div className="fb-obs-micro-cell">
              <span className="fb-obs-micro-lbl">V8 堆使用</span>
              <strong className="fb-mono">{formatBytes(runtime.heapUsedBytes)}</strong>
              <span className="fb-obs-muted">/ {formatBytes(runtime.heapTotalBytes)}</span>
            </div>
          </div>

          <div className="fb-obs-divider" />

          {connections.bots.length === 0 ? (
            <div className="fb-obs-empty-inline">暂无已配置智能体</div>
          ) : (
            <div className="fb-obs-table-wrap">
              <table className="fb-obs-table fb-num">
                <thead>
                  <tr>
                    <th>智能体</th>
                    <th className="fb-obs-tr">ACK P50 / P95</th>
                    <th className="fb-obs-tr">成功率</th>
                    <th className="fb-obs-tr">活跃绑定</th>
                    <th className="fb-obs-tr">SDK 异常</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.bots.map((b) => (
                    <tr key={b.botId}>
                      <td>
                        <div className="fb-obs-bot-cell">
                          <StateDot state={b.connected ? 'done' : b.enabled ? 'error' : 'idle'} />
                          <span className="fb-obs-cell-main" title={b.lastError || b.name}>
                            {b.name}
                          </span>
                        </div>
                      </td>
                      <td className="fb-obs-tr fb-mono">
                        {b.ackSamples > 0 ? `${b.ackP50Ms}ms / ${b.ackP95Ms}ms` : '—'}
                      </td>
                      <td className="fb-obs-tr">
                        <span
                          className="fb-obs-pill fb-mono"
                          data-tone={b.successRate >= 98 ? 'good' : b.successRate >= 90 ? 'warn' : 'bad'}
                        >
                          {b.successRate}%
                        </span>
                      </td>
                      <td className="fb-obs-tr fb-mono">{b.activeBindings}</td>
                      <td className="fb-obs-tr fb-mono">{b.sdkErrorCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="fb-card fb-obs-panel">
          <div className="fb-obs-panel-head">
            <div className="fb-obs-panel-title-wrap">
              <h2 className="fb-obs-panel-title">存储空间与 SQLite 引擎</h2>
              <span className="fb-obs-panel-sub fb-mono">
                {storage.journalMode.toUpperCase()} · v{storage.schemaVersion}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={compacting}
              onClick={onCheckpointWal}
            >
              {compacting ? '整理中…' : '整理 WAL'}
            </Button>
          </div>

          <SegmentedBar items={storageSegments} />

          <div className="fb-obs-divider" />

          <div className="fb-obs-storage-meta fb-num">
            <div className="fb-obs-kv-row">
              <span className="fb-obs-muted">WAL 健康度</span>
              <span className="fb-mono" data-warn={storage.walBloated ? '' : undefined}>
                {storage.walDetail}
              </span>
            </div>
            <div className="fb-obs-kv-row">
              <span className="fb-obs-muted">完整性校验 / 页数</span>
              <span className="fb-mono">
                {storage.integrityOk ? 'Integrity OK' : `外键冲突 ${storage.foreignKeyErrors}`} ·{' '}
                {storage.pageCount.toLocaleString('en-US')} 页 ({storage.pageSize} B)
              </span>
            </div>
          </div>

          <div className="fb-obs-divider" />

          <div className="fb-obs-subhead">SQLite 数据表行数分布</div>
          <div className="fb-obs-table-chips fb-num">
            {storage.tables.slice(0, 8).map((t) => (
              <div key={t.table} className="fb-obs-table-chip" title={t.table}>
                <span className="fb-obs-table-chip-name">{resolveTableLabel(t.table)}</span>
                <strong className="fb-mono">{t.rows.toLocaleString('en-US')}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

export function ObservabilityView({
  bots,
  runtimes,
  models,
  onToast,
}: {
  readonly bots: readonly BotRecord[]
  readonly runtimes: readonly RuntimeOption[]
  readonly models: readonly ModelGroup[]
  readonly onToast: (text: string, ok?: boolean) => void
}) {
  const [lens, setLens] = useState<ObservabilityLens>('product')
  const [windowKey, setWindowKey] = useState<ObservabilityWindow>('7d')
  const [botId, setBotId] = useState('')
  const [chatId, setChatId] = useState('')
  const [payload, setPayload] = useState<ObservabilityPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [error, setError] = useState('')

  const effectiveBotId = resolveEffectiveBotId(botId, bots)

  const loadData = useCallback(
    async (opts: { readonly refreshStorage?: boolean; readonly silent?: boolean } = {}) => {
      if (!opts.silent) setRefreshing(true)
      try {
        const res = await bridgeApi.observability({
          window: windowKey,
          ...(effectiveBotId ? { botId: effectiveBotId } : {}),
          ...(chatId ? { chatId } : {}),
          ...(opts.refreshStorage ? { refreshStorage: true } : {}),
        })
        setPayload(res)
        setError('')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [windowKey, effectiveBotId, chatId],
  )

  useEffect(() => {
    void loadData({ silent: Boolean(payload) })
  }, [loadData])

  const backfillRunning = Boolean(payload?.backfill.running)
  useEffect(() => {
    const interval = backfillRunning ? POLL_BACKFILL_MS : POLL_IDLE_MS
    const timer = window.setInterval(() => {
      void loadData({ silent: true })
    }, interval)
    return () => window.clearInterval(timer)
  }, [loadData, backfillRunning])

  const chatOptions = useMemo(() => {
    const chats = payload?.filters.chats ?? []
    return [
      { value: '', label: '全部渠道' },
      { value: P2P_CHAT_FILTER, label: '全部私聊 (P2P)' },
      ...chats.map((c) => ({ value: c.chatId, label: c.chatName })),
    ]
  }, [payload?.filters.chats])

  const effectiveChatId = useMemo(() => {
    if (!chatId) return ''
    if (chatId === P2P_CHAT_FILTER) return P2P_CHAT_FILTER
    const exists = (payload?.filters.chats ?? []).some((c) => c.chatId === chatId)
    return exists ? chatId : ''
  }, [chatId, payload?.filters.chats])

  const handleBotChange = (nextBotId: string) => {
    setBotId(nextBotId)
    setChatId('')
  }

  const handleCheckpointWal = async () => {
    setCompacting(true)
    try {
      const res = await bridgeApi.checkpointWal()
      const saved = Math.max(0, res.checkpoint.beforeWalBytes - res.checkpoint.afterWalBytes)
      onToast(
        saved > 0
          ? `WAL 整理完成，已回收 ${formatBytes(saved)}`
          : 'WAL 整理完成，当前状态健康',
        true,
      )
      await loadData({ refreshStorage: true })
    } catch (err) {
      onToast(`WAL 整理失败：${err instanceof Error ? err.message : String(err)}`, false)
    } finally {
      setCompacting(false)
    }
  }

  return (
    <div className="fb-obs-root">
      <div className="fb-obs-bar">
        <div className="fb-obs-bar-left">
          <CountSegmentedSwitch
            label="观测台视角切换"
            value={lens}
            options={[
              { value: 'product' as const, label: '产品洞察' },
              { value: 'technical' as const, label: '技术观测' },
            ]}
            onChange={setLens}
          />
          {payload?.backfill.running && (
            <span className="fb-obs-status-chip fb-mono">
              <i className="fb-obs-pulse-dot" data-busy="" />
              索引历史会话 {payload.backfill.scannedSessions}/{payload.backfill.totalSessions}
            </span>
          )}
          {payload && !payload.backfill.running && (
            <span className="fb-obs-status-chip fb-mono" title="实时采集，自动刷新">
              <i className="fb-obs-pulse-dot" />
              LIVE · {formatTime(payload.generatedAtMs)}
            </span>
          )}
        </div>

        <div className="fb-obs-bar-right">
          <div className="fb-obs-window-group" role="group" aria-label="时间周期">
            {OBSERVABILITY_WINDOWS.map((w) => (
              <button
                key={w.value}
                type="button"
                className="fb-obs-window-btn fb-mono"
                aria-pressed={windowKey === w.value}
                title={w.desc}
                onClick={() => setWindowKey(w.value)}
              >
                {w.label}
              </button>
            ))}
          </div>

          {bots.length > 1 && (
            <SelectMenu
              size="sm"
              value={effectiveBotId}
              options={[
                { value: '', label: '全部智能体' },
                ...bots.map((b) => ({ value: b.id, label: b.name })),
              ]}
              onChange={handleBotChange}
            />
          )}

          <SelectMenu
            size="sm"
            value={effectiveChatId}
            options={chatOptions}
            onChange={setChatId}
          />

          <Button
            size="sm"
            variant="ghost"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={refreshing}
            onClick={() => void loadData({ refreshStorage: true })}
          >
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="fb-card fb-empty">观测数据加载失败：{error}</div>
      )}

      {!error && loading && !payload && (
        <div className="fb-card fb-empty">正在加载观测指标…</div>
      )}

      {payload && lens === 'product' && (
        <ProductObservabilityPane
          payload={payload}
          runtimes={runtimes}
          models={models}
          selectedBotId={effectiveBotId}
          selectedChatId={effectiveChatId}
          onSelectBot={handleBotChange}
          onSelectChat={setChatId}
        />
      )}

      {payload && lens === 'technical' && (
        <TechnicalObservabilityPane
          payload={payload}
          compacting={compacting}
          onCheckpointWal={() => void handleCheckpointWal()}
        />
      )}
    </div>
  )
}
