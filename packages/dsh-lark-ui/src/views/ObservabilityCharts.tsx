import { useEffect, useId, useState, type ReactNode } from 'react'
import type {
  CockpitPayload,
  ObservabilityDatabasePerf,
  ObservabilityHeatmapCell,
  ObservabilityLatencyBucket,
  ObservabilitySeriesPoint,
  ProcessVitalPoint,
} from '../types.js'
import {
  buildSparklineGeometry,
  computeNiceAxisMax,
  computeNiceDurationAxisMax,
  formatBytes,
  formatCompactNumber,
  formatLatencyMs,
  formatSubMs,
  formatTokens,
  resolveApiRouteTone,
  resolveDbQueryTone,
  resolveHeatmapLevel,
  splitTelemetryVerb,
  WEEKDAY_LABELS,
} from './observability-model.js'

/**
 * Measure the real pixel width of a chart wrapper so SVG `viewBox` renders at
 * 1:1 CSS pixels across narrow laptops and ultrawide monitors (no bloated height or text).
 */
function useChartWidth(defaultWidth = 760): readonly [(node: HTMLDivElement | null) => void, number] {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(defaultWidth)

  useEffect(() => {
    if (!node) return
    const update = (next: number) => {
      const clamped = Math.max(420, Math.round(next))
      if (clamped > 0) setWidth((prev) => (Math.abs(prev - clamped) >= 2 ? clamped : prev))
    }
    const rect = node.getBoundingClientRect()
    if (rect.width > 0) update(rect.width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && entry.contentRect.width > 0) update(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return [setNode, width] as const
}

export function KpiCard({
  label,
  tag,
  value,
  unit,
  foot,
  delta,
  spark,
  sparkTone = 'primary',
  visual,
}: {
  readonly label: string
  readonly tag?: string
  readonly value: string
  readonly unit?: string
  readonly foot: string
  readonly delta?: { readonly text: string; readonly tone: 'good' | 'bad' | 'neutral' }
  readonly spark?: readonly number[]
  readonly sparkTone?: 'primary' | 'success' | 'warn' | 'danger'
  readonly visual?: ReactNode
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
        {visual ?? (spark ? <Sparkline values={spark} tone={sparkTone} /> : null)}
      </div>
      <div className="fb-obs-kpi-foot fb-num" title={foot}>
        {foot}
      </div>
    </div>
  )
}

export function Sparkline({
  values,
  tone = 'primary',
}: {
  readonly values: readonly number[]
  readonly tone?: 'primary' | 'success' | 'warn' | 'danger'
}) {
  const gradId = useId()
  const { linePath, areaPath, hasData } = buildSparklineGeometry(values, 68, 26, 3)
  return (
    <svg
      className="fb-obs-spark"
      data-tone={tone}
      viewBox="0 0 68 26"
      width={68}
      height={26}
      aria-hidden="true"
    >
      {hasData && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
          </linearGradient>
        </defs>
      )}
      {hasData && areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={hasData ? 1.5 : 1}
        strokeOpacity={hasData ? 0.92 : 0.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function MiniStorageMeter({
  bridgeBytes,
  dshBytes,
  walBloated,
}: {
  readonly bridgeBytes: number
  readonly dshBytes: number
  readonly walBloated?: boolean
}) {
  const total = Math.max(1, bridgeBytes + dshBytes)
  const bridgePct = Math.round((bridgeBytes / total) * 100)
  const dshPct = Math.max(0, 100 - bridgePct)
  return (
    <div
      className="fb-obs-mini-meter"
      title={`桥接数据 ${bridgePct}% · DSH 会话/附件 ${dshPct}%`}
      aria-hidden="true"
    >
      <div className="fb-obs-mini-meter-track">
        {bridgePct > 0 && (
          <span
            className="fb-obs-mini-meter-seg"
            data-kind={walBloated ? 'warn' : 'cache'}
            style={{ width: `${Math.max(4, bridgePct)}%` }}
          />
        )}
        {dshPct > 0 && (
          <span
            className="fb-obs-mini-meter-seg"
            data-kind="primary"
            style={{ width: `${Math.max(4, dshPct)}%` }}
          />
        )}
      </div>
      <span className="fb-obs-mini-meter-lbl fb-mono">
        DB {bridgePct}%
      </span>
    </div>
  )
}

export function MiniRatioMeter({
  online,
  total,
  healthy,
}: {
  readonly online: number
  readonly total: number
  readonly healthy: boolean
}) {
  const pct = total > 0 ? Math.round((online / total) * 100) : 0
  return (
    <div
      className="fb-obs-mini-meter"
      title={`在线率 ${pct}% (${online}/${total})`}
      aria-hidden="true"
    >
      <div className="fb-obs-mini-meter-track">
        {pct > 0 && (
          <span
            className="fb-obs-mini-meter-seg"
            data-kind={healthy ? 'cache' : 'error'}
            style={{ width: `${Math.max(6, pct)}%` }}
          />
        )}
      </div>
      <span className="fb-obs-mini-meter-lbl fb-mono">
        {total > 0 ? `${pct}%` : '—'}
      </span>
    </div>
  )
}

export function OverviewHourlyChart({
  hourlySeries,
  inboundTotal,
  repliedTotal,
  silentTotal,
  errorTotal,
  peakCount,
}: {
  readonly hourlySeries: CockpitPayload['hourlySeries']
  readonly inboundTotal: number
  readonly repliedTotal: number
  readonly silentTotal: number
  readonly errorTotal: number
  readonly peakCount: number
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [wrapRef, W] = useChartWidth(760)
  const H = 196
  const padL = 42
  const padR = 14
  const padT = 14
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const rawMax = Math.max(
    0,
    ...hourlySeries.map((h) => Math.max(h.inbound, h.replied, h.errors)),
  )
  const yMax = computeNiceAxisMax(rawMax)
  const yTicks = [0, yMax / 2, yMax]
  const yFor = (val: number) => padT + plotH * (1 - Math.min(1, Math.max(0, val / yMax)))
  const count = Math.max(1, hourlySeries.length)
  const slotW = plotW / count
  const barW = Math.max(4, Math.min(24, slotW * 0.62))
  const halfW = Math.max(2.5, barW * 0.46)
  const hovered = hoverIdx !== null ? hourlySeries[hoverIdx] : undefined
  const firstHour = hourlySeries[0]?.label ?? ''
  const lastHour = hourlySeries[hourlySeries.length - 1]?.label ?? ''

  return (
    <div ref={wrapRef} className="fb-obs-chart-wrap">
      <div className="fb-obs-hud fb-num">
        {hovered ? (
          <>
            <strong className="fb-mono">
              {hovered.label}–{hovered.label.slice(0, 2)}:59
            </strong>
            <span>收到 {hovered.inbound}</span>
            <span>回复/推送 {hovered.replied}</span>
            {(hovered.silentSkipped ?? 0) > 0 && <span>静默 {hovered.silentSkipped}</span>}
            {hovered.errors > 0 && <span>异常 {hovered.errors}</span>}
            {(hovered.avgLatencyMs ?? 0) > 0 && (
              <span>均耗 {formatLatencyMs(hovered.avgLatencyMs!)}</span>
            )}
          </>
        ) : rawMax === 0 ? (
          <span>过去 24 小时暂无飞书消息或定时通知记录</span>
        ) : (
          <span>
            统计窗口 <strong className="fb-mono">{firstHour}–{lastHour}</strong>（当前小时）· 小时峰值{' '}
            <strong className="fb-mono">{peakCount}</strong> 条 · 移动光标至图内查看单小时明细
          </span>
        )}
      </div>

      <svg
        className="fb-obs-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="近 24 小时消息与通知趋势图"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {yTicks.map((tick, i) => {
          const y = yFor(tick)
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                className="fb-obs-grid-line"
                strokeDasharray={i === 0 ? undefined : '2 3'}
              />
              <text x={padL - 8} y={y + 3.5} textAnchor="end" className="fb-obs-axis-text">
                {formatCompactNumber(tick)}
              </text>
            </g>
          )
        })}

        {hourlySeries.map((h, idx) => {
          const cx = padL + slotW * (idx + 0.5)
          const active = hoverIdx === idx
          const isCurrent = idx === hourlySeries.length - 1
          const inY = yFor(h.inbound)
          const repY = yFor(h.replied)
          const errH = h.errors > 0 ? Math.max(2.5, padT + plotH - yFor(h.errors)) : 0
          return (
            <g key={h.hourKey}>
              {isCurrent && (
                <rect
                  x={padL + slotW * idx + 2}
                  y={padT}
                  width={Math.max(4, slotW - 4)}
                  height={plotH}
                  rx={4}
                  className="fb-obs-current-band"
                />
              )}
              {active && (
                <line
                  x1={cx}
                  x2={cx}
                  y1={padT}
                  y2={padT + plotH}
                  className="fb-obs-crosshair"
                />
              )}
              {h.inbound > 0 && (
                <rect
                  x={cx - halfW - 0.5}
                  y={inY}
                  width={halfW}
                  height={Math.max(1.5, padT + plotH - inY)}
                  rx={1.5}
                  className="fb-obs-fill-primary"
                  data-active={active ? '' : undefined}
                />
              )}
              {h.replied > 0 && (
                <rect
                  x={cx + 0.5}
                  y={repY}
                  width={halfW}
                  height={Math.max(1.5, padT + plotH - repY)}
                  rx={1.5}
                  className="fb-obs-fill-success"
                  data-active={active ? '' : undefined}
                />
              )}
              {errH > 0 && (
                <rect
                  x={cx - halfW}
                  y={padT + plotH - errH}
                  width={halfW * 2}
                  height={errH}
                  rx={1.5}
                  className="fb-obs-fill-error"
                />
              )}
              <rect
                x={padL + slotW * idx}
                y={padT}
                width={slotW}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            </g>
          )
        })}

        {hourlySeries.map((h, idx) => {
          const isLast = idx === hourlySeries.length - 1
          const showLabel = idx === 0 || idx % 4 === 0 || isLast
          if (!showLabel || (!isLast && idx >= hourlySeries.length - 2)) return null
          const cx = padL + slotW * (idx + 0.5)
          return (
            <text
              key={`lbl-${h.hourKey}`}
              x={isLast ? W - padR : cx}
              y={H - 6}
              textAnchor={idx === 0 ? 'start' : isLast ? 'end' : 'middle'}
              className="fb-obs-axis-text"
            >
              {h.label}
            </text>
          )
        })}
      </svg>

      <div className="fb-obs-legend fb-num">
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="primary" />
          收到消息 {inboundTotal}
        </span>
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="success" />
          回复/推送 {repliedTotal}
        </span>
        {silentTotal > 0 && (
          <span className="fb-obs-legend-item">
            <i className="fb-obs-dot" data-kind="muted" />
            静默跳过 {silentTotal}
          </span>
        )}
        {errorTotal > 0 && (
          <span className="fb-obs-legend-item">
            <i className="fb-obs-dot" data-kind="error" />
            异常 {errorTotal}
          </span>
        )}
      </div>
    </div>
  )
}

export type ProductChartMode = 'tokens' | 'traffic' | 'sessions'

export function ProductTimeSeriesChart({
  series,
  mode,
}: {
  readonly series: readonly ObservabilitySeriesPoint[]
  readonly mode: ProductChartMode
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [wrapRef, W] = useChartWidth(760)
  const H = 196
  const padL = 52
  const padR = 14
  const padT = 14
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const rawMax = Math.max(
    0,
    ...series.map((p) =>
      mode === 'tokens'
        ? p.totalTokens
        : mode === 'traffic'
          ? Math.max(p.inbound, p.replied + p.silentSkipped + p.errors)
          : Math.max(p.sessions, p.llmSteps),
    ),
  )
  const yMax = computeNiceAxisMax(rawMax)
  const yTicks = [0, yMax / 2, yMax]
  const yFor = (val: number) => padT + plotH * (1 - Math.min(1, Math.max(0, val / yMax)))
  const count = Math.max(1, series.length)
  const slotW = plotW / count
  const barW = Math.max(4, Math.min(24, slotW * 0.62))
  const hovered = hoverIdx !== null ? series[hoverIdx] : undefined

  const formatY = (val: number) =>
    mode === 'tokens' ? formatTokens(val) : formatCompactNumber(val)

  const shouldShowXLabel = (p: ObservabilitySeriesPoint, idx: number): boolean => {
    const isLast = idx === series.length - 1
    if (isLast) return true
    if (idx >= series.length - 2) return false
    // Prefer midnight day-boundary labels (M/D) when available (e.g. 7d 6h buckets)
    if (series.length === 28 && !p.label.includes(':')) return true
    if (series.length === 28) return false
    const step = count <= 14 ? 2 : count <= 24 ? 4 : 5
    return idx === 0 || idx % step === 0
  }

  return (
    <div ref={wrapRef} className="fb-obs-chart-wrap">
      <div className="fb-obs-hud fb-num">
        {hovered ? (
          mode === 'tokens' ? (
            <>
              <strong className="fb-mono">{hovered.fullLabel}</strong>
              <span>总计 {formatTokens(hovered.totalTokens)}</span>
              <span>缓存命中 {formatTokens(hovered.cacheReadTokens)}</span>
              <span>非缓存输入 {formatTokens(hovered.inputTokens)}</span>
              <span>输出 {formatTokens(hovered.outputTokens)}</span>
              {hovered.reasoningTokens > 0 && (
                <span>思考 {formatTokens(hovered.reasoningTokens)}</span>
              )}
            </>
          ) : mode === 'traffic' ? (
            <>
              <strong className="fb-mono">{hovered.fullLabel}</strong>
              <span>收到 {hovered.inbound}</span>
              <span>回复 {hovered.replied}</span>
              <span>静默 {hovered.silentSkipped}</span>
              <span>异常 {hovered.errors}</span>
              <span>工具调用 {hovered.toolCalls}</span>
            </>
          ) : (
            <>
              <strong className="fb-mono">{hovered.fullLabel}</strong>
              <span>活跃会话 {hovered.sessions}</span>
              <span>模型步数 {hovered.llmSteps}</span>
              <span>工具调用 {hovered.toolCalls}</span>
            </>
          )
        ) : rawMax === 0 ? (
          <span>当前筛选周期内暂无数据，可尝试切换时间窗口或等待新会话写入</span>
        ) : (
          <span>
            窗口峰值 <strong className="fb-mono">{formatY(rawMax)}</strong> · 移动光标至图内查看各时段精密读数
          </span>
        )}
      </div>

      <svg
        className="fb-obs-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="产品趋势时序图"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Horizontal dashed reference grid */}
        {yTicks.map((tick, i) => {
          const y = yFor(tick)
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                className="fb-obs-grid-line"
                strokeDasharray={i === 0 ? undefined : '2 3'}
              />
              <text x={padL - 8} y={y + 3.5} textAnchor="end" className="fb-obs-axis-text">
                {formatY(tick)}
              </text>
            </g>
          )
        })}

        {/* Bars & lines */}
        {series.map((p, idx) => {
          const cx = padL + slotW * (idx + 0.5)
          const bx = cx - barW / 2
          const active = hoverIdx === idx

          if (mode === 'tokens') {
            const uncachedIn = p.inputTokens + p.cacheWriteTokens
            const segments = [
              { val: p.cacheReadTokens, cls: 'fb-obs-fill-cache' },
              { val: uncachedIn, cls: 'fb-obs-fill-primary' },
              { val: p.outputTokens, cls: 'fb-obs-fill-output' },
            ]
            let acc = 0
            return (
              <g key={p.bucketStartMs}>
                {active && (
                  <line
                    x1={cx}
                    x2={cx}
                    y1={padT}
                    y2={padT + plotH}
                    className="fb-obs-crosshair"
                  />
                )}
                {segments.map((seg, sIdx) => {
                  if (seg.val <= 0) return null
                  const yBottom = yFor(acc)
                  acc += seg.val
                  const yTop = yFor(acc)
                  const h = Math.max(1.5, yBottom - yTop)
                  return (
                    <rect
                      key={sIdx}
                      x={bx}
                      y={yTop}
                      width={barW}
                      height={h}
                      rx={sIdx === segments.length - 1 ? 2 : 0}
                      className={seg.cls}
                      data-active={active ? '' : undefined}
                    />
                  )
                })}
                <rect
                  x={padL + slotW * idx}
                  y={padT}
                  width={slotW}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(idx)}
                />
              </g>
            )
          }

          if (mode === 'traffic') {
            const halfW = Math.max(2.5, barW * 0.46)
            const inY = yFor(p.inbound)
            const repY = yFor(p.replied)
            const errH = p.errors > 0 ? Math.max(2.5, padT + plotH - yFor(p.errors)) : 0
            return (
              <g key={p.bucketStartMs}>
                {active && (
                  <line
                    x1={cx}
                    x2={cx}
                    y1={padT}
                    y2={padT + plotH}
                    className="fb-obs-crosshair"
                  />
                )}
                {p.inbound > 0 && (
                  <rect
                    x={cx - halfW - 0.5}
                    y={inY}
                    width={halfW}
                    height={Math.max(1.5, padT + plotH - inY)}
                    rx={1.5}
                    className="fb-obs-fill-primary"
                    data-active={active ? '' : undefined}
                  />
                )}
                {p.replied > 0 && (
                  <rect
                    x={cx + 0.5}
                    y={repY}
                    width={halfW}
                    height={Math.max(1.5, padT + plotH - repY)}
                    rx={1.5}
                    className="fb-obs-fill-success"
                    data-active={active ? '' : undefined}
                  />
                )}
                {errH > 0 && (
                  <rect
                    x={cx - halfW}
                    y={padT + plotH - errH}
                    width={halfW * 2}
                    height={errH}
                    rx={1.5}
                    className="fb-obs-fill-error"
                  />
                )}
                <rect
                  x={padL + slotW * idx}
                  y={padT}
                  width={slotW}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(idx)}
                />
              </g>
            )
          }

          // mode === 'sessions'
          const stepY = yFor(p.llmSteps)
          const sessY = yFor(p.sessions)
          return (
            <g key={p.bucketStartMs}>
              {active && (
                <line
                  x1={cx}
                  x2={cx}
                  y1={padT}
                  y2={padT + plotH}
                  className="fb-obs-crosshair"
                />
              )}
              {p.llmSteps > 0 && (
                <rect
                  x={bx}
                  y={stepY}
                  width={barW}
                  height={Math.max(1.5, padT + plotH - stepY)}
                  rx={2}
                  className="fb-obs-fill-muted"
                  data-active={active ? '' : undefined}
                />
              )}
              {p.sessions > 0 && (
                <rect
                  x={bx + barW * 0.18}
                  y={sessY}
                  width={Math.max(2, barW * 0.64)}
                  height={Math.max(2, padT + plotH - sessY)}
                  rx={2}
                  className="fb-obs-fill-primary"
                  data-active={active ? '' : undefined}
                />
              )}
              <rect
                x={padL + slotW * idx}
                y={padT}
                width={slotW}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            </g>
          )
        })}

        {/* X Axis labels */}
        {series.map((p, idx) => {
          const isLast = idx === series.length - 1
          if (!shouldShowXLabel(p, idx)) return null
          const cx = padL + slotW * (idx + 0.5)
          return (
            <text
              key={`lbl-${p.bucketStartMs}`}
              x={isLast ? W - padR : cx}
              y={H - 6}
              textAnchor={idx === 0 ? 'start' : isLast ? 'end' : 'middle'}
              className="fb-obs-axis-text"
            >
              {p.label}
            </text>
          )
        })}
      </svg>

      <div className="fb-obs-legend fb-num">
        {mode === 'tokens' && (
          <>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="cache" />
              缓存命中读取
            </span>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="primary" />
              非缓存输入
            </span>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="output" />
              模型输出
            </span>
          </>
        )}
        {mode === 'traffic' && (
          <>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="primary" />
              入站消息
            </span>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="success" />
              成功回复
            </span>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="error" />
              异常
            </span>
          </>
        )}
        {mode === 'sessions' && (
          <>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="primary" />
              活跃会话数
            </span>
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind="muted" />
              LLM 步数
            </span>
          </>
        )}
      </div>
    </div>
  )
}

export type TechChartMode = 'latency' | 'vitals' | 'database'

function DatabasePerfPanel({
  database,
}: {
  readonly database?: ObservabilityDatabasePerf
}) {
  const [hovered, setHovered] = useState<
    { readonly kind: 'api'; readonly index: number } | { readonly kind: 'sql'; readonly index: number } | null
  >(null)

  const db = database
  const slowThreshold = db?.slowThresholdMs ?? 100
  const slowCount = db?.slowQueryCount ?? 0
  const topRoutes = (db?.apiRoutes ?? []).slice(0, 5)
  const topQueries = (db?.slowQueries ?? []).slice(0, 5)
  const rawMaxRoute = Math.max(0, ...topRoutes.map((r) => Math.max(r.p95Ms, r.avgMs)))
  const rawMaxQuery = Math.max(0, ...topQueries.map((q) => Math.max(q.maxMs, q.avgMs)))
  const maxRouteScale = rawMaxRoute > 0 ? computeNiceAxisMax(rawMaxRoute) : 100
  const maxQueryScale = rawMaxQuery > 0 ? computeNiceAxisMax(rawMaxQuery) : 10
  const thresholdPct =
    maxQueryScale >= slowThreshold && slowThreshold / maxQueryScale <= 0.96
      ? (slowThreshold / maxQueryScale) * 100
      : null

  const hoveredRoute = hovered?.kind === 'api' ? topRoutes[hovered.index] : undefined
  const hoveredQuery = hovered?.kind === 'sql' ? topQueries[hovered.index] : undefined

  return (
    <div className="fb-obs-db-wrap" onMouseLeave={() => setHovered(null)}>
      <div className="fb-obs-hud fb-num">
        {hoveredRoute ? (
          <>
            <strong className="fb-mono">{hoveredRoute.route}</strong>
            <span>P50 {formatSubMs(hoveredRoute.p50Ms)}</span>
            <span>P95 {formatSubMs(hoveredRoute.p95Ms)}</span>
            <span>均耗 {formatSubMs(hoveredRoute.avgMs)}</span>
            <span>峰值 {formatSubMs(hoveredRoute.maxMs)}</span>
            <span>{hoveredRoute.count} 次请求</span>
          </>
        ) : hoveredQuery ? (
          <>
            <strong className="fb-mono">{hoveredQuery.fingerprint}</strong>
            <span>均耗 {formatSubMs(hoveredQuery.avgMs)}</span>
            <span>峰值 {formatSubMs(hoveredQuery.maxMs)}</span>
            <span>{formatCompactNumber(hoveredQuery.count)} 次执行</span>
          </>
        ) : (
          <>
            <span title={db ? `均耗 ${formatSubMs(db.avgMs)} · 近 ${db.sampleCount} 次采样窗口` : undefined}>
              SQLite P50{' '}
              <strong className="fb-mono">
                {db && db.sampleCount > 0 ? formatSubMs(db.p50Ms) : '—'}
              </strong>{' '}
              / P95{' '}
              <strong className="fb-mono">
                {db && db.sampleCount > 0 ? formatSubMs(db.p95Ms) : '—'}
              </strong>
            </span>
            <span>
              峰值{' '}
              <strong className="fb-mono">
                {db && db.sampleCount > 0 ? formatSubMs(db.maxMs) : '—'}
              </strong>
            </span>
            <span>
              慢查询 (≥{slowThreshold}ms){' '}
              <strong className="fb-mono" data-warn={slowCount > 0 ? '' : undefined}>
                {slowCount}
              </strong>
            </span>
            <span>
              累计 <strong className="fb-mono">{formatCompactNumber(db?.totalQueries ?? 0)}</strong> 次
            </span>
            {db && db.integrityCheckMs > 0 && (
              <span title="完整性校验结果 5 分钟缓存复用，不阻塞轮询">
                校验 <strong className="fb-mono">{formatSubMs(db.integrityCheckMs)}</strong>
              </span>
            )}
            {db?.lastCheckpointMs !== undefined && (
              <span>
                WAL <strong className="fb-mono">{formatSubMs(db.lastCheckpointMs)}</strong>
              </span>
            )}
          </>
        )}
      </div>

      <div className="fb-obs-db-split">
        <div className="fb-obs-db-col">
          <div className="fb-obs-db-col-head">
            <span className="fb-obs-subhead">后端接口耗时 Top</span>
            <span className="fb-obs-db-scale fb-mono">P95</span>
          </div>
          {topRoutes.length === 0 ? (
            <div className="fb-obs-empty-inline">等待接口请求采样…</div>
          ) : (
            <div className="fb-obs-db-rows fb-num">
              {topRoutes.map((r, idx) => {
                const { verb, target } = splitTelemetryVerb(r.route)
                const tone = resolveApiRouteTone(r.p95Ms)
                const p95Pct = Math.max(3, Math.min(100, (r.p95Ms / maxRouteScale) * 100))
                const p50Pct = Math.max(2, Math.min(p95Pct, (r.p50Ms / maxRouteScale) * 100))
                const active = hovered?.kind === 'api' && hovered.index === idx
                return (
                  <div
                    key={r.route}
                    className="fb-obs-db-row"
                    data-active={active ? '' : undefined}
                    title={`${r.route} · P50 ${formatSubMs(r.p50Ms)} / P95 ${formatSubMs(r.p95Ms)} · ${r.count} 次`}
                    onMouseEnter={() => setHovered({ kind: 'api', index: idx })}
                  >
                    <span className="fb-obs-db-name fb-mono">
                      {verb && <span className="fb-obs-db-verb">{verb}</span>}
                      <span className="fb-obs-db-target">{target}</span>
                    </span>
                    <div className="fb-obs-db-track" aria-hidden="true">
                      <div className="fb-obs-db-tail" data-kind={tone} style={{ width: `${p95Pct}%` }} />
                      <div className="fb-obs-db-core" data-kind={tone} style={{ width: `${p50Pct}%` }} />
                    </div>
                    <span
                      className="fb-obs-db-val fb-mono"
                      data-tone={tone === 'primary' ? undefined : tone}
                    >
                      {formatSubMs(r.p95Ms)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="fb-obs-db-col" data-bordered="">
          <div className="fb-obs-db-col-head">
            <span className="fb-obs-subhead">SQLite 高耗时语句 Top</span>
            <span className="fb-obs-db-scale fb-mono">峰值</span>
          </div>
          {topQueries.length === 0 ? (
            <div className="fb-obs-empty-inline">暂无 SQLite 语句采样</div>
          ) : (
            <div className="fb-obs-db-rows fb-num">
              {topQueries.map((q, idx) => {
                const { verb, target } = splitTelemetryVerb(q.fingerprint)
                const tone = resolveDbQueryTone(q.maxMs, slowThreshold)
                const maxPct = Math.max(3, Math.min(100, (q.maxMs / maxQueryScale) * 100))
                const avgPct = Math.max(2, Math.min(maxPct, (q.avgMs / maxQueryScale) * 100))
                const active = hovered?.kind === 'sql' && hovered.index === idx
                return (
                  <div
                    key={q.fingerprint}
                    className="fb-obs-db-row"
                    data-active={active ? '' : undefined}
                    title={`${q.fingerprint} · 均耗 ${formatSubMs(q.avgMs)} / 峰值 ${formatSubMs(q.maxMs)} · ${q.count} 次`}
                    onMouseEnter={() => setHovered({ kind: 'sql', index: idx })}
                  >
                    <span className="fb-obs-db-name fb-mono">
                      {verb && <span className="fb-obs-db-verb">{verb}</span>}
                      <span className="fb-obs-db-target">{target}</span>
                    </span>
                    <div className="fb-obs-db-track" aria-hidden="true">
                      {thresholdPct !== null && (
                        <span className="fb-obs-db-thresh" style={{ left: `${thresholdPct}%` }} />
                      )}
                      <div className="fb-obs-db-tail" data-kind={tone} style={{ width: `${maxPct}%` }} />
                      <div className="fb-obs-db-core" data-kind={tone} style={{ width: `${avgPct}%` }} />
                    </div>
                    <span
                      className="fb-obs-db-val fb-mono"
                      data-tone={tone === 'primary' ? undefined : tone}
                    >
                      {formatSubMs(q.maxMs)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="fb-obs-legend fb-obs-db-legend fb-num">
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="primary" />
          深色 P50 / 均耗 · 浅色 P95 / 峰值
        </span>
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="warn" />
          偏慢
        </span>
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="error" />
          慢查询 (SQL ≥{slowThreshold}ms / API ≥1.5s)
        </span>
        <span className="fb-obs-db-hint">悬停查看分位与次数</span>
      </div>
    </div>
  )
}

export function TechnicalTimeSeriesChart({
  series,
  vitals,
  database,
  mode,
}: {
  readonly series: readonly ObservabilitySeriesPoint[]
  readonly vitals: readonly ProcessVitalPoint[]
  readonly database?: ObservabilityDatabasePerf
  readonly mode: TechChartMode
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [wrapRef, W] = useChartWidth(760)
  const H = 196
  const padL = 54
  const padR = 44
  const padT = 14
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  if (mode === 'database') {
    return <DatabasePerfPanel {...(database ? { database } : {})} />
  }

  if (mode === 'vitals') {
    const count = Math.max(1, vitals.length)
    const maxRss = computeNiceAxisMax(Math.max(64 * 1024 * 1024, ...vitals.map((v) => v.rssBytes)))
    const maxLag = computeNiceAxisMax(Math.max(25, ...vitals.map((v) => v.eventLoopP95Ms)))
    const xFor = (i: number) =>
      count <= 1 ? padL + plotW / 2 : padL + (plotW * i) / (count - 1)
    const yMem = (b: number) => padT + plotH * (1 - Math.min(1, b / maxRss))
    const yLag = (ms: number) => padT + plotH * (1 - Math.min(1, ms / maxLag))
    const rssPath = vitals
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yMem(v.rssBytes).toFixed(1)}`)
      .join(' ')
    const heapPath = vitals
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yMem(v.heapUsedBytes).toFixed(1)}`)
      .join(' ')
    const lagPath = vitals
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yLag(v.eventLoopP95Ms).toFixed(1)}`)
      .join(' ')
    const hovered = hoverIdx !== null ? vitals[hoverIdx] : undefined
    const latest = vitals[vitals.length - 1]
    const slotW = plotW / count

    return (
      <div ref={wrapRef} className="fb-obs-chart-wrap">
        <div className="fb-obs-hud fb-num">
          {hovered ? (
            <>
              <strong className="fb-mono">{hovered.label}</strong>
              <span>RSS {formatBytes(hovered.rssBytes)}</span>
              <span>Heap {formatBytes(hovered.heapUsedBytes)}</span>
              <span>Event Loop P95 {hovered.eventLoopP95Ms.toFixed(1)}ms</span>
              <span>在途回合 {hovered.activeTurns}</span>
            </>
          ) : latest ? (
            <>
              <span>实时采样（每分钟 · 近 {vitals.length} 个点）</span>
              <span>RSS {formatBytes(latest.rssBytes)}</span>
              <span>Heap {formatBytes(latest.heapUsedBytes)}</span>
              <span>EL Lag P95 {latest.eventLoopP95Ms.toFixed(1)}ms</span>
            </>
          ) : (
            <span>等待采样点…</span>
          )}
        </div>

        <svg
          className="fb-obs-svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="进程内存与事件循环趋势"
          onMouseLeave={() => setHoverIdx(null)}
        >
          {[0, 0.5, 1].map((frac, i) => {
            const y = padT + plotH * (1 - frac)
            return (
              <g key={i}>
                <line
                  x1={padL}
                  x2={W - padR}
                  y1={y}
                  y2={y}
                  className="fb-obs-grid-line"
                  strokeDasharray={i === 0 ? undefined : '2 3'}
                />
                <text x={padL - 8} y={y + 3.5} textAnchor="end" className="fb-obs-axis-text">
                  {formatBytes(maxRss * frac)}
                </text>
                <text x={W - padR + 6} y={y + 3.5} textAnchor="start" className="fb-obs-axis-text">
                  {Math.round(maxLag * frac)}ms
                </text>
              </g>
            )
          })}

          {vitals.length >= 2 && (
            <>
              <path d={rssPath} fill="none" className="fb-obs-line-primary" />
              <path d={heapPath} fill="none" className="fb-obs-line-success" />
              <path d={lagPath} fill="none" className="fb-obs-line-warn" strokeDasharray="3 3" />
            </>
          )}

          {vitals.map((v, i) => {
            const cx = xFor(i)
            const active = hoverIdx === i || vitals.length === 1
            return (
              <g key={v.timestampMs}>
                {hoverIdx === i && (
                  <line x1={cx} x2={cx} y1={padT} y2={padT + plotH} className="fb-obs-crosshair" />
                )}
                {active && (
                  <>
                    <circle cx={cx} cy={yMem(v.rssBytes)} r={3} className="fb-obs-dot-primary" />
                    <circle cx={cx} cy={yMem(v.heapUsedBytes)} r={2.5} className="fb-obs-dot-success" />
                    <circle cx={cx} cy={yLag(v.eventLoopP95Ms)} r={2.5} className="fb-obs-dot-warn" />
                  </>
                )}
                <rect
                  x={Math.max(padL, cx - slotW / 2)}
                  y={padT}
                  width={Math.max(8, slotW)}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(i)}
                />
              </g>
            )
          })}

          {vitals.map((v, i) => {
            const isLast = i === vitals.length - 1
            const step = Math.max(1, Math.floor(vitals.length / 6))
            const show = i === 0 || isLast || (i % step === 0 && i < vitals.length - 2)
            if (!show) return null
            return (
              <text
                key={`vl-${v.timestampMs}`}
                x={xFor(i)}
                y={H - 6}
                textAnchor={i === 0 ? 'start' : isLast ? 'end' : 'middle'}
                className="fb-obs-axis-text"
              >
                {v.label}
              </text>
            )
          })}
        </svg>

        <div className="fb-obs-legend fb-num">
          <span className="fb-obs-legend-item">
            <i className="fb-obs-dot" data-kind="primary" />
            RSS 常驻内存
          </span>
          <span className="fb-obs-legend-item">
            <i className="fb-obs-dot" data-kind="success" />
            V8 Heap 已用
          </span>
          <span className="fb-obs-legend-item">
            <i className="fb-obs-dot" data-kind="warn" />
            Event Loop P95 (右轴)
          </span>
        </div>
      </div>
    )
  }

  // Agent end-to-end reply latency P50 / P95 + Error Spikes
  const count = Math.max(1, series.length)
  const slotW = plotW / count
  const barW = Math.max(4, Math.min(16, slotW * 0.45))
  const maxLat = computeNiceDurationAxisMax(
    Math.max(1000, ...series.map((p) => Math.max(p.latencyP95Ms, p.latencyP50Ms))),
  )
  const maxErr = computeNiceAxisMax(Math.max(2, ...series.map((p) => p.errors)))
  const yLat = (ms: number) => padT + plotH * (1 - Math.min(1, Math.max(0, ms / maxLat)))
  const yErr = (err: number) => padT + plotH * (1 - Math.min(1, Math.max(0, err / maxErr)))

  const buildSegmentedLine = (getter: (p: ObservabilitySeriesPoint) => number): string => {
    const segs: string[] = []
    let open = false
    for (let i = 0; i < series.length; i += 1) {
      const val = getter(series[i]!)
      if (val <= 0) {
        open = false
        continue
      }
      const x = padL + slotW * (i + 0.5)
      const y = yLat(val)
      segs.push(`${open ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`)
      open = true
    }
    return segs.join(' ')
  }

  const p95Path = buildSegmentedLine((p) => p.latencyP95Ms)
  const p50Path = buildSegmentedLine((p) => p.latencyP50Ms)
  const hovered = hoverIdx !== null ? series[hoverIdx] : undefined
  const shouldShowTechXLabel = (p: ObservabilitySeriesPoint, idx: number): boolean => {
    const isLast = idx === series.length - 1
    if (isLast) return true
    if (idx >= series.length - 2) return false
    if (series.length === 28 && !p.label.includes(':')) return true
    if (series.length === 28) return false
    const step = count <= 14 ? 2 : count <= 24 ? 4 : 5
    return idx === 0 || idx % step === 0
  }

  return (
    <div ref={wrapRef} className="fb-obs-chart-wrap">
      <div className="fb-obs-hud fb-num">
        {hovered ? (
          <>
            <strong className="fb-mono">{hovered.fullLabel}</strong>
            <span>回复耗时 P50 {formatLatencyMs(hovered.latencyP50Ms)}</span>
            <span>P95 {formatLatencyMs(hovered.latencyP95Ms)}</span>
            <span>均值 {formatLatencyMs(hovered.avgLatencyMs)}</span>
            <span>异常 {hovered.errors}</span>
          </>
        ) : (
          <span>
            Agent 端到端回复耗时（收消息→最终回复，含推理与工具）· 实线 P50 · 虚线 P95（左轴）· 异常柱（右轴）
          </span>
        )}
      </div>

      <svg
        className="fb-obs-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="端到端延迟分位与异常趋势"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {[0, 0.5, 1].map((frac, i) => {
          const y = padT + plotH * (1 - frac)
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                className="fb-obs-grid-line"
                strokeDasharray={i === 0 ? undefined : '2 3'}
              />
              <text x={padL - 8} y={y + 3.5} textAnchor="end" className="fb-obs-axis-text">
                {frac === 0 ? '0s' : formatLatencyMs(maxLat * frac)}
              </text>
              <text x={W - padR + 6} y={y + 3.5} textAnchor="start" className="fb-obs-axis-text">
                {Math.round(maxErr * frac)}
              </text>
            </g>
          )
        })}

        {/* Error bars */}
        {series.map((p, i) => {
          if (p.errors <= 0) return null
          const cx = padL + slotW * (i + 0.5)
          const top = yErr(p.errors)
          return (
            <rect
              key={`err-${p.bucketStartMs}`}
              x={cx - barW / 2}
              y={top}
              width={barW}
              height={Math.max(2, padT + plotH - top)}
              rx={1.5}
              className="fb-obs-fill-error"
              opacity={hoverIdx === i ? 0.95 : 0.45}
            />
          )
        })}

        {p95Path && <path d={p95Path} fill="none" className="fb-obs-line-warn" strokeDasharray="4 3" />}
        {p50Path && <path d={p50Path} fill="none" className="fb-obs-line-primary" />}

        {series.map((p, i) => {
          const cx = padL + slotW * (i + 0.5)
          const active = hoverIdx === i
          return (
            <g key={`pt-${p.bucketStartMs}`}>
              {active && (
                <line x1={cx} x2={cx} y1={padT} y2={padT + plotH} className="fb-obs-crosshair" />
              )}
              {p.latencyP95Ms > 0 && (
                <circle
                  cx={cx}
                  cy={yLat(p.latencyP95Ms)}
                  r={active ? 3.5 : 2}
                  className="fb-obs-dot-warn"
                />
              )}
              {p.latencyP50Ms > 0 && (
                <circle
                  cx={cx}
                  cy={yLat(p.latencyP50Ms)}
                  r={active ? 3.5 : 2}
                  className="fb-obs-dot-primary"
                />
              )}
              <rect
                x={padL + slotW * i}
                y={padT}
                width={slotW}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
              />
            </g>
          )
        })}

        {series.map((p, idx) => {
          const isLast = idx === series.length - 1
          if (!shouldShowTechXLabel(p, idx)) return null
          const cx = padL + slotW * (idx + 0.5)
          return (
            <text
              key={`tl-${p.bucketStartMs}`}
              x={isLast ? W - padR : cx}
              y={H - 6}
              textAnchor={idx === 0 ? 'start' : isLast ? 'end' : 'middle'}
              className="fb-obs-axis-text"
            >
              {p.label}
            </text>
          )
        })}
      </svg>

      <div className="fb-obs-legend fb-num">
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="primary" />
          回复耗时 P50（中位）
        </span>
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="warn" />
          回复耗时 P95（尾延迟）
        </span>
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="error" />
          异常次数（右轴）
        </span>
      </div>
    </div>
  )
}

export interface SegmentedBarItem {
  readonly id: string
  readonly label: string
  readonly valueText: string
  readonly sharePct: number
  readonly kind: 'cache' | 'primary' | 'output' | 'warn' | 'muted' | 'error'
}

export function SegmentedBar({
  items,
  layout = 'grid',
}: {
  readonly items: readonly SegmentedBarItem[]
  readonly layout?: 'grid' | 'row' | 'list'
}) {
  const nonZero = items.filter((item) => item.sharePct > 0)
  return (
    <div className="fb-obs-segbar-wrap">
      <div className="fb-obs-segbar" role="presentation">
        {nonZero.length === 0 ? (
          <div className="fb-obs-segbar-empty" />
        ) : (
          nonZero.map((item) => (
            <div
              key={item.id}
              className="fb-obs-segbar-seg"
              data-kind={item.kind}
              style={{ width: `${Math.max(2, item.sharePct)}%` }}
              title={`${item.label} · ${item.valueText} (${item.sharePct}%)`}
            />
          ))
        )}
      </div>
      <div className="fb-obs-segbar-legend fb-num" data-layout={layout}>
        {items.map((item) => (
          <div key={item.id} className="fb-obs-segbar-row">
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind={item.kind} />
              <span className="fb-obs-segbar-lbl" title={item.label}>{item.label}</span>
            </span>
            <span className="fb-obs-segbar-val">
              <strong className="fb-mono">{item.valueText}</strong>
              <span className="fb-obs-muted">{item.sharePct.toFixed(1)}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function LatencyHistogram({
  buckets,
}: {
  readonly buckets: readonly ObservabilityLatencyBucket[]
}) {
  const maxCount = Math.max(1, ...buckets.map((b) => b.count))
  return (
    <div className="fb-obs-hist">
      {buckets.map((b) => {
        const pctHeight = b.count > 0 ? Math.max(8, Math.round((b.count / maxCount) * 100)) : 0
        const isSlow = b.id === '30_60s' || b.id === 'gt_60s'
        return (
          <div key={b.id} className="fb-obs-hist-col" title={`${b.label}: ${b.count} 次 (${b.pct}%)`}>
            <span className="fb-obs-hist-val fb-num">{b.count > 0 ? b.count : ''}</span>
            <div className="fb-obs-hist-track">
              {pctHeight > 0 && (
                <div
                  className="fb-obs-hist-bar"
                  data-slow={isSlow ? '' : undefined}
                  style={{ height: `${pctHeight}%` }}
                />
              )}
            </div>
            <span className="fb-obs-hist-lbl fb-mono">{b.label}</span>
            <span className="fb-obs-hist-pct fb-num">{b.pct > 0 ? `${b.pct}%` : '—'}</span>
          </div>
        )
      })}
    </div>
  )
}

export function ActivityHeatmap({
  cells,
  maxCount,
}: {
  readonly cells: readonly ObservabilityHeatmapCell[]
  readonly maxCount: number
}) {
  const [hovered, setHovered] = useState<ObservabilityHeatmapCell | null>(null)
  const byKey = new Map<string, ObservabilityHeatmapCell>()
  for (const c of cells) {
    byKey.set(`${c.dayOfWeek}:${c.hour}`, c)
  }

  return (
    <div className="fb-obs-heat-wrap">
      <div className="fb-obs-heat-hud fb-num">
        {hovered ? (
          <span>
            <strong>
              {WEEKDAY_LABELS[hovered.dayOfWeek]} {String(hovered.hour).padStart(2, '0')}:00–
              {String(hovered.hour).padStart(2, '0')}:59
            </strong>
            {` · ${hovered.count} 次交互`}
            {hovered.tokens > 0 ? ` · ${formatTokens(hovered.tokens)} tok` : ''}
          </span>
        ) : (
          <span>7 × 24h 活跃节律矩阵 · 悬停单元格查看时段热度与 Token 强度</span>
        )}
      </div>

      <div className="fb-obs-heat-grid" onMouseLeave={() => setHovered(null)}>
        <div className="fb-obs-heat-axis-row">
          <span />
          {Array.from({ length: 24 }, (_, h) => {
            const show = h === 0 || h === 4 || h === 8 || h === 12 || h === 16 || h === 20 || h === 23
            return (
              <span
                key={h}
                className="fb-obs-heat-hour fb-mono"
                data-end={h === 23 ? '' : undefined}
              >
                {show ? String(h).padStart(2, '0') : ''}
              </span>
            )
          })}
        </div>
        {WEEKDAY_LABELS.map((dayLabel, dow) => (
          <div key={dayLabel} className="fb-obs-heat-row">
            <span className="fb-obs-heat-day">{dayLabel}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const cell = byKey.get(`${dow}:${hour}`) ?? {
                dayOfWeek: dow,
                hour,
                count: 0,
                tokens: 0,
              }
              const level = resolveHeatmapLevel(cell.count, maxCount)
              return (
                <button
                  key={hour}
                  type="button"
                  className="fb-obs-heat-cell"
                  data-level={level}
                  aria-label={`${dayLabel} ${hour}点 ${cell.count}次`}
                  onMouseEnter={() => setHovered(cell)}
                  onFocus={() => setHovered(cell)}
                />
              )
            })}
          </div>
        ))}
      </div>

      <div className="fb-obs-heat-foot">
        <span className="fb-obs-muted">低频</span>
        {[0, 1, 2, 3, 4].map((lv) => (
          <i key={lv} className="fb-obs-heat-swatch" data-level={lv} />
        ))}
        <span className="fb-obs-muted">高峰</span>
      </div>
    </div>
  )
}
