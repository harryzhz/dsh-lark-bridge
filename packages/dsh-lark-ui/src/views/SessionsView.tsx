import { useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CountSegmentedSwitch, OverflowMenu, SelectMenu } from '../components/fields.js'
import { formatDuration, formatTime } from '../state.js'
import type { AuditEvent, AuditEventKind, RuntimeOption, SessionBinding } from '../types.js'
import { eventTag } from './OverviewView.js'

type Pane = 'sessions' | 'events'

const EVENT_FILTERS: ReadonlyArray<{ value: 'all' | AuditEventKind; label: string }> = [
  { value: 'all', label: '全部事件' },
  { value: 'reply', label: '回复' },
  { value: 'inbound', label: '收到' },
  { value: 'silent_skip', label: '静默' },
  { value: 'error', label: '异常' },
]

export function SessionsView({
  bindings,
  events,
  runtimes,
  onOpen,
  onUnbind,
}: {
  bindings: readonly SessionBinding[]
  events: readonly AuditEvent[]
  runtimes: readonly RuntimeOption[]
  onOpen: (sessionId: string) => void
  onUnbind: (binding: SessionBinding) => void
}) {
  const [pane, setPane] = useState<Pane>('sessions')
  const [kind, setKind] = useState<'all' | AuditEventKind>('all')
  const filtered = useMemo(() => (kind === 'all' ? events : events.filter((e) => e.kind === kind)), [events, kind])
  const runtimeName = (id: string) => runtimes.find((r) => r.id === id)?.name ?? id

  return (
    <>
      <div className="fb-toolbar">
        <CountSegmentedSwitch
          label="会话与日志"
          value={pane}
          options={[
            { value: 'sessions', label: '活跃会话', count: bindings.length },
            { value: 'events', label: '运行日志' },
          ]}
          onChange={setPane}
        />
        <span style={{ flex: 1 }} />
        {pane === 'events' && <SelectMenu size="sm" value={kind} options={EVENT_FILTERS} onChange={setKind} />}
      </div>

      {pane === 'sessions' ? (
        <div className="fb-card fb-list">
          {bindings.length === 0 && <div className="fb-empty">暂无活跃会话</div>}
          {bindings.map((b) => (
            <div key={b.routeKey} className="fb-item">
              <div className="fb-item-main">
                <div className="fb-item-title">
                  <span>{b.chatName || (b.trigger === 'p2p' ? '私聊' : b.chatId)}</span>
                </div>
                <div className="fb-item-meta">
                  {runtimeName(b.agentPreset)} · 工作区 {b.workspaceName} · {b.listenerName ? `监听「${b.listenerName}」` : b.botName ?? b.botId}
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
                    { id: 'copy', label: '复制会话 ID', onSelect: () => void navigator.clipboard?.writeText(b.sessionId) },
                    { id: 'unbind', label: '结束并归档', danger: true, onSelect: () => onUnbind(b) },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="fb-card fb-list">
          {filtered.length === 0 && <div className="fb-empty">暂无日志</div>}
          {filtered.map((e) => (
            <div key={e.id} className="fb-item">
              {eventTag(e.kind)}
              <div className="fb-item-main">
                <div className="fb-item-title">
                  <span title={e.summary}>{e.summary}</span>
                </div>
                <div className="fb-item-meta">
                  {[e.botName ?? e.botId, e.chatName, e.durationMs !== undefined ? formatDuration(e.durationMs) : null].filter(Boolean).join(' · ')}
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
