import { z } from 'zod'
import { expandWorkingDir } from './types.js'

export const MEMORY_MAX_TITLE_CHARS = 100
export const MEMORY_MAX_CONTENT_CHARS = 1200
export const MEMORY_MAX_TAGS = 8
export const MEMORY_LAYER1_MAX_ENTRIES = 15
export const MEMORY_LAYER1_MAX_CHARS = 1000
export const MEMORY_LAYER1_MAX_EXPANDED = 2
export const MEMORY_LAYER1_EXPANDED_EXCERPT_CHARS = 180
export const MEMORY_LAYER1_MIN_QUERY_SCORE = 4
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

const ASCII_QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way',
  'who', 'did', 'get', 'let', 'put', 'say', 'she', 'too', 'use', 'add', 'fix', 'run', 'set',
  'try', 'is', 'to', 'in', 'on', 'at', 'of', 'or', 'an', 'do', 'go', 'no', 'ok', 'hi', 'my',
  'we', 'it', 'by', 'as', 'be', 'if', 'so', 'up', 'me', 'he', 'this', 'that', 'with', 'from',
  'have', 'will', 'what', 'when', 'where', 'which', 'there', 'their', 'about', 'would', 'could',
  'should', 'please', 'help', 'check', 'look', 'just', 'like', 'some', 'more', 'also', 'then',
  'than', 'into', 'only', 'make', 'need', 'want', 'know', 'good', 'well', 'here', 'true',
  'false', 'null', 'void', 'http', 'https', 'www', 'com', 'org', 'net', 'src', 'dist', 'mjs',
  'cjs', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'md', 'ts', 'js',
])

const CJK_QUERY_STOP_PHRASES_RE =
  /请问|麻烦|帮我|帮忙|看一下|看下|看看|查一下|查下|问一下|问下|为什么|怎么样|怎么|如何|什么|哪些|哪里|是否|能否|能不能|可以|需要|应该|必须|现在|目前|今天|昨天|明天|已经|还没|没有|不是|还是|或者|以及|关于|针对|进行|处理|问题|情况|东西|时候|如果|因为|所以|但是|然后|就是|一个|一下|一些|这个|那个|这些|那些|我们|你们|他们|自己|大家|觉得|确认|好的|谢谢/g

const CJK_QUERY_STOP_CHARS_RE =
  /[的了吗呢啊吧呀哦嗯嘛么着过在是有和与或也都就再很太真把被给让对向从到为以之不没会要能可请看问说做用来去上下中里这那我你他她它]/g

export interface MemoryQueryTerms {
  readonly asciiTokens: readonly string[]
  readonly cjkBigrams: readonly string[]
  readonly normalizedQuery: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesAsciiTerm(haystackLower: string, tokenLower: string): boolean {
  if (!tokenLower) return false
  if (tokenLower.length >= 5) {
    return haystackLower.includes(tokenLower)
  }
  const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(tokenLower)}(?![a-z0-9])`)
  return re.test(haystackLower)
}

/**
 * Extracts normalized ASCII domain tokens and CJK bigrams from a natural-language
 * user turn for millisecond-level, zero-LLM query-aware memory relevance scoring.
 */
export function extractMemoryQueryTerms(rawQuery?: string): MemoryQueryTerms {
  const sample = (rawQuery ?? '').trim().slice(0, 400)
  if (!sample) {
    return { asciiTokens: [], cjkBigrams: [], normalizedQuery: '' }
  }
  const normalizedQuery = sample.toLowerCase()

  const asciiSeen = new Set<string>()
  const asciiTokens: string[] = []
  const asciiMatches = normalizedQuery.match(/[a-z0-9]{2,32}/g) ?? []
  for (const clean of asciiMatches) {
    if (/^\d{1,2}$/.test(clean)) continue
    if (ASCII_QUERY_STOPWORDS.has(clean)) continue
    if (asciiSeen.has(clean)) continue
    asciiSeen.add(clean)
    asciiTokens.push(clean)
    if (asciiTokens.length >= 16) break
  }

  const cjkCleaned = sample
    .replace(CJK_QUERY_STOP_PHRASES_RE, ' ')
    .replace(CJK_QUERY_STOP_CHARS_RE, ' ')
  const cjkRuns = cjkCleaned.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  const cjkSeen = new Set<string>()
  const cjkBigrams: string[] = []
  for (const run of cjkRuns) {
    for (let i = 0; i <= run.length - 2; i += 1) {
      const gram = run.slice(i, i + 2)
      if (cjkSeen.has(gram)) continue
      cjkSeen.add(gram)
      cjkBigrams.push(gram)
      if (cjkBigrams.length >= 24) break
    }
    if (cjkBigrams.length >= 24) break
  }

  return { asciiTokens, cjkBigrams, normalizedQuery }
}

/**
 * Computes a lightweight lexical + tag relevance score for an active memory entry
 * against the user's first-turn message. Short ASCII tokens use identifier-boundary
 * matching to avoid false positives (e.g. `pr` vs `prompt`, `ui` vs `build`).
 */
export function scoreMemoryEntryForQuery(
  entry: Pick<LarkMemoryEntry, 'title' | 'content' | 'tags'>,
  terms: MemoryQueryTerms,
): number {
  if (terms.asciiTokens.length === 0 && terms.cjkBigrams.length === 0) return 0

  const titleLower = entry.title.toLowerCase()
  const contentLower = entry.content.toLowerCase()
  let score = 0

  for (const rawTag of entry.tags) {
    const tag = rawTag.trim().toLowerCase()
    if (tag.length < 2) continue
    const hasCjk = /[\u4e00-\u9fff]/.test(tag)
    const matched = hasCjk
      ? terms.normalizedQuery.includes(tag)
      : matchesAsciiTerm(terms.normalizedQuery, tag)
    if (matched) score += 5
  }

  for (const token of terms.asciiTokens) {
    if (matchesAsciiTerm(titleLower, token)) {
      score += 4
    } else if (matchesAsciiTerm(contentLower, token)) {
      score += 2
    }
  }

  for (const gram of terms.cjkBigrams) {
    if (titleLower.includes(gram)) {
      score += 2
    } else if (contentLower.includes(gram)) {
      score += 1
    }
  }

  return score
}

/**
 * Selects top query-relevant memories above `minScore` from an already scope-filtered
 * and priority-ranked candidate list, preserving priority order on score ties.
 */
export function selectQueryMatchedMemories(
  entries: readonly LarkMemoryEntry[],
  queryText?: string,
  options: { readonly limit?: number; readonly minScore?: number } = {},
): LarkMemoryEntry[] {
  const limit = Math.max(0, options.limit ?? MEMORY_LAYER1_MAX_EXPANDED)
  if (limit === 0 || entries.length === 0) return []
  const terms = extractMemoryQueryTerms(queryText)
  if (terms.asciiTokens.length === 0 && terms.cjkBigrams.length === 0) return []

  const minScore = options.minScore ?? MEMORY_LAYER1_MIN_QUERY_SCORE
  const scored: Array<{ readonly entry: LarkMemoryEntry; readonly score: number; readonly rank: number }> = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    const score = scoreMemoryEntryForQuery(entry, terms)
    if (score >= minScore) {
      scored.push({ entry, score, rank: i })
    }
  }

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.rank - b.rank))
  return scored.slice(0, limit).map((item) => item.entry)
}

export interface MemoryReminderResult {
  readonly reminder: string
  readonly includedEntryIds: readonly string[]
  readonly expandedEntryIds: readonly string[]
}

function formatMemoryIndexLine(entry: LarkMemoryEntry): string {
  const pinMark = entry.pinned ? '[置顶]' : ''
  return `- [${entry.id}]${pinMark} ${entry.type}: ${entry.title}`
}

function formatMemoryExpandedLine(entry: LarkMemoryEntry): string {
  const pinMark = entry.pinned ? '[置顶]' : ''
  const excerpt = singleLineExcerpt(entry.content, MEMORY_LAYER1_EXPANDED_EXCERPT_CHARS)
  return `- [${entry.id}]${pinMark} ${entry.type}: ${entry.title} — ${excerpt}`
}

/**
 * Progressive Disclosure Layer 1:
 * Synthesizes a compact `<memory>` block for the first turn of a session:
 * - Default: Title-Only index + `MEMORY.md` file pointer (full CLI syntax lives in the `lark-bridge` skill).
 * - Query-Aware: Expands top query-relevant entries inline (up to `maxExpanded`) without starving
 *   high-priority title anchors, keeping total size strictly budgeted.
 */
export function composeMemoryReminder(input: {
  readonly botId: string
  readonly entries: readonly LarkMemoryEntry[]
  readonly totalActiveCount?: number
  readonly queryText?: string
  readonly markdownPath?: string
  readonly maxEntries?: number
  readonly maxChars?: number
  readonly maxExpanded?: number
}): MemoryReminderResult | undefined {
  const maxEntries = Math.max(1, input.maxEntries ?? MEMORY_LAYER1_MAX_ENTRIES)
  const maxChars = Math.max(320, input.maxChars ?? MEMORY_LAYER1_MAX_CHARS)
  const maxExpanded = Math.max(0, input.maxExpanded ?? MEMORY_LAYER1_MAX_EXPANDED)
  const totalActive = input.totalActiveCount ?? input.entries.length
  const cleanFilePath = input.markdownPath?.trim()
  const fileAttr = cleanFilePath ? ` file="${escapeXmlAttr(cleanFilePath)}"` : ''
  const header = `<memory bot_id="${escapeXmlAttr(input.botId)}" active="${totalActive}"${fileAttr}>`

  if (input.entries.length === 0) {
    const emptyBlock = [
      header,
      '尚无长期记忆；收到明确纠偏、长期偏好或关键隐性决策时用 `lark-bridge memory upsert` 沉淀（参数见 `lark-bridge` 技能）。',
      '</memory>',
    ].join('\n')
    return { reminder: emptyBlock, includedEntryIds: [], expandedEntryIds: [] }
  }

  const expandedCandidates = selectQueryMatchedMemories(input.entries, input.queryText, {
    limit: Math.min(maxExpanded, maxEntries),
  })
  const expandedCandidateIds = new Set(expandedCandidates.map((e) => e.id))
  const indexCandidates = input.entries.filter((e) => !expandedCandidateIds.has(e.id))

  const detailHint = cleanFilePath
    ? '用 `lark-bridge memory get <id>` 或读上表文件查全文'
    : '用 `lark-bridge memory get <id>` 查全文'
  const indexOnlyLead = `长期记忆索引（遇相关话题${detailHint}；执行代码操作前以仓库现状为准，读写见 \`lark-bridge\` 技能）：`
  const expandedLead = '相关记忆（命中当前话题，执行代码操作前仍以仓库现状为准）：'
  const remainingLead = `其余记忆目录（遇相关话题${detailHint}；读写见 \`lark-bridge\` 技能）：`
  const allExpandedFooter = `（${detailHint}；读写见 \`lark-bridge\` 技能）`

  const hasExpandedCandidates = expandedCandidates.length > 0
  const hasIndexCandidates = indexCandidates.length > 0
  const staticOverhead =
    header.length +
    '</memory>'.length +
    (hasExpandedCandidates
      ? expandedLead.length + (hasIndexCandidates ? remainingLead.length : allExpandedFooter.length)
      : indexOnlyLead.length) +
    64
  let remainingChars = Math.max(160, maxChars - staticOverhead)

  // Reserve a modest floor for high-priority title anchors so expanded hits never crowd out
  // pinned / feedback rules when other entries exist.
  const indexReserveChars = hasExpandedCandidates && hasIndexCandidates
    ? Math.min(240, Math.floor(remainingChars * 0.35))
    : 0
  let expandedBudget = Math.max(0, remainingChars - indexReserveChars)

  const expandedLines: string[] = []
  const expandedEntryIds: string[] = []
  const demotedToIndex: LarkMemoryEntry[] = []

  for (const entry of expandedCandidates) {
    const line = formatMemoryExpandedLine(entry)
    if (line.length + 1 <= expandedBudget) {
      expandedLines.push(line)
      expandedEntryIds.push(entry.id)
      expandedBudget -= line.length + 1
      remainingChars -= line.length + 1
    } else {
      demotedToIndex.push(entry)
    }
  }

  const indexPool = [...demotedToIndex, ...indexCandidates]
  const indexLines: string[] = []
  const indexEntryIds: string[] = []
  const maxIndexSlots = Math.max(0, maxEntries - expandedEntryIds.length)

  for (const entry of indexPool.slice(0, maxIndexSlots)) {
    const line = formatMemoryIndexLine(entry)
    const hasAnyEntry = expandedLines.length > 0 || indexLines.length > 0
    if (line.length + 1 > remainingChars && hasAnyEntry) break
    indexLines.push(line)
    indexEntryIds.push(entry.id)
    remainingChars -= line.length + 1
  }

  const includedEntryIds = [...expandedEntryIds, ...indexEntryIds]
  const omittedCount = Math.max(0, totalActive - includedEntryIds.length)
  const omittedLine =
    omittedCount > 0 ? `（另有 ${omittedCount} 条，按需 \`lark-bridge memory search\` 查询）` : ''

  const bodyLines: string[] = [header]
  if (expandedLines.length > 0) {
    bodyLines.push(expandedLead, ...expandedLines)
    if (indexLines.length > 0) {
      bodyLines.push(remainingLead, ...indexLines)
    } else {
      bodyLines.push(allExpandedFooter)
    }
  } else {
    bodyLines.push(indexOnlyLead, ...indexLines)
  }
  if (omittedLine) {
    bodyLines.push(omittedLine)
  }
  bodyLines.push('</memory>')

  return {
    reminder: bodyLines.join('\n'),
    includedEntryIds,
    expandedEntryIds,
  }
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
    `# Memory — ${headerName}`,
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
 * Memory mutations, preventing false-positive `succeeded` status & watermark advancement.
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
