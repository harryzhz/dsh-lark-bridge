import { useMemo, useState } from 'react'
import {
  Button,
  IconAlarmClockOutlineRegular,
  StateDot,
  Switch,
  Tag,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CountSegmentedSwitch,
  FilterTabs,
  ListFilterBar,
  OverflowMenu,
  resolveEffectiveBotId,
  ScheduleAutomationHint,
} from '../components/fields.js'
import { choiceLabel, SCHEDULE_NOTIFY_ON } from '../presets.js'
import { formatIsoTime } from '../state.js'
import type { BotRecord, GroupView, ReminderItem, ScheduleView } from '../types.js'

export interface ScheduleActions {
  edit: (schedule: ScheduleView) => void
  toggle: (schedule: ScheduleView, enabled: boolean) => void
  runNow: (schedule: ScheduleView) => void
  openSession: (sessionId: string) => void
  reset: (schedule: ScheduleView) => void
}

export interface ReminderActions {
  edit: (item: ReminderItem) => void
  approve: (item: ReminderItem) => void
  cancel: (item: ReminderItem) => void
  runNow: (item: ReminderItem) => void
  remove: (item: ReminderItem) => void
  openSession: (sessionId: string) => void
}

type AutomationKind = 'reminders' | 'schedules'
export type ReminderFilter = 'active' | 'archived' | 'all'

export function scheduleMatchesBot(schedule: ScheduleView, botId: string): boolean {
  if (!botId) return true
  if (schedule.binding.targets.length > 0) {
    return schedule.binding.targets.some((t) => t.botId === botId)
  }
  return schedule.inferredOrigin?.botId === botId
}

function resolveTargetNames(schedule: ScheduleView, groups: readonly GroupView[]): string[] {
  if (schedule.binding.targets.length > 0) {
    return schedule.binding.targets.map((t) => {
      const found = groups.find((g) => g.botId === t.botId && g.chatId === t.chatId)
      if (found) return found.chatName
      if (schedule.inferredOrigin?.botId === t.botId && schedule.inferredOrigin.chatId === t.chatId) {
        return schedule.inferredOrigin.chatName
      }
      return t.chatId
    })
  }
  return schedule.inferredOrigin ? [schedule.inferredOrigin.chatName] : []
}

export function filterSchedules(
  schedules: readonly ScheduleView[],
  botId: string,
  query: string,
  groups: readonly GroupView[] = [],
): ScheduleView[] {
  const q = query.trim().toLowerCase()
  return schedules.filter((s) => {
    if (!scheduleMatchesBot(s, botId)) return false
    if (!q) return true
    const targetNames = resolveTargetNames(s, groups)
    return (
      s.title.toLowerCase().includes(q) ||
      s.prompt.toLowerCase().includes(q) ||
      s.ruleSummary.toLowerCase().includes(q) ||
      targetNames.some((name) => name.toLowerCase().includes(q))
    )
  })
}

export function filterReminders(
  reminders: readonly ReminderItem[],
  botId: string,
  filter: ReminderFilter,
  query: string,
): ReminderItem[] {
  const q = query.trim().toLowerCase()
  return reminders.filter((r) => {
    if (botId && r.origin.botId !== botId) return false
    if (filter === 'active' && r.status === 'archived') return false
    if (filter === 'archived' && r.status !== 'archived') return false
    if (!q) return true
    return (
      r.title.toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q) ||
      (r.origin.chatName ?? '').toLowerCase().includes(q) ||
      (r.origin.userName ?? '').toLowerCase().includes(q) ||
      (r.origin.botName ?? '').toLowerCase().includes(q)
    )
  })
}

function reminderStatusBadge(item: ReminderItem): { label: string; tone: TagTone } {
  if (item.status === 'running') return { label: '执行中', tone: 'info' }
  if (item.status === 'pending_confirm') return { label: '待确认', tone: 'warning' }
  if (item.status === 'scheduled') return { label: '单次待触发', tone: 'neutral' }
  switch (item.resolution) {
    case 'reminded':
      return { label: '已提醒 · 已归档', tone: 'neutral' }
    case 'silent_ok':
      return { label: '无需打扰 · 静默归档', tone: 'quiet' }
    case 'cancelled':
      return { label: '已取消', tone: 'quiet' }
    case 'rejected':
      return { label: '已忽略', tone: 'quiet' }
    case 'error':
      return { label: '执行异常 · 已归档', tone: 'danger' }
    default:
      return { label: '已归档', tone: 'quiet' }
  }
}

function formatReminderOrigin(item: ReminderItem): string {
  const { origin } = item
  if (origin.chatType === 'p2p') {
    return `私聊 · ${origin.userName || origin.userOpenId || '用户'}`
  }
  const chatLabel = origin.chatName || origin.chatId || '飞书群'
  return origin.deliveryMode === 'thread' ? `群话题 · ${chatLabel}` : `群聊 · ${chatLabel}`
}

export function SchedulesView({
  available,
  schedules,
  reminders,
  groups,
  bots = [],
  onOpenScheduleManager,
  actions,
  reminderActions,
}: {
  available: boolean
  schedules: readonly ScheduleView[]
  reminders: readonly ReminderItem[]
  groups: readonly GroupView[]
  bots?: readonly BotRecord[]
  onOpenScheduleManager?: () => void
  actions: ScheduleActions
  reminderActions: ReminderActions
}) {
  const [kind, setKind] = useState<AutomationKind>('schedules')
  const [reminderFilter, setReminderFilter] = useState<ReminderFilter>('active')
  const [botId, setBotId] = useState('')
  const [query, setQuery] = useState('')
  const effectiveBotId = resolveEffectiveBotId(botId, bots)

  const botSchedules = useMemo(
    () => schedules.filter((s) => scheduleMatchesBot(s, effectiveBotId)),
    [schedules, effectiveBotId],
  )
  const botReminders = useMemo(
    () => (effectiveBotId ? reminders.filter((r) => r.origin.botId === effectiveBotId) : reminders),
    [reminders, effectiveBotId],
  )

  const activeReminderCount = useMemo(
    () => botReminders.filter((r) => r.status !== 'archived').length,
    [botReminders],
  )
  const archivedReminderCount = botReminders.length - activeReminderCount

  const visibleReminders = useMemo(
    () => filterReminders(reminders, effectiveBotId, reminderFilter, query),
    [reminders, effectiveBotId, reminderFilter, query],
  )

  const visibleSchedules = useMemo(
    () => filterSchedules(schedules, effectiveBotId, query, groups),
    [schedules, effectiveBotId, query, groups],
  )

  const hasFilter = Boolean(effectiveBotId || query.trim())

  return (
    <>
      <div className="fb-view-bar">
        <CountSegmentedSwitch
          label="自动化类型"
          value={kind}
          options={[
            { value: 'schedules', label: '定时任务', count: botSchedules.length },
            { value: 'reminders', label: '提醒事项', count: activeReminderCount },
          ]}
          onChange={(next) => {
            setKind(next)
            setQuery('')
          }}
        />

        {kind === 'reminders' && (
          <FilterTabs
            label="提醒事项状态筛选"
            value={reminderFilter}
            options={[
              { value: 'active', label: '待触发', count: activeReminderCount },
              { value: 'archived', label: '已归档', count: archivedReminderCount },
              { value: 'all', label: '全部', count: botReminders.length },
            ]}
            onChange={setReminderFilter}
          />
        )}
      </div>

      {kind === 'schedules' && available && schedules.length > 0 && (
        <ScheduleAutomationHint onOpenScheduleManager={onOpenScheduleManager} />
      )}

      {(kind === 'reminders' || available) && (
        <ListFilterBar
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={
            kind === 'reminders' ? '搜索提醒事项名称、群聊或成员' : '搜索定时任务名称、规则或群聊'
          }
          bots={bots}
          botId={effectiveBotId}
          onBotIdChange={setBotId}
        />
      )}

      {kind === 'reminders' ? (
        <RemindersList
          items={visibleReminders}
          filter={reminderFilter}
          filtered={hasFilter}
          actions={reminderActions}
        />
      ) : !available ? (
        <div className="fb-card fb-empty">当前宿主未启用周期性定时任务服务</div>
      ) : (
        <PeriodicSchedulesList
          schedules={schedules}
          visible={visibleSchedules}
          groups={groups}
          onOpenScheduleManager={onOpenScheduleManager}
          actions={actions}
        />
      )}
    </>
  )
}

function RemindersList({
  items,
  filter,
  filtered,
  actions,
}: {
  items: readonly ReminderItem[]
  filter: ReminderFilter
  filtered: boolean
  actions: ReminderActions
}) {
  return (
    <div className="fb-card fb-list">
      {items.length === 0 && (
        <div className="fb-empty">
          {filtered
            ? '没有匹配的提醒事项'
            : filter === 'active'
              ? '暂无待触发的提醒事项。智能体开启「主动工作 → 主动创建提醒事项」或调用 lark-bridge reminder create 后会自动显示在这里'
              : filter === 'archived'
                ? '暂无已归档的提醒事项'
                : '暂无提醒事项'}
        </div>
      )}
      {items.map((item) => {
        const badge = reminderStatusBadge(item)
        const dotState =
          item.status === 'running'
            ? 'ongoing'
            : item.status === 'pending_confirm'
              ? 'warning'
              : item.status === 'scheduled'
                ? 'done'
                : 'idle'
        const mentionText =
          item.mentions.length > 0
            ? `@${item.mentions.map((m) => m.name || m.openId).join('、')}`
            : null

        return (
          <div key={item.id} className="fb-item">
            <StateDot state={dotState} />
            <div className="fb-item-main">
              <div className="fb-item-title">
                <span>{item.title}</span>
                <Tag tone={badge.tone}>{badge.label}</Tag>
                {item.urgency === 'high' && <Tag tone="warning">高优</Tag>}
                <Tag tone="quiet">{formatReminderOrigin(item)}</Tag>
                {item.worktree && <Tag tone="info">{`分支 · ${item.worktree.branch}`}</Tag>}
              </div>
              <div className="fb-item-meta">
                {[
                  item.origin.botName ? `智能体「${item.origin.botName}」` : null,
                  `计划触发 ${formatIsoTime(item.scheduledAt)}`,
                  item.deferredFromScheduledAt
                    ? `免打扰顺延自 ${formatIsoTime(item.deferredFromScheduledAt)}`
                    : null,
                  item.retryCount && item.retryCount > 0 ? `重启补跑 #${item.retryCount}` : null,
                  mentionText,
                  item.resultSummary || item.reason || null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <div className="fb-item-side">
              {item.status === 'running' && (
                <>
                  {item.lastSessionId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => actions.openSession(item.lastSessionId!)}
                    >
                      查看会话
                    </Button>
                  )}
                  {item.origin.sourceSessionId && (
                    <OverflowMenu
                      label={`${item.title} 更多操作`}
                      items={[
                        {
                          id: 'source',
                          label: '查看来源会话',
                          onSelect: () => actions.openSession(item.origin.sourceSessionId!),
                        },
                      ]}
                    />
                  )}
                </>
              )}
              {item.status === 'pending_confirm' && (
                <>
                  <Button size="sm" variant="primary" onClick={() => actions.approve(item)}>
                    确认创建
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => actions.cancel(item)}>
                    忽略
                  </Button>
                </>
              )}
              {item.status === 'scheduled' && (
                <>
                  <Button size="sm" variant="outline" onClick={() => actions.edit(item)}>
                    编辑
                  </Button>
                  <OverflowMenu
                    label={`${item.title} 更多操作`}
                    items={[
                      { id: 'run', label: '立即触发', onSelect: () => actions.runNow(item) },
                      ...(item.origin.sourceSessionId
                        ? [
                            {
                              id: 'source',
                              label: '查看来源会话',
                              onSelect: () => actions.openSession(item.origin.sourceSessionId!),
                            },
                          ]
                        : []),
                      { type: 'separator' as const, id: 'sep' },
                      {
                        id: 'cancel',
                        label: '取消并归档',
                        danger: true,
                        onSelect: () => actions.cancel(item),
                      },
                    ]}
                  />
                </>
              )}
              {item.status === 'archived' && (
                <>
                  {item.lastSessionId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => actions.openSession(item.lastSessionId!)}
                    >
                      查看会话
                    </Button>
                  )}
                  <OverflowMenu
                    label={`${item.title} 更多操作`}
                    items={[
                      ...(item.origin.sourceSessionId
                        ? [
                            {
                              id: 'source',
                              label: '查看来源会话',
                              onSelect: () => actions.openSession(item.origin.sourceSessionId!),
                            },
                          ]
                        : []),
                      {
                        id: 'delete',
                        label: '删除记录',
                        danger: true,
                        onSelect: () => actions.remove(item),
                      },
                    ]}
                  />
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PeriodicSchedulesList({
  schedules,
  visible,
  groups,
  onOpenScheduleManager,
  actions,
}: {
  schedules: readonly ScheduleView[]
  visible: readonly ScheduleView[]
  groups: readonly GroupView[]
  onOpenScheduleManager?: () => void
  actions: ScheduleActions
}) {
  return (
    <div className="fb-card fb-list">
      {visible.length === 0 && (
        <div className="fb-empty">
          {schedules.length === 0 ? (
            <div className="fb-empty-stack">
              <div>暂无周期性定时任务。此处用于为「自动化任务」绑定飞书群通知投递</div>
              {onOpenScheduleManager && (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconAlarmClockOutlineRegular size={14} />}
                  onClick={onOpenScheduleManager}
                >
                  前往「自动化任务」创建
                </Button>
              )}
            </div>
          ) : (
            '没有匹配的定时任务'
          )}
        </div>
      )}
      {visible.map((s) => {
        const targetNames = resolveTargetNames(s, groups)
        const hasTargets = targetNames.length > 0
        const effectiveEnabled = s.binding.enabled && hasTargets
        const dotState = s.executionActive
          ? 'ongoing'
          : s.status === 'active'
            ? 'done'
            : s.status === 'paused'
              ? 'warning'
              : 'idle'

        return (
          <div key={s.id} className="fb-item">
            <StateDot state={dotState} />
            <div className="fb-item-main">
              <div className="fb-item-title">
                <span>{s.title}</span>
                {s.executionActive && <Tag tone="info">执行中</Tag>}
                {!s.executionActive && s.status === 'paused' && <Tag tone="warning">已暂停</Tag>}
                {!s.executionActive && s.status === 'ended' && <Tag tone="quiet">已结束</Tag>}
                {effectiveEnabled ? (
                  <Tag tone="neutral">
                    {s.binding.targets.length > 0
                      ? targetNames.length === 1
                        ? `通知 · ${targetNames[0]}`
                        : `通知 · ${targetNames.length} 个群`
                      : `自动回传 · ${targetNames[0]}`}
                  </Tag>
                ) : (
                  <Tag tone="quiet">{s.configured && !s.binding.enabled ? '通知已关' : '未绑定群'}</Tag>
                )}
              </div>
              <div className="fb-item-meta">
                {[
                  s.ruleSummary,
                  s.status === 'active' ? `下次 ${formatIsoTime(s.scheduledAt)}` : null,
                  s.lastDeliveredAt ? `上次 ${formatIsoTime(s.lastDeliveredAt)}` : null,
                  effectiveEnabled ? choiceLabel(SCHEDULE_NOTIFY_ON, s.binding.notifyOn) : null,
                  effectiveEnabled && targetNames.length > 1 ? targetNames.join('、') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <div className="fb-item-side">
              <Switch
                label={`${s.title} 飞书通知`}
                checked={effectiveEnabled}
                onChange={(on) => {
                  if (on && !hasTargets) actions.edit(s)
                  else actions.toggle(s, on)
                }}
              />
              <Button size="sm" variant="outline" onClick={() => actions.edit(s)}>
                {hasTargets ? '通知设置' : '绑定群聊'}
              </Button>
              <OverflowMenu
                label={`${s.title} 更多操作`}
                items={[
                  ...(onOpenScheduleManager
                    ? [
                        {
                          id: 'manage-rule',
                          label: '在「自动化任务」中编辑规则',
                          onSelect: onOpenScheduleManager,
                        },
                      ]
                    : []),
                  {
                    id: 'run',
                    label: '立即试跑',
                    disabled: s.executionActive,
                    onSelect: () => actions.runNow(s),
                  },
                  ...(s.lastTargetSessionId
                    ? [
                        {
                          id: 'open',
                          label: '查看最近会话',
                          onSelect: () => actions.openSession(s.lastTargetSessionId!),
                        },
                      ]
                    : []),
                  ...(s.configured
                    ? [
                        { type: 'separator' as const, id: 'sep' },
                        {
                          id: 'reset',
                          label: '恢复默认',
                          danger: true,
                          onSelect: () => actions.reset(s),
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
  )
}
