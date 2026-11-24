import { z } from 'zod'
import { expandWorkingDir } from './types.js'

export const MEMORY_MAX_TITLE_CHARS = 100
export const MEMORY_MAX_CONTENT_CHARS = 1200
export const MEMORY_MAX_TAGS = 8
export const MEMORY_LAYER1_MAX_ENTRIES = 20
export const MEMORY_LAYER1_MAX_CHARS = 2600
export const MEMORY_MARKDOWN_MAX_LINES = 200
export const MEMORY_MARKDOWN_MAX_CHARS = 12_000

export const LarkMemoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference'])
export type LarkMemoryType = z.infer<typeof LarkMemoryTypeSchema>

export const LarkMemoryScopeSchema = z.enum(['bot', 'chat', 'workspace'])
export type LarkMemoryScope = z.infer<typeof LarkMemoryScopeSchema>

export const LarkMemoryStatusSchema = z.enum(['active', 'superseded', 'archived'])
export type LarkMemoryStatus = z.infer<typeof LarkMemoryStatusSchema>

export const LarkMemoryConfidenceSchema = z.enum(['high', 'medium'])
export type LarkMemoryConfidence = z.infer<typeof LarkMemoryConfidenceSchema>

export const LarkMemoryEntrySchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  scope: LarkMemoryScopeSchema.default('bot'),
  scopeId: z.string().default(''),
  type: LarkMemoryTypeSchema,
  title: z.string().min(1).max(MEMORY_MAX_TITLE_CHARS),
  content: z.string().min(1).max(MEMORY_MAX_CONTENT_CHARS),
  tags: z.array(z.string().min(1).max(40)).max(MEMORY_MAX_TAGS).default([]),
  confidence: LarkMemoryConfidenceSchema.default('high'),
  pinned: z.boolean().default(false),
  status: LarkMemoryStatusSchema.default('active'),
  sourceSessionId: z.string().optional(),
  supersededBy: z.string().optional(),
  supersededAtMs: z.number().int().nonnegative().optional(),
  supersedeReason: z.string().optional(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  lastVerifiedAtMs: z.number().int().nonnegative(),
  lastRecalledAtMs: z.number().int().nonnegative().optional(),
  recallCount: z.number().int().nonnegative().default(0),
})
export type LarkMemoryEntry = z.infer<typeof LarkMemoryEntrySchema>

export const LarkMemoryMutationStatsSchema = z.object({
  created: z.number().int().nonnegative().default(0),
  updated: z.number().int().nonnegative().default(0),
  superseded: z.number().int().nonnegative().default(0),
  archived: z.number().int().nonnegative().default(0),
})
export type LarkMemoryMutationStats = z.infer<typeof LarkMemoryMutationStatsSchema>

export const MEMORY_TYPE_LABELS: Readonly<Record<LarkMemoryType, string>> = {
  feedback: '纠偏与规范',
  user: '用户偏好',
  project: '项目决策',
  reference: '外部参考',
}

export const MEMORY_SCOPE_LABELS: Readonly<Record<LarkMemoryScope, string>> = {
  bot: '全局',
  chat: '群聊',
  workspace: '工作区',
}

const MEMORY_TYPE_PRIORITY: Readonly<Record<LarkMemoryType, number>> = {
  feedback: 0,
  user: 1,
  project: 2,
  reference: 3,
}

export function normalizeMemoryScopeId(scope: LarkMemoryScope, rawScopeId?: string): string {
  if (scope === 'bot') return ''
  const trimmed = (rawScopeId ?? '').trim()
  if (!trimmed) return ''
  if (scope === 'workspace') {
    const expanded = expandWorkingDir(trimmed) || trimmed
    return expanded.replace(/\/+$/, '') || '/'
  }
  return trimmed
}

export function normalizeMemoryTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function normalizeMemoryTags(rawTags?: readonly string[]): string[] {
  if (!rawTags || rawTags.length === 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const tag of rawTags) {
    const clean = tag.trim().slice(0, 40)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(clean)
    if (result.length >= MEMORY_MAX_TAGS) break
  }
  return result
}

export function formatMemoryDateIso(timestampMs: number): string {
  const d = new Date(timestampMs)
  if (!Number.isFinite(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface MemoryRecallContext {
  readonly botId: string
  readonly chatId?: string
  readonly workingDir?: string
}

export function matchesMemoryContext(
  entry: Pick<LarkMemoryEntry, 'botId' | 'scope' | 'scopeId' | 'status'>,
  context: MemoryRecallContext,
): boolean {
  if (entry.botId !== context.botId || entry.status !== 'active') return false
  if (entry.scope === 'bot') return true
  if (entry.scope === 'chat') {
    return Boolean(context.chatId && entry.scopeId === context.chatId.trim())
  }
  if (entry.scope === 'workspace') {
    if (!context.workingDir) return false
    const normalizedDir = normalizeMemoryScopeId('workspace', context.workingDir)
    return Boolean(normalizedDir && entry.scopeId === normalizedDir)
  }
  return false
}

export function rankMemoryEntriesForContext(
  entries: readonly LarkMemoryEntry[],
  context: MemoryRecallContext,
): LarkMemoryEntry[] {
  return entries
    .filter((entry) => matchesMemoryContext(entry, context))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const typeDiff = MEMORY_TYPE_PRIORITY[a.type] - MEMORY_TYPE_PRIORITY[b.type]
      if (typeDiff !== 0) return typeDiff
      const specificityA = a.scope === 'bot' ? 1 : 0
      const specificityB = b.scope === 'bot' ? 1 : 0
      if (specificityA !== specificityB) return specificityA - specificityB
      if (b.lastVerifiedAtMs !== a.lastVerifiedAtMs) return b.lastVerifiedAtMs - a.lastVerifiedAtMs
      return b.updatedAtMs - a.updatedAtMs
    })
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function singleLineExcerpt(raw: string, maxChars: number): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

export interface BridgeMemoryReminderResult {
  readonly reminder: string
  readonly includedEntryIds: readonly string[]
}

/**
 * Progressive Disclosure Layer 1:
 * Synthesizes a strictly budgeted core memory index for the first turn of a session,
 * leaving full details and historical search to on-demand Layer 2 CLI tools.
 */
export function composeBridgeMemoryReminder(input: {
  readonly botId: string
  readonly entries: readonly LarkMemoryEntry[]
  readonly totalActiveCount?: number
  readonly maxEntries?: number
  readonly maxChars?: number
}): BridgeMemoryReminderResult | undefined {
  const maxEntries = Math.max(1, input.maxEntries ?? MEMORY_LAYER1_MAX_ENTRIES)
  const maxChars = Math.max(400, input.maxChars ?? MEMORY_LAYER1_MAX_CHARS)
  const totalActive = input.totalActiveCount ?? input.entries.length

  const footerLines = [
    '记忆工具（跨运行时持久化，按需调用，不重复抄写源码/文档已有静态信息）：',
    `- 按需检索/详情：\`lark-bridge memory search "<关键词>"\` 或 \`lark-bridge memory get <id>\``,
    `- 沉淀长期认知/纠偏：\`lark-bridge memory upsert --type feedback|user|project|reference --title "<标题>" --content "<精炼事实>" [--scope bot|chat|workspace]\`；事实推翻时用 \`lark-bridge memory supersede <oldId> --reason "<依据>"\``,
  ]

  if (input.entries.length === 0) {
    const emptyBlock = [
      `<bridge_memory bot_id="${escapeXmlAttr(input.botId)}" active_count="${totalActive}">`,
      '当前尚无已沉淀的跨会话长期记忆。仅当用户明确纠偏、给出长期偏好或确立关键隐性决策时写入，避免记录一次性细节。',
      ...footerLines,
      '</bridge_memory>',
    ].join('\n')
    return { reminder: emptyBlock, includedEntryIds: [] }
  }

  const header = `<bridge_memory bot_id="${escapeXmlAttr(input.botId)}" active_count="${totalActive}">`
  const lead =
    '以下为按优先级精选的长期记忆索引（仅作高信号线索，执行代码操作前仍须以当前仓库事实为准）：'
  const footer = [...footerLines, '</bridge_memory>'].join('\n')
  const reservedChars = header.length + lead.length + footer.length + 120
  let remainingChars = Math.max(200, maxChars - reservedChars)

  const bulletLines: string[] = []
  const includedEntryIds: string[] = []

  for (const entry of input.entries.slice(0, maxEntries)) {
    const pinMark = entry.pinned ? '[置顶]' : ''
    const scopeLabel = MEMORY_SCOPE_LABELS[entry.scope]
    const dateLabel = formatMemoryDateIso(entry.lastVerifiedAtMs)
    const excerpt = singleLineExcerpt(entry.content, 110)
    const line = `- [${entry.id}]${pinMark}[${entry.type}][${scopeLabel}][${dateLabel}] ${entry.title}：${excerpt}`
    if (line.length + 1 > remainingChars && bulletLines.length > 0) break
    bulletLines.push(line)
    includedEntryIds.push(entry.id)
    remainingChars -= line.length + 1
  }

  const omittedCount = Math.max(0, totalActive - includedEntryIds.length)
  const omittedLine =
    omittedCount > 0
      ? `（另有 ${omittedCount} 条未展开，可用 \`lark-bridge memory search\` 或 \`lark-bridge memory list\` 按需查询）`
      : ''

  const reminder = [
    header,
    lead,
    ...bulletLines,
    ...(omittedLine ? [omittedLine] : []),
    '',
    footer,
  ].join('\n')

  return { reminder, includedEntryIds }
}

/**
 * Generates a human-auditable, strictly budgeted Markdown projection (`MEMORY.md`)
 * under `$DSH_HOME/lark-bridge/memory/<botId>/MEMORY.md`. SQLite remains the single
 * source of truth; this file is atomically regenerated after memory mutations.
 */
export function renderMemoryMarkdownProjection(input: {
  readonly botId: string
  readonly botName?: string
  readonly entries: readonly LarkMemoryEntry[]
  readonly generatedAtMs?: number
}): string {
  const active = input.entries
    .filter((e) => e.status === 'active')
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const typeDiff = MEMORY_TYPE_PRIORITY[a.type] - MEMORY_TYPE_PRIORITY[b.type]
      if (typeDiff !== 0) return typeDiff
      return b.lastVerifiedAtMs - a.lastVerifiedAtMs
    })

  const updatedIso = formatMemoryDateIso(input.generatedAtMs ?? Date.now())
  const headerName = input.botName?.trim() ? `${input.botName.trim()} (${input.botId})` : input.botId
  const lines: string[] = [
    `# Bridge Memory — ${headerName}`,
    '',
    `> 自动生成的只读镜像（真相源位于 SQLite \`memory_entries\` 表）。更新时间：${updatedIso} · 有效记忆：${active.length} 条。`,
    '',
  ]

  if (active.length === 0) {
    lines.push('（暂无有效长期记忆。可通过 `lark-bridge memory upsert` 或 Dreaming 自动整理写入。）', '')
    return lines.join('\n')
  }

  const orderedTypes: readonly LarkMemoryType[] = ['feedback', 'user', 'project', 'reference']
  let charCount = lines.join('\n').length
  let truncatedCount = 0

  for (const type of orderedTypes) {
    const group = active.filter((e) => e.type === type)
    if (group.length === 0) continue
    const heading = `## ${MEMORY_TYPE_LABELS[type]} (\`${type}\`)`
    if (lines.length + 3 >= MEMORY_MARKDOWN_MAX_LINES || charCount + heading.length > MEMORY_MARKDOWN_MAX_CHARS) {
      truncatedCount += group.length
      continue
    }
    lines.push(heading, '')
    charCount += heading.length + 2

    for (const entry of group) {
      const pinMark = entry.pinned ? ' [置顶]' : ''
      const scopeDesc =
        entry.scope === 'bot'
          ? '全局'
          : `${MEMORY_SCOPE_LABELS[entry.scope]}:${entry.scopeId}`
      const dateStr = formatMemoryDateIso(entry.lastVerifiedAtMs)
      const tagsSuffix = entry.tags.length > 0 ? ` · 标签: ${entry.tags.join(', ')}` : ''
      const body = singleLineExcerpt(entry.content, 240)
      const row = `- **${entry.title}** (\`${entry.id}\`${pinMark} · ${scopeDesc} · ${dateStr}${tagsSuffix})：${body}`

      if (
        lines.length + 3 >= MEMORY_MARKDOWN_MAX_LINES ||
        charCount + row.length + 1 > MEMORY_MARKDOWN_MAX_CHARS
      ) {
        truncatedCount += 1
        continue
      }
      lines.push(row)
      charCount += row.length + 1
    }
    lines.push('')
  }

  if (truncatedCount > 0) {
    lines.push(
      `> 还有 ${truncatedCount} 条记忆因展示预算截断，完整内容请使用 \`lark-bridge memory list --bot ${input.botId}\` 查询。`,
      '',
    )
  }

  return lines.join('\n')
}

const DREAM_WRITE_FAILURE_PATTERNS: readonly RegExp[] = [
  /未暴露可写.{0,12}(?:memory|记忆)/i,
  /无法写入.{0,12}(?:memory|记忆)/i,
  /记忆写入.{0,8}(?:未完成|失败)/i,
  /没有.{0,12}(?:memory|记忆).{0,8}(?:工具|接口|权限)/i,
  /lark-bridge\s*:\s*command not found/i,
  /memory\s+(?:write|api|cli)\s+(?:failed|unavailable)/i,
]

/**
 * Detects explicit runtime/tooling failure messages when a Dreaming pass produced zero
 * Bridge Memory mutations, preventing false-positive `succeeded` status & watermark advancement.
 */
export function detectDreamingMemoryWriteFailure(replyText: string): string | undefined {
  const clean = replyText.replace(/\s+/g, ' ').trim()
  if (!clean) return undefined
  for (const pattern of DREAM_WRITE_FAILURE_PATTERNS) {
    if (pattern.test(clean)) {
      return clean.slice(0, 160)
    }
  }
  return undefined
}
