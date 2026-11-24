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
  readonly sessionCount: number
  readonly config: BotDreamingConfig
  readonly proactive?: BotProactiveConfig
}

/**
 * Builds the offline Dreaming memory consolidation prompt inside `<system_reminder><dream_job>...`.
 * Never hardcodes or assumes any runtime-specific memory file path; instructs the
 * Agent to invoke its own built-in Memory capability.
 */
export function composeDreamExecutionPrompt(input: DreamExecutionPromptInput): string {
  const { config, currentDateIso, proactive } = input
  const absWorkingDir = expandWorkingDir(input.workingDir) || input.workingDir
  const scopes = config.scopes.map((s) => s.trim()).filter(Boolean)

  const scopeBlock =
    scopes.length > 0
      ? [
          '提炼范围：',
          ...scopes.map((scope, idx) => `${idx + 1}. **${scope}**`),
        ].join('\n')
      : '提炼范围：高价值长期上下文、工程约定与协作偏好。'

  const cleanupBlock = config.cleanupAndCorrect
    ? [
        '### 3. 过期清理与事实纠偏',
        '- 事实优先级：`代码库与文档现状 > 最新用户明确反馈 > 历史旧记忆`。',
        '- 对照最新代码结构与近期提交核查已有记忆：已被推翻的结论、已删除或重构的路径/接口、已解决的临时绕过方案及已闭环待办，立即清理或修正。',
        `- 以 \`${currentDateIso}\` 为基准将相对时间（如“昨天”“下周三”）统一转为 \`YYYY-MM-DD\`，合并重复条目。`,
      ].join('\n')
    : [
        '### 3. 去重与时间归一化',
        `- 以 \`${currentDateIso}\` 为基准将相对时间转为 \`YYYY-MM-DD\`，合并自身记忆中的重复条目。`,
      ].join('\n')

  const proactiveLines: string[] = []
  if (proactive?.remindersEnabled || proactive?.autoCodeEnabled) {
    proactiveLines.push('### 4. 主动跟进（按需执行，无确切事项跳过）')
    if (proactive.autoCodeEnabled) {
      proactiveLines.push(
        `- **隔离分支优化**：若发现根因明确且可本地验证的代码缺陷或共识待办，通过 \`lark-bridge worktree create <slug> --prefix "${proactive.branchPrefix}"\` 在 \`${absWorkingDir}/.worktrees/<slug>\` 独立分支完成修改与单测（严禁改动主工作目录 \`${absWorkingDir}\`），并按仓库规范提交分支或 PR/MR。`,
      )
    }
    if (proactive.remindersEnabled) {
      proactiveLines.push(
        `- **登记跟进提醒**：若增量对话存在待闭环承诺，或新建的优化分支需在工作时段提审，先运行 \`lark-bridge reminder list\` 去重，再运行 \`lark-bridge reminder create --bot ${input.botId} --chat <chat_id> --title "<标题>" --at "<YYYY-MM-DD HH:mm>" --prompt "<核查或提审指令>"\` 创建单次提醒。`,
      )
    }
  }

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

  const dreamSection = [
    `<dream_job agent="${escapeXmlAttr(input.botName)}" date="${escapeXmlAttr(currentDateIso)}" sessions="${input.sessionCount}">`,
    '执行离线 **Dreaming（长期记忆沉淀、清理与纠偏）**：',
    '',
    '### 1. 读取增量上下文',
    `- 读取 ${input.sessionCount} 个增量会话摘要：\`${input.transcriptDigestPath}\`。`,
    inspectDirLine,
    '',
    '### 2. 更新内置 Memory',
    scopeBlock,
    '- 直接调用并维护你自身内置的长期记忆（Memory）机制，仅沉淀值得跨会话保留的隐性认知。',
    '- 工作区文档或源码中已明确记录的静态信息不重复抄入记忆；不在工作区业务目录新建记忆文件。',
    '',
    cleanupBlock,
    ...(proactiveLines.length > 0 ? ['', ...proactiveLines] : []),
    '',
    '### 输出要求',
    '- 仅用 3~5 行简体中文输出本次沉淀、清理与纠偏要点摘要。',
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
