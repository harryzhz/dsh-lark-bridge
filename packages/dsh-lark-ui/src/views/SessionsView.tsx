import { useMemo, useState } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CountSegmentedSwitch,
  FilterTabs,
  ListFilterBar,
  OverflowMenu,
  resolveEffectiveBotId,
} from '../components/fields.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from '../components/options.js'
import { cleanSummaryDetail } from '../components/ExperimentalSection.js'
import { resolveNativeModelLabel } from '../components/TriageConfigFields.js'
import { formatDuration, formatTime } from '../state.js'
import type {
  AuditEvent,
  AuditEventKind,
  BotRecord,
  DreamSession,
  ModelGroup,
  RuntimeOption,
  SessionBinding,
  TriageSession,
} from '../types.js'
import { eventTag } from './OverviewView.js'

type Pane = 'sessions' | 'events'
export type SessionFilter = 'all' | 'chat' | 'triage' | 'dreaming'
export type EventFilter = 'all' | AuditEventKind

export type UnifiedSessionRow =
  | { readonly kind: 'chat'; readonly lastActivityMs: number; readonly binding: SessionBinding }
  | { readonly kind: 'triage'; readonly lastActivityMs: number; readonly triage: TriageSession }
  | { readonly kind: 'dreaming'; readonly lastActivityMs: number; readonly dream: DreamSession }

export const EVENT_FILTERS: ReadonlyArray<{ value: EventFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'triage', label: '分流' },
  { value: 'reply', label: '回复' },
  { value: 'inbound', label: '收到' },
  { value: 'silent_skip', label: '静默' },
  { value: 'error', label: '异常' },
]

export function mergeSessionRows(
  bindings: readonly SessionBinding[],
  dreamSessions: readonly DreamSession[],
  filter: SessionFilter,
  triageSessions: readonly TriageSession[] = [],
): UnifiedSessionRow[] {
  const rows: UnifiedSessionRow[] = []
  if (filter === 'all' || filter === 'chat') {
    for (const binding of bindings) {
      rows.push({ kind: 'chat', lastActivityMs: binding.lastActivityMs, binding })
    }
  }
  if (filter === 'all' || filter === 'triage') {
    for (const triage of triageSessions) {
      rows.push({ kind: 'triage', lastActivityMs: triage.lastActivityMs, triage })
    }
  }
  if (filter === 'all' || filter === 'dreaming') {
    for (const dream of dreamSessions) {
      rows.push({ kind: 'dreaming', lastActivityMs: dream.lastActivityMs, dream })
    }
  }
  return rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
}

export function filterSessionRows(
  rows: readonly UnifiedSessionRow[],
  query: string,
): UnifiedSessionRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter((row) => {
    if (row.kind === 'chat') {
      const b = row.binding
      return (
        (b.chatName ?? '').toLowerCase().includes(q) ||
        b.chatId.toLowerCase().includes(q) ||
        b.workspaceName.toLowerCase().includes(q) ||
        (b.botName ?? '').toLowerCase().includes(q) ||
        b.botId.toLowerCase().includes(q) ||
        (b.listenerName ?? '').toLowerCase().includes(q)
      )
    }
    if (row.kind === 'triage') {
      const t = row.triage
      return (
        (t.chatName ?? '').toLowerCase().includes(q) ||
        t.chatId.toLowerCase().includes(q) ||
        (t.senderName ?? '').toLowerCase().includes(q) ||
        t.reason.toLowerCase().includes(q) ||
        (t.errorCode ?? '').toLowerCase().includes(q) ||
        (t.errorMessage ?? '').toLowerCase().includes(q) ||
        (t.botName ?? '').toLowerCase().includes(q) ||
        t.botId.toLowerCase().includes(q) ||
        (t.listenerName ?? '').toLowerCase().includes(q)
      )
    }
    const d = row.dream
    return (
      (d.botName ?? '').toLowerCase().includes(q) ||
      d.botId.toLowerCase().includes(q) ||
      d.workspaceName.toLowerCase().includes(q) ||
      (d.summary ?? '').toLowerCase().includes(q)
    )
  })
}

export function countAuditEventsByKind(
  events: readonly AuditEvent[],
): Partial<Record<AuditEventKind, number>> {
  const counts: Partial<Record<AuditEventKind, number>> = {}
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1
  }
  return counts
}

export function filterAuditEvents(
  events: readonly AuditEvent[],
  botId: string,
  kind: EventFilter,
  query: string,
): AuditEvent[] {
  const q = query.trim().toLowerCase()
  return events.filter((e) => {
    if (botId && e.botId !== botId) return false
    if (kind !== 'all' && e.kind !== kind) return false
    if (!q) return true
    return (
      e.summary.toLowerCase().includes(q) ||
      (e.chatName ?? '').toLowerCase().includes(q) ||
      (e.chatId ?? '').toLowerCase().includes(q) ||
      (e.botName ?? '').toLowerCase().includes(q) ||
      e.botId.toLowerCase().includes(q)
    )
  })
}

function triageActionTag(t: TriageSession) {
  if (t.fallback) return <Tag tone="warning">回退</Tag>
  if (t.action === 'silent') return <Tag tone="neutral">静默</Tag>
  if (t.action === 'quick_reply') return <Tag tone="success">快回</Tag>
  return <Tag tone="info">转交</Tag>
}

export function SessionsView({
  bindings,
  dreamSessions,
  triageSessions = [],
  events,
  bots = [],
  runtimes,
  models = [],
  onOpen,
  onUnbind,
  onDeleteDreamSession,
  onDeleteTriageSession,
  onClearTriageSessions,
  onRotateViewerSecret,
}: {
  bindings: readonly SessionBinding[]
  dreamSessions: readonly DreamSession[]
  triageSessions?: readonly TriageSession[]
  events: readonly AuditEvent[]
  bots?: readonly BotRecord[]
  runtimes: readonly RuntimeOption[]
  models?: readonly ModelGroup[]
  onOpen: (sessionId: string) => void
  onUnbind: (binding: SessionBinding) => void
  onDeleteDreamSession?: (session: DreamSession) => void
  onDeleteTriageSession?: (session: TriageSession) => void
  onClearTriageSessions?: () => void
  onRotateViewerSecret?: () => void
}) {
  const [pane, setPane] = useState<Pane>('sessions')
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('chat')
  const [kind, setKind] = useState<EventFilter>('all')
  const [botId, setBotId] = useState('')
  const [query, setQuery] = useState('')
  const effectiveBotId = resolveEffectiveBotId(botId, bots)

  const botBindings = useMemo(
    () => (effectiveBotId ? bindings.filter((b) => b.botId === effectiveBotId) : bindings),
    [bindings, effectiveBotId],
  )
  const botDreamSessions = useMemo(
    () => (effectiveBotId ? dreamSessions.filter((d) => d.botId === effectiveBotId) : dreamSessions),
    [dreamSessions, effectiveBotId],
  )
  const botTriageSessions = useMemo(
    () => (effectiveBotId ? triageSessions.filter((t) => t.botId === effectiveBotId) : triageSessions),
    [triageSessions, effectiveBotId],
  )
  const botEvents = useMemo(
    () => (effectiveBotId ? events.filter((e) => e.botId === effectiveBotId) : events),
    [events, effectiveBotId],
  )

  const eventCounts = useMemo(() => countAuditEventsByKind(botEvents), [botEvents])

  const filteredEvents = useMemo(
    () => filterAuditEvents(botEvents, '', kind, query),
    [botEvents, kind, query],
  )
  const visibleSessions = useMemo(
    () =>
      filterSessionRows(
        mergeSessionRows(botBindings, botDreamSessions, sessionFilter, botTriageSessions),
        query,
      ),
    [botBindings, botDreamSessions, sessionFilter, botTriageSessions, query],
  )
  const primarySessionCount = botBindings.length + botDreamSessions.length
  const hasFilter = Boolean(effectiveBotId || query.trim())

  const emptySessionText = hasFilter
    ? '没有匹配的会话'
    : sessionFilter === 'chat'
      ? '暂无活跃对话会话'
      : sessionFilter === 'triage'
        ? '暂无智能分流会话。开启智能分流并收到群消息后，每次分流判断过程会完整记录在这里'
        : sessionFilter === 'dreaming'
          ? '暂无 Dreaming 会话。智能体定时整理或点击「立即整理」后会自动显示在这里'
          : '暂无会话'

  const searchPlaceholder =
    pane === 'events'
      ? '搜索日志内容、群聊或智能体'
      : sessionFilter === 'triage'
        ? '搜索群聊、成员、分流原因或智能体'
        : sessionFilter === 'dreaming'
          ? '搜索智能体、工作区或整理摘要'
          : '搜索群聊、工作区或智能体'

  return (
    <>
      <div className="fb-view-bar">
        <CountSegmentedSwitch
          label="会话与日志"
          value={pane}
          options={[
            { value: 'sessions', label: '会话', count: primarySessionCount },
            { value: 'events', label: '运行日志' },
          ]}
          onChange={(next) => {
            setPane(next)
            setQuery('')
          }}
        />
        {pane === 'sessions' ? (
          <div className="fb-view-bar-right">
            <FilterTabs
              label="会话类型筛选"
              value={sessionFilter}
              options={[
                { value: 'chat', label: '对话', count: botBindings.length },
                { value: 'triage', label: '智能分流', count: botTriageSessions.length },
                { value: 'dreaming', label: 'Dreaming', count: botDreamSessions.length },
              ]}
              onChange={setSessionFilter}
            />
            {sessionFilter === 'triage' && triageSessions.length > 0 && onClearTriageSessions && (
              <Button size="sm" variant="ghost" onClick={onClearTriageSessions}>
                清空记录
              </Button>
            )}
            {sessionFilter !== 'triage' && onRotateViewerSecret && (
              <Button size="sm" variant="ghost" onClick={onRotateViewerSecret}>
                重置只读链接
              </Button>
            )}
          </div>
        ) : (
          <FilterTabs
            label="运行日志事件筛选"
            value={kind}
            options={EVENT_FILTERS.map((opt) => ({
              value: opt.value,
              label: opt.label,
              count: opt.value === 'all' ? botEvents.length : (eventCounts[opt.value] ?? 0),
            }))}
            onChange={setKind}
          />
        )}
      </div>

      <ListFilterBar
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder={searchPlaceholder}
        bots={bots}
        botId={effectiveBotId}
        onBotIdChange={setBotId}
      />

      {pane === 'sessions' ? (
        <div className="fb-card fb-list">
          {visibleSessions.length === 0 && <div className="fb-empty">{emptySessionText}</div>}
          {visibleSessions.map((row) => {
            if (row.kind === 'chat') {
              const b = row.binding
              const runtimeLabel = resolveRuntimeDisplayName(b.agentPreset, runtimes, b.runtimeProfileId)
              return (
                <div key={`chat:${b.routeKey}`} className="fb-item">
                  <div className="fb-item-main">
                    <div className="fb-item-title">
                      <span>{b.chatName || (b.trigger === 'p2p' ? '私聊' : b.chatId)}</span>
                    </div>
                    <div className="fb-item-meta">
                      {runtimeLabel} · 工作区 {b.workspaceName} ·{' '}
                      {b.listenerName ? `监听「${b.listenerName}」` : b.botName ?? b.botId}
                    </div>
                  </div>
                  <span className="fb-item-time">{formatTime(b.lastActivityMs)}</span>
                  <div className="fb-item-side">
                    <Button size="sm" variant="outline" onClick={() => onOpen(b.sessionId)}>
                      打开
                    </Button>
                    <OverflowMenu
                      label="会话更多操作"
                      items={[
                        {
                          id: 'copy',
                          label: '复制会话 ID',
                          onSelect: () => void navigator.clipboard?.writeText(b.sessionId),
                        },
                        {
                          id: 'unbind',
                          label: '结束并归档',
                          danger: true,
                          onSelect: () => onUnbind(b),
                        },
                      ]}
                    />
                  </div>
                </div>
              )
            }

            if (row.kind === 'triage') {
              const t = row.triage
              const modelLabel = t.model
                ? resolveNativeModelLabel(t.provider ?? '', t.model, models)
                : ''
              const errorTag =
                t.fallback && (t.errorCode || t.errorMessage)
                  ? `[${t.errorCode ?? 'error'}${t.errorMessage ? `: ${t.errorMessage}` : ''}]`
                  : null
              const metaText = [
                t.botName || t.botId,
                t.listenerName ? `监听「${t.listenerName}」` : null,
                t.senderName || null,
                modelLabel || null,
                t.durationMs ? formatDuration(t.durationMs) : null,
                errorTag || t.reason || null,
              ]
                .filter(Boolean)
                .join(' · ')

              return (
                <div key={`triage:${t.sessionId}`} className="fb-item">
                  <div className="fb-item-main">
                    <div className="fb-item-title">
                      <span>{t.chatName || t.chatId}</span>
                      {triageActionTag(t)}
                    </div>
                    <div className="fb-item-meta" title={errorTag ? `${t.reason} ${errorTag}` : t.reason || metaText}>
                      {metaText}
                    </div>
                  </div>
                  <span className="fb-item-time">{formatTime(t.lastActivityMs)}</span>
                  <div className="fb-item-side">
                    <Button size="sm" variant="outline" onClick={() => onOpen(t.sessionId)}>
                      查看
                    </Button>
                    <OverflowMenu
                      label="分流会话更多操作"
                      items={[
                        ...(t.handoffSessionId
                          ? [
                              {
                                id: 'open-handoff',
                                label: '打开转交的主会话',
                                onSelect: () => onOpen(t.handoffSessionId!),
                              },
                            ]
                          : []),
                        {
                          id: 'copy',
                          label: '复制会话 ID',
                          onSelect: () => void navigator.clipboard?.writeText(t.sessionId),
                        },
                        ...(onDeleteTriageSession
                          ? [
                              { type: 'separator' as const, id: 'sep' },
                              {
                                id: 'delete',
                                label: '移除记录',
                                danger: true,
                                onSelect: () => onDeleteTriageSession(t),
                              },
                            ]
                          : []),
                      ]}
                    />
                  </div>
                </div>
              )
            }

            const s = row.dream
            const runtimeLabel = resolveRuntimeDisplayName(s.agentPreset, runtimes, s.runtimeProfileId)
            const modelLabel = resolveModelDisplayName(s.agentPreset, s.model, runtimes, models)
            const dotState =
              s.status === 'running' ? 'ongoing' : s.status === 'failed' ? 'error' : 'done'
            const memParts = s.memoryStats
              ? [
                  s.memoryStats.created > 0 ? `新增 ${s.memoryStats.created}` : null,
                  s.memoryStats.updated > 0 ? `更新 ${s.memoryStats.updated}` : null,
                  s.memoryStats.superseded > 0 ? `纠偏 ${s.memoryStats.superseded}` : null,
                  s.memoryStats.archived > 0 ? `归档 ${s.memoryStats.archived}` : null,
                ].filter(Boolean)
              : []
            const ps = s.proactiveStats
            const statusProgress =
              s.status === 'running'
                ? s.processedCount > 0
                  ? `正在整理 ${s.processedCount} 个会话`
                  : '正在核查记忆'
                : s.status === 'succeeded'
                  ? ps && ps.batchesRun > 1
                    ? `已整理 ${s.processedCount} 个会话（${ps.batchesRun} 批）`
                    : `已整理 ${s.processedCount} 个会话`
                  : null
            const cleanDreamSummary = s.summary ? cleanSummaryDetail(s.summary) : ''
            const metaText = [
              `${runtimeLabel}${modelLabel ? ` · ${modelLabel}` : ''}`,
              `工作区 ${s.workspaceName}`,
              statusProgress,
              ps && ps.backlogRemaining > 0 ? `剩余积压 ${ps.backlogRemaining}` : null,
              s.durationMs ? formatDuration(s.durationMs) : null,
              cleanDreamSummary || null,
            ]
              .filter(Boolean)
              .join(' · ')

            return (
              <div key={`dream:${s.sessionId}`} className="fb-item">
                <div className="fb-item-main">
                  <div className="fb-item-title">
                    <span>{`${s.botName || s.botId} · 记忆整理`}</span>
                    <StateDot state={dotState} />
                    <Tag tone="info">Dreaming</Tag>
                    {s.status === 'running' && <Tag tone="neutral">整理中</Tag>}
                    {s.status === 'failed' && <Tag tone="danger">失败</Tag>}
                    {s.status === 'succeeded' && memParts.length > 0 && (
                      <Tag tone="success">{memParts.join(' · ')}</Tag>
                    )}
                    {s.status === 'succeeded' && ps && ps.remindersCreated > 0 && (
                      <Tag tone="info">{`提醒 +${ps.remindersCreated}`}</Tag>
                    )}
                    {s.status === 'succeeded' && ps && ps.worktreesCreated > 0 && (
                      <Tag tone="info">{`分支 +${ps.worktreesCreated}`}</Tag>
                    )}
                    {s.status === 'succeeded' && s.outcome === 'no_change' && (
                      <Tag tone="neutral">无新增变更</Tag>
                    )}
                  </div>
                  <div className="fb-item-meta" title={s.summary || metaText}>
                    {metaText}
                  </div>
                </div>
                <span className="fb-item-time">{formatTime(s.lastActivityMs)}</span>
                <div className="fb-item-side">
                  <Button size="sm" variant="outline" onClick={() => onOpen(s.sessionId)}>
                    打开
                  </Button>
                  <OverflowMenu
                    label="Dreaming 会话更多操作"
                    items={[
                      {
                        id: 'copy',
                        label: '复制会话 ID',
                        onSelect: () => void navigator.clipboard?.writeText(s.sessionId),
                      },
                      ...(s.status !== 'running' && onDeleteDreamSession
                        ? [
                            { type: 'separator' as const, id: 'sep' },
                            {
                              id: 'delete',
                              label: '移除记录',
                              danger: true,
                              onSelect: () => onDeleteDreamSession(s),
                            },
                          ]
                        : []),
                    ]}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="fb-card fb-list">
          {filteredEvents.length === 0 && (
            <div className="fb-empty">
              {hasFilter || kind !== 'all' ? '没有匹配的日志' : '暂无日志'}
            </div>
          )}
          {filteredEvents.map((e) => (
            <div key={e.id} className="fb-item">
              {eventTag(e.kind)}
              <div className="fb-item-main">
                <div className="fb-item-title">
                  <span title={e.summary}>{e.summary}</span>
                </div>
                <div className="fb-item-meta">
                  {[
                    e.botName ?? e.botId,
                    e.chatName,
                    e.durationMs !== undefined ? formatDuration(e.durationMs) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <span className="fb-item-time">{formatTime(e.timestampMs)}</span>
              {e.sessionId && (
                <Button size="sm" variant="ghost" onClick={() => onOpen(e.sessionId!)}>
                  查看
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
