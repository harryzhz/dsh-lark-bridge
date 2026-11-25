import { composeSystemReminder } from './router.js'
import { expandWorkingDir, type BotDreamingConfig, type BotProactiveConfig } from './types.js'

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface DreamExecutionPromptInput {
  readonly botId: string
  readonly botName: string
  readonly workingDir: string
  readonly activeWorkingDirs?: readonly string[]
  readonly currentDateIso: string
  readonly transcriptDigestPath: string
  readonly memoryMarkdownPath?: string
  readonly activeMemoryCount?: number
  readonly sessionCount: number
  readonly config: BotDreamingConfig
  readonly proactive?: BotProactiveConfig
}

/**
 * Builds the 4-phase offline Auto-Dream consolidation prompt inside `<system_reminder><dream_job>...`.
 * Operates against runtime-agnostic Memory via `lark-bridge memory` CLI so all
 * native and external runtimes share durable, auditable, bi-temporal memory consolidation.
 */
export function composeDreamExecutionPrompt(input: DreamExecutionPromptInput): string {
  const { config, currentDateIso, proactive } = input
  const absWorkingDir = expandWorkingDir(input.workingDir) || input.workingDir
  const scopes = config.scopes.map((s) => s.trim()).filter(Boolean)

  const scopeBlock =
    scopes.length > 0
      ? [
          '重点提炼范围：',
          ...scopes.map((scope, idx) => `${idx + 1}. **${scope}**`),
        ].join('\n')
      : '重点提炼范围：高价值长期上下文、工程约定、用户纠偏与协作偏好。'

  const activeDirs = Array.from(
    new Set(
      (input.activeWorkingDirs ?? [])
        .map((d) => expandWorkingDir(d) || d.trim())
        .filter(Boolean),
    ),
  )
  const inspectDirLine =
    activeDirs.length > 0
      ? `- 仅定向只读巡检本次增量会话涉及的工作目录（${activeDirs.map((d) => `\`${d}\``).join('、')}）近期变更（如 \`git status -s\`、\`git log -n 20 --oneline\`）与核心文档，勿盲目遍历无关仓库。`
      : `- 只读巡检工作目录 \`${absWorkingDir}\` 近期变更（如 \`git status -s\`、\`git log -n 20 --oneline\`）与核心文档。`

  const orientationLines = [
    '### Phase 1 · 摸底现有记忆（Orientation）',
    ...(input.memoryMarkdownPath
      ? [`- 读取当前 Memory 只读镜像：\`${input.memoryMarkdownPath}\`（当前有效 ${input.activeMemoryCount ?? 0} 条）。`]
      : []),
    `- 按需运行 \`lark-bridge memory list --bot ${input.botId} --status active\` 查看完整有效条目与 ID，避免重复写入。`,
  ]

  const gatherLines = [
    '### Phase 2 · 采信增量信号（Gather Signal）',
    `- 读取 ${input.sessionCount} 个有效增量会话摘要：\`${input.transcriptDigestPath}\`。`,
    inspectDirLine,
    '- 严禁抄录代码仓文档（如 `README.md` / `AGENTS.md`）或源码中已清晰存在的静态事实；仅关注跨会话复用的隐性认知、纠偏、决策依据与外部指针。',
  ]

  const consolidateLines = [
    '### Phase 3 · 沉淀、合并与双时态纠偏（Consolidate & Supersede）',
    scopeBlock,
    '- 使用运行时无关的 Memory CLI 持久化写入（4 类语义分类：`feedback` 纠偏/防踩坑规则、`user` 用户/团队偏好、`project` 项目决策与背景、`reference` 外部系统/文档指针）：',
    `  - 新增或幂等更新：\`lark-bridge memory upsert --bot ${input.botId} --type <feedback|user|project|reference> --title "<自包含触发标题(≤35字)>" --content "<事实要点>" [--scope bot|chat|workspace] [--scope-id <chatId或目录>] [--tags "a,b"] [--pin]\`（标题须直接写清核心结论或触发词，便于首轮索引一眼识别）`,
    config.cleanupAndCorrect
      ? `  - 事实纠偏与旧结论替代（优先 \`代码库与文档现状 > 最新用户明确反馈 > 历史旧记忆\`）：\`lark-bridge memory supersede <oldId> --bot ${input.botId} --reason "<纠偏依据>" --type <type> --title "<新标题>" --content "<新结论>"\``
      : '  - 合并重复条目时使用 `lark-bridge memory supersede <oldId> --bot ' + input.botId + ' --reason "合并重复条目"`。',
    `  - 彻底过期或已闭环临时事项归档：\`lark-bridge memory forget <oldId> --bot ${input.botId} --reason "<过期原因>"\``,
    `- 以 \`${currentDateIso}\` 为基准将相对时间（如“昨天”“下周三”）统一转为绝对日期 \`YYYY-MM-DD\`；群聊专属规则用 \`--scope chat --scope-id <chatId>\`，仓库专属规则用 \`--scope workspace --scope-id <目录>\`，禁止在业务目录新建记忆文件。`,
  ]

  const proactiveLines: string[] = []
  if (proactive?.remindersEnabled || proactive?.autoCodeEnabled) {
    proactiveLines.push('### Phase 4 · 主动跟进（按需执行，无确切事项跳过）')
    if (proactive.autoCodeEnabled) {
      proactiveLines.push(
        `- **隔离分支优化**：若发现根因明确且可本地验证的代码缺陷或共识待办，通过 \`lark-bridge worktree create <slug> --prefix "${proactive.branchPrefix}"\` 在 \`${absWorkingDir}/.worktrees/<slug>\` 独立分支完成修改与单测（严禁改动主工作目录 \`${absWorkingDir}\`），并按仓库规范提交分支或 PR/MR。`,
      )
    }
    if (proactive.remindersEnabled) {
      proactiveLines.push(
        `- **登记跟进提醒**：若增量对话存在待闭环承诺，或新建的优化分支需在工作时段提审，先运行 \`lark-bridge reminder list\` 去重，再运行 \`lark-bridge reminder create --bot ${input.botId} --chat <chat_id> --mention <open_id:负责人> [--cc <open_id:关注人>] --title "<标题>" --at "<YYYY-MM-DD HH:mm>" --prompt "<核查或提审指令>"\` 创建单次提醒（群聊必填 \`--mention\` 负责人）。`,
      )
    }
  }

  const dreamSection = [
    `<dream_job agent="${escapeXmlAttr(input.botName)}" bot_id="${escapeXmlAttr(input.botId)}" date="${escapeXmlAttr(currentDateIso)}" sessions="${input.sessionCount}">`,
    '执行离线 **Auto-Dream（跨运行时 Memory 沉淀、核验与双时态纠偏）**：',
    '',
    ...orientationLines,
    '',
    ...gatherLines,
    '',
    ...consolidateLines,
    ...(proactiveLines.length > 0 ? ['', ...proactiveLines] : []),
    '',
    '### 输出要求',
    '- 仅用 3~5 行简体中文总结本次实际调用 `lark-bridge memory` 完成的新增、更新、纠偏与归档要点；若本次增量无值得沉淀的长期记忆，直接说明“无新增长期记忆”。',
    '- 如实汇报工具执行结果，严禁虚报未落盘的记忆更新。',
    '</dream_job>',
  ].join('\n')

  const systemBlock = composeSystemReminder([dreamSection])!
  return [
    systemBlock,
    '',
    '<user_message>',
    `执行 ${currentDateIso} 周期 Dreaming 记忆整理（增量会话 ${input.sessionCount} 个）。`,
    '</user_message>',
  ].join('\n')
}
