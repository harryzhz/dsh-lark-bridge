import { Fragment, useMemo, useState } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { FilterTabs } from '../components/fields.js'
import { formatTime } from '../state.js'
import type { ObservabilityListenerRuleRow, ObservabilityListenerSummary } from '../types.js'
import { LatencyHistogram, SegmentedBar, type SegmentedBarItem } from './ObservabilityCharts.js'
import {
  computeNiceDurationAxisMax,
  formatCompactNumber,
  formatLatencyMs,
  formatTokens,
} from './observability-model.js'

type ListenerPaneTab = 'rules' | 'latency'

const DEFAULT_VISIBLE_RULES = 8

function resolveSilentRateTone(rule: ObservabilityListenerRuleRow): 'warn' | 'neutral' {
  if (rule.hits < 5) return 'neutral'
  if (rule.silentRate >= 85) return 'warn'
  if (rule.workerSilent / rule.hits >= 0.6) return 'warn'
  return 'neutral'
}

export function ListenerRulesPanel({
  listeners,
  showBotName,
  onOpenSession,
}: {
  readonly listeners?: ObservabilityListenerSummary | undefined
  readonly showBotName: boolean
  readonly onOpenSession?: ((sessionId: string) => void) | undefined
}) {
  const [viewTab, setViewTab] = useState<ListenerPaneTab>('rules')
  const [expandedKey, setExpandedKey] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [reflectionExpanded, setReflectionExpanded] = useState(false)

  const rules = listeners?.rules ?? []
  const totalHits = listeners?.totalHits ?? 0
  const totalReplied = listeners?.totalReplied ?? 0
  const totalSilentSkipped = listeners?.totalSilentSkipped ?? 0
  const totalTriageSilent = listeners?.totalTriageSilent ?? 0
  const totalWorkerSilent = listeners?.totalWorkerSilent ?? 0
  const totalErrors = listeners?.totalErrors ?? 0
  const latencySamples = listeners?.latencySamples ?? 0
  const latestReflection = listeners?.latestReflection

  const outcomeSegments = useMemo<SegmentedBarItem[]>(() => {
    const denom = Math.max(1, totalReplied + totalSilentSkipped + totalErrors)
    const pct = (n: number) => Math.round((n / denom) * 1000) / 10
    const items: SegmentedBarItem[] = [
      {
        id: 'replied',
        label: '命中并回复',
        valueText: formatCompactNumber(totalReplied),
        sharePct: pct(totalReplied),
        kind: 'primary',
      },
      {
        id: 'triage_silent',
        label: '分流静默拦截',
        valueText: formatCompactNumber(totalTriageSilent),
        sharePct: pct(totalTriageSilent),
        kind: 'cache',
      },
      {
        id: 'worker_silent',
        label: '运行时静默',
        valueText: formatCompactNumber(totalWorkerSilent),
        sharePct: pct(totalWorkerSilent),
        kind: 'muted',
      },
    ]
    if (totalErrors > 0) {
      items.push({
        id: 'errors',
        label: '执行异常',
        valueText: formatCompactNumber(totalErrors),
        sharePct: pct(totalErrors),
        kind: 'error',
      })
    }
    return items
  }, [totalReplied, totalSilentSkipped, totalTriageSilent, totalWorkerSilent, totalErrors])

  const visibleRules = showAll ? rules : rules.slice(0, DEFAULT_VISIBLE_RULES)

  const latencyRankedRules = useMemo(
    () =>
      rules
        .filter((r) => r.latencySamples > 0)
        .sort((a, b) => b.p95LatencyMs - a.p95LatencyMs || b.avgLatencyMs - a.avgLatencyMs),
    [rules],
  )
  const latencyAxisMaxMs = useMemo(() => {
    const rawMax = Math.max(
      0,
      ...latencyRankedRules.map((r) => Math.max(r.p95LatencyMs, r.p50LatencyMs)),
    )
    return computeNiceDurationAxisMax(rawMax)
  }, [latencyRankedRules])

  const subheadText = useMemo(() => {
    if (!listeners || (rules.length === 0 && totalHits === 0)) return 'NO RULES'
    const parts = [`${rules.length} RULES`]
    if (totalHits > 0) {
      parts.push(`${formatCompactNumber(totalHits)} HITS`)
      parts.push(`${listeners.silentRate}% SILENT`)
    } else {
      parts.push('0 HITS')
    }
    return parts.join(' · ')
  }, [listeners, rules.length, totalHits])

  const toggleExpand = (key: string) => {
    setExpandedKey((prev) => (prev === key ? '' : key))
  }

  return (
    <section className="fb-card fb-obs-panel" data-panel="listener-rules">
      <div className="fb-obs-panel-head">
        <div className="fb-obs-panel-title-wrap">
          <h2 className="fb-obs-panel-title">主动监听规则观测</h2>
          <span className="fb-obs-panel-sub fb-mono">{subheadText}</span>
        </div>
        <FilterTabs
          label="监听规则观测视角切换"
          value={viewTab}
          options={[
            { value: 'rules' as const, label: '规则明细', count: rules.length },
            {
              value: 'latency' as const,
              label: '耗时分布',
              ...(latencySamples > 0 ? { count: latencySamples } : {}),
            },
          ]}
          onChange={setViewTab}
        />
      </div>

      {!listeners || (rules.length === 0 && totalHits === 0) ? (
        <div className="fb-obs-empty-inline">当前筛选范围暂无主动监听规则记录</div>
      ) : viewTab === 'rules' ? (
        <>
          {totalHits > 0 && (
            <>
              <div className="fb-obs-listener-segbar">
                <SegmentedBar items={outcomeSegments} layout="row" />
              </div>
              <div className="fb-obs-divider" />
            </>
          )}

          <div className="fb-obs-table-wrap">
            <table className="fb-obs-table fb-obs-listener-table fb-num">
              <thead>
                <tr>
                  <th>监听规则</th>
                  <th className="fb-obs-tr">命中</th>
                  <th>回复 / 静默分布</th>
                  <th className="fb-obs-tr">静默率</th>
                  <th className="fb-obs-tr">P50 / P95</th>
                  <th className="fb-obs-tr">Token</th>
                </tr>
              </thead>
              <tbody>
                {visibleRules.map((rule) => {
                  const expanded = expandedKey === rule.key
                  const denom = Math.max(1, rule.replied + rule.silentSkipped + rule.errors)
                  const repliedPct = rule.hits > 0 ? (rule.replied / denom) * 100 : 0
                  const triageSilentPct = rule.hits > 0 ? (rule.triageSilent / denom) * 100 : 0
                  const workerSilentPct = rule.hits > 0 ? (rule.workerSilent / denom) * 100 : 0
                  const errPct = rule.hits > 0 ? (rule.errors / denom) * 100 : 0
                  const subParts = [
                    rule.chatName,
                    showBotName ? rule.botName : '',
                    rule.kind === 'delegation' ? '委派观察' : !rule.enabled ? '已停用' : '',
                  ].filter(Boolean)
                  const silentTone = resolveSilentRateTone(rule)

                  return (
                    <Fragment key={rule.key}>
                      <tr
                        className="fb-obs-listener-row"
                        data-expanded={expanded ? '' : undefined}
                        tabIndex={0}
                        aria-expanded={expanded}
                        onClick={() => toggleExpand(rule.key)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleExpand(rule.key)
                          }
                        }}
                      >
                        <td>
                          <div className="fb-obs-cell-stack">
                            <span className="fb-obs-cell-main" title={rule.ruleName}>
                              {rule.ruleName}
                            </span>
                            <span className="fb-obs-cell-sub" title={subParts.join(' · ')}>
                              {subParts.join(' · ')}
                            </span>
                          </div>
                        </td>
                        <td className="fb-obs-tr fb-mono">
                          {rule.hits > 0 ? (
                            <strong>{formatCompactNumber(rule.hits)}</strong>
                          ) : (
                            <span className="fb-obs-muted">0</span>
                          )}
                        </td>
                        <td>
                          {rule.hits === 0 ? (
                            <span className="fb-obs-muted">本周期未命中</span>
                          ) : (
                            <div
                              className="fb-obs-listener-ratio"
                              title={`回复 ${rule.replied} · 分流静默 ${rule.triageSilent} · 运行时静默 ${rule.workerSilent}${rule.errors > 0 ? ` · 异常 ${rule.errors}` : ''}`}
                            >
                              <div className="fb-obs-listener-bar">
                                {repliedPct > 0 && (
                                  <span
                                    className="fb-obs-listener-seg"
                                    data-kind="primary"
                                    style={{ width: `${repliedPct}%` }}
                                  />
                                )}
                                {triageSilentPct > 0 && (
                                  <span
                                    className="fb-obs-listener-seg"
                                    data-kind="cache"
                                    style={{ width: `${triageSilentPct}%` }}
                                  />
                                )}
                                {workerSilentPct > 0 && (
                                  <span
                                    className="fb-obs-listener-seg"
                                    data-kind="muted"
                                    style={{ width: `${workerSilentPct}%` }}
                                  />
                                )}
                                {errPct > 0 && (
                                  <span
                                    className="fb-obs-listener-seg"
                                    data-kind="error"
                                    style={{ width: `${errPct}%` }}
                                  />
                                )}
                              </div>
                              <span className="fb-obs-listener-ratio-meta fb-mono">
                                回 {rule.replied} · 静 {rule.silentSkipped}
                                {rule.errors > 0 ? ` · 错 ${rule.errors}` : ''}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="fb-obs-tr">
                          {rule.hits > 0 ? (
                            <span className="fb-obs-pill fb-mono" data-tone={silentTone}>
                              {rule.silentRate}%
                            </span>
                          ) : (
                            <span className="fb-obs-muted fb-mono">—</span>
                          )}
                        </td>
                        <td className="fb-obs-tr fb-mono">
                          {rule.latencySamples > 0 ? (
                            <span
                              title={`均值 ${formatLatencyMs(rule.avgLatencyMs)} · 最大 ${formatLatencyMs(rule.maxLatencyMs)} · ${rule.latencySamples} 样本`}
                            >
                              {formatLatencyMs(rule.p50LatencyMs)}{' '}
                              <span className="fb-obs-muted">
                                / {formatLatencyMs(rule.p95LatencyMs)}
                              </span>
                            </span>
                          ) : (
                            <span className="fb-obs-muted">—</span>
                          )}
                        </td>
                        <td className="fb-obs-tr">
                          <div className="fb-obs-listener-end fb-mono">
                            <span>{rule.totalTokens > 0 ? formatTokens(rule.totalTokens) : '—'}</span>
                            <span className="fb-obs-rank-chevron" aria-hidden="true">
                              ›
                            </span>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="fb-obs-listener-detail-row">
                          <td colSpan={6}>
                            <div className="fb-obs-listener-detail">
                              <div className="fb-obs-listener-detail-grid fb-mono">
                                <span>
                                  <em className="fb-obs-muted">静默拆解</em> 分流 {rule.triageSilent}{' '}
                                  · 运行时 {rule.workerSilent}
                                </span>
                                <span>
                                  <em className="fb-obs-muted">回复 / 静默均耗</em>{' '}
                                  {formatLatencyMs(rule.repliedAvgLatencyMs)} /{' '}
                                  {formatLatencyMs(rule.silentAvgLatencyMs)}
                                </span>
                                <span>
                                  <em className="fb-obs-muted">最大耗时 / 样本</em>{' '}
                                  {formatLatencyMs(rule.maxLatencyMs)} · {rule.latencySamples}
                                </span>
                                <span>
                                  <em className="fb-obs-muted">最近触发</em>{' '}
                                  {rule.lastTriggeredAtMs > 0
                                    ? formatTime(rule.lastTriggeredAtMs)
                                    : '本周期无触发'}
                                </span>
                              </div>
                              {rule.latencySamples > 0 && (
                                <LatencyHistogram buckets={rule.latencyHistogram} />
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {rules.length > DEFAULT_VISIBLE_RULES && (
            <button
              type="button"
              className="fb-obs-rank-more"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? '收起规则列表' : `查看全部 ${rules.length} 条监听规则`}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="fb-obs-percentile-strip fb-mono">
            <span>
              <em className="fb-obs-muted">P50</em> {formatLatencyMs(listeners.p50LatencyMs)}
            </span>
            <span>
              <em className="fb-obs-muted">P75</em> {formatLatencyMs(listeners.p75LatencyMs)}
            </span>
            <span>
              <em className="fb-obs-muted">P95</em> {formatLatencyMs(listeners.p95LatencyMs)}
            </span>
            <span>
              <em className="fb-obs-muted">P99</em> {formatLatencyMs(listeners.p99LatencyMs)}
            </span>
            <span>
              <em className="fb-obs-muted">回复均耗</em>{' '}
              {formatLatencyMs(listeners.repliedAvgLatencyMs)}
            </span>
            <span>
              <em className="fb-obs-muted">静默均耗</em>{' '}
              {formatLatencyMs(listeners.silentAvgLatencyMs)}
            </span>
          </div>

          {latencySamples > 0 ? (
            <LatencyHistogram buckets={listeners.latencyHistogram} />
          ) : (
            <div className="fb-obs-empty-inline">当前周期暂无监听处理耗时采样</div>
          )}

          {latencyRankedRules.length > 0 && (
            <>
              <div className="fb-obs-divider" />
              <div className="fb-obs-listener-lat-head">
                <span className="fb-obs-subhead">各规则耗时区间对比（实色 P50 · 浅色 P95）</span>
                <span className="fb-mono fb-obs-muted">
                  刻度上限 {formatLatencyMs(latencyAxisMaxMs)}
                </span>
              </div>
              <div className="fb-obs-listener-lat-list fb-num">
                {latencyRankedRules.slice(0, 10).map((rule) => {
                  const p50Pct = Math.min(100, (rule.p50LatencyMs / latencyAxisMaxMs) * 100)
                  const p95Pct = Math.min(
                    100,
                    Math.max(p50Pct, (rule.p95LatencyMs / latencyAxisMaxMs) * 100),
                  )
                  const tip = `均耗 ${formatLatencyMs(rule.avgLatencyMs)} · 回复均耗 ${formatLatencyMs(rule.repliedAvgLatencyMs)} · 静默均耗 ${formatLatencyMs(rule.silentAvgLatencyMs)} · 最大 ${formatLatencyMs(rule.maxLatencyMs)} · ${rule.latencySamples} 样本`
                  return (
                    <div key={rule.key} className="fb-obs-listener-lat-row" title={tip}>
                      <div className="fb-obs-listener-lat-name">
                        <span className="fb-obs-cell-main">{rule.ruleName}</span>
                        <span className="fb-obs-cell-sub">
                          {rule.chatName}
                          {showBotName ? ` · ${rule.botName}` : ''}
                        </span>
                      </div>
                      <div className="fb-obs-listener-lat-track">
                        <span
                          className="fb-obs-listener-lat-p95"
                          style={{ width: `${Math.max(2, p95Pct)}%` }}
                        />
                        <span
                          className="fb-obs-listener-lat-p50"
                          style={{ width: `${Math.max(1.5, p50Pct)}%` }}
                        />
                      </div>
                      <span className="fb-obs-listener-lat-val fb-mono">
                        {formatLatencyMs(rule.p50LatencyMs)}{' '}
                        <em className="fb-obs-muted">/ {formatLatencyMs(rule.p95LatencyMs)}</em>
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}

      {latestReflection && (
        <>
          <div className="fb-obs-divider" />
          <div className="fb-obs-reflection-bar">
            <div className="fb-obs-reflection-main">
              <div className="fb-obs-reflection-head">
                <i
                  className="fb-obs-dot"
                  data-kind={latestReflection.suggestionsCount > 0 ? 'warn' : 'success'}
                />
                <span className="fb-obs-reflection-title">Auto-Dream 周度规则反思</span>
                <span className="fb-obs-muted fb-mono">
                  {latestReflection.dateKey}
                  {showBotName ? ` · ${latestReflection.botName}` : ''}
                  {latestReflection.evaluatedRules > 0
                    ? ` · 评估 ${latestReflection.evaluatedRules} 条规则`
                    : ''}
                  {latestReflection.suggestionsCount > 0
                    ? ` · ${latestReflection.suggestionsCount} 项建议`
                    : ' · 规则健康'}
                </span>
              </div>
              <button
                type="button"
                className="fb-obs-reflection-summary"
                data-expanded={reflectionExpanded ? '' : undefined}
                title={latestReflection.summary}
                onClick={() => setReflectionExpanded((v) => !v)}
              >
                {latestReflection.summary}
              </button>
            </div>
            {latestReflection.sessionId && onOpenSession && (
              <button
                type="button"
                className="fb-dream-inline-link"
                onClick={() => onOpenSession(latestReflection.sessionId!)}
              >
                <span>查看会话</span>
                <IconChevronRightOutlineRegular size={13} />
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
