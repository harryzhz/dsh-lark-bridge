import { describe, expect, it } from 'vitest'
import {
  BotDreamingConfigSchema,
  DEFAULT_BOT_DREAMING_CONFIG,
  DEFAULT_BOT_PROACTIVE_CONFIG,
  composeDreamDeepConsolidationPrompt,
  composeDreamProactivePrompt,
  extractLarkContextMeta,
  renderMemoryAuditReport,
  truncateSessionTranscriptHeadTail,
  type LarkMemoryEntry,
} from '../src/index.js'

describe('Auto-Dream v2 protocol helpers & defaults', () => {
  it('uses updated overnight defaults (03:00, 5000 chars, all sessions, cap 5 reminders, quiet hours on)', () => {
    const dream = BotDreamingConfigSchema.parse({})
    expect(dream).toMatchObject({
      enabled: false,
      scheduleTime: '03:00',
      minNewSessions: 2,
      maxSessionsPerRun: 0,
      maxCharsPerSession: 5000,
      maxRemindersPerRun: 5,
      maxDurationMinutes: 45,
      deepConsolidation: true,
      model: '',
      reasoningEffort: '',
      cleanupAndCorrect: true,
    })
    expect(DEFAULT_BOT_DREAMING_CONFIG.scheduleTime).toBe('03:00')
    expect(DEFAULT_BOT_DREAMING_CONFIG.maxCharsPerSession).toBe(5000)
    expect(DEFAULT_BOT_DREAMING_CONFIG.maxSessionsPerRun).toBe(0)
    expect(DEFAULT_BOT_DREAMING_CONFIG.maxRemindersPerRun).toBe(5)
    expect(DEFAULT_BOT_PROACTIVE_CONFIG.reminderCreationMode).toBe('silent')
    expect(DEFAULT_BOT_PROACTIVE_CONFIG.quietHoursEnabled).toBe(true)
  })

  it('extracts speaker open_id, thread_id, and peer mentions from raw <lark_context> prompts', () => {
    const raw = [
      '<system_reminder>',
      '<lark_context bot_id="dev-bot" chat_type="group" chat_id="oc_team" chat_name="研发群" trigger="mention" message_id="om_msg_9" thread_id="om_root_1" sender_open_id="ou_alex" sender_name="林晓" sender_type="user">',
      '提及成员：陈明(open_id="ou_chen")、Sam(open_id="ou_sam")',
      '</lark_context>',
      '</system_reminder>',
      '<user_message>',
      '明天上午一起复核灰度监控',
      '</user_message>',
    ].join('\n')

    const meta = extractLarkContextMeta(raw)
    expect(meta).toMatchObject({
      chatType: 'group',
      chatId: 'oc_team',
      chatName: '研发群',
      messageId: 'om_msg_9',
      threadId: 'om_root_1',
      senderOpenId: 'ou_alex',
      senderName: '林晓',
      senderType: 'user',
    })
    expect(meta.peerMentions).toEqual([
      { openId: 'ou_chen', name: '陈明' },
      { openId: 'ou_sam', name: 'Sam' },
    ])
  })

  it('preserves both opening context and closing commitments under head+tail truncation', () => {
    const lines = [
      '- **User [林晓 | open_id=ou_alex]**: 开头核心背景：需要排查订单回调偶发超时',
      ...Array.from({ length: 18 }, (_, i) => `- **Agent**: 中间日志分析步骤 ${i + 1}：${'x'.repeat(260)}`),
      '- **User [林晓 | open_id=ou_alex]**: 结尾承诺：明天上午 10 点记得核查压测回滚开关是否已合入',
    ]

    const truncated = truncateSessionTranscriptHeadTail(lines, 1600)
    expect(truncated.length).toBeLessThanOrEqual(1700)
    expect(truncated).toContain('开头核心背景：需要排查订单回调偶发超时')
    expect(truncated).toContain('已省略中间')
    expect(truncated).toContain('结尾承诺：明天上午 10 点记得核查压测回滚开关是否已合入')
  })

  it('renders deterministic memory health audit highlighting stale entries, cold zero-recall memories, and tag clusters', () => {
    const nowMs = Date.UTC(2026, 10, 27, 3, 0, 0)
    const dayMs = 24 * 60 * 60_000
    const makeEntry = (patch: Partial<LarkMemoryEntry> & Pick<LarkMemoryEntry, 'id' | 'title'>): LarkMemoryEntry => ({
      botId: 'dev-bot',
      scope: 'bot',
      scopeId: '',
      type: 'project',
      content: '正文内容',
      tags: ['deploy'],
      confidence: 'high',
      pinned: false,
      status: 'active',
      createdAtMs: nowMs - 40 * dayMs,
      updatedAtMs: nowMs - 40 * dayMs,
      lastVerifiedAtMs: nowMs - 40 * dayMs,
      recallCount: 0,
      ...patch,
    })

    const report = renderMemoryAuditReport({
      botId: 'dev-bot',
      botName: '研发助手',
      nowMs,
      entries: [
        makeEntry({ id: 'mem-cold-1', title: '冷门构建脚本说明', tags: ['deploy', 'ci'] }),
        makeEntry({ id: 'mem-hot-2', title: '灰度回滚红线', tags: ['deploy'], recallCount: 8, lastVerifiedAtMs: nowMs - 20 * dayMs }),
        makeEntry({ id: 'mem-fresh-3', title: '最新发布窗口', tags: ['deploy'], recallCount: 2, lastVerifiedAtMs: nowMs - 2 * dayMs }),
      ],
    })

    expect(report).toContain('mem-cold-1')
    expect(report).toContain('冷记忆治理候选')
    expect(report).toContain('`#deploy`（3 条）')
    expect(report).toContain('mem-hot-2')
  })

  it('builds dedicated Stage 2 deep consolidation and Stage 3 proactive audit prompts', () => {
    const deep = composeDreamDeepConsolidationPrompt({
      botId: 'dev-bot',
      botName: '研发助手',
      workingDir: '/Users/demo/repo',
      currentDateIso: '2026-11-27',
      memoryMarkdownPath: '/Users/demo/.dsh/lark-bridge/memory/dev-bot/MEMORY.md',
      memoryAuditPath: '/Users/demo/.dsh/lark-bridge/dreaming/dev-bot/memory-audit.md',
      activeMemoryCount: 12,
      config: { ...DEFAULT_BOT_DREAMING_CONFIG, enabled: true },
    })
    expect(deep).toContain('stage="deep_consolidate"')
    expect(deep).toContain('memory-audit.md')
    expect(deep).toContain('程序性 SOP')

    const proactive = composeDreamProactivePrompt({
      botId: 'dev-bot',
      botName: '研发助手',
      workingDir: '/Users/demo/repo',
      currentDateIso: '2026-11-27',
      nextWorkdayMorningIso: '2026-11-27 09:30',
      openLoopsSnapshotPath: '/Users/demo/.dsh/lark-bridge/dreaming/dev-bot/open-loops-snapshot.md',
      config: { ...DEFAULT_BOT_DREAMING_CONFIG, enabled: true, maxRemindersPerRun: 5 },
      proactive: { ...DEFAULT_BOT_PROACTIVE_CONFIG, remindersEnabled: true, autoCodeEnabled: true },
    })
    expect(proactive).toContain('stage="proactive_audit"')
    expect(proactive).toContain('max_reminders="5"')
    expect(proactive).toContain('2026-11-27 09:30')
    expect(proactive).toContain('open-loops-snapshot.md')
    expect(proactive).toContain('--reply-to')
    expect(proactive).toContain('worktree create')
  })
})
