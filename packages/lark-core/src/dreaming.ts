import { z } from 'zod'
import {
  formatMemoryDateIso,
  MEMORY_SCOPE_LABELS,
  MEMORY_TYPE_LABELS,
  type LarkMemoryEntry,
} from './memory.js'
import { composeSystemReminder } from './router.js'
import { expandWorkingDir, type BotDreamingConfig, type BotProactiveConfig } from './types.js'

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export const LarkDreamProactiveStatsSchema = z.object({
  batchesRun: z.number().int().nonnegative().default(1),
  backlogRemaining: z.number().int().nonnegative().default(0),
  remindersCreated: z.number().int().nonnegative().default(0),
  worktreesCreated: z.number().int().nonnegative().default(0),
  deepConsolidated: z.boolean().default(false),
  openLoopsAudited: z.boolean().default(false),
})
export type LarkDreamProactiveStats = z.infer<typeof LarkDreamProactiveStatsSchema>

export interface ExtractedLarkContextMeta {
  readonly chatType?: 'group' | 'p2p'
  readonly chatId?: string
  readonly chatName?: string
  readonly messageId?: string
  readonly threadId?: string
  readonly quotedMessageId?: string
  readonly senderOpenId?: string
  readonly senderName?: string
  readonly senderType?: string
  readonly trigger?: string
  readonly peerMentions: ReadonlyArray<{ readonly openId: string; readonly name: string }>
}

/**
 * Extracts structured sender/thread/mention metadata from a raw user turn prompt
 * containing `<lark_context ...>` before stripping `<system_reminder>`.
 */
export function extractLarkContextMeta(rawPrompt: string): ExtractedLarkContextMeta {
  if (!rawPrompt) return { peerMentions: [] }
  const tagMatch = /<lark_context\b([^>]*)>([\s\S]*?)<\/lark_context>/i.exec(rawPrompt)
  if (!tagMatch) return { peerMentions: [] }

  const attrStr = tagMatch[1] ?? ''
  const body = tagMatch[2] ?? ''
  const readAttr = (name: string): string | undefined => {
    const re = new RegExp(`\\b${name}="([^"]*)"`, 'i')
    const m = re.exec(attrStr)
    const val = m?.[1] ? unescapeXmlAttr(m[1]).trim() : ''
    return val || undefined
  }

  const peerMentions: Array<{ readonly openId: string; readonly name: string }> = []
  const seenOpenIds = new Set<string>()
  const mentionLineMatch = /提及成员[：:]\s*([^\n]+)/.exec(body)
  if (mentionLineMatch?.[1]) {
    const mentionItemRe = /([^\s、,()（）]+)\(open_id="([^"]+)"\)/g
    for (const m of mentionLineMatch[1].matchAll(mentionItemRe)) {
      const name = (m[1] ?? '').trim()
      const openId = (m[2] ?? '').trim()
      if (!openId || seenOpenIds.has(openId)) continue
      seenOpenIds.add(openId)
      peerMentions.push({ openId, name })
    }
  }

  const chatTypeRaw = readAttr('chat_type')
  const chatType = chatTypeRaw === 'p2p' ? 'p2p' : chatTypeRaw === 'group' ? 'group' : undefined

  const chatId = readAttr('chat_id')
  const chatName = readAttr('chat_name')
  const messageId = readAttr('message_id')
  const threadId = readAttr('thread_id')
  const quotedMessageId = readAttr('quoted_message_id')
  const senderOpenId = readAttr('sender_open_id')
  const senderName = readAttr('sender_name')
  const senderType = readAttr('sender_type')
  const trigger = readAttr('trigger')

  return {
    ...(chatType ? { chatType } : {}),
    ...(chatId ? { chatId } : {}),
    ...(chatName ? { chatName } : {}),
    ...(messageId ? { messageId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(quotedMessageId ? { quotedMessageId } : {}),
    ...(senderOpenId ? { senderOpenId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderType ? { senderType } : {}),
    ...(trigger ? { trigger } : {}),
    peerMentions,
  }
}

/**
 * Truncates a session transcript using head+tail budgeting so both the opening
 * problem statement (~35%) and closing commitments/conclusions (~60%) survive
 * long sessions without losing trailing unfinished work.
 */
export function truncateSessionTranscriptHeadTail(
  lines: readonly string[],
  maxChars: number,
): string {
  const budget = Math.max(400, Math.floor(maxChars))
  const full = lines.join('\n')
  if (full.length <= budget) return full
  if (lines.length === 1) {
    const headLen = Math.floor(budget * 0.35)
    const tailLen = Math.max(100, budget - headLen - 28)
    const only = lines[0]!
    return `${only.slice(0, headLen).trimEnd()}\n…（中间省略）…\n${only.slice(-tailLen).trimStart()}`
  }

  const headBudget = Math.floor(budget * 0.35)
  const tailBudget = Math.max(200, Math.floor(budget * 0.58))

  const headLines: string[] = []
  let headUsed = 0
  let headIdx = 0
  while (headIdx < lines.length) {
    const line = lines[headIdx]!
    const cost = line.length + (headLines.length > 0 ? 1 : 0)
    if (headLines.length > 0 && headUsed + cost > headBudget) break
    if (headLines.length === 0 && line.length > headBudget) {
      headLines.push(`${line.slice(0, Math.max(80, headBudget - 1)).trimEnd()}…`)
      headUsed = headLines[0]!.length
      headIdx += 1
      break
    }
    headLines.push(line)
    headUsed += cost
    headIdx += 1
  }

  const tailLines: string[] = []
  let tailUsed = 0
  let tailIdx = lines.length - 1
  while (tailIdx >= headIdx) {
    const line = lines[tailIdx]!
    const cost = line.length + (tailLines.length > 0 ? 1 : 0)
    if (tailLines.length > 0 && tailUsed + cost > tailBudget) break
    if (tailLines.length === 0 && line.length > tailBudget) {
      tailLines.unshift(`…${line.slice(-Math.max(120, tailBudget - 1)).trimStart()}`)
      tailUsed = tailLines[0]!.length
      tailIdx -= 1
      break
    }
    tailLines.unshift(line)
    tailUsed += cost
    tailIdx -= 1
  }

  const omittedCount = Math.max(0, tailIdx - headIdx + 1)
  if (omittedCount === 0) {
    return [...headLines, ...tailLines].join('\n')
  }
  const marker = `  …（已省略中间 ${omittedCount} 条对话，保留首尾上下文）…`
  return [...headLines, marker, ...tailLines].join('\n')
}

export interface MemoryAuditReportInput {
  readonly botId: string
  readonly botName: string
  readonly entries: readonly LarkMemoryEntry[]
  readonly nowMs: number
  readonly coldDaysThreshold?: number
  readonly staleProjectDaysThreshold?: number
}

/**
 * Deterministically builds a zero-LLM memory health & consolidation audit report
 * highlighting stale entries, zero-recall cold candidates, and overlapping tag clusters.
 */
export function renderMemoryAuditReport(input: MemoryAuditReportInput): string {
  const coldDays = input.coldDaysThreshold ?? 30
  const staleProjectDays = input.staleProjectDaysThreshold ?? 14
  const dayMs = 24 * 60 * 60_000
  const active = input.entries.filter((e) => e.status === 'active')
  const dateStr = formatMemoryDateIso(input.nowMs)

  const coldCandidates: Array<{ entry: LarkMemoryEntry; daysSinceVerified: number }> = []
  const staleVerifyCandidates: Array<{ entry: LarkMemoryEntry; daysSinceVerified: number }> = []

  for (const entry of active) {
    const daysSinceVerified = Math.max(0, Math.floor((input.nowMs - entry.lastVerifiedAtMs) / dayMs))
    if (!entry.pinned && entry.recallCount === 0 && daysSinceVerified >= coldDays) {
      coldCandidates.push({ entry, daysSinceVerified })
    }
    if (
      daysSinceVerified >= staleProjectDays &&
      (entry.type === 'project' || entry.type === 'reference' || entry.type === 'feedback')
    ) {
      staleVerifyCandidates.push({ entry, daysSinceVerified })
    }
  }

  coldCandidates.sort((a, b) => b.daysSinceVerified - a.daysSinceVerified)
  staleVerifyCandidates.sort((a, b) => b.daysSinceVerified - a.daysSinceVerified)

  // Detect candidate duplicate/fragment clusters by shared normalized tags (zero LLM cost).
  const byTag = new Map<string, LarkMemoryEntry[]>()
  for (const entry of active) {
    for (const rawTag of entry.tags) {
      const key = rawTag.trim().toLowerCase()
      if (key.length < 2) continue
      let list = byTag.get(key)
      if (!list) {
        list = []
        byTag.set(key, list)
      }
      list.push(entry)
    }
  }
  const overlappingClusters = [...byTag.entries()]
    .filter(([, list]) => list.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)

  const lines: string[] = [
    `# Memory Health & Consolidation Audit (${dateStr})`,
    '',
    `- 智能体：${input.botName} (\`${input.botId}\`)`,
    `- 当前有效记忆：${active.length} 条（置顶 ${active.filter((e) => e.pinned).length} 条）`,
    '',
    '## 1. 待代码库/现状验真条目（距上次核验较久）',
  ]

  if (staleVerifyCandidates.length === 0) {
    lines.push('- 暂无超期未核验条目。')
  } else {
    for (const { entry, daysSinceVerified } of staleVerifyCandidates.slice(0, 20)) {
      const scopeLabel =
        entry.scope === 'bot' ? '全局' : `${MEMORY_SCOPE_LABELS[entry.scope]}:${entry.scopeId}`
      lines.push(
        `- \`${entry.id}\` [${MEMORY_TYPE_LABELS[entry.type]} · ${scopeLabel}] **${entry.title}**（${daysSinceVerified} 天未核验，累计召回 ${entry.recallCount} 次）`,
      )
    }
  }

  lines.push('', `## 2. 冷记忆治理候选（未置顶、累计 0 次召回且 ≥ ${coldDays} 天未核验）`)
  if (coldCandidates.length === 0) {
    lines.push('- 暂无长期零召回冷记忆。')
  } else {
    for (const { entry, daysSinceVerified } of coldCandidates.slice(0, 15)) {
      const tagsText = entry.tags.length > 0 ? ` · 标签: ${entry.tags.join(', ')}` : ' · 无标签'
      lines.push(
        `- \`${entry.id}\` [${entry.type}] **${entry.title}**（${daysSinceVerified} 天未核验${tagsText}）`,
      )
    }
  }

  lines.push('', '## 3. 高重叠标签簇（可检查是否存在碎片重复可合并）')
  if (overlappingClusters.length === 0) {
    lines.push('- 暂无显著碎片聚集簇。')
  } else {
    for (const [tag, list] of overlappingClusters) {
      const items = list
        .slice(0, 6)
        .map((e) => `\`${e.id}\` ${e.title}`)
        .join(' / ')
      lines.push(`- \`#${tag}\`（${list.length} 条）：${items}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

function normalizeActiveDirs(workingDir: string, activeWorkingDirs?: readonly string[]): string[] {
  const dirs = Array.from(
    new Set(
      (activeWorkingDirs ?? [])
        .map((d) => expandWorkingDir(d) || d.trim())
        .filter(Boolean),
    ),
  )
  if (dirs.length > 0) return dirs
  const abs = expandWorkingDir(workingDir) || workingDir
  return abs ? [abs] : []
}

function buildInspectDirLine(workingDir: string, activeWorkingDirs?: readonly string[]): string {
  const activeDirs = normalizeActiveDirs(workingDir, activeWorkingDirs)
  if (activeDirs.length > 1 || (activeWorkingDirs && activeWorkingDirs.length > 0)) {
    return `- 仅定向只读巡检本次增量会话涉及的工作目录（${activeDirs.map((d) => `\`${d}\``).join('、')}）近期变更（如 \`git status -s\`、\`git log -n 20 --oneline\`）与核心文档，勿盲目遍历无关仓库。`
  }
  const absWorkingDir = expandWorkingDir(workingDir) || workingDir
  return `- 只读巡检工作目录 \`${absWorkingDir}\` 近期变更（如 \`git status -s\`、\`git log -n 20 --oneline\`）与核心文档。`
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
  readonly batchIndex?: number
  readonly totalBatches?: number
  /** When true, Stage 2/3 run as dedicated follow-up turns; Stage 1 focuses strictly on Memory + open-loop note extraction. */
  readonly stagedMode?: boolean
}

/**
 * Stage 1 (or single-pass fallback) Auto-Dream prompt:
 * Ingests the current batch of denoised head+tail transcripts (with speaker open_ids & thread IDs),
 * consolidates runtime-agnostic Memory via `lark-bridge memory`, and surfaces open-loop clues.
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

  const inspectDirLine = buildInspectDirLine(input.workingDir, input.activeWorkingDirs)
  const batchSuffix =
    input.batchIndex !== undefined && input.totalBatches !== undefined && input.totalBatches > 1
      ? `（第 ${input.batchIndex}/${input.totalBatches} 批）`
      : ''

  const orientationLines = [
    '### Phase 1 · 摸底现有记忆（Orientation）',
    ...(input.memoryMarkdownPath
      ? [`- 读取当前 Memory 只读镜像：\`${input.memoryMarkdownPath}\`（当前有效 ${input.activeMemoryCount ?? 0} 条）。`]
      : []),
    `- 按需运行 \`lark-bridge memory list --bot ${input.botId} --status active\` 查看完整有效条目与 ID，避免重复写入。`,
  ]

  const gatherLines = [
    `### Phase 2 · 采信增量信号（Gather Signal）${batchSuffix}`,
    `- 读取 ${input.sessionCount} 个有效增量会话摘要：\`${input.transcriptDigestPath}\`（已保留首尾对话、发言人 \`open_id\`、话题 \`thread_reply_to\` 与中断状态）。`,
    inspectDirLine,
    '- 严禁抄录代码仓文档（如 `README.md` / `AGENTS.md`）或源码中已清晰存在的静态事实；仅关注跨会话复用的隐性认知、纠偏、决策依据、反复踩坑排障套路（SOP）与外部指针。',
  ]

  const consolidateLines = [
    '### Phase 3 · 沉淀、合并与双时态纠偏（Consolidate & Supersede）',
    scopeBlock,
    '- 使用运行时无关的 Memory CLI 持久化写入（4 类语义分类：`feedback` 纠偏/防踩坑规则/可复用 SOP、`user` 用户/团队偏好、`project` 项目决策与背景、`reference` 外部系统/文档指针）：',
    `  - 新增或幂等更新：\`lark-bridge memory upsert --bot ${input.botId} --type <feedback|user|project|reference> --title "<自包含触发标题(≤35字)>" --content "<事实要点>" [--scope bot|chat|workspace] [--scope-id <chatId或目录>] [--tags "a,b"] [--pin]\`（标题须直接写清核心结论或触发词；可复用排障流程请加 \`sop\` 标签）`,
    config.cleanupAndCorrect
      ? `  - 事实纠偏与旧结论替代（优先 \`代码库与文档现状 > 最新用户明确反馈 > 历史旧记忆\`）：\`lark-bridge memory supersede <oldId> --bot ${input.botId} --reason "<纠偏依据>" --type <type> --title "<新标题>" --content "<新结论>"\``
      : '  - 合并重复条目时使用 `lark-bridge memory supersede <oldId> --bot ' + input.botId + ' --reason "合并重复条目"`。',
    `  - 彻底过期或已闭环临时事项归档：\`lark-bridge memory forget <oldId> --bot ${input.botId} --reason "<过期原因>"\``,
    `- 以 \`${currentDateIso}\` 为基准将相对时间（如“昨天”“下周三”）统一转为绝对日期 \`YYYY-MM-DD\`；群聊专属规则用 \`--scope chat --scope-id <chatId>\`，仓库专属规则用 \`--scope workspace --scope-id <目录>\`，禁止在业务目录新建记忆文件。`,
  ]

  const proactiveLines: string[] = []
  if (input.stagedMode) {
    proactiveLines.push(
      '### 潜在未完事项记录（供后续前瞻盘点阶段使用，本批先不建提醒）',
      '- 若本批会话中存在“明确待做承诺、待验证项、异常中断未收口或遗留代码缺陷”，请在输出末尾单列 `未闭环线索：` 1~3 条（保留 `chat_id`、`thread_reply_to`、负责人姓名与 `open_id` 及一句话事项说明），留待后续前瞻盘点阶段统一验真去重并创建提醒。',
    )
  } else if (proactive?.remindersEnabled || proactive?.autoCodeEnabled) {
    const maxReminders = config.maxRemindersPerRun
    proactiveLines.push('### Phase 4 · 主动跟进（按需执行，无确切事项跳过）')
    if (proactive.autoCodeEnabled) {
      proactiveLines.push(
        `- **隔离分支优化**：若发现根因明确且可本地验证的代码缺陷或共识待办，通过 \`lark-bridge worktree create <slug> --prefix "${proactive.branchPrefix}"\` 在 \`${absWorkingDir}/.worktrees/<slug>\` 独立分支完成修改与单测（严禁改动主工作目录 \`${absWorkingDir}\`），并按仓库规范提交分支或 PR/MR。`,
      )
    }
    if (proactive.remindersEnabled && maxReminders > 0) {
      proactiveLines.push(
        `- **登记跟进提醒（单次上限 ${maxReminders} 条）**：若增量对话存在待闭环承诺，或新建的优化分支需在工作时段提审，先运行 \`lark-bridge reminder list\` 去重，再运行 \`lark-bridge reminder create --bot ${input.botId} --chat <chat_id> [--reply-to <thread_reply_to>] --mention <open_id:负责人> [--cc <open_id:关注人>] --title "<标题>" --at "<YYYY-MM-DD HH:mm>" --prompt "<核查或提审指令>"\` 创建单次提醒（群聊必填 \`--mention\` 负责人）。`,
      )
    }
  }

  const dreamSection = [
    `<dream_job agent="${escapeXmlAttr(input.botName)}" bot_id="${escapeXmlAttr(input.botId)}" date="${escapeXmlAttr(currentDateIso)}" sessions="${input.sessionCount}" stage="ingest">`,
    `执行离线 **Auto-Dream 阶段一：增量会话提炼与记忆沉淀${batchSuffix}**：`,
    '',
    ...orientationLines,
    '',
    ...gatherLines,
    '',
    ...consolidateLines,
    ...(proactiveLines.length > 0 ? ['', ...proactiveLines] : []),
    '',
    '### 输出要求',
    '- 用 3~5 行简体中文总结本次实际调用 `lark-bridge memory` 完成的新增、更新、纠偏与归档要点；若本次增量无值得沉淀的长期记忆，直接说明“无新增长期记忆”。',
    ...(input.stagedMode
      ? ['- 若发现潜在未闭环事项，另附 `未闭环线索：` 列表（无则省略）。']
      : []),
    '- 如实汇报工具执行结果，严禁虚报未落盘的记忆更新。',
    '</dream_job>',
  ].join('\n')

  const systemBlock = composeSystemReminder([dreamSection])!
  return [
    systemBlock,
    '',
    '<user_message>',
    `执行 ${currentDateIso} 周期 Dreaming 记忆整理${batchSuffix}（增量会话 ${input.sessionCount} 个）。`,
    '</user_message>',
  ].join('\n')
}

export interface DreamDeepConsolidationPromptInput {
  readonly botId: string
  readonly botName: string
  readonly workingDir: string
  readonly activeWorkingDirs?: readonly string[]
  readonly currentDateIso: string
  readonly memoryMarkdownPath?: string
  readonly memoryAuditPath: string
  readonly stage1NotesPath?: string
  readonly activeMemoryCount: number
  readonly config: BotDreamingConfig
}

/**
 * Stage 2 (Deep Sleep / Memory Rethink):
 * Full-library codebase verification, cold-memory curation, duplicate/fragment merging,
 * and cross-session procedural SOP synthesis.
 */
export function composeDreamDeepConsolidationPrompt(
  input: DreamDeepConsolidationPromptInput,
): string {
  const inspectDirLine = buildInspectDirLine(input.workingDir, input.activeWorkingDirs)
  const dreamSection = [
    `<dream_job agent="${escapeXmlAttr(input.botName)}" bot_id="${escapeXmlAttr(input.botId)}" date="${escapeXmlAttr(input.currentDateIso)}" stage="deep_consolidate">`,
    '执行离线 **Auto-Dream 阶段二：深度睡眠（全库代码验真、跨会话 SOP 提炼与记忆代谢）**：',
    '',
    '### 1. 读取体检报告与现有记忆',
    ...(input.memoryMarkdownPath
      ? [`- 读取当前 Memory 镜像：\`${input.memoryMarkdownPath}\`（有效 ${input.activeMemoryCount} 条）。`]
      : []),
    `- 读取记忆健康体检报告：\`${input.memoryAuditPath}\`（已标出久未核验条目、长期零召回冷记忆与标签高重叠簇）。`,
    ...(input.stage1NotesPath
      ? [`- 结合阶段一全批次摘要记录：\`${input.stage1NotesPath}\`。`]
      : []),
    '',
    '### 2. 代码库真值验真（防 Memory Rot）',
    inspectDirLine,
    '- 对体检报告中涉及文件路径、配置项、接口行为或架构结论的存量记忆逐项核对真实代码与近期 `git log`：',
    input.config.cleanupAndCorrect
      ? `  - 已被最新代码推翻或过时：立即用 \`lark-bridge memory supersede <oldId> --bot ${input.botId} --reason "<代码事实依据>" ...\` 双时态替换，或对彻底失效条目用 \`lark-bridge memory forget <oldId> --bot ${input.botId} --reason "<原因>"\` 归档。`
      : '  - 发现事实明显失效或冲突时，谨慎合并重复条目或补充纠偏说明。',
    '- 若某条记忆已核验仍然准确，无需重复写入（避免无意义刷写）。',
    '',
    '### 3. 碎片合并、冷记忆治理与程序性 SOP 提炼',
    '- **碎片合并**：检查高重叠标签簇，将同一主题的零散多条记忆整合为一条高密度、结构清晰的权威记忆，旧条目以 `supersede` 退场。',
    '- **冷记忆治理**：审视长期 0 次召回的冷条目——若确实过时则 `forget` 归档；若仍有长期价值但标题/标签太泛导致白天检索命中不了，调用 `lark-bridge memory upsert` 重写自包含触发标题并补齐精准 `--tags`（中英文核心关键词）。',
    '- **程序性 SOP 沉淀**：若多轮会话反复出现同类排障套路、发布检查清单或高频踩坑处置流程，提炼成结构化 SOP（`--type feedback --tags "sop,<领域>"`，写明“触发症状 → 核查步骤 → 根治原则”）。',
    '',
    '### 输出要求',
    '- 用 3~5 行简体中文汇报本次深度验真、合并/归档、冷记忆优化与 SOP 沉淀结果；若全库健康无需变更，直接说明“全库核验健康，无需额外变更”。',
    '</dream_job>',
  ].join('\n')

  const systemBlock = composeSystemReminder([dreamSection])!
  return [
    systemBlock,
    '',
    '<user_message>',
    `执行 ${input.currentDateIso} 周期 Dreaming 阶段二：存量记忆代码验真、冷记忆治理与 SOP 反思。`,
    '</user_message>',
  ].join('\n')
}

export interface DreamProactiveAuditPromptInput {
  readonly botId: string
  readonly botName: string
  readonly workingDir: string
  readonly activeWorkingDirs?: readonly string[]
  readonly currentDateIso: string
  readonly nextWorkdayMorningIso: string
  readonly openLoopsSnapshotPath: string
  readonly stage1NotesPath?: string
  readonly transcriptDigestPath?: string
  readonly config: BotDreamingConfig
  readonly proactive: BotProactiveConfig
}

/**
 * Stage 3 & 4 (Prospective Sleep & Overnight Preparation):
 * Audits real unfinished work against live git/worktree/reminder state, schedules
 * deduplicated daytime follow-up reminders (strictly capped), and optionally prepares
 * isolated `.worktrees/` fixes for clear, locally-verifiable defects.
 */
export function composeDreamProactivePrompt(input: DreamProactiveAuditPromptInput): string {
  const { config, proactive, currentDateIso, nextWorkdayMorningIso } = input
  const absWorkingDir = expandWorkingDir(input.workingDir) || input.workingDir
  const inspectDirLine = buildInspectDirLine(input.workingDir, input.activeWorkingDirs)
  const canRemind = proactive.remindersEnabled && config.maxRemindersPerRun > 0
  const canAutoCode = proactive.autoCodeEnabled

  const sections: string[] = [
    `<dream_job agent="${escapeXmlAttr(input.botName)}" bot_id="${escapeXmlAttr(input.botId)}" date="${escapeXmlAttr(currentDateIso)}" stage="proactive_audit" max_reminders="${config.maxRemindersPerRun}">`,
    '执行离线 **Auto-Dream 阶段三：前瞻记忆盘点（未完成事项核查、主动提醒与夜间隔离预备）**：',
    '',
    '### 1. 读取运行现场快照与增量线索',
    `- 读取实时运行快照：\`${input.openLoopsSnapshotPath}\`（含现有活跃提醒、近期失败提醒、未合入 \`.worktrees/\` 与脏分支、近期异常/中断会话）。`,
    ...(input.stage1NotesPath
      ? [`- 读取阶段一汇集的未闭环线索与增量摘要：\`${input.stage1NotesPath}\`。`]
      : []),
    ...(input.transcriptDigestPath
      ? [`- 必要时回查最近批次会话摘要（含发言人 \`open_id\` 与话题 \`thread_reply_to\`）：\`${input.transcriptDigestPath}\`。`]
      : []),
    '',
    '### 2. 真值二次核验（宁缺毋滥，绝不造假提醒）',
    inspectDirLine,
    '- 对每一条候选“没干完的活”（用户明确待做/待验承诺、异常中断未恢复任务、久未合入的 worktree/PR、未闭环的明确缺陷）必须**先对照当前代码库、Git 提交历史与已有活跃提醒核实**：',
    '  - 若已通过后续提交/PR 合入完成，或已有同类活跃提醒覆盖 → **直接跳过，禁止重复建单**；',
    '  - 若只是泛泛讨论、头脑风暴、无明确责任人或无清晰验收锚点 → **直接跳过，禁止骚扰群聊**。',
  ]

  if (canAutoCode) {
    sections.push(
      '',
      '### 3. 夜间隔离分支预修复（可选，仅限明确小缺陷）',
      `- 仅当发现**根因 100% 明确、改动边界清晰、且可在本地跑通构建与测试门禁**的遗留缺陷或已达成共识的小改造时，才执行隔离预修复：`,
      `  - 使用 \`lark-bridge worktree create <slug> --prefix "${proactive.branchPrefix}" --cwd <仓库目录>\` 创建隔离分支（**严禁直接修改主工作目录 \`${absWorkingDir}\` 或合入 main**）；`,
      '  - 在隔离 worktree 内完成修改并跑通对应仓库的构建、类型检查、单元测试与隐私检查；',
      '  - 验证全部通过后提交分支（按仓库规范可发起 Draft/常规 PR），并进入下方提醒步骤创建一条白天工作时段的提审提醒（携带 `--worktree <路径> --branch <分支> [--pr <链接>]`）；若测试不通过或发现范围扩大，及时放弃并在结论中如实说明。',
    )
  }

  if (canRemind) {
    sections.push(
      '',
      `### ${canAutoCode ? '4' : '3'}. 创建白天跟进提醒（硬上限：本次最多 ${config.maxRemindersPerRun} 条）`,
      `- 先运行 \`lark-bridge reminder list --status active\` 再次确认无重复提醒。`,
      `- 若缺少群成员 \`open_id\`，先运行 \`lark-bridge members --bot ${input.botId} --chat <chat_id> --query <姓名>\` 查询真实 \`open_id\`（严禁编造）。`,
      `- 创建命令：\`lark-bridge reminder create --bot ${input.botId} --chat <chat_id> [--reply-to <thread_reply_to>] --mention <open_id:负责人> [--cc <open_id:关注人>] --title "<简洁事项标题>" --at "${nextWorkdayMorningIso}" --reason "<未闭环依据>" --prompt "<到点后要核查的具体状态、判断条件与汇报要点>" [--worktree <路径> --branch <分支> [--pr <链接>]]\``,
      '- 时间与礼仪约定：',
      `  - 触发时间默认安排在${proactive.skipWeekends ? '工作日' : ''}白天工作时段（参考基准 \`${nextWorkdayMorningIso}\`，多条提醒请错开 15~30 分钟避免同时轰炸）；系统也会自动对凌晨时段${proactive.skipWeekends ? '与周末' : ''}执行免打扰顺延；`,
      '  - 群聊提醒优先带 `--reply-to <thread_reply_to>` 回到原话题内跟进，且必填 `--mention <open_id:姓名>`；私聊任务使用 `--user <open_id>`；',
      `  - 系统会在代码层硬拦截超过 ${config.maxRemindersPerRun} 条的新增请求，请只挑真正重要、未闭环、可验收的事项建单。`,
    )
  }

  sections.push(
    '',
    '### 输出要求',
    '- 用 3~5 行简体中文总结：核查了哪些候选未完事项、哪些经代码验真已完结跳过、实际创建了几条提醒（含标题与触发时间）及是否产出隔离分支；若无确切未闭环事项，直接说明“未发现需要新增跟进提醒的未闭环事项”。',
    '</dream_job>',
  )

  const systemBlock = composeSystemReminder([sections.join('\n')])!
  return [
    systemBlock,
    '',
    '<user_message>',
    `执行 ${currentDateIso} 周期 Dreaming 阶段三：盘点未闭环事项并按需创建白天跟进提醒。`,
    '</user_message>',
  ].join('\n')
}
