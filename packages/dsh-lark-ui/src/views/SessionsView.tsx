import { useMemo, useState } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { CountSegmentedSwitch, FilterTabs, OverflowMenu, SelectMenu } from '../components/fields.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from '../components/options.js'
import { formatDuration, formatTime } from '../state.js'
import type {
  AuditEvent,
  AuditEventKind,
  DreamSession,
  ModelGroup,
  RuntimeOption,
  SessionBinding,
} from '../types.js'
import { eventTag } from './OverviewView.js'

type Pane = 'sessions' | 'events'
type SessionFilter = 'all' | 'chat' | 'dreaming'

type UnifiedSessionRow =
  | { readonly kind: 'chat'; readonly lastActivityMs: number; readonly binding: SessionBinding }
  | { readonly kind: 'dreaming'; readonly lastActivityMs: number; readonly dream: DreamSession }

const EVENT_FILTERS: ReadonlyArray<{ value: 'all' | AuditEventKind; label: string }> = [
  { value: 'all', label: '全部事件' },
  { value: 'reply', label: '回复' },
  { value: 'inbound', label: '收到' },
  { value: 'silent_skip', label: '静默' },
  { value: 'error', label: '异常' },
]

export function mergeSessionRows(
  bindings: readonly SessionBinding[],
  dreamSessions: readonly DreamSession[],
  filter: SessionFilter,
): UnifiedSessionRow[] {
  const rows: UnifiedSessionRow[] = []
  if (filter === 'all' || filter === 'chat') {
    for (const binding of bindings) {
      rows.push({ kind: 'chat', lastActivityMs: binding.lastActivityMs, binding })
    }
  }
  if (filter === 'all' || filter === 'dreaming') {
    for (const dream of dreamSessions) {
      rows.push({ kind: 'dreaming', lastActivityMs: dream.lastActivityMs, dream })
    }
  }
  return rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
}

export function SessionsView({
  bindings,
  dreamSessions,
  events,
  runtimes,
  models = [],
  onOpen,
  onUnbind,
  onDeleteDreamSession,
  onRotateViewerSecret,
}: {
  bindings: readonly SessionBinding[]
  dreamSessions: readonly DreamSession[]
  events: readonly AuditEvent[]
  runtimes: readonly RuntimeOption[]
  models?: readonly ModelGroup[]
  onOpen: (sessionId: string) => void
  onUnbind: (binding: SessionBinding) => void
  onDeleteDreamSession?: (session: DreamSession) => void
  onRotateViewerSecret?: () => void
}) {
  const [pane, setPane] = useState<Pane>('sessions')
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all')
  const [kind, setKind] = useState<'all' | AuditEventKind>('all')
  const filteredEvents = useMemo(
    () => (kind === 'all' ? events : events.filter((e) => e.kind === kind)),
    [events, kind],
  )
  const visibleSessions = useMemo(
    () => mergeSessionRows(bindings, dreamSessions, sessionFilter),
    [bindings, dreamSessions, sessionFilter],
  )
  const totalSessions = bindings.length + dreamSessions.length

  const emptySessionText =
    sessionFilter === 'chat'
      ? '暂无活跃对话会话'
      : sessionFilter === 'dreaming'
        ? '暂无 Dreaming 会话。智能体定时整理或点击「立即整理」后会自动显示在这里'
        : '暂无会话'

  return (
    <>
      <div className="fb-toolbar" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <CountSegmentedSwitch
          label="会话与日志"
          value={pane}
          options={[
            { value: 'sessions', label: '会话', count: totalSessions },
            { value: 'events', label: '运行日志' },
          ]}
          onChange={setPane}
        />
        {pane === 'sessions' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <FilterTabs
              label="会话类型筛选"
              value={sessionFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'chat', label: '对话', count: bindings.length },
                { value: 'dreaming', label: 'Dreaming', count: dreamSessions.length },
              ]}
              onChange={setSessionFilter}
            />
            {onRotateViewerSecret && (
              <Button size="sm" variant="ghost" onClick={onRotateViewerSecret}>
                重置只读链接
              </Button>
            )}
          </div>
        ) : (
          <SelectMenu size="sm" value={kind} options={EVENT_FILTERS} onChange={setKind} />
        )}
      </div>

      {pane === 'sessions' ? (
        <div className="fb-card fb-list">
          {visibleSessions.length === 0 && <div className="fb-empty">{emptySessionText}</div>}
          {visibleSessions.map((row) => {
            if (row.kind === 'chat') {
              const b = row.binding
              const runtimeLabel = resolveRuntimeDisplayName(b.agentPreset, runtimes)
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

            const s = row.dream
            const runtimeLabel = resolveRuntimeDisplayName(s.agentPreset, runtimes)
            const modelLabel = resolveModelDisplayName(s.agentPreset, s.model, runtimes, models)
            const dotState =
              s.status === 'running' ? 'ongoing' : s.status === 'failed' ? 'error' : 'done'
            const statusProgress =
              s.status === 'running'
                ? s.processedCount > 0
                  ? `正在整理 ${s.processedCount} 个会话`
                  : '正在核查记忆'
                : s.status === 'succeeded'
                  ? `已整理 ${s.processedCount} 个会话`
                  : null
            const metaText = [
              `${runtimeLabel}${modelLabel ? ` · ${modelLabel}` : ''}`,
              `工作区 ${s.workspaceName}`,
              statusProgress,
              s.durationMs ? formatDuration(s.durationMs) : null,
              s.summary || null,
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
          {filteredEvents.length === 0 && <div className="fb-empty">暂无日志</div>}
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
