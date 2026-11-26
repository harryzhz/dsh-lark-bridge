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
export const MAX_DELEGATION_CHAIN_WINDOW_MS = 24 * 60 * 60_000
export const MAX_REMINDER_PROMPT_CHARS = 2400
export const MIN_CHAINED_REMINDER_BACKOFF_SECONDS: readonly number[] = [1800, 3600, 7200]
export const MIN_DELEGATION_CHAIN_BACKOFF_SECONDS: readonly number[] = [600, 1800, 3600]
export const MAX_REMINDER_RESTART_RETRIES = 1
export const STALE_REMINDER_RETRY_WINDOW_MS = 2 * 60 * 60_000
export const RESTART_RETRY_DELAY_MS = 15_000
const MAX_SIBLING_REMINDERS_IN_PROMPT = 10

export const ReminderUrgencySchema = z.enum(['normal', 'high'])
export type ReminderUrgency = z.infer<typeof ReminderUrgencySchema>

export const LarkReminderKindSchema = z.enum(['general', 'delegation'])
export type LarkReminderKind = z.infer<typeof LarkReminderKindSchema>

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
  kind: LarkReminderKindSchema.optional(),
  title: z.string().min(1),
  prompt: z.string().min(1),
  reason: z.string().optional(),
  scheduledAt: z.string().min(1),
  status: LarkReminderStatusSchema,
  resolution: LarkReminderResolutionSchema.optional(),
  origin: LarkReminderOriginSchema,
  workingDir: z.string().optional(),
  mentions: z.array(LarkReminderMentionSchema).default([]),
  ccMentions: z.array(LarkReminderMentionSchema).default([]),
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function normalizeReminderMentions(
  raw?: readonly Partial<LarkReminderMention>[],
  excludeOpenIds?: ReadonlySet<string>,
): LarkReminderMention[] {
  if (!raw || raw.length === 0) return []
  const seen = new Set<string>(excludeOpenIds ? [...excludeOpenIds] : [])
  const out: LarkReminderMention[] = []
  for (const item of raw) {
    const openId = item?.openId?.trim() ?? ''
    if (!openId || openId === 'all' || seen.has(openId)) continue
    seen.add(openId)
    out.push({ openId, name: item?.name?.trim() ?? '' })
  }
  return out
}

function markdownMentionsOpenId(markdown: string, openId: string): boolean {
  const re = new RegExp(`<at\\s+(?:user_id|id)\\s*=\\s*["']?${escapeRegex(openId)}["']?(?:\\s|>)`, 'i')
  return re.test(markdown)
}

/**
 * Guarantees every group reminder delivered to Feishu explicitly `@`s all primary
 * owners (`mentions`) and notifies CC stakeholders (`ccMentions`) via `cc <at ...>`.
 */
export function formatReminderOutputWithMentions(input: {
  readonly chatType: 'group' | 'p2p'
  readonly markdown: string
  readonly mentions?: readonly LarkReminderMention[]
  readonly ccMentions?: readonly LarkReminderMention[]
}): string {
  let markdown = input.markdown.trim()
  if (input.chatType !== 'group') return markdown

  const owners = normalizeReminderMentions(input.mentions)
  const ownerIds = new Set(owners.map((m) => m.openId))
  const ccList = normalizeReminderMentions(input.ccMentions, ownerIds)

  const missingOwners = owners.filter((m) => !markdownMentionsOpenId(markdown, m.openId))
  if (missingOwners.length > 0) {
    const ownerPrefix = missingOwners
      .map((m) => `<at id="${m.openId}">${m.name || ''}</at>`)
      .join(' ')
    markdown = markdown ? `${ownerPrefix}\n\n${markdown}` : ownerPrefix
  }

  const missingCc = ccList.filter((m) => !markdownMentionsOpenId(markdown, m.openId))
  if (missingCc.length > 0) {
    const ccTags = missingCc
      .map((m) => `<at id="${m.openId}">${m.name || ''}</at>`)
      .join(' ')
    markdown = markdown ? `${markdown}\n\ncc ${ccTags}` : `cc ${ccTags}`
  }

  return markdown
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
  const delegationOn = Boolean(config.remindersEnabled && config.delegationFollowupEnabled)
  const modeAttr = `reminders="${config.remindersEnabled ? config.reminderCreationMode : 'off'}" auto_code="${config.autoCodeEnabled ? 'on' : 'off'}"${delegationOn ? ' delegation="on"' : ''}`
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
      `- **跟进提醒（\`lark-bridge reminder\`）**：仅用于明确锚点/待闭环（发版承诺、变更止损复查、待审、错峰交付）；纯问答或已有 \`schedule\` 不建。群聊必传 \`--mention\`（按需 \`--cc\`）；先 \`list\` 去重，单链限 ${MAX_REMINDER_CHAIN_DEPTH} 次/${maxChainHours}h，闭环调 \`lark-bridge silence\`；继承当前路由，${modeRule}${quietRule}，见 \`lark-bridge\` 技能。`,
    )
    if (delegationOn) {
      lines.push(
        '- **委派跟进（`--kind delegation`）**：群内 A@B 明确行动指派（排查/修复/审批/CR/交付）后台静默建提醒（`--mention` B、`--cc` A；无时间则紧急故障 10m、常规 1h），仅记委派不插话调 `lark-bridge silence`。',
      )
    }
  }

  if (config.autoCodeEnabled) {
    const reminderPairSuffix = config.remindersEnabled
      ? '（错峰提审配 `lark-bridge reminder create --worktree <path> --branch <branch> [--pr <url>]`）'
      : ''
    lines.push(
      `- **隔离编码（\`lark-bridge worktree\`）**：仅限根因明确可验证缺陷或共识小改；模糊或大改只给方案。**严禁直改主目录**，用 \`lark-bridge worktree create <slug> --prefix "${config.branchPrefix}"\` 在 \`${absWorkDir}/.worktrees/<slug>\` 验证提审${reminderPairSuffix}。`,
    )
  }

  lines.push('</proactive>')
  return lines.join('\n')
}

export interface ReminderTriggerPromptInput {
  readonly item: LarkReminderItem
  readonly currentLocalTimeStr: string
  readonly siblingActiveReminders?: readonly Pick<LarkReminderItem, 'id' | 'title' | 'scheduledAt'>[]
  readonly roleReminder?: string
  readonly memoryReminder?: string
}

/**
 * Builds the execution prompt when a one-shot reminder reaches `scheduledAt`.
 */
export function composeReminderTriggerPrompt(input: ReminderTriggerPromptInput): string {
  const { item } = input
  const isDelegation = item.kind === 'delegation'
  const originDesc =
    item.origin.chatType === 'p2p'
      ? `私聊「${item.origin.userName || item.origin.userOpenId || '用户'}」(bot_id="${item.origin.botId}", open_id="${item.origin.userOpenId ?? ''}")`
      : `群聊「${item.origin.chatName || item.origin.chatId || ''}」(bot_id="${item.origin.botId}", chat_id="${item.origin.chatId ?? ''}", delivery="${item.origin.deliveryMode}"${item.origin.replyToMessageId ? `, thread_root="${item.origin.replyToMessageId}"` : ''})`

  const kindAttr = isDelegation ? ' kind="delegation"' : ''
  const innerLines: string[] = [
    `<reminder_trigger reminder_id="${escapeXmlAttr(item.id)}"${kindAttr} title="${escapeXmlAttr(item.title)}" now="${escapeXmlAttr(input.currentLocalTimeStr)}">`,
    `- 投递目标：${originDesc}`,
  ]

  if (item.mentions.length > 0) {
    const ownerMentions = item.mentions
      .map((m) => `${m.name || m.openId}(open_id="${m.openId}")`)
      .join('、')
    innerLines.push(`- 主负责人（必 @）：${ownerMentions}`)
  }

  const ccList = item.ccMentions ?? []
  if (ccList.length > 0) {
    const ccText = ccList
      .map((m) => `${m.name || m.openId}(open_id="${m.openId}")`)
      .join('、')
    innerLines.push(`- 抄送关注（cc）：${ccText}`)
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
      `- 链式续查额度：${currentDepth}/${MAX_REMINDER_CHAIN_DEPTH}（**本轮为链末次核查，系统已禁止继续创建续查提醒**；若事项仍未闭环请直接提醒主负责人${ccList.length > 0 ? '并 cc 抄送人' : ''}处理，或建议改用周期性 \`lark-bridge schedule\`）`,
    )
  } else {
    innerLines.push(
      `- 链式续查额度：${currentDepth}/${MAX_REMINDER_CHAIN_DEPTH}（严禁将单次提醒用作无限轮询；若确需顺延复查且未超上限，须拉大间隔且仅写增量要点，勿复制长段历史日志）`,
    )
  }

  const checkGuideline =
    isDelegation && item.origin.chatType === 'group'
      ? '  1. 同时核查原话题与群主消息流（运行 `lark-bridge history --limit 20` 及 `lark-bridge history --thread none --limit 20`），并按需核对关联 PR/工单/部署状态。'
      : '  1. 先按下方指令核查最新事实（如 `lark-bridge history` 查看群内最新消息、检查仓库提交/分支/PR 或部署状态）。'

  const delegationDeferLine =
    isDelegation && currentDepth < MAX_REMINDER_CHAIN_DEPTH
      ? '  3. 若主负责人已回复（如“收到/在看/稍后处理”）但**尚未给出最终结果**：不要在群内重复催办，请结合承诺时间或自适应延迟（紧急故障 10–30m，常规协作/CR/审批 1–2h）运行 `lark-bridge reminder create --kind delegation` 顺延复查（保留 `--mention` 主负责人与 `--cc` 发起人），再调用 `lark-bridge silence --reason "负责人已响应，已顺延复查"` 静默。'
      : undefined

  const outputStepNum = delegationDeferLine ? 4 : 3
  const outputGuideline =
    item.origin.chatType === 'group'
      ? `  ${outputStepNum}. 若需发出消息：**群聊提醒严禁无 @ 群发**，必须以 \`<at id="ou_xxx">姓名</at>\` 明确 @ 主负责人，有抄送或关注人员时通过 \`cc <at id="ou_xxx">姓名</at>\` 一并周知；正文直接说明具体事项或询问当前进展（像群内同事自然沟通，勿将系统或提醒指令中的语气要求字面写进正文${isDelegation ? '，且不武断断言“未处理”' : ''}）；未给出 \`open_id\` 时先运行 \`lark-bridge members --query <姓名>\` 按需查询本群真实 ID，禁止编造或跨应用混用；勿用 \`lark-bridge send\` 重复发送正文。`
      : `  ${outputStepNum}. 若需发出消息，直接输出简洁的简体中文 Markdown 正文说明事项或待确认点（勿将系统或提醒指令中的语气要求字面写进正文，勿用 \`lark-bridge send\` 重复发送正文）。`

  innerLines.push(
    '- 执行准则：',
    checkGuideline,
    `  2. 若事项已完成、已取消或无需干预，优先运行 \`lark-bridge silence --reason "<简短原因>"\`（或仅输出 \`${REMINDER_SILENT_SENTINEL}\`）静默归档。`,
    ...(delegationDeferLine ? [delegationDeferLine] : []),
    outputGuideline,
    '</reminder_trigger>',
  )

  const systemBlock = composeSystemReminder([
    input.roleReminder,
    input.memoryReminder,
    innerLines.join('\n'),
  ])!
  return `${systemBlock}\n\n<user_message>\n${item.prompt.trim()}\n</user_message>`
}

export function extractReminderTriggerOutput(rawReply: string): string | undefined {
  const normalized = normalizeReplyText(rawReply, { allowSilentSentinel: true })
  return normalized || undefined
}
