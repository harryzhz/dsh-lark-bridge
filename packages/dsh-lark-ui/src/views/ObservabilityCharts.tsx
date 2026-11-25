import { useId, useState } from 'react'
import type {
  ObservabilityHeatmapCell,
  ObservabilityLatencyBucket,
  ObservabilitySeriesPoint,
  ProcessVitalPoint,
} from '../types.js'
import {
  buildSparklineGeometry,
  computeNiceAxisMax,
  formatBytes,
  formatCompactNumber,
  formatLatencyMs,
  formatTokens,
  resolveHeatmapLevel,
  WEEKDAY_LABELS,
} from './observability-model.js'

export function Sparkline({
  values,
  tone = 'primary',
}: {
  readonly values: readonly number[]
  readonly tone?: 'primary' | 'success' | 'warn' | 'danger'
}) {
  const gradId = useId()
  const { linePath, areaPath, hasData } = buildSparklineGeometry(values, 84, 28, 3)
  return (
    <svg
      className="fb-obs-spark"
      data-tone={tone}
      viewBox="0 0 84 28"
      width={84}
      height={28}
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

export type ProductChartMode = 'tokens' | 'traffic' | 'sessions'

export function ProductTimeSeriesChart({
  series,
  mode,
}: {
  readonly series: readonly ObservabilitySeriesPoint[]
  readonly mode: ProductChartMode
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const W = 760
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
  const barW = Math.max(4, Math.min(20, slotW * 0.62))
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
    <div className="fb-obs-chart-wrap">
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

export type TechChartMode = 'latency' | 'vitals'

export function TechnicalTimeSeriesChart({
  series,
  vitals,
  mode,
}: {
  readonly series: readonly ObservabilitySeriesPoint[]
  readonly vitals: readonly ProcessVitalPoint[]
  readonly mode: TechChartMode
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const W = 760
  const H = 196
  const padL = 54
  const padR = 44
  const padT = 14
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB

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
      <div className="fb-obs-chart-wrap">
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

  // Latency P50 / P95 + Error Spikes
  const count = Math.max(1, series.length)
  const slotW = plotW / count
  const barW = Math.max(4, Math.min(16, slotW * 0.45))
  const maxLat = computeNiceAxisMax(
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
    <div className="fb-obs-chart-wrap">
      <div className="fb-obs-hud fb-num">
        {hovered ? (
          <>
            <strong className="fb-mono">{hovered.fullLabel}</strong>
            <span>P50 {formatLatencyMs(hovered.latencyP50Ms)}</span>
            <span>P95 {formatLatencyMs(hovered.latencyP95Ms)}</span>
            <span>均值 {formatLatencyMs(hovered.avgLatencyMs)}</span>
            <span>异常 {hovered.errors}</span>
          </>
        ) : (
          <span>实线 P50 · 虚线 P95（左轴）· 异常柱（右轴）· 悬停查看各时段延迟分位</span>
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
          P50 中位延迟
        </span>
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="warn" />
          P95 尾延迟
        </span>
        <span className="fb-obs-legend-item">
          <i className="fb-obs-dot" data-kind="error" />
          异常次数 (右轴)
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

export function SegmentedBar({ items }: { readonly items: readonly SegmentedBarItem[] }) {
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
      <div className="fb-obs-segbar-legend fb-num">
        {items.map((item) => (
          <div key={item.id} className="fb-obs-segbar-row">
            <span className="fb-obs-legend-item">
              <i className="fb-obs-dot" data-kind={item.kind} />
              <span>{item.label}</span>
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
          {[0, 4, 8, 12, 16, 20, 23].map((h) => (
            <span
              key={h}
              className="fb-obs-heat-hour fb-mono"
              style={{ gridColumn: `${h + 2} / span 2` }}
            >
              {String(h).padStart(2, '0')}
            </span>
          ))}
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
