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

import { buildDreamStatusPresentation } from '../src/components/ExperimentalSection.js'
import { buildTriageUserMessagePreview } from '../src/components/TriageConfigFields.js'
import { mergeSessionRows } from '../src/views/SessionsView.js'
import type { DreamRunState, DreamSession, SessionBinding, TriageSession } from '../src/types.js'

describe('Dreaming status presentation & unified SessionsView merging', () => {
  it('splits legacy and structured Dreaming summaries into a clear header and note', () => {
    const succeeded: DreamRunState = {
      botId: 'bot-1',
      status: 'succeeded',
      lastDreamAtMs: Date.now(),
      lastSessionId: 'sess-dream-1',
      lastProcessedCount: 9,
      lastSummary: '已整理 9 个会话 · 已完成只读核查；巡检 11 个仓库。',
      processedSessionIds: ['s1'],
    }
    const view = buildDreamStatusPresentation(succeeded, '', false)
    expect(view).not.toBeNull()
    expect(view?.dot).toBe('done')
    expect(view?.title).toContain('已整理 9 个会话')
    expect(view?.detail).toBe('已完成只读核查；巡检 11 个仓库。')

    const failed = buildDreamStatusPresentation(
      {
        botId: 'bot-1',
        status: 'failed',
        lastSummary: '整理失败：模型鉴权失败',
        processedSessionIds: [],
      },
      '',
      false,
    )
    expect(failed).toMatchObject({
      dot: 'error',
      detail: '模型鉴权失败',
      isError: true,
    })

    const running = buildDreamStatusPresentation(succeeded, '', true)
    expect(running?.dot).toBe('ongoing')
    expect(running?.title).toBe('正在整理记忆…')

    const skipped = buildDreamStatusPresentation(
      {
        botId: 'bot-1',
        status: 'skipped',
        lastCheckedDateKey: '2026-11-23',
        lastSummary: '增量会话 1 个（未达阈值 2），已静默跳过',
        processedSessionIds: [],
      },
      '',
      false,
    )
    expect(skipped).toMatchObject({
      dot: 'idle',
      title: '上次检查 2026-11-23',
      detail: '增量会话 1 个（未达阈值 2），已静默跳过',
    })

    const err = buildDreamStatusPresentation(succeeded, '网络连接超时', false)
    expect(err).toMatchObject({ dot: 'error', title: '运行异常', detail: '网络连接超时', isError: true })
  })

  it('merges chat bindings and Dreaming sessions in reverse chronological order and respects filters', () => {
    const bindings: SessionBinding[] = [
      {
        routeKey: 'bot-1:oc_team',
        botId: 'bot-1',
        botName: '研发助手',
        chatId: 'oc_team',
        chatName: '研发协作群',
        workspaceName: 'demo',
        sessionId: 'sess-chat-1',
        agentPreset: 'standard',
        workingDir: '/Users/demo/project',
        trigger: 'mention',
        lastActivityMs: 2000,
      },
    ]
    const dreams: DreamSession[] = [
      {
        sessionId: 'sess-dream-new',
        botId: 'bot-1',
        botName: '研发助手',
        workspaceName: 'demo',
        workingDir: '/Users/demo/project',
        agentPreset: 'standard',
        status: 'succeeded',
        dateKey: '2026-11-23',
        processedCount: 4,
        summary: '更新 2 条约定',
        createdAtMs: 3000,
        lastActivityMs: 3500,
      },
      {
        sessionId: 'sess-dream-old',
        botId: 'bot-1',
        botName: '研发助手',
        workspaceName: 'demo',
        workingDir: '/Users/demo/project',
        agentPreset: 'standard',
        status: 'failed',
        dateKey: '2026-11-22',
        processedCount: 2,
        summary: '超时',
        createdAtMs: 1000,
        lastActivityMs: 1500,
      },
    ]

    const triages: TriageSession[] = [
      {
        sessionId: 'sess-triage-1',
        botId: 'bot-1',
        botName: '研发助手',
        chatId: 'oc_team',
        chatName: '研发协作群',
        workspaceName: 'demo',
        workingDir: '/Users/demo/project',
        routeKey: 'bot-1:oc_team:om_1',
        trigger: 'listener',
        action: 'silent',
        reason: '日常确认语',
        provider: 'deepseek',
        model: 'deepseek-chat',
        durationMs: 320,
        createdAtMs: 2400,
        lastActivityMs: 2500,
      },
    ]

    const rowId = (r: ReturnType<typeof mergeSessionRows>[number]) =>
      r.kind === 'chat' ? r.binding.sessionId : r.kind === 'triage' ? r.triage.sessionId : r.dream.sessionId

    const all = mergeSessionRows(bindings, dreams, 'all', triages)
    expect(all.map(rowId)).toEqual([
      'sess-dream-new',
      'sess-triage-1',
      'sess-chat-1',
      'sess-dream-old',
    ])

    const chatOnly = mergeSessionRows(bindings, dreams, 'chat', triages)
    expect(chatOnly.map(rowId)).toEqual(['sess-chat-1'])

    const triageOnly = mergeSessionRows(bindings, dreams, 'triage', triages)
    expect(triageOnly.map(rowId)).toEqual(['sess-triage-1'])

    const dreamOnly = mergeSessionRows(bindings, dreams, 'dreaming', triages)
    expect(dreamOnly.map(rowId)).toEqual(['sess-dream-new', 'sess-dream-old'])
  })

  it('generates live UserMessage preview reflecting recentMessageCount, contextTtlMinutes, and includeLastReply', () => {
    const full = buildTriageUserMessagePreview(
      {
        scope: 'passive_only',
        recentMessageCount: 10,
        contextTtlMinutes: 45,
        includeLastReply: true,
      },
      { chatName: '研发协作群', listenerName: '项目讨论' },
    )
    expect(full).toContain('trigger=listener')
    expect(full).toContain('chat="研发协作群"')
    expect(full).toContain('listener="项目讨论"')
    expect(full).toContain('<last_reply>')
    expect(full).toContain('<recent_context>')
    expect(full).toContain('最近 45 分钟内最多携带 10 条上下文')
    expect(full).toContain('<incoming_message>')

    const minimal = buildTriageUserMessagePreview({
      scope: 'all_group',
      recentMessageCount: 0,
      contextTtlMinutes: 30,
      includeLastReply: false,
    })
    expect(minimal).toContain('trigger=mention')
    expect(minimal).not.toContain('<last_reply>')
    expect(minimal).not.toContain('<recent_context>')
    expect(minimal).toContain('<incoming_message>')
  })
})
