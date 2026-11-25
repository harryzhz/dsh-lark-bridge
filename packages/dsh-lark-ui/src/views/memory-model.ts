import { leafDirectoryLabel } from '../components/options.js'
import type { BotRecord, GroupView, MemoryEntry, MemoryScope, MemoryType } from '../types.js'

export type MemorySortBy = 'priority' | 'recent' | 'recall'
export type MemoryHistoryFilter = 'all' | 'superseded' | 'archived'

export type MemoryNavNode =
  | { readonly kind: 'all' }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'history' }
  | { readonly kind: 'type'; readonly type: MemoryType }
  | { readonly kind: 'scope'; readonly scope: MemoryScope; readonly scopeId?: string }
  | { readonly kind: 'tag'; readonly tag: string }

export const MEMORY_TYPE_ORDER: readonly MemoryType[] = [
  'feedback',
  'user',
  'project',
  'reference',
]

export const MEMORY_TYPE_META: Readonly<
  Record<MemoryType, { readonly label: string; readonly shortLabel: string; readonly priority: number }>
> = {
  feedback: { label: '纠偏与规范', shortLabel: '纠偏', priority: 0 },
  user: { label: '用户偏好', shortLabel: '偏好', priority: 1 },
  project: { label: '项目决策', shortLabel: '决策', priority: 2 },
  reference: { label: '外部参考', shortLabel: '参考', priority: 3 },
}

export const MEMORY_SORT_OPTIONS: ReadonlyArray<{
  readonly value: MemorySortBy
  readonly label: string
}> = [
  { value: 'priority', label: '按优先级' },
  { value: 'recent', label: '按最近核验' },
  { value: 'recall', label: '按召回次数' },
]

export const MEMORY_HISTORY_FILTERS: ReadonlyArray<{
  readonly value: MemoryHistoryFilter
  readonly label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'superseded', label: '已纠偏' },
  { value: 'archived', label: '已归档' },
]

export interface MemoryScopeLabelInfo {
  readonly label: string
  readonly shortLabel: string
  readonly fullTitle: string
}

export function resolveMemoryScopeLabel(
  entry: Pick<MemoryEntry, 'botId' | 'scope' | 'scopeId'>,
  groups: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[],
): MemoryScopeLabelInfo {
  if (entry.scope === 'bot') {
    return {
      label: '全局记忆',
      shortLabel: '全局记忆',
      fullTitle: '智能体全局（该智能体所有群聊与私聊可见）',
    }
  }
  if (entry.scope === 'chat') {
    const found = groups.find((g) => g.botId === entry.botId && g.chatId === entry.scopeId)
    if (found?.chatName) {
      return {
        label: `群聊 · ${found.chatName}`,
        shortLabel: found.chatName,
        fullTitle: `${found.chatName} (${entry.scopeId})`,
      }
    }
    return {
      label: `群聊 · ${entry.scopeId}`,
      shortLabel: entry.scopeId,
      fullTitle: entry.scopeId,
    }
  }
  const leaf = leafDirectoryLabel(entry.scopeId) || entry.scopeId
  return {
    label: `工作区 · ${leaf}`,
    shortLabel: leaf,
    fullTitle: entry.scopeId,
  }
}

export function countMemoriesByType(
  entries: readonly MemoryEntry[],
): Record<MemoryType, number> {
  const counts: Record<MemoryType, number> = { feedback: 0, user: 0, project: 0, reference: 0 }
  for (const e of entries) counts[e.type] += 1
  return counts
}

export function countMemoriesByHistoryStatus(
  entries: readonly MemoryEntry[],
): { readonly superseded: number; readonly archived: number } {
  let superseded = 0
  let archived = 0
  for (const e of entries) {
    if (e.status === 'superseded') superseded += 1
    else if (e.status === 'archived') archived += 1
  }
  return { superseded, archived }
}

export interface MemoryScopeBranch {
  readonly scopeId: string
  readonly label: string
  readonly fullTitle: string
  readonly count: number
}

export interface MemoryHierarchy {
  readonly globalCount: number
  readonly workspaceTotal: number
  readonly workspaces: readonly MemoryScopeBranch[]
  readonly chatTotal: number
  readonly chats: readonly MemoryScopeBranch[]
}

function sortScopeBranches(list: MemoryScopeBranch[]): MemoryScopeBranch[] {
  return list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
}

/**
 * Builds the 3-level scope hierarchy with 全局记忆 always first, followed by 工作区 and 群聊 branches.
 */
export function buildMemoryHierarchy(
  activeEntries: readonly MemoryEntry[],
  groups: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[],
): MemoryHierarchy {
  let globalCount = 0
  let workspaceTotal = 0
  let chatTotal = 0
  const wsMap = new Map<string, { label: string; fullTitle: string; count: number }>()
  const chatMap = new Map<string, { label: string; fullTitle: string; count: number }>()

  for (const entry of activeEntries) {
    if (entry.scope === 'bot') {
      globalCount += 1
      continue
    }
    const info = resolveMemoryScopeLabel(entry, groups)
    if (entry.scope === 'workspace') {
      workspaceTotal += 1
      const cur = wsMap.get(entry.scopeId)
      if (cur) cur.count += 1
      else wsMap.set(entry.scopeId, { label: info.shortLabel, fullTitle: info.fullTitle, count: 1 })
    } else if (entry.scope === 'chat') {
      chatTotal += 1
      const cur = chatMap.get(entry.scopeId)
      if (cur) cur.count += 1
      else chatMap.set(entry.scopeId, { label: info.shortLabel, fullTitle: info.fullTitle, count: 1 })
    }
  }

  return {
    globalCount,
    workspaceTotal,
    workspaces: sortScopeBranches(
      Array.from(wsMap.entries()).map(([scopeId, v]) => ({ scopeId, ...v })),
    ),
    chatTotal,
    chats: sortScopeBranches(
      Array.from(chatMap.entries()).map(([scopeId, v]) => ({ scopeId, ...v })),
    ),
  }
}

export interface MemoryTagStat {
  readonly tag: string
  readonly count: number
}

export function collectTopMemoryTags(
  activeEntries: readonly MemoryEntry[],
  limit = 12,
): MemoryTagStat[] {
  const counts = new Map<string, number>()
  for (const entry of activeEntries) {
    for (const rawTag of entry.tags) {
      const tag = rawTag.trim()
      if (!tag) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'))
    .slice(0, limit)
}

export function isSameMemoryNav(a: MemoryNavNode, b: MemoryNavNode): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'type' && b.kind === 'type') return a.type === b.type
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag.toLowerCase() === b.tag.toLowerCase()
  if (a.kind === 'scope' && b.kind === 'scope') {
    return a.scope === b.scope && (a.scopeId ?? '') === (b.scopeId ?? '')
  }
  return true
}

export function resolveNavHeading(
  nav: MemoryNavNode,
  groups: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[],
): string {
  switch (nav.kind) {
    case 'all':
      return '全部有效'
    case 'pinned':
      return '核心置顶'
    case 'history':
      return '历史演进'
    case 'type':
      return MEMORY_TYPE_META[nav.type].label
    case 'tag':
      return `#${nav.tag}`
    case 'scope': {
      if (nav.scope === 'bot') return '全局记忆'
      if (!nav.scopeId) return nav.scope === 'workspace' ? '工作区' : '群聊'
      if (nav.scope === 'workspace') {
        return `工作区 · ${leafDirectoryLabel(nav.scopeId) || nav.scopeId}`
      }
      const found = groups.find((g) => g.chatId === nav.scopeId)
      return `群聊 · ${found?.chatName || nav.scopeId}`
    }
  }
}

export function matchesMemorySearch(
  entry: MemoryEntry,
  rawQuery: string,
  botsById: ReadonlyMap<string, Pick<BotRecord, 'id' | 'name'>>,
  groups: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[],
): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true
  const scopeInfo = resolveMemoryScopeLabel(entry, groups)
  const botName = botsById.get(entry.botId)?.name ?? ''
  return (
    entry.title.toLowerCase().includes(q) ||
    entry.content.toLowerCase().includes(q) ||
    entry.id.toLowerCase().includes(q) ||
    entry.scopeId.toLowerCase().includes(q) ||
    scopeInfo.label.toLowerCase().includes(q) ||
    botName.toLowerCase().includes(q) ||
    entry.botId.toLowerCase().includes(q) ||
    (entry.supersedeReason ?? '').toLowerCase().includes(q) ||
    entry.tags.some((t) => t.toLowerCase().includes(q))
  )
}

export function sortMemoryEntries(
  entries: readonly MemoryEntry[],
  sortBy: MemorySortBy,
): MemoryEntry[] {
  const list = [...entries]
  list.sort((a, b) => {
    if (sortBy === 'recent') {
      return b.lastVerifiedAtMs - a.lastVerifiedAtMs || b.updatedAtMs - a.updatedAtMs
    }
    if (sortBy === 'recall') {
      return (
        b.recallCount - a.recallCount ||
        Number(b.pinned) - Number(a.pinned) ||
        b.lastVerifiedAtMs - a.lastVerifiedAtMs
      )
    }
    // priority: pinned DESC -> semantic type weight ASC -> lastVerifiedAtMs DESC -> updatedAtMs DESC
    return (
      Number(b.pinned) - Number(a.pinned) ||
      MEMORY_TYPE_META[a.type].priority - MEMORY_TYPE_META[b.type].priority ||
      b.lastVerifiedAtMs - a.lastVerifiedAtMs ||
      b.updatedAtMs - a.updatedAtMs
    )
  })
  return list
}

export function filterAndSortMemories(input: {
  readonly entries: readonly MemoryEntry[]
  readonly botId: string
  readonly nav: MemoryNavNode
  readonly historyFilter: MemoryHistoryFilter
  readonly query: string
  readonly sortBy: MemorySortBy
  readonly bots?: readonly Pick<BotRecord, 'id' | 'name'>[]
  readonly groups?: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[]
}): MemoryEntry[] {
  const { entries, botId, nav, historyFilter, query, sortBy, bots = [], groups = [] } = input
  const botsById = new Map(bots.map((b) => [b.id, b]))

  const filtered = entries.filter((entry) => {
    if (botId && entry.botId !== botId) return false

    if (nav.kind === 'history') {
      if (entry.status === 'active') return false
      if (historyFilter !== 'all' && entry.status !== historyFilter) return false
    } else {
      if (entry.status !== 'active') return false
      if (nav.kind === 'pinned' && !entry.pinned) return false
      if (nav.kind === 'type' && entry.type !== nav.type) return false
      if (nav.kind === 'scope') {
        if (entry.scope !== nav.scope) return false
        if (nav.scopeId && entry.scopeId !== nav.scopeId) return false
      }
      if (nav.kind === 'tag') {
        const needle = nav.tag.toLowerCase()
        if (!entry.tags.some((t) => t.toLowerCase() === needle)) return false
      }
    }

    return matchesMemorySearch(entry, query, botsById, groups)
  })

  return sortMemoryEntries(filtered, sortBy)
}

export function summarizeMemoryExcerpt(content: string): string {
  return content
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function findSupersededPredecessors(
  entryId: string,
  allEntries: readonly MemoryEntry[],
): MemoryEntry[] {
  return allEntries
    .filter((e) => e.supersededBy === entryId)
    .sort((a, b) => (b.supersededAtMs ?? b.updatedAtMs) - (a.supersededAtMs ?? a.updatedAtMs))
}
