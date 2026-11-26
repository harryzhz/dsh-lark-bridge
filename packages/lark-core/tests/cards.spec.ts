import { describe, expect, it } from 'vitest'
import {
  buildApprovalCard,
  buildReminderConfirmCard,
  buildReminderNoticeCard,
  buildReminderStatusCard,
  buildReplyCard,
  LarkBotConfigSchema,
  LarkReminderItemSchema,
} from '../src/index.js'

function createBot() {
  return LarkBotConfigSchema.parse({
    id: 'dsh-bot',
    name: 'DSH-Bot',
    larkAppId: 'cli_test',
    larkAppSecret: 'sec_test',
    defaultWorkingDir: '~/workspace',
  })
}

function createReminderItem() {
  return LarkReminderItemSchema.parse({
    id: 'rem-width-1',
    botId: 'dsh-bot',
    title: '跟进发版验证',
    prompt: '检查灰度指标并在正常后同步结果',
    reason: '确认灰度稳定',
    scheduledAt: '2026-11-26T12:00:00+08:00',
    status: 'scheduled',
    createdAtMs: Date.parse('2026-11-26T10:00:00+08:00'),
    updatedAtMs: Date.parse('2026-11-26T10:00:00+08:00'),
    workingDir: '~/workspace',
    mentions: [{ openId: 'ou_owner', name: 'Alex Chen' }],
    ccMentions: [{ openId: 'ou_peer', name: 'Sam' }],
    origin: {
      botId: 'dsh-bot',
      botName: 'DSH-Bot',
      larkAppId: 'cli_test',
      chatType: 'group',
      deliveryMode: 'thread',
      chatId: 'oc_team',
      chatName: '核心研发群',
      replyToMessageId: 'om_root_1',
    },
  })
}

describe('Feishu Card JSON 2.0 width_mode configuration', () => {
  it('sets width_mode=fill and update_multi=true on reply cards without deprecated wide_screen_mode', () => {
    const card = buildReplyCard({
      title: '分析结论',
      markdown: '| 列A | 列B | 列C |\n| --- | --- | --- |\n| 1 | 2 | 3 |',
      bot: createBot(),
      modelLabel: 'demo-model',
      sessionUrl: 'http://127.0.0.1:3880/#session=s1',
    }) as {
      schema: string
      config: Record<string, unknown>
    }

    expect(card.schema).toBe('2.0')
    expect(card.config).toEqual({
      update_multi: true,
      width_mode: 'fill',
    })
    expect(card.config).not.toHaveProperty('wide_screen_mode')
  })

  it('keeps width_mode=default and update_multi=true on compact action and status cards', () => {
    const item = createReminderItem()
    const compactCards = [
      buildApprovalCard({
        approvalId: 'apr-1',
        toolName: 'bash',
        reason: '执行构建检查',
        sessionUrl: 'http://127.0.0.1:3880/#session=s1',
      }),
      buildReminderConfirmCard(item, '2026-11-26 12:00'),
      buildReminderNoticeCard(item, '2026-11-26 12:00'),
      buildReminderStatusCard('已取消提醒', '用户已主动取消该跟进提醒。'),
    ] as Array<{
      schema: string
      config: Record<string, unknown>
    }>

    for (const card of compactCards) {
      expect(card.schema).toBe('2.0')
      expect(card.config).toEqual({
        update_multi: true,
        width_mode: 'default',
      })
      expect(card.config).not.toHaveProperty('wide_screen_mode')
    }
  })
})
