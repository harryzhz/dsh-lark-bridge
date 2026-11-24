import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const stub = () => null
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true
        if (prop === 'then' || typeof prop === 'symbol') return undefined
        return stub
      },
      has: (_target, prop) => typeof prop === 'string' && prop !== 'then',
      getOwnPropertyDescriptor: (_target, prop) =>
        typeof prop === 'string' && prop !== 'then'
          ? { configurable: true, enumerable: true, value: stub }
          : undefined,
    },
  )
})

import { resolveEffectiveBotId } from '../src/components/fields.js'
import {
  filterReminders,
  filterSchedules,
  scheduleMatchesBot,
} from '../src/views/SchedulesView.js'
import {
  countAuditEventsByKind,
  EVENT_FILTERS,
  filterAuditEvents,
  filterSessionRows,
  mergeSessionRows,
} from '../src/views/SessionsView.js'
import type {
  AuditEvent,
  DreamSession,
  GroupView,
  ReminderItem,
  ScheduleView,
  SessionBinding,
  TriageSession,
} from '../src/types.js'

describe('Unified list filter helpers (bots, automation, sessions, audit events)', () => {
  it('resolves effective botId and safely falls back when single/removed', () => {
    const twoBots = [{ id: 'bot-a' }, { id: 'bot-b' }]
    expect(resolveEffectiveBotId('', twoBots)).toBe('')
    expect(resolveEffectiveBotId('bot-a', twoBots)).toBe('bot-a')
    expect(resolveEffectiveBotId('bot-deleted', twoBots)).toBe('')
    expect(resolveEffectiveBotId('bot-a', [{ id: 'bot-a' }])).toBe('')
    expect(resolveEffectiveBotId('bot-a', [])).toBe('')
  })

  it('filters schedules by bound bot targets, inferred origin, and keyword including group names', () => {
    const groups = [
      {
        key: 'bot-a:oc_dev',
        botId: 'bot-a',
        botName: '研发助手',
        chatId: 'oc_dev',
        chatName: '研发协作群',
      },
      {
        key: 'bot-b:oc_ops',
        botId: 'bot-b',
        botName: '运维助手',
        chatId: 'oc_ops',
        chatName: '值班告警群',
      },
    ] as unknown as GroupView[]

    const schedules: ScheduleView[] = [
      {
        id: 'sch-1',
        title: '每日构建巡检',
        prompt: '检查 CI 状态',
        kind: 'cron',
        ruleSummary: '每天 09:00',
        status: 'active',
        scheduledAt: '2026-11-25T01:00:00.000Z',
        executionActive: false,
        configured: true,
        binding: {
          scheduleId: 'sch-1',
          enabled: true,
          targets: [{ botId: 'bot-a', chatId: 'oc_dev' }],
          deliveryMode: 'chat',
          notifyOn: 'non_empty',
        },
      },
      {
        id: 'sch-2',
        title: '晚间值班汇总',
        prompt: '输出告警统计',
        kind: 'cron',
        ruleSummary: '每天 21:00',
        status: 'active',
        scheduledAt: '2026-11-25T13:00:00.000Z',
        executionActive: false,
        configured: false,
        inferredOrigin: {
          botId: 'bot-b',
          botName: '运维助手',
          chatId: 'oc_ops',
          chatName: '值班告警群',
        },
        binding: {
          scheduleId: 'sch-2',
          enabled: true,
          targets: [],
          deliveryMode: 'chat',
          notifyOn: 'non_empty',
        },
      },
      {
        id: 'sch-3',
        title: '未绑定群任务',
        prompt: '本地汇总',
        kind: 'cron',
        ruleSummary: '每周一 10:00',
        status: 'paused',
        scheduledAt: '2026-11-30T02:00:00.000Z',
        executionActive: false,
        configured: false,
        binding: {
          scheduleId: 'sch-3',
          enabled: false,
          targets: [],
          deliveryMode: 'chat',
          notifyOn: 'non_empty',
        },
      },
    ]

    expect(scheduleMatchesBot(schedules[0]!, 'bot-a')).toBe(true)
    expect(scheduleMatchesBot(schedules[0]!, 'bot-b')).toBe(false)
    expect(scheduleMatchesBot(schedules[1]!, 'bot-b')).toBe(true)
    expect(scheduleMatchesBot(schedules[2]!, 'bot-a')).toBe(false)
    expect(scheduleMatchesBot(schedules[2]!, '')).toBe(true)

    expect(filterSchedules(schedules, 'bot-a', '', groups).map((s) => s.id)).toEqual(['sch-1'])
    expect(filterSchedules(schedules, 'bot-b', '', groups).map((s) => s.id)).toEqual(['sch-2'])
    expect(filterSchedules(schedules, '', '研发协作群', groups).map((s) => s.id)).toEqual(['sch-1'])
    expect(filterSchedules(schedules, 'bot-b', '研发协作群', groups)).toEqual([])
  })

  it('filters reminders by bot scope, status tab, and search query', () => {
    const reminders: ReminderItem[] = [
      {
        id: 'rem-1',
        title: '跟进发布窗口',
        prompt: '确认指标正常',
        scheduledAt: '2026-11-25T02:00:00.000Z',
        status: 'scheduled',
        origin: {
          botId: 'bot-a',
          botName: '研发助手',
          larkAppId: 'cli_test_a',
          chatType: 'group',
          chatId: 'oc_dev',
          chatName: '研发协作群',
          deliveryMode: 'thread',
        },
        mentions: [],
        createdAtMs: 1000,
        updatedAtMs: 1000,
      },
      {
        id: 'rem-2',
        title: '归档复盘提醒',
        prompt: '整理复盘纪要',
        scheduledAt: '2026-11-24T02:00:00.000Z',
        status: 'archived',
        resolution: 'reminded',
        origin: {
          botId: 'bot-a',
          botName: '研发助手',
          larkAppId: 'cli_test_a',
          chatType: 'group',
          chatId: 'oc_dev',
          chatName: '研发协作群',
          deliveryMode: 'chat',
        },
        mentions: [],
        createdAtMs: 900,
        updatedAtMs: 950,
      },
      {
        id: 'rem-3',
        title: '核对告警阈值',
        prompt: '检查 P95',
        scheduledAt: '2026-11-25T04:00:00.000Z',
        status: 'scheduled',
        origin: {
          botId: 'bot-b',
          botName: '运维助手',
          larkAppId: 'cli_test_b',
          chatType: 'p2p',
          userOpenId: 'ou_owner',
          userName: 'Alex Chen',
          deliveryMode: 'p2p',
        },
        mentions: [],
        createdAtMs: 1100,
        updatedAtMs: 1100,
      },
    ]

    expect(filterReminders(reminders, 'bot-a', 'active', '').map((r) => r.id)).toEqual(['rem-1'])
    expect(filterReminders(reminders, 'bot-a', 'archived', '').map((r) => r.id)).toEqual(['rem-2'])
    expect(filterReminders(reminders, 'bot-a', 'all', '').map((r) => r.id)).toEqual(['rem-1', 'rem-2'])
    expect(filterReminders(reminders, 'bot-b', 'active', 'alex').map((r) => r.id)).toEqual(['rem-3'])
    expect(filterReminders(reminders, 'bot-a', 'active', 'alex')).toEqual([])
  })

  it('filters unified sessions and audit events with bot scope, event tabs, and search', () => {
    const bindings: SessionBinding[] = [
      {
        routeKey: 'bot-a:oc_dev',
        botId: 'bot-a',
        botName: '研发助手',
        chatId: 'oc_dev',
        chatName: '研发协作群',
        workspaceName: 'repo-alpha',
        sessionId: 'sess-a',
        agentPreset: 'standard',
        workingDir: '/Users/demo/alpha',
        trigger: 'mention',
        lastActivityMs: 2000,
      },
      {
        routeKey: 'bot-b:oc_ops',
        botId: 'bot-b',
        botName: '运维助手',
        chatId: 'oc_ops',
        chatName: '值班告警群',
        workspaceName: 'repo-beta',
        sessionId: 'sess-b',
        agentPreset: 'standard',
        workingDir: '/Users/demo/beta',
        trigger: 'mention',
        lastActivityMs: 2500,
      },
    ]
    const triages: TriageSession[] = [
      {
        sessionId: 'tri-1',
        botId: 'bot-a',
        botName: '研发助手',
        chatId: 'oc_dev',
        chatName: '研发协作群',
        workspaceName: 'repo-alpha',
        workingDir: '/Users/demo/alpha',
        routeKey: 'bot-a:oc_dev:om_1',
        trigger: 'listener',
        senderName: '林晓',
        action: 'handoff',
        reason: '请求排查 CI 失败',
        durationMs: 180,
        createdAtMs: 2100,
        lastActivityMs: 2100,
      },
    ]
    const dreams: DreamSession[] = [
      {
        sessionId: 'drm-1',
        botId: 'bot-b',
        botName: '运维助手',
        workspaceName: 'repo-beta',
        workingDir: '/Users/demo/beta',
        agentPreset: 'standard',
        status: 'succeeded',
        dateKey: '2026-11-24',
        processedCount: 3,
        summary: '整理值班排障手册',
        createdAtMs: 2200,
        lastActivityMs: 2200,
      },
    ]

    const merged = mergeSessionRows(bindings, dreams, 'all', triages)
    expect(filterSessionRows(merged, 'repo-alpha')).toHaveLength(1)
    expect(filterSessionRows(merged, 'CI 失败')).toHaveLength(1)
    expect(filterSessionRows(merged, '排障手册')).toHaveLength(1)

    const events: AuditEvent[] = [
      {
        id: 'ev-1',
        timestampMs: 3000,
        botId: 'bot-a',
        botName: '研发助手',
        chatId: 'oc_dev',
        chatName: '研发协作群',
        kind: 'triage',
        summary: '分流判定：转交主会话',
      },
      {
        id: 'ev-2',
        timestampMs: 2900,
        botId: 'bot-a',
        botName: '研发助手',
        chatId: 'oc_dev',
        chatName: '研发协作群',
        kind: 'reply',
        summary: '回复排查结果',
      },
      {
        id: 'ev-3',
        timestampMs: 2800,
        botId: 'bot-b',
        botName: '运维助手',
        chatId: 'oc_ops',
        chatName: '值班告警群',
        kind: 'error',
        summary: '连接超时异常',
      },
    ]

    expect(EVENT_FILTERS.map((f) => f.label)).toEqual(['全部', '分流', '回复', '收到', '静默', '异常'])
    expect(countAuditEventsByKind(events)).toEqual({ triage: 1, reply: 1, error: 1 })
    expect(filterAuditEvents(events, 'bot-a', 'all', '').map((e) => e.id)).toEqual(['ev-1', 'ev-2'])
    expect(filterAuditEvents(events, 'bot-a', 'reply', '').map((e) => e.id)).toEqual(['ev-2'])
    expect(filterAuditEvents(events, 'bot-b', 'error', '超时').map((e) => e.id)).toEqual(['ev-3'])
    expect(filterAuditEvents(events, 'bot-a', 'error', '')).toEqual([])
  })
})
