import { formatMarkdownForLarkCard } from './markdown.js'
import type { LarkReminderItem } from './proactive.js'
import { trimInvisibleText } from './reply-text.js'
import type { LarkBotConfig } from './types.js'

export interface ReplyCardImage {
  readonly imgKey: string
  readonly alt?: string
  readonly mode?: 'fit_horizontal' | 'large' | 'medium' | 'small' | 'tiny'
}

export interface ReplyCardOptions {
  readonly title?: string
  readonly markdown: string
  readonly bot: LarkBotConfig
  readonly modelLabel?: string
  readonly sessionUrl?: string
  readonly template?: 'blue' | 'green' | 'orange' | 'red' | 'grey'
  readonly images?: readonly ReplyCardImage[]
}

function buildBodyElementsWithImages(
  markdown: string,
  images: readonly ReplyCardImage[] | undefined,
): Record<string, unknown>[] {
  const trimmed = trimInvisibleText(markdown)
  if (!images || images.length === 0) {
    const formatted = formatMarkdownForLarkCard(trimmed)
    return [{ tag: 'markdown', content: formatted || '(空回复)' }]
  }

  const usedIndices = new Set<number>()
  const elements: Record<string, unknown>[] = []
  const placeholderRegex = /!\[([^\]]*)\]\(img:(\d+)\)/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = placeholderRegex.exec(trimmed)) !== null) {
    const before = formatMarkdownForLarkCard(trimmed.slice(cursor, match.index))
    if (before) {
      elements.push({ tag: 'markdown', content: before })
    }
    const idx = Number(match[2])
    const img = images[idx]
    if (img) {
      usedIndices.add(idx)
      elements.push({
        tag: 'img',
        img_key: img.imgKey,
        alt: { tag: 'plain_text', content: match[1] || img.alt || '图片' },
        mode: img.mode ?? 'fit_horizontal',
      })
    }
    cursor = match.index + match[0].length
  }

  const tail = formatMarkdownForLarkCard(trimmed.slice(cursor))
  if (tail) {
    elements.push({ tag: 'markdown', content: tail })
  }

  images.forEach((img, idx) => {
    if (usedIndices.has(idx)) return
    elements.push({
      tag: 'img',
      img_key: img.imgKey,
      alt: { tag: 'plain_text', content: img.alt || '图片' },
      mode: img.mode ?? 'fit_horizontal',
    })
  })

  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: '(空回复)' })
  }
  return elements
}

export function buildReplyCard(options: ReplyCardOptions): Record<string, unknown> {
  const elements: Record<string, unknown>[] = buildBodyElementsWithImages(
    options.markdown,
    options.images,
  )

  const noteParts: string[] = []
  if (options.bot.replyFooterEnabled) {
    const signature = options.bot.signature?.trim()
    if (options.bot.replyFooterSignature && signature) {
      noteParts.push(signature)
    }
    if (options.bot.replyFooterModel && options.modelLabel) {
      noteParts.push(options.modelLabel)
    }
  }
  if (options.bot.dshSessionLinkInCard && options.sessionUrl) {
    noteParts.push(`[在 DSH 接管会话](${options.sessionUrl})`)
  }

  if (noteParts.length > 0) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: noteParts.join(' · '),
    })
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    ...(options.title
      ? {
          header: {
            title: { tag: 'plain_text', content: options.title },
            template: options.template ?? 'blue',
          },
        }
      : {}),
    body: { elements },
  }
}

export interface ApprovalCardOptions {
  readonly approvalId: string
  readonly toolName: string
  readonly reason: string
  readonly sessionUrl?: string
}

export function buildApprovalCard(options: ApprovalCardOptions): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `**工具**: \`${options.toolName}\`\n**原因**: ${options.reason}`,
    },
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '允许本次' },
              type: 'primary',
              value: { kind: 'dsh_approval', approvalId: options.approvalId, decision: 'allow' },
            },
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '拒绝' },
              type: 'danger',
              value: { kind: 'dsh_approval', approvalId: options.approvalId, decision: 'reject' },
            },
          ],
        },
      ],
    },
  ]

  if (options.sessionUrl) {
    elements.push({
      tag: 'markdown',
      content: `[在 DSH 查看上下文](${options.sessionUrl})`,
    })
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '需要工具执行审批' },
      template: 'orange',
    },
    body: { elements },
  }
}

function formatReminderStakeholderLines(
  item: Pick<LarkReminderItem, 'mentions' | 'ccMentions'>,
): string[] {
  const lines: string[] = []
  if (item.mentions && item.mentions.length > 0) {
    lines.push(
      `**主负责人**：${item.mentions.map((m) => m.name || m.openId).join('、')}`,
    )
  }
  if (item.ccMentions && item.ccMentions.length > 0) {
    lines.push(
      `**抄送关注**：cc ${item.ccMentions.map((m) => m.name || m.openId).join('、')}`,
    )
  }
  return lines
}

export function buildReminderConfirmCard(
  item: Pick<LarkReminderItem, 'id' | 'title' | 'scheduledAt' | 'reason' | 'prompt' | 'mentions' | 'ccMentions'>,
  formattedTime: string,
): Record<string, unknown> {
  const detail = item.reason?.trim() || item.prompt.trim().slice(0, 160)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `待确认跟进提醒 · ${item.title}` },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**计划触发时间**：${formattedTime}`,
            ...formatReminderStakeholderLines(item),
            detail ? `**跟进说明**：${detail}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '确认添加' },
                  type: 'primary',
                  value: {
                    kind: 'lark_reminder_confirm',
                    reminderId: item.id,
                    decision: 'approve',
                  },
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '忽略' },
                  type: 'default',
                  value: {
                    kind: 'lark_reminder_confirm',
                    reminderId: item.id,
                    decision: 'reject',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

export function buildReminderNoticeCard(
  item: Pick<LarkReminderItem, 'id' | 'title' | 'mentions' | 'ccMentions'>,
  formattedTime: string,
): Record<string, unknown> {
  const stakeholderLines = formatReminderStakeholderLines(item)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `已创建跟进提醒 · ${item.title}` },
      template: 'grey',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `将于 **${formattedTime}** 自动跟进执行（触发后自动归档；若届时已完成将保持静默）。`,
            ...stakeholderLines,
          ].join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '取消该提醒' },
                  type: 'default',
                  value: {
                    kind: 'lark_reminder_cancel',
                    reminderId: item.id,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

export function buildReminderStatusCard(
  title: string,
  markdown: string,
  template: 'green' | 'grey' = 'grey',
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    body: {
      elements: [{ tag: 'markdown', content: markdown }],
    },
  }
}
