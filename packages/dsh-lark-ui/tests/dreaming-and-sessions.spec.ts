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

import { newBotConfig } from '../src/components/BotConfigDialog.js'
import { buildDreamStatusPresentation } from '../src/components/ExperimentalSection.js'
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

    const structured = buildDreamStatusPresentation(
      {
        botId: 'bot-1',
        status: 'succeeded',
        lastDreamAtMs: Date.now(),
        lastProcessedCount: 6,
        lastSummary: '已整理 6 个会话（新增 2 · 纠偏 1） · - **发布红线**：统一检查 `P95` 延迟。',
        processedSessionIds: ['s1'],
      },
      '',
      false,
    )
    expect(structured?.title).toContain('已整理 6 个会话 · 新增 2 · 纠偏 1')
    expect(structured?.detail).toBe('发布红线：统一检查 P95 延迟。')
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

  it('initializes newBotConfig with Citlalin-aligned conversation & message defaults', () => {
    const draft = newBotConfig(undefined, [])
    expect(draft).toMatchObject({
      groupAccessMode: 'configured_only',
      mentionTriggerMode: 'mention_and_active_thread',
      groupSessionMode: 'thread',
      idleCloseMinutes: 720,
      groupReplyMode: 'reply',
      receivedReactionEmoji: 'OnIt',
      sendIntermediateMessages: false,
      longTurnProgressNotice: true,
      longTurnNoticeDelaySeconds: 300,
      longTurnNoticeText: '当前任务仍在深度求索中，请耐心等待…[敲键盘]',
      useInteractiveCard: true,
      dshSessionLinkInCard: true,
      sessionLinkGuestReadOnly: true,
      replyFooterEnabled: true,
      replyFooterModel: true,
      replyFooterSignature: true,
      signature: 'AI 可能出错，请谨慎判断结果~',
    })
  })
})
