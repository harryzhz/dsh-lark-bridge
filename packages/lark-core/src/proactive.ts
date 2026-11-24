import { z } from 'zod'
import { normalizeReplyText } from './reply-text.js'
import { composeSystemReminder } from './router.js'
import {
  expandWorkingDir,
  type BotProactiveConfig,
} from './types.js'

export const REMINDER_SILENT_SENTINEL = '<no_reminder_needed/>'
export const MAX_REMINDER_CHAIN_DEPTH = 3
export const MAX_REMINDER_CHAIN_WINDOW_MS = 6 * 60 * 60_000
export const MAX_REMINDER_PROMPT_CHARS = 2400
export const MIN_CHAINED_REMINDER_BACKOFF_SECONDS: readonly number[] = [1800, 3600, 7200]
export const MAX_REMINDER_RESTART_RETRIES = 1
export const STALE_REMINDER_RETRY_WINDOW_MS = 2 * 60 * 60_000
export const RESTART_RETRY_DELAY_MS = 15_000
const MAX_SIBLING_REMINDERS_IN_PROMPT = 10

export const ReminderUrgencySchema = z.enum(['normal', 'high'])
export type ReminderUrgency = z.infer<typeof ReminderUrgencySchema>

function parseHHMMToMinutes(hhmm: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  if (!m) return undefined
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Defers a `normal` urgency reminder that falls inside the bot's configured local
 * Quiet Hours window (`[start, end)`) to the window's end time. `high` urgency
 * reminders always bypass Quiet Hours so real P0 alerts are never delayed.
 */
export function applyQuietHoursDeferral(
  targetIso: string,
  config: Pick<BotProactiveConfig, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>,
  urgency: ReminderUrgency = 'normal',
): { readonly scheduledAt: string; readonly deferredFrom?: string } {
  if (!config.quietHoursEnabled || urgency === 'high') {
    return { scheduledAt: targetIso }
  }
  const startMins = parseHHMMToMinutes(config.quietHoursStart)
  const endMins = parseHHMMToMinutes(config.quietHoursEnd)
  if (startMins === undefined || endMins === undefined || startMins === endMins) {
    return { scheduledAt: targetIso }
  }
  const target = new Date(targetIso)
  if (!Number.isFinite(target.getTime())) return { scheduledAt: targetIso }

  const curMins = target.getHours() * 60 + target.getMinutes()
  const overnight = startMins > endMins
  const inQuietWindow = overnight
    ? curMins >= startMins || curMins < endMins
    : curMins >= startMins && curMins < endMins
  if (!inQuietWindow) {
    return { scheduledAt: targetIso }
  }

  const endHour = Math.floor(endMins / 60)
  const endMinute = endMins % 60
  const deferred = new Date(target.getTime())
  if (overnight && curMins >= startMins) {
    deferred.setDate(deferred.getDate() + 1)
  }
  deferred.setHours(endHour, endMinute, 0, 0)
  return {
    scheduledAt: deferred.toISOString(),
    deferredFrom: targetIso,
  }
}

export const LarkReminderStatusSchema = z.enum([
  'pending_confirm',
  'scheduled',
  'running',
  'archived',
])

export const LarkReminderResolutionSchema = z.enum([
  'reminded',
  'silent_ok',
  'cancelled',
  'rejected',
  'error',
])

export const LarkReminderOriginSchema = z.object({
  botId: z.string().min(1),
  botName: z.string().default(''),
  larkAppId: z.string().default(''),
  chatType: z.enum(['group', 'p2p']),
  chatId: z.string().optional(),
  chatName: z.string().optional(),
  replyToMessageId: z.string().optional(),
  deliveryMode: z.enum(['thread', 'chat', 'p2p']),
  userOpenId: z.string().optional(),
  userName: z.string().optional(),
  sourceSessionId: z.string().optional(),
})

export const LarkReminderMentionSchema = z.object({
  openId: z.string().min(1),
  name: z.string().default(''),
})

export const LarkReminderWorktreeMetaSchema = z.object({
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  prUrl: z.string().optional(),
})

export const LarkReminderItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  reason: z.string().optional(),
  scheduledAt: z.string().min(1),
  status: LarkReminderStatusSchema,
  resolution: LarkReminderResolutionSchema.optional(),
  origin: LarkReminderOriginSchema,
  workingDir: z.string().optional(),
  mentions: z.array(LarkReminderMentionSchema).default([]),
  worktree: LarkReminderWorktreeMetaSchema.optional(),
  confirmMessageId: z.string().optional(),
  lastSessionId: z.string().optional(),
  resultSummary: z.string().optional(),
  urgency: ReminderUrgencySchema.optional(),
  retryCount: z.number().int().nonnegative().optional(),
  deferredFromScheduledAt: z.string().optional(),
  rootReminderId: z.string().optional(),
  parentReminderId: z.string().optional(),
  chainDepth: z.number().int().nonnegative().optional(),
  chainStartedAtMs: z.number().optional(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  archivedAtMs: z.number().optional(),
})

export type LarkReminderStatus = z.infer<typeof LarkReminderStatusSchema>
export type LarkReminderResolution = z.infer<typeof LarkReminderResolutionSchema>
export type LarkReminderOrigin = z.infer<typeof LarkReminderOriginSchema>
export type LarkReminderMention = z.infer<typeof LarkReminderMentionSchema>
export type LarkReminderWorktreeMeta = z.infer<typeof LarkReminderWorktreeMetaSchema>
export type LarkReminderItem = z.infer<typeof LarkReminderItemSchema>

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface ProactiveSessionReminderInput {
  readonly botId: string
  readonly workingDir: string
  readonly config: BotProactiveConfig
  readonly nowIso?: string
}

/**
 * Injected as a compact `<proactive>` directive on the first turn of a session when
 * proactive capabilities are enabled. Carries only dynamic runtime config, trigger/non-trigger
 * boundaries, and hard isolation redlines; full CLI flags and examples live in the `lark-bridge` skill.
 */
export function composeProactiveSessionReminder(
  input: ProactiveSessionReminderInput,
): string | undefined {
  const { config } = input
  if (!config.remindersEnabled && !config.autoCodeEnabled) return undefined

  const absWorkDir = expandWorkingDir(input.workingDir) || input.workingDir
  const modeAttr = `reminders="${config.remindersEnabled ? config.reminderCreationMode : 'off'}" auto_code="${config.autoCodeEnabled ? 'on' : 'off'}"`
  const lines: string[] = [`<proactive ${modeAttr}>`]

  if (config.remindersEnabled) {
    const modeRule =
      config.reminderCreationMode === 'confirm'
        ? '建后发确认卡待确认'
        : config.reminderCreationMode === 'notify'
          ? '建后附可取消卡（正文勿重复说明）'
          : '后台静默生效（正文勿播报）'
    const quietRule = config.quietHoursEnabled
      ? `；免打扰 ${config.quietHoursStart}–${config.quietHoursEnd}（普通顺延，仅 P0 止损传 \`--urgency high\`）`
      : ''
    const maxChainHours = Math.round(MAX_REMINDER_CHAIN_WINDOW_MS / 3_600_000)
    lines.push(
      `- **跟进提醒（\`lark-bridge reminder\`）**：仅在有明确时间锚点或待闭环责任时创建（发版/承诺、变更止损复查、待审催办、里程碑/错峰交付）；纯问答、无锚点或已有 \`schedule\` 覆盖不建。先 \`reminder list\` 去重，单链限 ${MAX_REMINDER_CHAIN_DEPTH} 次/${maxChainHours}h 勿作轮询，\`--prompt\` 须约定闭环后调 \`lark-bridge silence\` 静默；自动继承当前路由，${modeRule}${quietRule}，参数见 \`lark-bridge\` 技能。`,
    )
  }

  if (config.autoCodeEnabled) {
    const reminderPairSuffix = config.remindersEnabled
      ? '（错峰提审可配 `lark-bridge reminder create --worktree <path> --branch <branch> [--pr <url>]`）'
      : ''
    lines.push(
      `- **隔离编码（\`lark-bridge worktree\`）**：仅限根因明确可验证的缺陷、评审隐患或共识小改；需求模糊、破坏性大改或无法本地验证时只给方案。**严禁直改主工作目录**，须用 \`lark-bridge worktree create <slug> --prefix "${config.branchPrefix}"\` 在 \`${absWorkDir}/.worktrees/<slug>\` 改码验证并提交/提 PR${reminderPairSuffix}。`,
    )
  }

  lines.push('</proactive>')
  return lines.join('\n')
}

export interface ReminderTriggerPromptInput {
  readonly item: LarkReminderItem
  readonly currentLocalTimeStr: string
  readonly siblingActiveReminders?: readonly Pick<LarkReminderItem, 'id' | 'title' | 'scheduledAt'>[]
}

/**
 * Builds the execution prompt when a one-shot reminder reaches `scheduledAt`.
 */
export function composeReminderTriggerPrompt(input: ReminderTriggerPromptInput): string {
  const { item } = input
  const originDesc =
    item.origin.chatType === 'p2p'
      ? `私聊「${item.origin.userName || item.origin.userOpenId || '用户'}」(bot_id="${item.origin.botId}", open_id="${item.origin.userOpenId ?? ''}")`
      : `群聊「${item.origin.chatName || item.origin.chatId || ''}」(bot_id="${item.origin.botId}", chat_id="${item.origin.chatId ?? ''}", delivery="${item.origin.deliveryMode}"${item.origin.replyToMessageId ? `, thread_root="${item.origin.replyToMessageId}"` : ''})`

  const innerLines: string[] = [
    `<reminder_trigger reminder_id="${escapeXmlAttr(item.id)}" title="${escapeXmlAttr(item.title)}" now="${escapeXmlAttr(input.currentLocalTimeStr)}">`,
    `- 投递目标：${originDesc}`,
  ]

  if (item.mentions.length > 0) {
    const presetMentions = item.mentions
      .map((m) => `${m.name || m.openId}(open_id="${m.openId}")`)
      .join('、')
    innerLines.push(`- 关注人员：${presetMentions}`)
  }

  if (item.worktree) {
    innerLines.push(
      `- 关联工作树：\`${item.worktree.worktreePath}\`（分支 \`${item.worktree.branch}\`${item.worktree.prUrl ? `，PR/MR：${item.worktree.prUrl}` : ''}）`,
    )
  }

  if (input.siblingActiveReminders && input.siblingActiveReminders.length > 0) {
    const visible = input.siblingActiveReminders.slice(0, MAX_SIBLING_REMINDERS_IN_PROMPT)
    const remaining = input.siblingActiveReminders.length - visible.length
    const sibs = visible
      .map((s) => `${s.id}「${s.title}」(计划 ${s.scheduledAt})`)
      .join('；')
    const moreSuffix =
      remaining > 0 ? `；另有 ${remaining} 条待触发（运行 \`lark-bridge reminder list\` 查看）` : ''
    innerLines.push(
      `- 同源待触发提醒：${sibs}${moreSuffix}（若整体事项已提前闭环，运行 \`lark-bridge reminder cancel <id>\` 取消冗余提醒；需跟进下一阶段时运行 \`lark-bridge reminder create ...\`）`,
    )
  }

  const currentDepth = item.chainDepth ?? 0
  if (currentDepth >= MAX_REMINDER_CHAIN_DEPTH) {
    innerLines.push(
      `- 链式续查额度：${currentDepth}/${MAX_REMINDER_CHAIN_DEPTH}（**本轮为链末次核查，系统已禁止继续创建续查提醒**；若事项仍未闭环请直接提醒负责人处理，或建议改用周期性 \`lark-bridge schedule\`）`,
    )
  } else {
    innerLines.push(
      `- 链式续查额度：${currentDepth}/${MAX_REMINDER_CHAIN_DEPTH}（严禁将单次提醒用作无限轮询；若确需继续观察且未超上限，须拉大间隔且仅写增量要点，勿复制长段历史日志）`,
    )
  }

  const outputGuideline =
    item.origin.chatType === 'group'
      ? '  3. 若需提醒或提审，直接输出简洁的简体中文 Markdown 正文（@ 群成员用 `<at id="ou_xxx">姓名</at>`；未给出 `open_id` 时先运行 `lark-bridge members --query <姓名>` 按需查询本群真实 ID，禁止编造或跨应用混用；勿用 `lark-bridge send` 重复发送正文）。'
      : '  3. 若需提醒或提审，直接输出简洁的简体中文 Markdown 正文（勿用 `lark-bridge send` 重复发送正文）。'

  innerLines.push(
    '- 执行准则：',
    '  1. 先按下方指令核查最新事实（如 `lark-bridge history` 查看群内最新消息、检查仓库提交/分支/PR 或部署状态）。',
    `  2. 若事项已完成、进度正常或无需干预，优先运行 \`lark-bridge silence --reason "<简短原因>"\`（或仅输出 \`${REMINDER_SILENT_SENTINEL}\`）静默归档。`,
    outputGuideline,
    '</reminder_trigger>',
  )

  const systemBlock = composeSystemReminder([innerLines.join('\n')])!
  return `${systemBlock}\n\n<user_message>\n${item.prompt.trim()}\n</user_message>`
}

export function extractReminderTriggerOutput(rawReply: string): string | undefined {
  const normalized = normalizeReplyText(rawReply, { allowSilentSentinel: true })
  return normalized || undefined
}
