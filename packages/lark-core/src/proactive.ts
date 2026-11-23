import { z } from 'zod'
import { normalizeReplyText } from './reply-text.js'
import { composeSystemReminder } from './router.js'
import {
  expandWorkingDir,
  type BotProactiveConfig,
} from './types.js'

export const REMINDER_SILENT_SENTINEL = '<no_reminder_needed/>'
const MAX_SIBLING_REMINDERS_IN_PROMPT = 10

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
 * Injected as `<proactive>` on the first turn of a session when proactive capabilities
 * are enabled. Teaches the Agent concrete scenarios, non-goals, and CLI workflows for
 * one-shot follow-up reminders and isolated `.worktrees/` code changes.
 */
export function composeProactiveSessionReminder(
  input: ProactiveSessionReminderInput,
): string | undefined {
  const { config } = input
  if (!config.remindersEnabled && !config.autoCodeEnabled) return undefined

  const absWorkDir = expandWorkingDir(input.workingDir) || input.workingDir
  const modeAttr = `reminders="${config.remindersEnabled ? config.reminderCreationMode : 'off'}" auto_code="${config.autoCodeEnabled ? 'on' : 'off'}"`
  const lines: string[] = [
    `<proactive ${modeAttr}>`,
    '完成当轮响应的同时，按以下边界执行主动协作：',
  ]

  if (config.remindersEnabled) {
    const modeRule =
      config.reminderCreationMode === 'confirm'
        ? '当前为 `confirm` 模式：执行命令后发送确认卡片，用户确认后生效。'
        : config.reminderCreationMode === 'notify'
          ? '当前为 `notify` 模式：执行命令后自动附带可取消提示卡，正文中无需重复说明。'
          : '当前为 `silent` 模式：后台静默生效，正文中无需专门播报“已创建提醒”。'
    lines.push(
      '1. **一次性跟进提醒（`lark-bridge reminder`）**：',
      '   - 触发场景（仅在存在明确时间锚点或待闭环责任时创建）：',
      '     a) **承诺与发版核查**：对话约定“下午 16:00 发版 / 稍后回填压测数据 / 今晚回滚配置”，在约定时间后创建核查提醒（已完成则静默，未完成才提醒责任人）；',
      '     b) **变更与止损后复查**：执行限流、降级、热修或放量灰度后，创建 `30~60` 分钟后的复查提醒（核查错误率/延迟是否回落、临时开关是否需清理）；',
      '     c) **待审与外部依赖催办**：PR/MR 待评审、跨团队接口确认或问题单超过合理等待窗口未响应时，创建跟进提醒（已合入/已回复则静默，仍挂起则提醒对应人员）；',
      '     d) **多节点里程碑跟进**：跨天交付事项（如“周五前完成迁移”），可拆分前置进度核查（如周三上午，正常则静默）与截止兜底核查（周五下午）；',
      '     e) **非工作时段错峰交付**：夜间或节假日自动排查产出非紧急优化方案/PR 时，创建下一工作日上午（如 `10:00`）提醒推送给负责人。',
      '   - 不创建边界：纯技术问答、无时间锚点与责任人的泛泛讨论、或已有周期性 `schedule` 覆盖的例行任务；创建前先用 `lark-bridge reminder list` 避免重复。',
      `   - 模式说明：自动继承当前会话投递路径；${modeRule}`,
      '   - 命令示例：',
      '     - 按时间点核查：`lark-bridge reminder create --title "核查 16:00 发版结果" --at "<YYYY-MM-DD HH:mm>" --mention "<open_id>:<姓名>" --prompt "运行 lark-bridge history --limit 20 并检查部署状态：已完成或群内已同步延期则输出 <no_reminder_needed/>；未完成且无说明则简短提醒负责人"`',
      '     - 按相对延时复查：`lark-bridge reminder create --title "复查降级恢复情况" --after 1800 --prompt "检查近 30 分钟错误率与群内通报：指标已恢复且无遗留开关则输出 <no_reminder_needed/>；异常持续则同步数据提醒值班人"`',
    )
  }

  if (config.autoCodeEnabled) {
    lines.push(
      `${config.remindersEnabled ? '2' : '1'}. **隔离工作树主动编码（\`lark-bridge worktree\`）**：`,
      '   - 触发场景：',
      '     a) **告警/报错确定性缺陷**：排查线上告警、异常堆栈或构建失败时，定位到明确的空指针、超时/重试配置遗漏、幂等边界漏洞或类型错误；',
      '     b) **代码评审与巡检隐患**：发现契约不一致、缺失边界校验、遗漏单测或过时死代码，可附带可验证补丁辅助评审；',
      '     c) **群内已达成共识的待办小改**：讨论已明确方案但暂无人动手的小步重构、配置收敛、脚本或文档更新。',
      `   - 隔离红线：**严禁直接修改主工作目录 \`${absWorkDir}\`**；需求模糊、涉及不兼容协议变更/架构大改/破坏性迁移或无法本地验证时，仅输出方案不擅自改码。`,
      `   - 命令示例：运行 \`lark-bridge worktree create <slug> --prefix "${config.branchPrefix}"\` 在 \`${absWorkDir}/.worktrees/<slug>\` 创建隔离分支 -> 在该工作树内完成修改与构建/单测验证 -> 按仓库规范提交分支或创建 PR/MR（非工作时段可搭配 \`lark-bridge reminder create --worktree <path> --branch <branch> [--pr <url>]\` 错峰提审）。`,
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

  const outputGuideline =
    item.origin.chatType === 'group'
      ? '  3. 若需提醒或提审，直接输出简洁的简体中文 Markdown 正文（@ 群成员用 `<at id="ou_xxx">姓名</at>`；未给出 `open_id` 时先运行 `lark-bridge members --query <姓名>` 按需查询本群真实 ID，禁止编造或跨应用混用；勿用 `lark-bridge send` 重复发送正文）。'
      : '  3. 若需提醒或提审，直接输出简洁的简体中文 Markdown 正文（勿用 `lark-bridge send` 重复发送正文）。'

  innerLines.push(
    '- 执行准则：',
    '  1. 先按下方指令核查最新事实（如 `lark-bridge history` 查看群内最新消息、检查仓库提交/分支/PR 或部署状态）。',
    `  2. 若事项已完成、进度正常或无需干预，仅输出 \`${REMINDER_SILENT_SENTINEL}\`。`,
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
